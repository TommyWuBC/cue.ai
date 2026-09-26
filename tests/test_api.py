import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
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
            'items': [{'id': 'j4', 'size': 'M', 'color': 'Oat'}], 'customer_words': 'Add the sweater in medium. Check out.'
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['total_cents'], 5999)
        self.assertEqual(self.client.get('/api/merchant/orders').json(), {'orders': []})
        self.assertFalse(self.client.get('/api/checkout/status').json()['passkey_registered'])
        self.assertEqual(self.client.post('/api/passkey/authenticate/options/' + response.json()['intent_id']).status_code, 409)
        self.assertEqual(self.client.get('/merchant.html').status_code, 200)

    def test_cancel_endpoint_revokes_checkout(self):
        quote = self.client.post('/api/checkout/prepare', json={
            'items': [{'id': 'j4', 'size': 'M', 'color': 'Oat'}], 'customer_words': 'Check out.'
        }).json()
        path = '/api/checkout/cancel/' + quote['intent_id']
        self.assertEqual(self.client.post(path).json()['status'], 'cancelled')
        self.assertEqual(self.client.post(path).status_code, 200)
        self.assertEqual(self.client.post('/api/passkey/authenticate/options/' + quote['intent_id']).status_code, 409)

    def test_gaze_session_is_limited_to_extension_or_loopback_origins(self):
        denied = self.client.post('/api/gaze/session', headers={'Origin': 'https://store.example'})
        self.assertEqual(denied.status_code, 403)
        allowed = self.client.post('/api/gaze/session',
                                   headers={'Origin': 'chrome-extension://cue-test'})
        self.assertEqual(allowed.status_code, 200)
        self.assertGreater(len(allowed.json()['token']), 20)
        gaze = self.client.get('/health').json()['gaze']
        self.assertEqual(gaze['engine'], 'eyetrax')
        self.assertIn('installed', gaze)


    def prepared_approval(self):
        quote = main.checkout.prepare([{'id': 'j4', 'size': 'M', 'color': 'Oat'}], 'Add in medium. Check out.')
        with main.checkout.db() as conn:
            conn.execute('INSERT INTO credentials VALUES (?, ?, 0)', (b'key', b'public-key'))
        ceremony = main.checkout.authentication_options(quote['intent_id'])
        return {'ceremony_id': ceremony['ceremony_id'], 'credential': {'rawId': 'a2V5'}}

    def test_gateway_signs_and_merchant_verifies_order_then_blocks_replay(self):
        approval = self.prepared_approval()
        signed = []
        sign = main.checkout.agent_trust.sign
        def capture(payload):
            request = sign(payload)
            signed.append(request)
            return request
        with patch.object(main.checkout.agent_trust, 'sign', side_effect=capture), \
             patch('checkout.verify_authentication_response', return_value=SimpleNamespace(new_sign_count=1)):
            response = self.client.post('/api/checkout/approve', json=approval)
        self.assertEqual(response.status_code, 200, response.text)
        order = self.client.get('/api/merchant/orders').json()['orders'][0]
        proof = order['agent_verification']
        self.assertTrue(proof['verified'])
        self.assertEqual(proof['trust_source'], 'local_demo_key')
        self.assertIn('content-digest', proof['covered_components'])
        replay = self.client.post(str(signed[0].url), content=signed[0].content, headers=dict(signed[0].headers))
        self.assertEqual(replay.status_code, 409)
        self.assertEqual(self.client.get('/api/merchant/trust').json()['replays_rejected'], 1)
        self.assertNotIn('d', self.client.get('/.well-known/cue-agent-keys.json').json()['keys'][0])
        self.assertEqual(len(main.checkout.orders()), 1)

    def test_merchant_requires_signature_passkey_and_matching_intent(self):
        approval = self.prepared_approval()
        target = main.checkout.agent_trust.target
        self.assertEqual(self.client.post(target, json=approval).status_code, 401)
        intent = main.checkout.intent_for_ceremony(approval['ceremony_id'])
        intent['total_cents'] = 1
        request = main.checkout.agent_trust.sign({**approval, 'intent': intent})
        with patch('checkout.verify_authentication_response', return_value=SimpleNamespace(new_sign_count=1)):
            response = self.client.post(target, content=request.content, headers=dict(request.headers))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(main.checkout.orders(), [])
        # Signing alone does not replace the shopper's passkey.
        real_intent = main.checkout.intent_for_ceremony(approval['ceremony_id'])
        request = main.checkout.agent_trust.sign({**approval, 'intent': real_intent})
        response = self.client.post(target, content=request.content, headers=dict(request.headers))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(main.checkout.orders(), [])



if __name__ == '__main__':
    unittest.main()
