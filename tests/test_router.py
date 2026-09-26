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


if __name__ == '__main__':
    unittest.main()
