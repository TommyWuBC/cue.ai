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


def answer(text: str, ctx: dict) -> dict:
    t = text.lower()
    focused = ctx.get("focused") if isinstance(ctx.get("focused"), dict) else None
    visible = [p for p in ctx.get("visible", []) if isinstance(p, dict)] if isinstance(ctx.get("visible"), list) else []

    if re.search(r"\b(differ|different|compare|versus|vs|which is better)\b", t):
        previous = ctx.get("previous") if isinstance(ctx.get("previous"), dict) else None
        other = previous if previous and focused and previous.get("id") != focused.get("id") else None
        wants_previous = bool(re.search(r"\b(last|previous|before|earlier)\b", t))
        if not other and wants_previous:
            return {"say": "I don't have a previous product to compare yet. Ask me about one, then look at another.",
                    "do": [], "source": "fallback"}
        if not other:
            other = next((p for p in visible if focused and p.get("id") != focused.get("id")), None)
        if focused and other:
            return {"say": f"{_summary(focused)}. Compared with {_summary(other)}.",
                    "do": [], "source": "fallback"}
        return {"say": "Look at one of them and I'll compare it with another visible item.",
                "do": [], "source": "fallback"}

    if not focused:
        return {"say": "Look at an item and I'll tell you about it.", "do": [], "source": "fallback"}

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
