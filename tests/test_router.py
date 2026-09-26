import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import router


class RouterTests(unittest.TestCase):
    def test_recalibrate_command(self):
        result = router.route('please recalibrate')
        self.assertEqual(result['do'], [{'verb': 'recalibrate', 'args': {}}])

    def test_unmatched_question_goes_to_agent(self):
        self.assertIsNone(router.route('Is this wool?'))

    def test_checkout_confirmation_and_passkey_setup(self):
        self.assertEqual(router.route('yes')['do'][0]['verb'], 'approve_checkout')
        self.assertEqual(router.route('set up passkey')['do'][0]['verb'], 'setup_passkey')
        self.assertEqual(router.route('no')['do'][0]['verb'], 'cancel_checkout')


if __name__ == '__main__':
    unittest.main()
