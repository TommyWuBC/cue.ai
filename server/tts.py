"""Three-tier speech out, built to spend as few ElevenLabs credits as possible.

  1. Disk cache      — every line ever spoken is kept; repeats cost nothing.
  2. Prewarmed lines — the demo script is generated once, ahead of time.
  3. Browser voice   — the default in dev, and the fallback when budget runs out.

Flip TTS_PROVIDER=eleven only when rehearsing or demoing.
"""
import hashlib, json, os, pathlib, httpx

CACHE = pathlib.Path(__file__).parent / "cache"
CACHE.mkdir(exist_ok=True)
LEDGER = CACHE / "_ledger.json"

PROVIDER = os.getenv("TTS_PROVIDER", "browser")          # browser | eleven
VOICE    = os.getenv("ELEVEN_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
MODEL    = os.getenv("ELEVEN_MODEL", "eleven_flash_v2_5")  # half the credits of v2
BUDGET   = int(os.getenv("ELEVEN_CHAR_BUDGET", "20000"))   # hard stop, characters


def _key(text: str) -> str:
    return hashlib.sha256(f"{text}|{VOICE}|{MODEL}".encode()).hexdigest()[:16]


def _spent() -> int:
    if LEDGER.exists():
        return json.loads(LEDGER.read_text()).get("chars", 0)
    return 0


def _charge(n: int):
    LEDGER.write_text(json.dumps({"chars": _spent() + n}))


def cached(text: str):
    p = CACHE / f"{_key(text)}.mp3"
    return p.read_bytes() if p.exists() else None


def synth(text: str, force: bool = False):
    """Returns (audio_bytes, source) or (None, 'browser') to let the page speak it."""
    hit = cached(text)
    if hit:
        return hit, "cache"
    if PROVIDER != "eleven" and not force:
        return None, "browser"
    if not os.getenv("ELEVENLABS_API_KEY"):
        return None, "browser"
    if _spent() + len(text) > BUDGET:
        print(f"[tts] budget exhausted ({_spent()}/{BUDGET} chars) -> browser voice")
        return None, "browser"

    r = httpx.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}",
        params={"output_format": "mp3_44100_64"},
        headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
        json={"text": text, "model_id": MODEL,
              "voice_settings": {"stability": 0.4, "similarity_boost": 0.75, "speed": 1.05}},
        timeout=20,
    )
    if r.status_code != 200:
        print(f"[tts] eleven {r.status_code}: {r.text[:200]} -> browser voice")
        return None, "browser"

    (CACHE / f"{_key(text)}.mp3").write_bytes(r.content)
    _charge(len(text))
    print(f"[tts] synthesized {len(text)} chars ({_spent()}/{BUDGET} used)")
    return r.content, "eleven"


def budget_status():
    return {"provider": PROVIDER, "model": MODEL, "spent": _spent(),
            "budget": BUDGET, "cached_lines": len(list(CACHE.glob("*.mp3")))}
