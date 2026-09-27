"""Fast path for a few exact commands. Everything else is the agent's job.

These are the phrases that must not wait on a model, or that the model is not
allowed to invent: yes and no during confirmation, checkout, stopping Cue, and
the number on screen.
"""
import re

ORDINALS = {"first": 1, "one": 1, "1st": 1, "second": 2, "2nd": 2, "two": 2,
            "third": 3, "3rd": 3, "three": 3, "fourth": 4, "4th": 4, "four": 4,
            "fifth": 5, "5th": 5, "five": 5, "sixth": 6, "6th": 6, "six": 6,
            "seventh": 7, "7th": 7, "seven": 7, "eighth": 8, "8th": 8, "eight": 8,
            "ate": 8, "ninth": 9, "9th": 9, "nine": 9}


CLICK_RE = re.compile(
    r"(?:please |can you |could you )?(?:click(?: on)?|tap(?: on)?|press|hit|open(?: up)?|select|choose|"
    r"go to|take me to|visit) (.{1,60}?)(?: button| link| tab| page| menu| option)?(?: please)?")
SEARCH_RE = re.compile(
    r"(?:please |can you |could you )?(?:search(?: amazon| the site| the store)?(?: for)?|find me|"
    r"look for|look up|shop for|i(?:'m| am) looking for|i want to buy) (.{2,80}?)"
    r"(?: on amazon| on here| on this site| please)?")
FIND_ON_PAGE_RE = re.compile(r"(?:please )?find (.{2,80}?) on (?:this|the) page")
TYPE_RE = re.compile(
    r"(?:please )?(?:type|write|input|enter|fill in) (?:in )?(.{1,200}?)"
    r"(?: (?:in|into|on) (?:the )?(.{1,60}?)(?: field| box| bar| input)?)?"
    r"( and (?:press enter|hit enter|press return|search|submit|go|enter))?", re.I)
SUBMIT = {"press enter", "hit enter", "enter", "submit", "submit it", "search it", "press return",
          "hit return", "go"}
# Words that point back at something already chosen. Those need the agent.
DEICTIC = re.compile(r"^(?:it|this|that|here|there|this one|that one)$")


def action(verb, **args):
    return {"verb": verb, "args": args}


def _number(word):
    n = int(word) if word.isdigit() else ORDINALS.get(word)
    return n if n and 1 <= n <= 9 else None


def _click(phrase):
    phrase = re.sub(r"^(?:on |the |my |up )+", "", phrase).strip()
    if not phrase or DEICTIC.match(phrase):
        return None
    numbered = re.fullmatch(r"(?:number |item |option )?([a-z0-9]+)(?: one)?", phrase)
    if numbered and _number(numbered.group(1)):
        return result(actions=[action("focus_number", n=_number(numbered.group(1)))])
    # Adding and checking out have their own read-back; a click must not skip it.
    if re.fullmatch(r"add to (?:my |the )?(?:cart|bag|basket)", phrase):
        return result(actions=[action("add_to_cart")])
    if re.fullmatch(r"(?:proceed to )?check ?out", phrase):
        return result(actions=[action("checkout")])
    if phrase in {"top", "bottom"}:
        return result(actions=[action("scroll", dir=phrase)])
    return result(actions=[action("click_named", name=phrase)])


def _search(query):
    query = re.sub(r"^(?:some |a |an )", "", query).strip()
    # "find me the one I looked at" is about this page, not a new search.
    if not query or re.match(r"(?:the|it|this|that|one)\b", query) or \
            re.search(r"\b(?:this|that|it|number)\b", query):
        return None
    return result(actions=[action("search", query=query)])


def _type(text, field, submit):
    text = text.strip().strip("\"'")
    if not text or DEICTIC.match(text) or re.match(r"(?:my|your|the) ", text):
        return None
    actions = [action("fill", field=(field or "").strip(), text=text)]
    if submit:
        actions.append(action("submit"))
    return result(actions=actions)


def result(say=None, actions=None):
    return {"say": say, "do": actions or [], "source": "router"}


def route(text: str):
    t = re.sub(r"[,.!?]+", " ", text.lower()).strip()
    t = re.sub(r"\s+", " ", t)
    if not t:
        return None

    if t in {"end", "cue end", "stop cue", "pause cue"}:
        return result("Paused.", [action("stop_cue")])
    if t in {"no", "cancel", "cancel checkout", "cancel order"}:
        return result(actions=[action("cancel_checkout")])
    if t in {"yes", "yes approve", "approve", "confirm", "approve the order", "confirm the order",
             "approve checkout", "confirm checkout"}:
        return result(actions=[action("approve_checkout")])
    if re.fullmatch(r"(?:please |can you |could you |i want to )?(?:check ?out|pay|place (?:the )?order)(?: now)?", t):
        return result(actions=[action("checkout")])
    if re.fullmatch(r"(?:set up|create|register) (?:a |my )?passkey", t):
        return result(actions=[action("setup_passkey")])
    if re.fullmatch(r"(?:please )?(?:recalibrate|calibrate again|calibrate my eyes|fix my gaze|fix gaze)", t):
        return result("Let's recalibrate your gaze.", [action("recalibrate")])

    asked = re.fullmatch(r"what(?:'s|s| is) (?:number )?([a-z0-9]+)\??", t)
    if asked:
        word = asked.group(1)
        n = int(word) if word.isdigit() else ORDINALS.get(word)
        if n and 1 <= n <= 9:
            return result(actions=[action("describe_number", n=n)])

    # "add number three to cart": the badge they said outranks where their eyes are.
    added = re.fullmatch(r"(?:please |can you |could you )?add (?:number|item|option) ([a-z0-9]+)"
                         r"(?: to (?:my |the )?(?:bag|cart|basket))?", t)
    if added:
        word = added.group(1)
        n = int(word) if word.isdigit() else ORDINALS.get(word)
        if n and 1 <= n <= 9:
            return result(actions=[action("focus_number", n=n), action("add_to_cart")])

    bare = re.fullmatch(r"(?:number )?([a-z0-9]+)\.?", t)
    if bare and bare.group(1).isdigit() and 1 <= int(bare.group(1)) <= 9:
        return result(actions=[action("focus_number", n=int(bare.group(1)))])
    if bare and bare.group(1) in ORDINALS:
        return result(actions=[action("focus_number", n=ORDINALS[bare.group(1)])])

    # Doing things to the page. Each pattern is anchored on its verb, so a
    # question ("what does this button do") never reaches them.
    if t in SUBMIT:
        return result(actions=[action("submit")])
    found = FIND_ON_PAGE_RE.fullmatch(t)
    if found:
        return result(actions=[action("find_on_page", text=found.group(1))])
    # Typed text keeps its case and punctuation ("john@example.com").
    raw = re.sub(r"\s+", " ", text.replace(",", " ")).strip().rstrip(".!?")
    typed = TYPE_RE.fullmatch(raw)
    if typed:
        return _type(typed.group(1), typed.group(2), typed.group(3))
    searched = SEARCH_RE.fullmatch(t)
    if searched:
        return _search(searched.group(1))
    clicked = CLICK_RE.fullmatch(t)
    if clicked:
        return _click(clicked.group(1))
    return None
