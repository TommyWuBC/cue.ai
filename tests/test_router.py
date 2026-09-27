import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import router


class RouterTests(unittest.TestCase):
    def test_fast_path_is_only_the_exact_commands(self):
        self.assertEqual(router.route('yes')['do'][0]['verb'], 'approve_checkout')
        self.assertEqual(router.route('no')['do'][0]['verb'], 'cancel_checkout')
        self.assertEqual(router.route('check out')['do'][0]['verb'], 'checkout')
        self.assertEqual(router.route('end')['do'][0]['verb'], 'stop_cue')
        self.assertIsNone(router.route('two'))
        self.assertEqual(router.route('set up passkey')['do'][0]['verb'], 'setup_passkey')
        self.assertEqual(router.route('please recalibrate')['do'][0]['verb'], 'recalibrate')

    def test_everything_else_is_the_agents_job(self):
        for phrase in (
            'Is this wool?',
            'Add the second one in medium, in black',
            "Don't add it",
            'search for wool coats',
            'scroll to bottom',
            'go back',
            'find the second one',
        ):
            self.assertIsNone(router.route(phrase), phrase)


if __name__ == '__main__':
    unittest.main()

    def test_stop_scrolling_is_caught_however_it_is_asked(self):
        for phrase in ('stop scrolling', 'could you stop scrolling', 'hey cue please stop',
                       'cue stop scrolling please'):
            self.assertEqual(router.route(phrase)['do'], [{'verb': 'scroll_stop', 'args': {}}], phrase)

    def test_an_agreement_is_a_yes_however_it_is_said(self):
        for phrase in ('yes', 'yeah', 'yep', 'sure', 'go ahead', 'do it', 'okay', 'add it'):
            self.assertEqual(router.route(phrase)['do'], [{'verb': 'approve_checkout', 'args': {}}], phrase)
        self.assertIsNone(router.route('yeah but what about the other one'))
