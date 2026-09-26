import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import memory


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.db = tempfile.NamedTemporaryFile(suffix='.sqlite3')
        self.shopper = memory.ShopperMemory(self.db.name)

    def test_profile_and_history_survive_a_new_process(self):
        self.shopper.note('tab-1', 'I prefer medium, in black. These usually run small.', {'say': 'Medium, noted.'})
        self.shopper.note('tab-1', 'This coat is too expensive.', {'say': 'We can look for something less.'})
        again = memory.ShopperMemory(self.db.name)
        profile = again.profile()
        self.assertIn('M', profile['sizes'])
        self.assertIn('Black', profile['colors'])
        self.assertEqual(profile['price'], 'prefers lower prices')
        self.assertTrue(any('small' in note for note in profile['notes']))
        history = again.history('tab-1')
        self.assertEqual(history[0]['content'], 'I prefer medium, in black. These usually run small.')
        self.assertEqual(history[-1]['role'], 'assistant')
        self.assertEqual(again.history('other-tab'), [])


if __name__ == '__main__':
    unittest.main()
