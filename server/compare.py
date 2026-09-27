"""Two products, side by side, in the words a shop clerk would use.

One model call returns the whole panel: the rows, a verdict, and the line about
what the shopper already owns. Two calls would be two round trips in front of
someone waiting, and the second line needs the first one's reasoning anyway.

Everything here is page text and local history — untrusted evidence, never
instructions, and every field is type-checked and capped before it is rendered.
"""
import json

from agent import MODEL, _details, client

SYSTEM = """You compare two products for someone shopping by voice who cannot
easily read the screen. You are the same shop clerk who has been talking to
them: plain words, no marketing, no hedging.

Return JSON only:
{"rows": [{"label": "...", "a": "...", "b": "..."}],
 "verdict": "...", "pick": "a" | "b", "ecosystem": "..."}

`rows` are 3 to 5 things a person would actually weigh — price, battery, fit,
noise cancelling, what buyers complain about. Label is two words or less. `a`
and `b` are short phrases, not sentences, and never "N/A": if the page does not
say, write "not listed". Do not invent a number that is not in the evidence.

`verdict` is one sentence, under twenty words, naming which one you would hand
them and why. `pick` is which side that is.

`ecosystem` is one sentence about how the pick fits what they already own, from
`owns`. Say it the way a person would — "you picked up the iPhone last week, so
these pair the moment you open the case". If `owns` is empty or nothing
connects, return "" and do not invent a link. Never claim a discount, a bundle
or a compatibility guarantee that is not in the evidence."""


def _row(value):
    if not isinstance(value, dict):
        return None
    label = value.get("label")
    a, b = value.get("a"), value.get("b")
    if not all(isinstance(x, str) and x.strip() for x in (label, a, b)):
        return None
    return {"label": label[:24], "a": a[:80], "b": b[:80]}


def compare(a: dict, b: dict, owns=None) -> dict:
    """`a` and `b` are {title, price, facts}. `owns` is recent local purchases."""
    def side(p):
        p = p if isinstance(p, dict) else {}
        rows = _details([{"title": p.get("title"), "facts": p.get("facts")}])
        out = rows[0] if rows else {"title": str(p.get("title") or "")[:90]}
        if p.get("price") is not None:
            out["price"] = str(p["price"])[:24]
        return out

    payload = json.dumps({
        "a": side(a), "b": side(b),
        "owns": [str(x)[:80] for x in (owns or [])][:6],
    }, ensure_ascii=False)

    r = client().messages.create(
        model=MODEL, system=SYSTEM, max_tokens=700,
        messages=[{"role": "user", "content": payload},
                  {"role": "assistant", "content": "{"}],
    )
    try:
        out = json.loads("{" + r.content[0].text)
    except (json.JSONDecodeError, TypeError, IndexError, AttributeError):
        out = {}

    rows = [r for r in (_row(x) for x in (out.get("rows") or [])[:6]) if r]
    pick = out.get("pick") if out.get("pick") in {"a", "b"} else "a"
    verdict = out.get("verdict")
    return {
        "rows": rows,
        "verdict": verdict[:200] if isinstance(verdict, str) else "",
        "pick": pick,
        "ecosystem": out["ecosystem"][:200] if isinstance(out.get("ecosystem"), str) else "",
        "titles": {"a": side(a).get("title", ""), "b": side(b).get("title", "")},
    }
