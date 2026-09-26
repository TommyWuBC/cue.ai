"""Deterministic fast path. Anything matched here never touches the LLM,
so the commands that carry the demo feel instant (<50ms) and never hallucinate."""
import re

ORDINALS = {"first": 1, "one": 1, "1st": 1, "second": 2, "2nd": 2, "two": 2,
            "third": 3, "3rd": 3, "three": 3, "fourth": 4, "4th": 4, "four": 4}

RULES = [
    (r"\b(recalibrate|calibrate (again|my eyes)|fix (my )?gaze)\b",
     lambda m: {"say": "Let's recalibrate your gaze.", "do": [{"verb": "recalibrate", "args": {}}]}),
    (r"\b(scroll|go|move)\s+(down|up)\b",
     lambda m: {"say": None, "do": [{"verb": "scroll", "args": {"dir": m.group(2)}}]}),
    (r"\b(scroll|go)\s+(back|to the )?top\b",
     lambda m: {"say": None, "do": [{"verb": "scroll", "args": {"dir": "up"}}]}),
    (rf"\bthe\s+({'|'.join(ORDINALS)})\s+(one|item|jacket|product)\b",
     lambda m: {"say": None, "do": [{"verb": "focus_nth", "args": {"n": ORDINALS[m.group(1)]}}]}),
    (r"\b(add (it|that|this)( to (the )?(cart|bag|basket))?|add to (cart|bag))\b",
     lambda m: {"say": "Added.", "do": [{"verb": "add_to_cart", "args": {}}]}),
    (r"\b(check ?out|pay|place (the )?order)\b",
     lambda m: {"say": None, "do": [{"verb": "checkout", "args": {}}]}),
    (r"\b(stop|quiet|never ?mind|cancel)\b",
     lambda m: {"say": "Okay.", "do": []}),
]

COMPILED = [(re.compile(p, re.I), f) for p, f in RULES]


def route(text: str):
    """Return an action dict, or None to hand off to the LLM."""
    t = text.strip()
    for rx, fn in COMPILED:
        m = rx.search(t)
        if m:
            out = fn(m)
            out["source"] = "router"
            return out
    return None
