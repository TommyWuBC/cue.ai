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

    def test_add_second_item_with_options_is_one_safe_sequence(self):
        self.assertEqual(router.route('Add the second one in medium, in black')['do'], [
            {'verb': 'focus_nth', 'args': {'n': 2}},
            {'verb': 'select_variant', 'args': {'value': 'M'}},
            {'verb': 'select_color', 'args': {'value': 'Black'}},
            {'verb': 'add_to_cart', 'args': {}},
        ])
        self.assertEqual(router.route('Medium, in black. Add it')['do'][-1]['verb'], 'add_to_cart')
        self.assertEqual(router.route('medium in black')['do'], [
            {'verb': 'select_variant', 'args': {'value': 'M'}},
            {'verb': 'select_color', 'args': {'value': 'Black'}},
        ])

    def test_questions_and_negations_do_not_act(self):
        self.assertIsNone(router.route('Should I add it?'))
        self.assertEqual(router.route("Don't add it")['do'], [])
        self.assertEqual(router.route("Don't check out")['do'], [])
        self.assertEqual(router.route('Add it in pink')['do'], [])
        self.assertEqual(router.route('Add it but not in black')['do'], [])
        self.assertEqual(router.route('Add it in size medium')['do'][:1], [
            {'verb': 'select_variant', 'args': {'value': 'M'}},
        ])
        self.assertIsNone(router.route('Is this black?'))


if __name__ == '__main__':
    unittest.main()
