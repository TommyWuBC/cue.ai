"""Conservative fast path for explicit shopping and browser commands.

Questions and negated commands fall through without side effects. The client
still validates every target and option before acting.
"""
import json
import re
from pathlib import Path

ORDINALS = {"first": 1, "one": 1, "1st": 1, "second": 2, "2nd": 2, "two": 2,
            "third": 3, "3rd": 3, "three": 3, "fourth": 4, "4th": 4, "four": 4,
            "fifth": 5, "5th": 5, "five": 5, "sixth": 6, "6th": 6, "six": 6,
            "seventh": 7, "7th": 7, "seven": 7, "eighth": 8, "8th": 8, "eight": 8,
            "ate": 8,  # what STT reliably hears for "eight"
            "ninth": 9, "9th": 9, "nine": 9}
SIZES = {"extra small": "XS", "xs": "XS", "small": "S", "s": "S", "medium": "M", "m": "M",
         "large": "L", "l": "L", "extra large": "XL", "xl": "XL", "xxl": "XXL"}
COLORS = {color["name"].lower()
          for product in json.loads((Path(__file__).resolve().parent.parent / "store/products.json").read_text())
          for color in product["colors"]}
SIZE_RE = re.compile(r"\b(" + "|".join(re.escape(s) for s in sorted(SIZES, key=len, reverse=True)) + r")\b")
COLOR_RE = re.compile(r"\b(" + "|".join(sorted(COLORS, key=len, reverse=True)) + r")\b")
ORDINAL_RE = re.compile(r"\b(?:the )?(" + "|".join(ORDINALS) + r") (?:one|item|jacket|coat|sweater|product)\b")


def action(verb, **args):
    return {"verb": verb, "args": args}


def result(say=None, actions=None):
    return {"say": say, "do": actions or [], "source": "router"}


def route(text: str):
    t = re.sub(r"[,.!?]+", " ", text.lower()).strip()
    t = re.sub(r"\s+", " ", t)
    if not t:
        return None

    if re.search(r"\b(?:don't|do not|never)\s+(?:add|check ?out|pay|place|approve|confirm|click)\b", t):
        return result("Okay, I won't do that.")
    if t in {"stop", "quiet", "never mind", "cancel"}:
        return result("Okay.")
    if t in {"no", "cancel checkout", "cancel order"}:
        return result("Okay, checkout cancelled.", [action("cancel_checkout")])
    if t in {"yes", "yes approve", "approve", "confirm", "approve the order", "confirm the order",
             "approve checkout", "confirm checkout"}:
        return result(actions=[action("approve_checkout")])
    if re.fullmatch(r"(?:set up|create|register) (?:a |my )?passkey", t):
        return result(actions=[action("setup_passkey")])
    if re.fullmatch(r"(?:please )?(?:recalibrate|calibrate again|calibrate my eyes|fix my gaze|fix gaze)", t):
        return result("Let's recalibrate your gaze.", [action("recalibrate")])
    if re.fullmatch(r"(?:please |can you |could you |i want to )?(?:check ?out|pay|place (?:the )?order)(?: now)?", t):
        return result(actions=[action("checkout")])
    if re.fullmatch(r"(?:please )?(?:scroll|go|move|page) (?:down|up|left|right)", t):
        direction = t.split()[-1]
        return result(actions=[action("scroll", dir=direction)])
    if re.fullmatch(r"(?:please )?(?:scroll|go) (?:back (?:to )?|to (?:the )?)?top", t):
        return result(actions=[action("scroll", dir="top")])
    if re.fullmatch(r"(?:please )?(?:scroll|go) (?:to (?:the )?)?bottom", t):
        return result(actions=[action("scroll", dir="bottom")])
    if t in {"go back", "back", "previous page"}:
        return result(actions=[action("history", dir="back")])
    if t in {"go forward", "forward", "next page"}:
        return result(actions=[action("history", dir="forward")])

    # A bare number names one of the numbered badges on screen. Gaze is too
    # coarse to point at our measured error, so numbering the items and saying
    # one is the primary way to select. A lone number is never a question,
    # which is why this sits above the question guard.
    bare = re.fullmatch(r"(?:number )?([a-z0-9]+)\.?", t)
    if bare and bare.group(1).isdigit() and 1 <= int(bare.group(1)) <= 9:
        return result(actions=[action("focus_number", n=int(bare.group(1)))])
    if bare and bare.group(1) in ORDINALS:
        return result(actions=[action("focus_number", n=ORDINALS[bare.group(1)])])
    picked = re.fullmatch(r"(?:please )?(?:pick|take|select|choose|number) ([a-z0-9]+)", t)
    if picked:
        word = picked.group(1)
        if word.isdigit() and 1 <= int(word) <= 9:
            return result(actions=[action("focus_number", n=int(word))])
        if word in ORDINALS:
            return result(actions=[action("focus_number", n=ORDINALS[word])])

    # Do not turn a question about an item into a cart action.
    if re.match(r"^(?:is|are|should|would|what|why|how|do|does|will)\b", t):
        return None

    add = bool(re.match(r"^(?:(?:please|can you|could you|i want to) )?add\b", t) or
               re.fullmatch(r"(?:size )?(?:extra small|small|medium|large|extra large|xs|s|m|l|xl|xxl)(?: in \w+)? add (?:it|this|that)", t))
    ordinal = ORDINAL_RE.search(t)
    size = SIZE_RE.search(t)
    color = COLOR_RE.search(t)

    # A requested but unknown option must not silently fall back to a previous
    # selection. The same is true of a size that this specific item lacks;
    # the client will stop the action sequence in that case.
    if add:
        if re.search(r"\b(?:not|without|except)\b", t):
            return result("Please say the size and color you want directly.")
        requested = re.findall(r"\bin ([a-z]+)\b", t)
        unknown = [word for word in requested if word not in COLORS and word not in SIZES and word != "size"]
        if unknown:
            return result(f"I don't see {unknown[0]} as an option. Please choose an available size or color.")
        actions = []
        if ordinal:
            actions.append(action("focus_nth", n=ORDINALS[ordinal.group(1)]))
        if size:
            actions.append(action("select_variant", value=SIZES[size.group(1)]))
        if color:
            actions.append(action("select_color", value=color.group(1).title()))
        actions.append(action("add_to_cart"))
        return result(actions=actions)

    if ordinal and re.fullmatch(r"(?:the )?(?:first|one|1st|second|2nd|two|third|3rd|three|fourth|4th|four) (?:one|item|jacket|coat|sweater|product)", t):
        return result(actions=[action("focus_nth", n=ORDINALS[ordinal.group(1)])])
    if size or color:
        parts = []
        if size:
            parts.append(action("select_variant", value=SIZES[size.group(1)]))
        if color:
            parts.append(action("select_color", value=color.group(1).title()))
        stripped = t
        if size:
            stripped = stripped.replace(size.group(1), "", 1)
        if color:
            stripped = stripped.replace(color.group(1), "", 1)
        stripped = re.sub(r"\b(size|in|please|the|color|colour|and|choose|select|make|it)\b", "", stripped).strip()
        if not stripped:
            return result(actions=parts)
    if re.fullmatch(r"(?:please )?(?:click|open|press|select) (?:this|that|it|the focused button)", t):
        return result(actions=[action("click_focused")])
    return None
