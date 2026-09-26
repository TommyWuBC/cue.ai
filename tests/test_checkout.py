import base64
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import checkout as module


class CheckoutTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.shop = module.Checkout(db_path=Path(self.tmp.name) / 'orders.sqlite3')

    def test_server_reprices_and_rejects_invalid_items(self):
        quote = self.shop.prepare([{'id': 'j1', 'size': 'M', 'price': 1}], 'Add this in medium. Check out.')
        self.assertEqual(quote['total_cents'], 12900)
        self.assertEqual(quote['remaining_after_cents'], 12100)
        with self.assertRaises(module.CheckoutError):
            self.shop.prepare([{'id': 'j1', 'size': 'XXL'}], 'Check out.')
        with self.assertRaises(module.CheckoutError):
            self.shop.prepare([{'id': 'fake', 'size': 'M'}], 'Check out.')
        with self.assertRaises(module.CheckoutError):
            self.shop.prepare([{'id': 'j1', 'size': 'M'}, {'id': 'j2', 'size': 'M'}], 'Check out.')

    def test_passkey_approval_enforces_budget_and_cannot_replay(self):
        first = self.shop.prepare([{'id': 'j1', 'size': 'M'}], 'Add first in medium. Check out.')
        second = self.shop.prepare([{'id': 'j5', 'size': 'M'}], 'Add second in medium. Check out.')
        credential_id = b'credential-for-test'
        with self.shop.db() as conn:
            conn.execute('INSERT INTO credentials VALUES (?, ?, 0)', (credential_id, b'public-key'))
        auth = self.shop.authentication_options(first['intent_id'])
        raw_id = base64.urlsafe_b64encode(credential_id).decode().rstrip('=')
        response = {'rawId': raw_id}
        with patch.object(module, 'verify_authentication_response', return_value=SimpleNamespace(new_sign_count=1)) as verify:
            order = self.shop.approve(auth['ceremony_id'], response)
            self.assertEqual(order['remaining_cents'], 12100)
            self.assertEqual(len(self.shop.orders()), 1)
            self.assertEqual(self.shop.orders()[0]['customer_words'], 'Add first in medium. Check out.')
            verify.assert_called_once()
            self.assertTrue(verify.call_args.kwargs['require_user_verification'])
            with self.assertRaises(module.CheckoutError):
                self.shop.approve(auth['ceremony_id'], response)
            second_auth = self.shop.authentication_options(second['intent_id'])
            with self.assertRaises(module.CheckoutError):
                self.shop.approve(second_auth['ceremony_id'], response)
        self.assertEqual(len(self.shop.orders()), 1)

    def test_unverified_passkey_never_creates_order(self):
        quote = self.shop.prepare([{'id': 'j2', 'size': 'M'}], 'Check out.')
        with self.assertRaises(module.CheckoutError):
            self.shop.authentication_options(quote['intent_id'])
        self.assertEqual(self.shop.orders(), [])


if __name__ == '__main__':
    unittest.main()
