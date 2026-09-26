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
        self.assertEqual(router.route('two')['do'], [{'verb': 'focus_number', 'args': {'n': 2}}])
        self.assertEqual(router.route("what's two")['do'], [{'verb': 'describe_number', 'args': {'n': 2}}])
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
