import base64
import json
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
from checkout import Checkout
from trust import AgentTrust, TrustError, COMPONENTS, TAG, digest


class TrustTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'trust.sqlite3'
        self.trust = AgentTrust(self.path, 'http://localhost:4173')

    def verify(self, request, body=None):
        return self.trust.verify(request.method, str(request.url), request.headers,
                                 request.content if body is None else body)

    def test_signature_is_independently_verifiable_with_published_public_key(self):
        request = self.trust.sign({'intent': 'Medium in black', 'total_cents': 5900})
        jwk = self.trust.public_keys()['keys'][0]
        self.assertNotIn('d', jwk)
        key = Ed25519PublicKey.from_public_bytes(base64.urlsafe_b64decode(jwk['x'] + '=='))
        params = request.headers['signature-input'].split('=', 1)[1]
        signature = base64.b64decode(request.headers['signature'].split(':')[1])
        # Independently construct the RFC 9421 signature base (no library verifier).
        fields = {'@method': 'POST', '@authority': 'localhost:4173',
                  '@path': '/api/merchant/checkout/approve', '@query': '?',
                  'content-type': 'application/json', 'content-digest': digest(request.content)}
        lines = [json.dumps(k) + ': ' + fields[k] for k in COMPONENTS]
        lines.append('"@signature-params": ' + params)
        key.verify(signature, '\n'.join(lines).encode())
        self.assertTrue(self.verify(request)['verified'])

    def test_body_tampering_and_metadata_changes_fail_closed(self):
        original = self.trust.sign({'amount': 59})
        for body in [b'{"amount":1}', original.content + b' ']:
            with self.assertRaises(TrustError):
                self.verify(original, body)
        for name, value in [('content-type', 'text/plain'),
                            ('signature-input', original.headers['signature-input'].replace(TAG, 'agent-browser-auth')),
                            ('signature', 'cue=:AAAA:')]:
            headers = dict(original.headers)
            headers[name] = value
            with self.assertRaises(TrustError):
                self.trust.verify('POST', self.trust.target, headers, original.content)
        for method, url in [('GET', self.trust.target), ('POST', self.trust.target + '?other=1'),
                            ('POST', 'http://evil.example/api/merchant/checkout/approve')]:
            with self.assertRaises(TrustError):
                self.trust.verify(method, url, original.headers, original.content)
        # Rejected tampering does not burn the genuine request's nonce.
        self.assertTrue(self.verify(original)['verified'])

    def test_replays_are_atomic_and_survive_restart(self):
        request = self.trust.sign({'intent': 'one'})
        def attempt():
            try:
                return self.verify(request)['verified']
            except TrustError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: attempt(), range(4)))
        self.assertEqual(results.count(True), 1)
        self.assertEqual(results.count(409), 3)
        restarted = AgentTrust(self.path, 'http://localhost:4173')
        self.assertEqual(restarted.kid, self.trust.kid)
        with self.assertRaises(TrustError) as error:
            restarted.verify('POST', self.trust.target, request.headers, request.content)
        self.assertEqual(error.exception.status, 409)
        self.assertEqual(restarted.status()['replays_rejected'], 4)

    def signed_with(self, *, components=COMPONENTS, seconds_ago=0, lifetime=120, tag=TAG, nonce='n' * 32):
        body = b'{}'
        request = httpx.Request('POST', self.trust.target, content=body,
                                headers={'content-type': 'application/json', 'content-digest': digest(body)})
        created = datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)
        self.trust.signer.sign(request, key_id=self.trust.kid, created=created,
            expires=created + timedelta(seconds=lifetime), tag=tag, nonce=nonce,
            covered_component_ids=components)
        return request

    def test_valid_signatures_still_require_time_purpose_nonce_and_body_coverage(self):
        for options in [
            {'components': ('@authority', '@path')},
            {'seconds_ago': 200, 'lifetime': 120},
            {'seconds_ago': -90},
            {'lifetime': 481},
            {'tag': 'agent-browser-auth'},
            {'nonce': None},
        ]:
            with self.subTest(options=options), self.assertRaises(TrustError):
                self.verify(self.signed_with(**options))
        other = AgentTrust(Path(self.tmp.name) / 'other.sqlite3', 'http://localhost:4173')
        with self.assertRaises(TrustError):
            self.verify(other.sign({'intent': 'unknown signer'}))

    def test_existing_orders_migrate_without_inventing_signature_evidence(self):
        path = Path(self.tmp.name) / 'legacy.sqlite3'
        with sqlite3.connect(path) as conn:
            conn.execute('''CREATE TABLE orders (id TEXT PRIMARY KEY, intent_id TEXT UNIQUE NOT NULL,
                items_json TEXT NOT NULL, total_cents INTEGER NOT NULL, customer_words TEXT NOT NULL,
                credential_id BLOB NOT NULL, created_at TEXT NOT NULL)''')
            conn.execute("INSERT INTO orders VALUES ('old', 'intent', '[]', 10, 'yes', X'61', '2026-01-01')")
        migrated = Checkout(db_path=path)
        self.assertEqual(migrated.orders()[0]['id'], 'old')
        self.assertIsNone(migrated.orders()[0]['agent_verification'])
        self.assertEqual(Checkout(db_path=path).orders()[0]['id'], 'old')


if __name__ == '__main__':
    unittest.main()
