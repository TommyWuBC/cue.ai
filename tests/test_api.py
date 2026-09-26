import sys
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import main
from checkout import Checkout


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.original = main.checkout
        main.checkout = Checkout(db_path=Path(self.tmp.name) / 'api.sqlite3')
        self.addCleanup(lambda: setattr(main, 'checkout', self.original))
        self.client = TestClient(main.app)

    def test_checkout_api_and_merchant_feed(self):
        response = self.client.post('/api/checkout/prepare', json={
            'items': [{'id': 'j4', 'size': 'M'}], 'customer_words': 'Add the sweater in medium. Check out.'
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['total_cents'], 5999)
        self.assertEqual(self.client.get('/api/merchant/orders').json(), {'orders': []})
        self.assertFalse(self.client.get('/api/checkout/status').json()['passkey_registered'])
        self.assertEqual(self.client.post('/api/passkey/authenticate/options/' + response.json()['intent_id']).status_code, 409)
        self.assertEqual(self.client.get('/merchant.html').status_code, 200)


if __name__ == '__main__':
    unittest.main()
