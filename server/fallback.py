"""Offline answers grounded only in fields present in page product data."""
import re
from decimal import Decimal, InvalidOperation

FIELDS = [
    (r"\b(wool|cotton|polyester|merino|denim|acrylic|nylon|material|made of|fabric|cashmere)\b", "material"),
    (r"\b(run small|runs small|run large|sizing|size up|size down|true to size|fit)\b", "sizing"),
    (r"\b(wash|care|dry clean|machine wash)\b", "care"),
    (r"\b(warm|warmth|cold|winter|temperature)\b", "warmth"),
    (r"\b(made in|origin|where.*made)\b", "origin"),
    (r"\b(review|rating|stars|good|worth it)\b", "rating"),
    (r"\b(cut|shape|oversized|cropped|relaxed|slim)\b", "fit"),
]


def _price(product):
    try:
        amount = Decimal(str(product.get("price")))
        if not amount.is_finite() or amount < 0:
            return None
        value = f"{amount:.2f}".removesuffix(".00")
        currency = product.get("currency") or "USD"
        symbol = {"USD": "$", "EUR": "€", "GBP": "£"}.get(currency)
        return f"{symbol}{value}" if symbol else f"{value} {str(currency)[:8]}"
    except (InvalidOperation, TypeError, ValueError):
        return None


def _field(product, key):
    attrs = product.get("attrs") if isinstance(product.get("attrs"), dict) else {}
    if key == "rating":
        rating = attrs.get("rating")
        reviews = attrs.get("reviews")
        if rating is None:
            return None
        return f"{rating} stars from {reviews} reviews" if reviews is not None else f"{rating} stars"
    value = attrs.get(key)
    return value if isinstance(value, str) and value.strip() else None


def _summary(product):
    title = product.get("title") or "This item"
    details = [f"{title} is {_price(product)}" if _price(product) else title]
    for key in ("material", "warmth"):
        value = _field(product, key)
        if value:
            details.append(value.split(",")[0].split("—")[0].strip())
    return ", ".join(details)


def _attended(ctx, key, pool, n=2, min_share=0.0):
    """Products from the attention map (client/attention.js), strongest first.

    Webcam gaze is coarse, so these are probabilities, not a pointer: callers
    use them to resolve "this", "these" and "the one I was looking at", and to
    ask when two items are too close to call."""
    att = ctx.get("attention") if isinstance(ctx.get("attention"), dict) else {}
    out = []
    for row in att.get(key) or []:
        if not isinstance(row, dict):
            continue
        product = pool.get(row.get("id"))
        share = row.get("share", 1) if isinstance(row.get("share", 1), (int, float)) else 0
        if product and share >= min_share and product not in [p for p, _ in out]:
            out.append((product, share))
        if len(out) >= n:
            break
    return out


def answer(text: str, ctx: dict) -> dict:
    t = text.lower()
    focused = ctx.get("focused") if isinstance(ctx.get("focused"), dict) else None
    visible = [p for p in ctx.get("visible", []) if isinstance(p, dict)] if isinstance(ctx.get("visible"), list) else []

    pool = {p.get("id"): p for p in visible if p.get("id")}
    if focused and focused.get("id"):
        pool.setdefault(focused["id"], focused)

    # "Compare them", "these two", "which is better": the two items the eyes have
    # been going back and forth between, when nothing more specific was named.
    wants_pair = re.search(r"\b(compare|differ|different|versus|vs|which is better|these|both|them)\b", t)
    if wants_pair and not re.search(r"\b(last|previous|before|earlier)\b", t):
        pair = _attended(ctx, "recent", pool, n=2, min_share=0.2)
        if len(pair) == 2:
            a, b = pair[0][0], pair[1][0]
            return {"say": f"{_summary(a)}. Compared with {_summary(b)}.", "do": [], "source": "fallback"}

    # "The one I was looking at": what this visit lingered on longest.
    if re.search(r"\b(the one i (?:was|were) looking at|i was looking at|the one i looked at)\b", t):
        studied = _attended(ctx, "studied", pool, n=1)
        if studied:
            focused = studied[0][0]

    # "This" with two items too close to call when they started speaking: ask.
    deictic = re.search(r"\b(this|that|it)\b", t)
    discussed = ctx.get("discussed") if isinstance(ctx.get("discussed"), dict) else None
    if deictic and not discussed:
        onset = _attended(ctx, "at_speech", pool, n=2)
        if len(onset) == 2 and abs(onset[0][1] - onset[1][1]) < 0.2:
            return {"say": f"The {onset[0][0].get('title')} or the {onset[1][0].get('title')}?",
                    "do": [], "source": "fallback"}
        if onset and onset[0][1] >= 0.55 and not focused:
            focused = onset[0][0]

    if re.search(r"\b(differ|different|compare|versus|vs|which is better)\b", t):
        previous = ctx.get("previous") if isinstance(ctx.get("previous"), dict) else None
        other = previous if previous and focused and previous.get("id") != focused.get("id") else None
        wants_previous = bool(re.search(r"\b(last|previous|before|earlier)\b", t))
        if not other and wants_previous:
            return {"say": "I don't have a previous product to compare yet. Ask me about one, then name another.",
                    "do": [], "source": "fallback"}
        if not other:
            other = next((p for p in visible if focused and p.get("id") != focused.get("id")), None)
        if focused and other:
            return {"say": f"{_summary(focused)}. Compared with {_summary(other)}.",
                    "do": [], "source": "fallback"}
        return {"say": "Tell me which two, by number, and I'll compare them.",
                "do": [], "source": "fallback"}

    if not focused:
        return {"say": "Say an item's number and I'll tell you about it.", "do": [], "source": "fallback"}

    title = focused.get("title") or "This item"
    if re.search(r"\b(price|cost|how much)\b", t):
        price = _price(focused)
        say = f"{title} is {price}." if price else "I can't see a price on the page."
        return {"say": say, "do": [], "source": "fallback"}

    for rx, key in FIELDS:
        if re.search(rx, t):
            value = _field(focused, key)
            say = f"{title}: {value}." if value else f"I can't see {key} details on the page."
            return {"say": say, "do": [], "source": "fallback"}

    summary = _summary(focused)
    return {"say": f"{summary}." if summary != title else f"I can see {title}, but no more details.",
            "do": [], "source": "fallback"}
