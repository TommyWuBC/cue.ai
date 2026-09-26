"""Offline brain. Answers attribute questions straight from the product data.

This exists because at 2pm on demo day the venue wifi will be saturated, or the
xAI key will rate-limit, and "is this wool?" still has to work. It never invents
anything — every answer is a field that is actually on the page.
"""
import re

FIELDS = [
    (r"\b(wool|cotton|polyester|merino|denim|acrylic|nylon|material|made of|fabric|cashmere)\b", "material"),
    (r"\b(run small|runs small|run large|sizing|size up|size down|true to size|fit)\b", "sizing"),
    (r"\b(wash|care|dry clean|machine wash)\b", "care"),
    (r"\b(warm|warmth|cold|winter|temperature)\b", "warmth"),
    (r"\b(made in|origin|where.*made)\b", "origin"),
    (r"\b(review|rating|stars|good|worth it)\b", "rating"),
    (r"\b(cut|shape|oversized|cropped|relaxed|slim)\b", "fit"),
]


def _price(p):
    return f"${p['price']:.2f}".replace(".00", "")


def _field(p, key):
    a = p.get("attrs", {})
    if key == "rating":
        return f"{a.get('rating')} stars from {a.get('reviews')} reviews"
    return a.get(key)


def answer(text: str, ctx: dict) -> dict:
    t = text.lower()
    focused = ctx.get("focused")
    visible = ctx.get("visible", [])

    # Comparison: "how's this different", "compare these"
    if re.search(r"\b(differ|different|compare|versus|vs|which is better)\b", t):
        if focused and len(visible) >= 2:
            other = next((p for p in visible if p["id"] != focused["id"]), None)
            if other:
                return {"say": (f"The {focused['title']} is {_price(focused)}, "
                                f"{focused['attrs']['material'].split(',')[0]}. "
                                f"The {other['title']} is {_price(other)}, "
                                f"{other['attrs']['material'].split(',')[0]}. "
                                f"{focused['attrs']['warmth'].split('—')[0].strip()} versus "
                                f"{other['attrs']['warmth'].split('—')[0].strip()}."),
                        "do": [], "source": "fallback"}
        return {"say": "Look at one of them and I'll compare it with the other.", "do": [], "source": "fallback"}

    if not focused:
        return {"say": "Look at an item and I'll tell you about it.", "do": [], "source": "fallback"}

    if re.search(r"\b(price|cost|how much)\b", t):
        return {"say": f"The {focused['title']} is {_price(focused)}.", "do": [], "source": "fallback"}

    for rx, key in FIELDS:
        if re.search(rx, t):
            val = _field(focused, key)
            if val:
                return {"say": f"{focused['title']}: {val}.", "do": [], "source": "fallback"}

    a = focused.get("attrs", {})
    return {"say": (f"The {focused['title']}, {_price(focused)}. "
                    f"{a.get('material', '')}. {a.get('fit', '')}."),
            "do": [], "source": "fallback"}
