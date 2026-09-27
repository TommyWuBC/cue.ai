import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
import agent


class AgentBoundaryTests(unittest.TestCase):
    def test_the_agent_may_shop_but_may_never_commit(self):
        """Cue is allowed to shop. Only the human is allowed to commit.

        Adding is announced and reversible; checkout only stages an order and
        reads it back, charging nothing. What the model must never reach is the
        moment of commitment — the spoken yes and the passkey — because that
        confirmation is the entire trust argument.
        """
        result = agent.sanitize({'say': 'Adding that', 'do': [
            {'verb': 'add_to_cart', 'args': {}},
            {'verb': 'checkout', 'args': {}},
        ]})
        self.assertEqual(result['do'], [{'verb': 'add_to_cart', 'args': {}},
                                        {'verb': 'checkout', 'args': {}}])

    def test_commitment_never_comes_from_the_model(self):
        result = agent.sanitize({'say': 'Approved', 'do': [
            {'verb': 'confirm', 'args': {}},
            {'verb': 'approve_checkout', 'args': {}},
            {'verb': 'setup_passkey', 'args': {}},
        ]})
        self.assertEqual(result['do'], [])

    def test_ambiguous_click_and_raw_navigation_are_filtered(self):
        # click_focused is whatever gaze happens to be on, which at our measured
        # error is a coin flip; navigate is a raw URL. The agent gets the named
        # controls instead.
        result = agent.sanitize({'say': 'Here is the answer', 'do': [
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

    def test_the_agent_can_type_and_press_enter(self):
        result = agent.sanitize({'say': 'Searching', 'do': [
            {'verb': 'fill', 'args': {'field': '', 'text': 'desk top'}},
            {'verb': 'submit', 'args': {}},
            {'verb': 'focus_number', 'args': {'n': 3}},
        ]})
        # focus_number went with the numbered badges; the model may not propose it.
        self.assertEqual(result['do'], [{'verb': 'fill', 'args': {'field': '', 'text': 'desk top'}},
                                        {'verb': 'submit', 'args': {}}])

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


def test_open_link_is_allowed_and_bounded():
    out = agent.sanitize({"say": "Opening it.", "do": [
        {"verb": "open_link", "args": {"target": 8, "part": "reviews"}},
        {"verb": "open_link", "args": {"target": "it", "part": "javascript:alert(1)"}},
    ]})
    assert out["do"] == [{"verb": "open_link", "args": {"target": "8", "part": "reviews"}}]


def test_client_conversation_replaces_server_history_and_drops_current_turn():
    ctx = {"convo": [{"role": "user", "content": "number eight"},
                     {"role": "assistant", "content": "The Soundcore Q20i."},
                     {"role": "user", "content": "how is the battery"}]}
    turns = agent._convo(ctx, "how is the battery", [{"role": "user", "content": "stale"}])
    assert [t["content"] for t in turns] == ["number eight", "The Soundcore Q20i."]


def test_page_brief_survives_untrusted_input():
    page = agent._page({"kind": "product", "title": "Razer BlackShark V3", "url": "https://www.amazon.com/dp/B0X",
                        "text": "x" * 4000, "product": {"title": "Razer BlackShark V3", "price": "$149.99",
                                                        "rating": "4.4 from 900 reviews"}})
    assert page["kind"] == "product"
    assert len(page["text"]) <= 6000
    assert page["product"]["price"] == "$149.99"
    assert agent._page({"kind": "evil"})["kind"] == "page"
    assert agent._page(None) is None


def test_agent_may_start_and_stop_a_scroll():
    out = agent.sanitize({"say": "Stopping.", "do": [{"verb": "scroll_stop", "args": {}}]})
    assert out["do"] == [{"verb": "scroll_stop", "args": {}}]
    out = agent.sanitize({"say": "Scrolling.", "do": [
        {"verb": "scroll_start", "args": {"dir": "down", "speed": "fast"}},
        {"verb": "scroll_start", "args": {"dir": "sideways"}}]})
    assert out["do"] == [{"verb": "scroll_start", "args": {"dir": "down", "speed": "fast"}}]


def test_whole_page_reaches_the_model_including_items_below_the_fold():
    page = agent._page({"kind": "cart", "title": "Amazon.com Shopping Cart", "text": "cart",
                        "products": [{"title": "Dawn dish soap", "price": 4.5, "onScreen": True},
                                     {"title": "Banana Boat Sport SPF 50", "onScreen": False},
                                     {"bad": "row"}]})
    assert page["kind"] == "cart"
    assert [p["title"] for p in page["products"]] == ["Dawn dish soap", "Banana Boat Sport SPF 50"]
    assert page["products"][1]["onScreen"] is False
