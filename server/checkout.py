"""Local demo checkout. Prices, limits, passkeys and orders live on the server.

This is intentionally a single-shopper localhost deployment. It records demo
orders; it never charges a card. A hosted deployment needs account enrollment
and merchant authentication before these endpoints can be exposed publicly.
"""
import json
import os
import pathlib
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal

from webauthn import (
    generate_authentication_options, generate_registration_options,
    options_to_json, verify_authentication_response, verify_registration_response,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
    ResidentKeyRequirement, UserVerificationRequirement,
)

ROOT = pathlib.Path(__file__).resolve().parent.parent


class CheckoutError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def cents(value):
    return int(Decimal(str(value)) * 100)


class Checkout:
    def __init__(self, db_path=None, catalog_path=None, rp_id=None, origin=None,
                 monthly_limit=None, order_limit=None):
        self.db_path = pathlib.Path(db_path or os.getenv("CUE_DB", ROOT / "server/data/cue.sqlite3"))
        self.catalog = {p["id"]: p for p in json.loads(pathlib.Path(catalog_path or ROOT / "store/products.json").read_text())}
        self.rp_id = rp_id or os.getenv("CUE_RP_ID", "localhost")
        self.origin = origin or os.getenv("CUE_ORIGIN", "http://localhost:4173")
        self.monthly_limit = int(monthly_limit or os.getenv("CUE_MONTHLY_LIMIT_CENTS", "25000"))
        self.order_limit = int(order_limit or os.getenv("CUE_ORDER_LIMIT_CENTS", "20000"))
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self.db() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS credentials (
                    id BLOB PRIMARY KEY, public_key BLOB NOT NULL, sign_count INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ceremonies (
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge BLOB NOT NULL,
                    intent_id TEXT, expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS intents (
                    id TEXT PRIMARY KEY, items_json TEXT NOT NULL, total_cents INTEGER NOT NULL,
                    customer_words TEXT NOT NULL, created_at TEXT NOT NULL,
                    expires_at INTEGER NOT NULL, status TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS orders (
                    id TEXT PRIMARY KEY, intent_id TEXT UNIQUE NOT NULL,
                    items_json TEXT NOT NULL, total_cents INTEGER NOT NULL,
                    customer_words TEXT NOT NULL, credential_id BLOB NOT NULL,
                    created_at TEXT NOT NULL
                );
            """)

    @contextmanager
    def db(self):
        conn = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    @staticmethod
    def _month_start():
        now = datetime.now(timezone.utc)
        return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()

    def _spent(self, conn):
        return conn.execute("SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE created_at >= ?",
                            (self._month_start(),)).fetchone()[0]

    def status(self):
        with self.db() as conn:
            return {
                "passkey_registered": bool(conn.execute("SELECT 1 FROM credentials LIMIT 1").fetchone()),
                "monthly_limit_cents": self.monthly_limit,
                "order_limit_cents": self.order_limit,
                "remaining_cents": max(0, self.monthly_limit - self._spent(conn)),
                "payment_mode": "demo_order_no_charge",
            }

    def prepare(self, items, customer_words):
        if not isinstance(items, list) or not 1 <= len(items) <= 10:
            raise CheckoutError("Add 1 to 10 items before checkout.")
        if not isinstance(customer_words, str) or not customer_words.strip() or len(customer_words) > 500:
            raise CheckoutError("A short record of your spoken intent is required.")
        lines = []
        total = 0
        for item in items:
            if not isinstance(item, dict):
                raise CheckoutError("Invalid cart item.")
            product = self.catalog.get(item.get("id"))
            size = item.get("size")
            color = item.get("color")
            if (not product or size not in product["variants"] or
                    color not in [option["name"] for option in product["colors"]]):
                raise CheckoutError("A cart item, size, or color is unavailable.")
            price = cents(product["price"])
            lines.append({"id": product["id"], "title": product["title"],
                          "size": size, "color": color,
                          "unit_price_cents": price, "currency": product["currency"]})
            total += price
        if total > self.order_limit:
            raise CheckoutError("This order exceeds your per-order spending limit.")
        intent_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc).isoformat()
        expires_at = int(time.time()) + 300
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            remaining = self.monthly_limit - self._spent(conn)
            if total > remaining:
                raise CheckoutError("This order exceeds your remaining monthly budget.")
            conn.execute("INSERT INTO intents VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (intent_id, json.dumps(lines), total, customer_words.strip(), now, expires_at, "prepared"))
            conn.commit()
        return {"intent_id": intent_id, "items": lines, "total_cents": total,
                "remaining_after_cents": remaining - total, "expires_at": expires_at,
                "payment_mode": "demo_order_no_charge"}

    def registration_options(self):
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute("SELECT 1 FROM credentials LIMIT 1").fetchone():
                raise CheckoutError("A passkey is already registered for this local demo.", 409)
            ceremony_id = str(uuid.uuid4())
            challenge = secrets.token_bytes(32)
            conn.execute("INSERT INTO ceremonies VALUES (?, 'register', ?, NULL, ?)",
                         (ceremony_id, challenge, int(time.time()) + 300))
            conn.commit()
        options = generate_registration_options(
            rp_id=self.rp_id, rp_name="Cue demo store", user_name="Cue shopper",
            user_id=b"cue-local-demo-shopper", challenge=challenge,
            authenticator_selection=AuthenticatorSelectionCriteria(
                resident_key=ResidentKeyRequirement.PREFERRED,
                user_verification=UserVerificationRequirement.REQUIRED),
        )
        return {"ceremony_id": ceremony_id, "options": json.loads(options_to_json(options))}

    def register(self, ceremony_id, credential):
        with self.db() as conn:
            row = conn.execute("SELECT * FROM ceremonies WHERE id=? AND kind='register'", (ceremony_id,)).fetchone()
            if not row or row["expires_at"] < time.time():
                raise CheckoutError("Passkey setup expired. Try again.", 409)
            try:
                verified = verify_registration_response(
                    credential=credential, expected_challenge=row["challenge"],
                    expected_rp_id=self.rp_id, expected_origin=self.origin,
                    require_user_verification=True,
                )
            except Exception as exc:
                raise CheckoutError("Passkey setup could not be verified.") from exc
            conn.execute("BEGIN IMMEDIATE")
            if conn.execute("SELECT 1 FROM credentials LIMIT 1").fetchone():
                raise CheckoutError("A passkey is already registered.", 409)
            conn.execute("INSERT INTO credentials VALUES (?, ?, ?)",
                         (verified.credential_id, verified.credential_public_key, verified.sign_count))
            conn.execute("DELETE FROM ceremonies WHERE id=?", (ceremony_id,))
            conn.commit()
        return {"registered": True}

    def authentication_options(self, intent_id):
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            intent = conn.execute("SELECT * FROM intents WHERE id=?", (intent_id,)).fetchone()
            if not intent or intent["status"] != "prepared" or intent["expires_at"] < time.time():
                raise CheckoutError("Checkout expired. Please review your cart again.", 409)
            credential_ids = [r["id"] for r in conn.execute("SELECT id FROM credentials")]
            if not credential_ids:
                raise CheckoutError("Set up a passkey before approving.", 409)
            ceremony_id = str(uuid.uuid4())
            challenge = secrets.token_bytes(32)
            conn.execute("INSERT INTO ceremonies VALUES (?, 'authenticate', ?, ?, ?)",
                         (ceremony_id, challenge, intent_id, int(time.time()) + 180))
            conn.commit()
        options = generate_authentication_options(
            rp_id=self.rp_id, challenge=challenge,
            allow_credentials=[PublicKeyCredentialDescriptor(id=x) for x in credential_ids],
            user_verification=UserVerificationRequirement.REQUIRED,
        )
        return {"ceremony_id": ceremony_id, "options": json.loads(options_to_json(options))}

    def cancel(self, intent_id):
        """Revoke the intent and every approval challenge atomically."""
        with self.db() as conn:
            conn.execute("BEGIN IMMEDIATE")
            intent = conn.execute("SELECT status FROM intents WHERE id=?", (intent_id,)).fetchone()
            if not intent:
                raise CheckoutError("Checkout was not found.", 404)
            if intent["status"] == "approved":
                raise CheckoutError("This order was already recorded; it cannot be cancelled here.", 409)
            conn.execute("UPDATE intents SET status='cancelled' WHERE id=?", (intent_id,))
            conn.execute("DELETE FROM ceremonies WHERE intent_id=?", (intent_id,))
            conn.commit()
        return {"intent_id": intent_id, "status": "cancelled"}

    def approve(self, ceremony_id, credential):
        with self.db() as conn:
            ceremony = conn.execute("SELECT * FROM ceremonies WHERE id=? AND kind='authenticate'",
                                    (ceremony_id,)).fetchone()
            if not ceremony or ceremony["expires_at"] < time.time():
                raise CheckoutError("Passkey approval expired. Try again.", 409)
            passkey = conn.execute("SELECT * FROM credentials WHERE id=?",
                                   (credential.get("rawId") and self._decode_id(credential["rawId"]),)).fetchone()
            if not passkey:
                raise CheckoutError("This passkey is not registered.")
            try:
                verified = verify_authentication_response(
                    credential=credential, expected_challenge=ceremony["challenge"],
                    expected_rp_id=self.rp_id, expected_origin=self.origin,
                    credential_public_key=passkey["public_key"],
                    credential_current_sign_count=passkey["sign_count"],
                    require_user_verification=True,
                )
            except Exception as exc:
                raise CheckoutError("Passkey approval could not be verified.") from exc
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute("SELECT * FROM ceremonies WHERE id=? AND kind='authenticate'",
                                   (ceremony_id,)).fetchone()
            intent = conn.execute("SELECT * FROM intents WHERE id=?", (ceremony["intent_id"],)).fetchone()
            if (not current or current["expires_at"] < time.time() or not intent or
                    intent["status"] != "prepared" or intent["expires_at"] < time.time()):
                raise CheckoutError("This checkout was already used or expired.", 409)
            remaining = self.monthly_limit - self._spent(conn)
            if intent["total_cents"] > self.order_limit or intent["total_cents"] > remaining:
                raise CheckoutError("Spending limit reached since the readback. Review your cart again.", 409)
            order_id = str(uuid.uuid4())
            now = datetime.now(timezone.utc).isoformat()
            conn.execute("INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?)",
                         (order_id, intent["id"], intent["items_json"], intent["total_cents"],
                          intent["customer_words"], passkey["id"], now))
            conn.execute("UPDATE intents SET status='approved' WHERE id=?", (intent["id"],))
            conn.execute("UPDATE credentials SET sign_count=? WHERE id=?", (verified.new_sign_count, passkey["id"]))
            conn.execute("DELETE FROM ceremonies WHERE id=?", (ceremony_id,))
            conn.commit()
        return {"order_id": order_id, "total_cents": intent["total_cents"],
                "remaining_cents": remaining - intent["total_cents"],
                "payment_mode": "demo_order_no_charge"}

    @staticmethod
    def _decode_id(value):
        from webauthn import base64url_to_bytes
        try:
            return base64url_to_bytes(value)
        except Exception as exc:
            raise CheckoutError("Invalid passkey ID.") from exc

    def orders(self):
        with self.db() as conn:
            rows = conn.execute("SELECT * FROM orders ORDER BY created_at DESC LIMIT 50").fetchall()
        return [{"id": r["id"], "items": json.loads(r["items_json"]),
                 "total_cents": r["total_cents"], "customer_words": r["customer_words"],
                 "approved_with_passkey": True, "payment_mode": "demo_order_no_charge",
                 "created_at": r["created_at"]} for r in rows]
