"""Gaze must never make Cue worse than talking alone. This checks it.

Runs the same spoken scenarios against the demo store twice: once with gaze
off (?gaze=off), once with simulated webcam gaze at realistic error
(?gaze=sim&sigma=242: the mouse is the true gaze point, with 242px of noise on
top, run through the real filter chain). In several scenarios the "eyes"
wander onto the wrong card on purpose, because that is what real eyes do.

Each scenario is scored right / asked / wrong from what Cue said. Parity holds
when gaze is never worse than off: never "wrong" where off was right or asked,
never "asked" where off was right.

Needs a running server with an agent key, and Playwright:
    .venv/bin/uvicorn main:app --app-dir server --port 4190
    python3 tools/gaze-parity.py --base http://localhost:4190 [--only S3] [--runs 2]
"""
import argparse
import json
import re
import sys
import time

from playwright.sync_api import sync_playwright

RANK = {"right": 3, "narrowed": 2, "asked": 1, "other": 1, "wrong": 0}

# Distinctive words per product on /shop/outerwear, used to read what Cue said.
WORDS = {
    "j1": "Wool-Blend", "j2": "Puffer", "j3": "Denim", "j5": "Trench", "o7": "Overcoat",
    "o8": "Shearling", "o9": "Field Jacket", "o10": "Parka", "o11": "Biker", "o12": "Vest",
}

# Each step is ("look", id) to move the eyes onto a card, ("glance", [ids]) to
# go back and forth between cards, ("say", text), or ("goto", path).
# expect: the product the outcome should be about; judge: which lines count.
SCENARIOS = [
    {"id": "S1", "name": "Product page: 'add it' while the eyes are on a recommendation",
     "steps": [("goto", "/product/j1"), ("scroll_related",), ("look_related",),
               ("say", "add it to my bag")],
     "expect": "j1", "judge": "add"},
    {"id": "S2", "name": "Results: 'how much is this one' looking at a card",
     "steps": [("look", "j2"), ("say", "how much is this one?")],
     "expect": "j2", "judge": "answer"},
    {"id": "S3", "name": "Results: agent recommends, eyes wander, then 'add it'",
     "steps": [("look", "j1"), ("say", "which is the cheapest jacket on this page?"),
               ("look", "o8"), ("say", "add it to my bag")],
     "expect": "j3", "judge": "add"},
    {"id": "S4", "name": "Results: named item, eyes wander, then 'is it waterproof'",
     "steps": [("look", "j2"), ("say", "tell me about the trench coat"),
               ("look", "o10"), ("say", "is it waterproof?")],
     "expect": "j5", "judge": "answer_last"},
    {"id": "S5", "name": "Results: 'add the quilted one' (two items match) looking at one",
     "steps": [("look", "o12"), ("say", "add the quilted one to my bag"), ("say_if_asked", "the vest")],
     "expect": "o12", "judge": "add"},
    {"id": "S6", "name": "Results: 'add this' looking at a card",
     "steps": [("look", "o10"), ("say", "add this to my bag")],
     "expect": "o10", "judge": "add"},
    {"id": "S7", "name": "Results: 'compare these two' after going back and forth",
     "steps": [("glance", ["j1", "j5"]), ("say", "compare these two")],
     "expect": ["j1", "j5"], "judge": "pair"},
    {"id": "S8", "name": "Results: 'how much was the one I was looking at'",
     "steps": [("look_long", "o11"), ("look", "j2"), ("say", "how much was the one I was looking at?")],
     "expect": "o11", "judge": "answer_last"},
]

JS_CARD = """(id) => {
  const el = [...document.querySelectorAll('[data-cue-product],[data-aura-product]')]
    .find(e => { try { return JSON.parse(e.dataset.cueProduct || e.dataset.auraProduct).id === id; } catch { return false; } });
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}"""


def run(page, base, mode, sc, log, sigma=242):
    said = []
    page.goto(f"{base}/shop/outerwear?gaze={mode}&sigma={sigma}&cal=0&server={base}")
    page.wait_for_function("window.cue && window.cue.bus", timeout=15000)
    # Everything Cue speaks (bus SAY lines and agent replies alike) is written to
    # the HUD's reply line first; read it from there.
    page.evaluate("""() => { window.__said = [];
      const el = document.querySelector('.aura-hud-said');
      new MutationObserver(() => { const t = el.textContent.trim();
        if (t && t !== window.__said.at(-1)) window.__said.push(t); })
        .observe(el, { childList: true, characterData: true, subtree: true }); }""")
    page.wait_for_timeout(1200)
    here = {"x": 400, "y": 400}

    def eyes(x, y, ms):
        # Real eyes are never still; keeping the pointer moving also keeps sim
        # mode from treating it as abandoned.
        end = time.time() + ms / 1000
        i = 0
        while time.time() < end:
            page.mouse.move(x + (i % 3 - 1) * 6, y + (i % 2) * 5)
            page.wait_for_timeout(60)
            i += 1
        here.update(x=x, y=y)

    def say(text):
        n = page.evaluate("window.__said.length")
        # Speech onset first (a partial), as the real recogniser sends it.
        page.evaluate("(t) => window.cue.bus.emit('UTTERANCE', { text: t, final: false })", text[:8])
        eyes(here["x"], here["y"], 300)
        page.evaluate("(t) => window.cue.say(t)", text)
        # Keep "looking" while Cue thinks; wait for the reply to settle.
        deadline, last, quiet = time.time() + 25, n, time.time()
        while time.time() < deadline:
            eyes(here["x"], here["y"], 250)
            m = page.evaluate("window.__said.length")
            if m != last:
                last, quiet = m, time.time()
            if m > n and time.time() - quiet > 1.6:
                break
        new = page.evaluate("(n) => window.__said.slice(n)", n)
        said.append((text, new))
        log(f"      > {text}\n      < {' | '.join(new) or '(nothing)'}")
        return new

    for step in sc["steps"]:
        kind = step[0]
        if kind == "goto":
            page.evaluate("(p) => { history.pushState({}, '', p + location.search); dispatchEvent(new PopStateEvent('popstate')); }", step[1])
            page.wait_for_timeout(1500)
        elif kind == "scroll_related":
            page.evaluate("() => [...document.querySelectorAll('h2')].find(h => /may also like/i.test(h.textContent))?.scrollIntoView({ block: 'center', behavior: 'instant' })")
            page.wait_for_timeout(500)
        elif kind == "look_related":
            pt = page.evaluate("""() => { const h = [...document.querySelectorAll('h2')].find(h => /may also like/i.test(h.textContent));
              const card = h?.closest('section')?.querySelector('[data-cue-product],[data-aura-product]');
              if (!card) return null; const r = card.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }""")
            if pt:
                eyes(pt["x"], pt["y"], 1800)
        elif kind == "glance":
            pts = [page.evaluate(JS_CARD, i) for i in step[1]]
            # scrollIntoView for the second card may move the first; re-read.
            for _ in range(4):
                for i in step[1]:
                    pt = page.evaluate(JS_CARD, i)
                    if pt:
                        eyes(pt["x"], pt["y"], 800)
        elif kind == "look_long":
            pt = page.evaluate(JS_CARD, step[1])
            if pt:
                eyes(pt["x"], pt["y"], 5000)
        elif kind == "look":
            pt = page.evaluate(JS_CARD, step[1])
            if pt:
                eyes(pt["x"], pt["y"], 1800)
        elif kind == "say":
            say(step[1])
        elif kind == "say_if_asked":
            last = said[-1][1] if said else []
            if last and QUESTION.search(last[-1].strip()):
                say(step[1])
    return said, page.evaluate("window.cue.debugState?.() ?? {}")


