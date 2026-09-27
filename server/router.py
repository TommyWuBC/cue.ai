"""Fast path for a few exact commands. Everything else is the agent's job.

These are the phrases that must not wait on a model, or that the model is not
allowed to invent: yes and no during confirmation, checkout, and stopping Cue.
"""
import re

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
ORDINAL_REF = re.compile(
    r"(?:number |item |option )?(?:[1-9]|one|two|three|four|five|six|seven|eight|nine|first|second|"
    r"third|fourth|fifth|sixth|seventh|eighth|ninth|last)(?: one| item)?")
# Words that point back at something already chosen. Those need the agent.
DEICTIC = re.compile(r"^(?:it|this|that|here|there|this one|that one)$")


def action(verb, **args):
    return {"verb": verb, "args": args}


def _click(phrase):
    phrase = re.sub(r"^(?:on |the |my |up )+", "", phrase).strip()
    if not phrase or DEICTIC.match(phrase):
        return None
    # "the second one", "number three": which item that means is the agent's
    # call (focus_nth), now that nothing on screen is numbered.
    if ORDINAL_REF.fullmatch(phrase):
        return None
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
    lead = r"(?:hey cue )?(?:(?:please|can you|could you|cue|keep|start|just) )*"
    t = re.sub(r"\s+", " ", t)
    if not t:
        return None

    if t in {"end", "cue end", "stop cue", "pause cue"}:
        return result("Paused.", [action("stop_cue")])
    if t in {"no", "cancel", "cancel checkout", "cancel order"}:
        return result(actions=[action("cancel_checkout")])
    # Declining something that popped up. A bare "no" stays with cancel_checkout
    # above, which now falls through to dismissing an overlay when nothing was
    # actually waiting to be confirmed.
    if re.fullmatch(lead + r"(?:no thanks|no thank you|not now|not interested|maybe later|"
                    r"remind me later|close (?:that|it|this)(?: popup| dialog| window)?|"
                    r"get rid of (?:that|it|this)|dismiss (?:that|it|this)|"
                    r"(?:i )?don't (?:need|want) (?:it|that|the warranty|the protection plan)|"
                    r"no warranty|skip (?:that|it|this))(?: please)?", t):
        return result(actions=[action("dismiss")])
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
