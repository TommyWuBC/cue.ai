import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import fallback
import agent

COAT = {'id': 'j1', 'title': 'Wool Coat', 'price': 129, 'attrs': {'material': '62% wool'}}
PUFFER = {'id': 'j2', 'title': 'Puffer Jacket', 'price': 79.99, 'attrs': {'material': 'recycled polyester'}}
DENIM = {'id': 'j3', 'title': 'Denim Jacket', 'price': 44.99}


def ctx(attention, focused=None, discussed=None):
    return {'focused': focused, 'discussed': discussed, 'visible': [COAT, PUFFER, DENIM], 'attention': attention}


class FallbackAttentionTests(unittest.TestCase):
    def test_compare_them_uses_the_two_items_the_eyes_went_between(self):
        att = {'recent': [{'id': 'j2', 'share': 0.48}, {'id': 'j3', 'share': 0.41}, {'id': 'j1', 'share': 0.11}]}
        say = fallback.answer('compare them', ctx(att, focused=COAT))['say']
        self.assertIn('Puffer Jacket', say)
        self.assertIn('Denim Jacket', say)
        self.assertNotIn('Wool Coat', say)

    def test_this_with_two_close_candidates_asks_by_name(self):
        att = {'at_speech': [{'id': 'j1', 'share': 0.46}, {'id': 'j2', 'share': 0.39}]}
        say = fallback.answer('is this warm?', ctx(att))['say']
        self.assertEqual(say, 'The Wool Coat or the Puffer Jacket?')

    def test_this_with_a_clear_leader_just_answers(self):
        att = {'at_speech': [{'id': 'j1', 'share': 0.81}, {'id': 'j2', 'share': 0.12}]}
        self.assertIn('wool', fallback.answer('is this wool?', ctx(att))['say'].lower())

    def test_something_already_named_beats_the_eyes(self):
        att = {'at_speech': [{'id': 'j1', 'share': 0.5}, {'id': 'j2', 'share': 0.45}]}
        say = fallback.answer('is this wool?', ctx(att, focused=PUFFER, discussed={'id': 'j2', 'title': 'Puffer Jacket'}))['say']
        self.assertNotIn(' or the ', say)

    def test_the_one_i_was_looking_at_means_what_was_studied(self):
        att = {'studied': [{'id': 'j3', 'share': 0.7}], 'now': [{'id': 'j1', 'share': 0.9}]}
        say = fallback.answer('how much was the one I was looking at', ctx(att, focused=COAT))['say']
        self.assertIn('Denim Jacket', say)

    def test_no_attention_changes_nothing(self):
        self.assertIn('Wool Coat', fallback.answer('how much is it', ctx(None, focused=COAT))['say'])


class AgentAttentionTests(unittest.TestCase):
    def test_attention_is_bounded_and_typed(self):
        out = agent._attention({
            'now': [{'title': 'x' * 500, 'share': 7}, {'title': 42, 'share': 0.3}, {'title': 'ok', 'share': 'high'}],
            'session': [{'title': 'Coat', 'seconds': 10 ** 9}],
            'at_speech': [{'title': 'Coat', 'share': 0.66}],
        })
        self.assertEqual(len(out['now']), 1)
        self.assertLessEqual(len(out['now'][0]['title']), 60)
        self.assertEqual(out['now'][0]['share'], 1.0)
        self.assertEqual(out['session_seconds'][0]['seconds'], 3600.0)
        self.assertEqual(out['when_they_started_speaking'][0]['share'], 0.66)
        self.assertIsNone(agent._attention('nope'))
        self.assertIsNone(agent._attention({'now': []}))


if __name__ == '__main__':
    unittest.main()
