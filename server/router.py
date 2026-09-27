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


def action(verb, **args):
    return {"verb": verb, "args": args}


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

    lead = r"(?:hey cue )?(?:(?:please|can you|could you|cue|keep|start|just) )*"
    # "a bit", "a little", "once", "one page" is a single step; everything else
    # keeps scrolling slowly until they say stop.
    step = re.fullmatch(lead + r"scroll (up|down) (?:a (?:bit|little)|once|one (?:page|screen)|a page|a screen)(?: please)?", t)
    if step:
        return result(actions=[action("scroll", dir=step.group(1))])
    scroll = re.fullmatch(lead + r"(?:scroll|scrolling|go|move) (up|down)"
                          r"(?: (?:slowly|slow|fast|faster|quickly|more|again|please|the page|for me))*"
                          r"(?: (?:so i can|to) see.*)?", t)
    if scroll:
        speed = "fast" if re.search(r"\b(?:fast|faster|quickly)\b", t) else \
                "slow" if re.search(r"\bslow(?:ly)?\b", t) else None
        args = {"dir": scroll.group(1), **({"speed": speed} if speed else {})}
        return result(actions=[action("scroll_start", **args)])
    if re.fullmatch(r"(?:please )?(?:stop scrolling|stop scroll|stop the scroll)", t):
        return result(actions=[action("scroll_stop")])
    if re.fullmatch(r"(?:hey cue )?(?:(?:please|can you|could you|cue) )*(?:scroll|go) to the (top|bottom)", t):
        return result(actions=[action("scroll", dir=re.search(r"top|bottom", t).group(0))])

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
    return None
