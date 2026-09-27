"""Fast path for a few exact commands. Everything else is the agent's job.

These are the phrases that must not wait on a model, or that the model is not
allowed to invent: yes and no during confirmation, checkout, and stopping Cue.
"""
import re

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
    # "yeah" is a yes. It used to fall through to the model, which re-narrated
    # "Adding it" and performed nothing, leaving a staged add hanging forever.
    if re.fullmatch(r"(?:yes|yeah|yep|yup|yes please|sure|okay|ok|go ahead|do it|please do|"
                    r"that's right|thats right|correct|approve|confirm|add it|"
                    r"(?:yes |please )?(?:approve|confirm)(?: the)?(?: order| checkout)?)\.?", t):
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
    if re.fullmatch(lead + r"(?:stop|stop scrolling|stop scroll|stop the scroll|"
                    r"stop moving|that's enough|thats enough)(?: please)?", t):
        return result(actions=[action("scroll_stop")])
    if re.fullmatch(r"(?:hey cue )?(?:(?:please|can you|could you|cue) )*(?:scroll|go) to the (top|bottom)", t):
        return result(actions=[action("scroll", dir=re.search(r"top|bottom", t).group(0))])

    return None
