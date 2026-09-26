"""Deterministic fast path. Anything matched here never touches the LLM,
so the commands that carry the demo feel instant (<50ms) and never hallucinate.

Order matters: the compound rules have to be tried before the single-verb ones
they contain, or "add the second one in medium" degrades into just a focus.
"""
import re

ORDINALS = {
    "first": 1, "1st": 1, "one": 1,
    "second": 2, "2nd": 2, "two": 2, "to": 2, "too": 2,   # STT hears these for "two"
    "third": 3, "3rd": 3, "three": 3,
    "fourth": 4, "4th": 4, "four": 4, "for": 4,
    "fifth": 5, "5th": 5, "five": 5,
    "sixth": 6, "6th": 6, "six": 6,
    # Up to 9, because at poor calibration every visible item gets a badge.
    "seventh": 7, "7th": 7, "seven": 7,
    "eighth": 8, "8th": 8, "eight": 8, "ate": 8,   # STT hears "ate" for "eight"
    "ninth": 9, "9th": 9, "nine": 9,
}
ORD = "|".join(ORDINALS)

SIZES = {
    "xs": "XS", "extra small": "XS",
    "s": "S", "small": "S",
    "m": "M", "medium": "M", "med": "M",
    "l": "L", "large": "L",
    "xl": "XL", "extra large": "XL",
}
SIZE = "|".join(sorted(SIZES, key=len, reverse=True))   # longest first: "extra small" before "s"

NOUN = r"(?:one|item|jacket|coat|product|thing)"


def _nth(m, key="n"):
    return ORDINALS[m.group(key).lower()]


def _num(m, key="n"):
    """Accepts either a digit or an ordinal word."""
    v = m.group(key).lower()
    return int(v) if v.isdigit() else ORDINALS[v]


def _size(m, key="sz"):
    return SIZES[m.group(key).lower()]


RULES = [
    # ── Compound: pick, size and add in one breath ──────────────────────────
    (rf"\badd\s+(?:the\s+)?(?P<n>{ORD})\s+{NOUN}\s+in\s+(?P<sz>{SIZE})\b",
     lambda m: {"say": None, "do": [
         {"verb": "focus_nth", "args": {"n": _nth(m)}},
         {"verb": "select_variant", "args": {"value": _size(m)}},
         {"verb": "add_to_cart", "args": {}},
     ]}),
    (rf"\badd\s+(?:the\s+)?(?P<n>{ORD})\s+{NOUN}\b",
     lambda m: {"say": None, "do": [
         {"verb": "focus_nth", "args": {"n": _nth(m)}},
         {"verb": "add_to_cart", "args": {}},
     ]}),
    (rf"\b(?P<sz>{SIZE})\s*,?\s*(?:in\s+\w+\s*,?\s*)?add (?:it|that|this)\b",
     lambda m: {"say": None, "do": [
         {"verb": "select_variant", "args": {"value": _size(m)}},
         {"verb": "add_to_cart", "args": {}},
     ]}),

    # ── Confirmation. Nothing spends money without one of these. ────────────
    (r"\b(yes|yeah|yep|yup|correct|confirm|approve|approved|go ahead|do it|that's right)\b",
     lambda m: {"say": None, "do": [{"verb": "confirm", "args": {}}]}),
    (r"\b(no|nope|cancel|don't|do not|never ?mind|stop|wait|abort)\b",
     lambda m: {"say": None, "do": [{"verb": "cancel", "args": {}}]}),

    # ── Navigation ──────────────────────────────────────────────────────────
    (r"\b(scroll|go|move)\s+(?:back\s+)?(?:to\s+the\s+)?top\b",
     lambda m: {"say": None, "do": [{"verb": "scroll", "args": {"dir": "up"}}]}),
    (r"\b(scroll|go|move)\s+(down|up)\b",
     lambda m: {"say": None, "do": [{"verb": "scroll", "args": {"dir": m.group(2)}}]}),

    # ── Recalibration ───────────────────────────────────────────────────────
    (r"\b(re-?calibrate|calibrate again|fix (?:the )?(?:tracking|calibration)|"
     r"you(?:'re| are) off|re-?do (?:the )?calibration)\b",
     lambda m: {"say": None, "do": [{"verb": "recalibrate", "args": {}}]}),

    # ── Selection ───────────────────────────────────────────────────────────
    # A bare number picks one of the on-screen badges. This is the primary way
    # to select an item when gaze is too coarse to point (measured 242px error
    # against 249px Amazon tiles), so it has to be as terse as possible.
    (rf"^\s*(?:number\s+)?(?P<n>{ORD}|\d)\s*[.!]?\s*$",
     lambda m: {"say": None, "do": [{"verb": "focus_number", "args": {"n": _num(m)}}]}),
    (rf"\b(?:pick|take|select|choose|number)\s+(?P<n>{ORD}|\d)\b",
     lambda m: {"say": None, "do": [{"verb": "focus_number", "args": {"n": _num(m)}}]}),
    (rf"\b(?:the\s+)?(?P<n>{ORD})\s+{NOUN}\b",
     lambda m: {"say": None, "do": [{"verb": "focus_nth", "args": {"n": _nth(m)}}]}),
    (rf"\b(?:size\s+)?(?P<sz>{SIZE})\s+please\b|\bin\s+(?P<sz2>{SIZE})\b|\bsize\s+(?P<sz3>{SIZE})\b",
     lambda m: {"say": None, "do": [{"verb": "select_variant", "args": {
         "value": SIZES[(m.group("sz") or m.group("sz2") or m.group("sz3")).lower()]}}]}),

    # ── Cart ────────────────────────────────────────────────────────────────
    (r"\b(add (?:it|that|this)(?: to (?:the )?(?:cart|bag|basket))?|add to (?:cart|bag|basket))\b",
     lambda m: {"say": None, "do": [{"verb": "add_to_cart", "args": {}}]}),
    (r"\b(check ?out|pay|place (?:the )?order|buy (?:it|this|that))\b",
     lambda m: {"say": None, "do": [{"verb": "checkout", "args": {}}]}),

    (r"\b(quiet|shush|be quiet)\b",
     lambda m: {"say": "Okay.", "do": []}),
]

COMPILED = [(re.compile(p, re.I), f) for p, f in RULES]

# A question that happens to name an item is still a question. Without this,
# "how is this different from the second one" matched the ordinal rule and was
# silently executed as a selection — the user asked something and got silence.
# "can/could/would you..." are polite commands, not information requests, so
# they are deliberately absent.
QUESTION = re.compile(
    r"^\s*(is|are|was|were|does|do|did|has|have|how|what|why|which|who|whose|where|when|"
    r"tell me|compare|any|anything)\b", re.I)

# ...unless it is one of these, which must work no matter how they are phrased.
ALWAYS = re.compile(r"\b(yes|yeah|yep|no|nope|cancel|stop|never ?mind|check ?out|scroll)\b", re.I)


def route(text: str):
    """Return an action dict, or None to hand off to the LLM."""
    t = text.strip()
    if QUESTION.match(t) and not ALWAYS.search(t):
        return None
    for rx, fn in COMPILED:
        m = rx.search(t)
        if m:
            out = fn(m)
            out["source"] = "router"
            return out
    return None
