"""Three live conversation cases. They call the real model, so they skip without
XAI_API_KEY. Grading is mechanical: short, answers first, no assistant-speak,
uses what was said earlier, and never claims an action it did not propose."""
import os
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'server'))
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).resolve().parents[1] / '.env')
except ImportError:
    pass
import agent

ROBOTIC = re.compile(r"\b(sure thing|certainly|absolutely|great question|as an ai|"
                     r"i'd be happy|let me know if|how can i (?:help|assist)|feel free)\b", re.I)

SOUNDCORE = {"id": "a", "title": "Soundcore by Anker Q20i Headphones", "price": 44.99,
             "currency": "USD", "attrs": {"rating": 4.5, "reviews": 75000}}
SONY = {"id": "b", "title": "Sony WH-CH520 Wireless Headphones", "price": 44.99,
        "currency": "USD", "attrs": {"rating": 4.4, "reviews": 30000}}
AIRPODS = {"id": "c", "title": "Apple AirPods Pro 3", "price": 199.0, "currency": "USD",
           "attrs": {"rating": 4.7, "reviews": 9000}}
TOZO = {"id": "d", "title": "TOZO T6 Earbuds", "price": 29.99, "currency": "USD",
        "attrs": {"rating": 3.9, "reviews": 1200}}
PAGE = [AIRPODS, SOUNDCORE, TOZO, SONY]


def sentences(text):
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


@unittest.skipUnless(os.getenv("XAI_API_KEY"), "needs XAI_API_KEY")
class ConversationTests(unittest.TestCase):
    def reply(self, said, **ctx):
        out = agent.respond(said, {"visible": PAGE, "controls": ["Cart", "Sign in"], **ctx})
        say = out["say"] or ""
        self.assertTrue(say, "empty reply")
        self.assertLessEqual(len(sentences(say)), 2, say)
        self.assertNotRegex(say, ROBOTIC)
        return out, say

    def test_recommend_under_budget_names_one_and_why(self):
        """'Best one under a hundred' must pick a specific item, say its price or
        rating, and not read the whole page back."""
        out, say = self.reply(
            "Based on everything we've seen, recommend one under a hundred dollars that's highly rated.")
        self.assertRegex(say, r"Soundcore|Sony")
        self.assertNotIn("AirPods", say)
        self.assertLessEqual(len(say.split()), 22, say)
        self.assertNotRegex(say, r"thousand reviews|point five", "recited stats")
        self.assertRegex(say, r"forty|44|rated|star|review|love|battery|comfort|popular|people", "gave no reason")

    def test_add_it_stages_the_item_it_named(self):
        """'Add it' after a discussion acts on that item, names it, and never
        claims an action it did not propose or says it is already in the bag."""
        out, say = self.reply("Yes, that sounds good. Add it to my cart.",
                              focused=SOUNDCORE, previous=SOUNDCORE, bag=None)
        proposed = [a["verb"] for a in (out["do"] or []) + (out["ask"] or [])]
        self.assertIn("add_to_cart", proposed, say)
        self.assertRegex(say, r"Soundcore|Q20i")
        self.assertNotRegex(say, r"already in your (bag|cart)")
        self.assertNotRegex(say, r"look at")

    def test_thanks_gets_a_short_human_reply_and_no_page_narration(self):
        """Small talk is small: no page description, no offers of more help."""
        out, say = self.reply("Okay, thanks Cue.", focused=SONY)
        self.assertLessEqual(len(say.split()), 8, say)
        self.assertNotRegex(say, r"Sony|headphones|\$|dollars")
        self.assertEqual(out["do"], [])


if __name__ == "__main__":
    unittest.main()
