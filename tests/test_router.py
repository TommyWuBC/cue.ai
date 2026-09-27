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
            'scroll to bottom',
            'go back',
            'find the second one',
            'find me the cheapest one',
            'click it',
            'type that',
            'how do I open the bag',
            'what does this button do',
        ):
            self.assertIsNone(router.route(phrase), phrase)

    def test_clicking_opening_and_selecting_by_name(self):
        click = lambda name: [{'verb': 'click_named', 'args': {'name': name}}]
        self.assertEqual(router.route('click the cart')['do'], click('cart'))
        self.assertEqual(router.route('Open my bag.')['do'], click('bag'))
        self.assertEqual(router.route('select medium')['do'], click('medium'))
        self.assertEqual(router.route('can you click on account and lists')['do'], click('account and lists'))
        # Nothing is numbered on screen: ordinals go to the agent, which has focus_nth.
        self.assertIsNone(router.route('open number three'))
        self.assertIsNone(router.route('select the second one'))
        # Money controls keep their own verbs, which are confirmed on the page.
        self.assertEqual(router.route('click add to cart')['do'][0]['verb'], 'add_to_cart')
        self.assertEqual(router.route('go to checkout')['do'][0]['verb'], 'checkout')

    def test_searching_types_into_the_search_bar(self):
        search = lambda q: [{'verb': 'search', 'args': {'query': q}}]
        self.assertEqual(router.route('find me desk tops')['do'], search('desk tops'))
        self.assertEqual(router.route('search for wool coats')['do'], search('wool coats'))
        self.assertEqual(router.route('Search Amazon for gaming laptops.')['do'], search('gaming laptops'))
        self.assertEqual(router.route('i want to buy a standing desk')['do'], search('standing desk'))
        self.assertEqual(router.route('find shipping info on this page')['do'],
                         [{'verb': 'find_on_page', 'args': {'text': 'shipping info'}}])

    def test_typing_keeps_case_and_can_press_enter(self):
        self.assertEqual(router.route('Type John@Example.com into the email field.')['do'],
                         [{'verb': 'fill', 'args': {'field': 'email', 'text': 'John@Example.com'}}])
        self.assertEqual(router.route('Type desk top, and press enter.')['do'],
                         [{'verb': 'fill', 'args': {'field': '', 'text': 'desk top'}}, {'verb': 'submit', 'args': {}}])
        self.assertEqual(router.route('press enter')['do'], [{'verb': 'submit', 'args': {}}])


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

    def test_declining_a_popup_dismisses_it_and_a_bare_no_still_cancels(self):
        for phrase in ('no thanks', "i don't need the warranty", 'not interested',
                       'close that popup', 'hey cue please get rid of that'):
            self.assertEqual(router.route(phrase)['do'], [{'verb': 'dismiss', 'args': {}}], phrase)
        # A plain no during a staged confirmation must stay a cancellation.
        for phrase in ('no', 'cancel', 'cancel checkout'):
            self.assertEqual(router.route(phrase)['do'], [{'verb': 'cancel_checkout', 'args': {}}], phrase)

    def test_stop_stops_the_scroll_and_quit_quits(self):
        """Saying "stop" to a runaway scroll used to shut Cue down entirely —
        the one command a voice user cannot undo by repeating it."""
        for phrase in ('stop', 'stop scrolling', 'cue stop please', "that's enough"):
            self.assertEqual(router.route(phrase)['do'], [{'verb': 'scroll_stop', 'args': {}}], phrase)
        for phrase in ('quit', 'exit', 'stop cue', 'quit cue', 'end'):
            self.assertEqual(router.route(phrase)['do'], [{'verb': 'stop_cue', 'args': {}}], phrase)
