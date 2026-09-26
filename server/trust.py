"""Local merchant profile of TAP agent recognition using RFC 9421 signatures.

This demo pins Cue's own Ed25519 public key. It does not claim Visa enrollment,
Visa consumer identity, or a Visa payment container. Signing keys stay on the
server; the merchant verifies the complete HTTP request before passkey approval.
"""
import base64
import hashlib
import hmac
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from http_message_signatures import (
    HTTPMessageSigner, HTTPMessageVerifier, HTTPSignatureKeyResolver, algorithms,
)

MERCHANT_PATH = "/api/merchant/checkout/approve"
COMPONENTS = ("@method", "@authority", "@path", "@query", "content-type", "content-digest")
TAG = "agent-payer-auth"
LIFETIME = 120
MAX_BODY = 64 * 1024


class TrustError(Exception):
    def __init__(self, message, status=401):
        super().__init__(message)
        self.status = status


def b64url(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def digest(body):
    return "sha-256=:" + base64.b64encode(hashlib.sha256(body).digest()).decode() + ":"


class PinnedKeys(HTTPSignatureKeyResolver):
    def __init__(self, kid, public_key, private_key=None):
        self.kid, self.public_key, self.private_key = kid, public_key, private_key

    def resolve_public_key(self, key_id):
        if key_id != self.kid:
            raise TrustError("The agent signing key is not trusted.")
        return self.public_key

    def resolve_private_key(self, key_id):
        if key_id != self.kid or self.private_key is None:
            raise TrustError("No signing key is available.")
        return self.private_key


class AgentTrust:
    def __init__(self, db_path, origin):
        self.db_path = db_path
        self.target = origin.rstrip("/") + MERCHANT_PATH
        with self.db() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS agent_keys (
                    name TEXT PRIMARY KEY, private_key BLOB NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_nonces (
                    key_id TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL,
                    PRIMARY KEY (key_id, nonce)
                );
                CREATE TABLE IF NOT EXISTS agent_trust_counts (
                    outcome TEXT PRIMARY KEY, count INTEGER NOT NULL
                );
            """)
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT private_key FROM agent_keys WHERE name='cue'").fetchone()
            if row:
                key = Ed25519PrivateKey.from_private_bytes(row[0])
            else:
                key = Ed25519PrivateKey.generate()
                conn.execute("INSERT INTO agent_keys VALUES ('cue', ?)", (key.private_bytes_raw(),))
            conn.commit()
        public = key.public_key()
        self.jwk = {"crv": "Ed25519", "kty": "OKP", "x": b64url(public.public_bytes_raw())}
        # RFC 7638 thumbprint: the key ID depends only on the public key.
        self.kid = b64url(hashlib.sha256(json.dumps(self.jwk, sort_keys=True, separators=(",", ":")).encode()).digest())
        self.signer = HTTPMessageSigner(signature_algorithm=algorithms.ED25519,
                                       key_resolver=PinnedKeys(self.kid, public, key))
        self.verifier = HTTPMessageVerifier(signature_algorithm=algorithms.ED25519,
                                           key_resolver=PinnedKeys(self.kid, public))

    @contextmanager
    def db(self):
        conn = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
        try:
            yield conn
        finally:
            conn.close()

    def public_keys(self):
        return {"keys": [{**self.jwk, "kid": self.kid, "use": "sig", "alg": "EdDSA"}]}

    def sign(self, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        if len(body) > MAX_BODY:
            raise TrustError("The approval request is too large.", 413)
        request = httpx.Request("POST", self.target, content=body, headers={
            "Content-Type": "application/json", "Content-Digest": digest(body),
        })
        now = datetime.now(timezone.utc)
        self.signer.sign(request, key_id=self.kid, created=now, expires=now + timedelta(seconds=LIFETIME),
                         nonce=secrets.token_urlsafe(32), tag=TAG, label="cue",
                         covered_component_ids=COMPONENTS)
        return request

    @staticmethod
    def _count(conn, outcome):
        conn.execute("""INSERT INTO agent_trust_counts VALUES (?, 1)
                        ON CONFLICT(outcome) DO UPDATE SET count=count+1""", (outcome,))

    def verify(self, method, url, headers, body):
        try:
            return self._verify(method, url, headers, body)
        except TrustError:
            with self.db() as conn:
                self._count(conn, "rejected")
            raise
        except Exception as exc:
            with self.db() as conn:
                self._count(conn, "rejected")
            raise TrustError("The agent request signature could not be verified.") from exc

    def _verify(self, method, url, headers, body):
        if method != "POST" or url != self.target or len(body) > MAX_BODY:
            raise TrustError("The signed request does not target this merchant checkout.")
        request = httpx.Request(method, url, headers=headers, content=body)
        if request.headers.get("content-type") != "application/json" or "content-encoding" in request.headers:
            raise TrustError("Unsupported signed request encoding.")
        result, = self.verifier.verify(request, max_age=timedelta(seconds=480))
        params = result.parameters
        covered = result.covered_components
        if any('"' + name + '"' not in covered for name in COMPONENTS):
            raise TrustError("The signature does not cover every required request component.")
        now = time.time()
        created, expires = params.get("created"), params.get("expires")
        if (type(created) is not int or type(expires) is not int or
                not created <= now < expires or not 0 < expires - created <= 480):
            raise TrustError("The agent request has expired or has invalid timestamps.")
        nonce = params.get("nonce")
        if (params.get("tag") != TAG or params.get("alg") != "ed25519" or
                not isinstance(nonce, str) or not 16 <= len(nonce) <= 256):
            raise TrustError("The agent request is missing valid purpose or nonce metadata.")
        if not hmac.compare_digest(request.headers.get("content-digest", ""), digest(body)):
            raise TrustError("The signed approval body was changed.")
        # Persistent, atomic consumption prevents replays across workers/restarts.
        replay = False
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("DELETE FROM agent_nonces WHERE expires <= ?", (int(now),))
            try:
                conn.execute("INSERT INTO agent_nonces VALUES (?, ?, ?)", (params["keyid"], nonce, expires))
            except sqlite3.IntegrityError:
                replay = True
                self._count(conn, "replay_rejected")
            else:
                self._count(conn, "verified")
            conn.commit()
        if replay:
            raise TrustError("This signed agent request has already been used.", 409)
        return {
            "verified": True, "trust_source": "local_demo_key", "key_id": params["keyid"],
            "algorithm": "ed25519", "tag": TAG, "nonce": nonce,
            "created": created, "expires": expires,
            "verified_at": datetime.now(timezone.utc).isoformat(),
            "body_digest": digest(body), "covered_components": list(COMPONENTS),
            "signature_input": request.headers["signature-input"],
            "signature": request.headers["signature"],
        }

    def status(self):
        with self.db() as conn:
            counts = dict(conn.execute("SELECT outcome, count FROM agent_trust_counts"))
        return {"trust_source": "local_demo_key", "key_id": self.kid,
                "verified_requests": counts.get("verified", 0),
                "rejected_requests": counts.get("rejected", 0),
                "replays_rejected": counts.get("replay_rejected", 0)}
