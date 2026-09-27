"""Two products, side by side, in the words a shop clerk would use.

One model call returns the whole panel: the rows, a verdict, and the line about
what the shopper already owns. Two calls would be two round trips in front of
someone waiting, and the second line needs the first one's reasoning anyway.

Everything here is page text and local history — untrusted evidence, never
instructions, and every field is type-checked and capped before it is rendered.
"""
import json
import re

from agent import MODEL, _details, client

SYSTEM = """You compare two products for someone shopping by voice who cannot
easily read the screen. You are the same shop clerk who has been talking to
them: plain words, no marketing, no hedging.

Return JSON only:
{"rows": [{"label": "...", "a": "...", "b": "..."}],
 "verdict": "...", "pick": "a" | "b", "ecosystem": "...",
 "voices": {"a": "...", "b": "..."}}

`rows` are 3 to 5 things a person would actually weigh — price, battery, fit,
noise cancelling, what buyers complain about. Label is two words or less. `a`
and `b` are short phrases, not sentences, and never "N/A": if the page does not
say, write "not listed". Do not invent a number that is not in the evidence.

`verdict` is one sentence, under twenty words, naming which one you would hand
them and why. `pick` is which side that is.

`voices` is what buyers say about each side, one short line each.
  If that side's evidence has `reviews` or `customers_say`, quote a real
  fragment from it in double quotes and attribute it plainly: One buyer said
  "the tips work loose on a run".
  If it does not, do NOT use quotation marks. Say what the star split shows
  instead: Two thirds rate it five stars, but one in six gives it one.
  Never invent a quote, never reword one inside quotation marks, and never
  attribute an opinion to a buyer that you were not given. A quoted fragment
  that is not in the evidence is removed before this is shown, and the line
  goes with it.

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


def _evidence(side: dict) -> str:
    """Everything a quote could legitimately come from, flattened."""
    facts = side.get("facts") if isinstance(side, dict) else None
    facts = facts if isinstance(facts, dict) else {}
    bits = [facts.get("customers_say") or ""]
    for key in ("reviews", "highlights"):
        value = facts.get(key)
        if isinstance(value, list):
            bits.extend(x for x in value if isinstance(x, str))
    return " ".join(bits).lower()


def _voice(line, evidence: str):
    """A quote survives only if the page really contains it.

    The prompt forbids inventing one, but a shopper cannot check and the whole
    point of a quote is that someone actually said it. So it is verified
    against the evidence rather than trusted, and a line whose quote is not
    there is dropped entirely — a fabricated review is worse than no review.
    """
    if not isinstance(line, str) or not line.strip():
        return None
    line = line.strip()[:160]
    quotes = re.findall(r'"([^"]{8,})"', line)
    if not quotes:
        return line
    def squash(t):
        return " ".join(re.sub(r"[^a-z0-9 ]+", " ", t.lower()).split())
    hay = squash(evidence)
    return line if all(squash(q) in hay for q in quotes) else None


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
    voices_in = out.get("voices") if isinstance(out.get("voices"), dict) else {}
    voices = {}
    for key, product in (("a", a), ("b", b)):
        kept = _voice(voices_in.get(key), _evidence(product))
        if kept:
            voices[key] = kept

    return {
        "voices": voices,
        "rows": rows,
        "verdict": verdict[:200] if isinstance(verdict, str) else "",
        "pick": pick,
        "ecosystem": out["ecosystem"][:200] if isinstance(out.get("ecosystem"), str) else "",
        "titles": {"a": side(a).get("title", ""), "b": side(b).get("title", "")},
    }