QUESTION = re.compile(r"\bor the\b.*\?$|^which(?! size| colou?r)\b|which one", re.I)
ADD_FLOW = re.compile(r"add it\?|\badding\b|\badded\b|which size|what size|which colou?r|size\?|size and colou?r|colou?r\?|your size|need (?:a|your) size", re.I)


def named_in(line):
    """Product ids a line names, in the order it names them."""
    low = line.lower()
    hits = [(low.find(w.lower()), k) for k, w in WORDS.items() if w.lower() in low]
    return [k for _, k in sorted(hits)]


def judge(sc, said, state):
    """right: acted on or answered about the intended item. narrowed: asked
    "the X or the Y?" with the intended item first. asked: asked without
    narrowing. wrong: acted on or answered about a different item."""
    want = sc["expect"]
    lines = [l for _, out in said for l in out]
    if sc["judge"] == "pair":
        named = set(k for l in said[-1][1] for k in named_in(l))
        if set(want) <= named:
            return "right"
        return "asked" if "?" in (said[-1][1] or [""])[-1] else ("wrong" if named - set(want) else "other")
    last = lines[-1] if lines else ""
    if state.get("pending") == "which" or QUESTION.search(last.strip()):
        order = named_in(last)
        return "narrowed" if order and order[0] == want and len(order) <= 3 else "asked"
    about = state.get("discussed")
    if sc["judge"] == "add":
        flow = [l for l in lines if ADD_FLOW.search(l)]
        if not flow:
            return "asked" if "?" in last else "other"
        named = [k for l in flow for k in named_in(l)]
        if want in named or (about == want and not named):
            return "right"
        return "wrong" if named or about else "other"
    turn = said[-1][1] if sc["judge"] == "answer_last" else lines
    named = [k for l in turn for k in named_in(l)]
    if about == want or (named and named[0] == want):
        return "right"
    if about or named:
        return "wrong"
    return "asked" if "?" in last else "other"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:4190")
    ap.add_argument("--only", default=None)
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--modes", default="off,sim")
    ap.add_argument("--json", default=None)
    ap.add_argument("--sigma", type=int, default=242)
    args = ap.parse_args()
    modes = args.modes.split(",")
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"])
        for sc in SCENARIOS:
            if args.only and sc["id"] not in args.only.split(","):
                continue
            print(f"\n{sc['id']}  {sc['name']}")
            for mode in modes:
                for r in range(args.runs):
                    ctx = browser.new_context(viewport={"width": 1440, "height": 900})
                    page = ctx.new_page()
                    page.on("pageerror", lambda e: print("      [pageerror]", e))
                    print(f"   [{mode} #{r + 1}]")
                    said, state = run(page, args.base, mode, sc, print, args.sigma)
                    verdict = judge(sc, said, state)
                    print(f"      = {verdict}")
                    results.append({"id": sc["id"], "mode": mode, "run": r, "verdict": verdict, "said": said})
                    ctx.close()
        browser.close()

    print("\nScenario   " + "   ".join(f"{m:>12}" for m in modes))
    worse = []
    for sc in SCENARIOS:
        rows = [r for r in results if r["id"] == sc["id"]]
        if not rows:
            continue
        cells = []
        best = {}
        for m in modes:
            vs = [r["verdict"] for r in rows if r["mode"] == m]
            best[m] = min(RANK[v] for v in vs)
            cells.append(",".join(vs))
        print(f"{sc['id']:<10} " + "   ".join(f"{c:>12}" for c in cells))
        if "off" in best and "sim" in best and best["sim"] < best["off"]:
            worse.append(sc["id"])
    if args.json:
        json.dump(results, open(args.json, "w"), indent=1)
    print("\nParity:", "HOLDS" if not worse else f"BROKEN in {', '.join(worse)}")
    sys.exit(1 if worse else 0)


if __name__ == "__main__":
    main()
