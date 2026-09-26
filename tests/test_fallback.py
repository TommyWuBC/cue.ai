import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import fallback


class FallbackTests(unittest.TestCase):
    def test_partial_product_never_invents_missing_fields(self):
        context = {'focused': {'id': 'outside-1', 'title': 'Unknown coat'},
                   'visible': [{'id': 'outside-1', 'title': 'Unknown coat'},
                               {'id': 'outside-2', 'title': 'Another coat', 'price': 80}]}
        self.assertIn("can't see a price", fallback.answer('How much?', context)['say'])
        self.assertIn("can't see material", fallback.answer('Is this wool?', context)['say'])
        self.assertIn('Compared with', fallback.answer('Compare these', context)['say'])
        self.assertNotIn('None', fallback.answer('Compare these', context)['say'])

    def test_comparison_uses_previous_product_even_when_off_screen(self):
        ctx = {'focused': {'id': 'new', 'title': 'New coat', 'price': 90, 'currency': 'EUR'},
               'previous': {'id': 'old', 'title': 'Previous coat', 'price': 120},
               'visible': [{'id': 'random', 'title': 'Unrelated product', 'price': 1}]}
        result = fallback.answer("How is this different from the last one?", ctx)
        self.assertIn('Previous coat', result['say'])
        self.assertIn('€90', result['say'])
        self.assertNotIn('Unrelated', result['say'])
        self.assertEqual(result['do'], [])
        del ctx['previous']
        self.assertIn("don't have a previous product", fallback.answer('Compare with the last one', ctx)['say'])

    def test_local_product_answer_remains_grounded(self):
        product = {'id': 'j1', 'title': 'Wool coat', 'price': 129,
                   'attrs': {'material': '62% wool, 38% polyester', 'warmth': 'Heavy'}}
        self.assertEqual(fallback.answer('Is this wool?', {'focused': product})['say'],
                         'Wool coat: 62% wool, 38% polyester.')


if __name__ == '__main__':
    unittest.main()
