"""Conversational layer. One Grok call, strict JSON out — no tool round trip,
because a second hop costs a second of demo latency we don't have."""
import json, os
from openai import OpenAI

MODEL = os.getenv("GROK_MODEL", "grok-4")
_client = None


def client():
    global _client
    if _client is None:
        _client = OpenAI(api_key=os.environ["XAI_API_KEY"], base_url="https://api.x.ai/v1")
    return _client


SYSTEM = """You are Cue, a shopping assistant for someone who cannot use a mouse.
They steer with their eyes and speak to you. You are their eyes' voice.

You are given what they are LOOKING AT and what is VISIBLE on screen.
"this", "it", "that one" always mean the focused item.

Answer in ONE or TWO short spoken sentences. No lists, no markdown, no emoji —
this is read aloud. Never invent a material, price or measurement that is not in
the data; if it isn't there, say you can't see it on the page.

Reply with JSON only:
{"say": "<what to speak>", "do": [{"verb": "...", "args": {}}]}

Verbs you may use: scroll{dir}, focus_nth{n}, select_variant{value},
add_to_cart{}, checkout{}, click_focused{}. Use [] when nothing should happen.
Never add to cart or check out unless they clearly asked."""


def respond(text: str, ctx: dict) -> dict:
    focused = ctx.get("focused")
    visible = ctx.get("visible", [])[:8]
    user = json.dumps({
        "said": text,
        "looking_at": focused,
        "also_visible": [{"id": p["id"], "title": p["title"], "price": p["price"]} for p in visible],
    }, ensure_ascii=False)

    r = client().chat.completions.create(
        model=MODEL,
        messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
        response_format={"type": "json_object"},
        temperature=0.3,
        max_tokens=220,
    )
    try:
        out = json.loads(r.choices[0].message.content)
    except json.JSONDecodeError:
        out = {"say": "Sorry, say that again?", "do": []}
    out.setdefault("do", [])
    out["source"] = "grok"
    return out
