import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import agent


class AgentBoundaryTests(unittest.TestCase):
    def test_purchase_click_and_navigation_are_filtered(self):
        result = agent.sanitize({'say': 'Here is the answer', 'do': [
            {'verb': 'add_to_cart', 'args': {}},
            {'verb': 'checkout', 'args': {}},
            {'verb': 'click_focused', 'args': {}},
            {'verb': 'navigate', 'args': {'url': 'https://example.com'}},
        ]})
        self.assertEqual(result['do'], [])

    def test_only_valid_reversible_actions_survive(self):
        result = agent.sanitize({'say': 'Okay', 'do': [
            {'verb': 'scroll', 'args': {'dir': 'sideways'}},
            {'verb': 'focus_nth', 'args': {'n': True}},
            {'verb': 'select_variant', 'args': {'value': 'M'}},
            {'verb': 'select_color', 'args': {'value': 'Black'}},
        ]})
        self.assertEqual(result['do'], [{'verb': 'select_variant', 'args': {'value': 'M'}},
                                        {'verb': 'select_color', 'args': {'value': 'Black'}}])

    def test_page_evidence_is_bounded(self):
        product = {'id': 'j1', 'title': 'A' * 1000, 'price': 4,
                   'attrs': {'material': 'wool' * 1000},
                   'variants': ['M' * 500], 'colors': [{'name': 'Black' * 100}]}
        safe = agent._product(product)
        self.assertEqual(len(safe['title']), 180)
        self.assertEqual(len(safe['attrs']['material']), 180)
        self.assertEqual(len(safe['variants'][0]), 20)
        self.assertEqual(len(safe['colors'][0]), 30)


if __name__ == '__main__':
    unittest.main()
