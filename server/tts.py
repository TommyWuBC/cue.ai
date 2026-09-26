"""Speech out via ElevenLabs, built to spend as few credits as possible.

  1. Disk cache      — every line ever spoken is kept; repeats cost nothing.
  2. Prewarmed lines — the demo script is generated once, ahead of time.
  3. Browser voice   — the fallback when the key is missing or budget runs out.

Text is normalised to spoken form first, and the browser path is handed the
SAME normalised string, so "$79.99" is never read out as "dollar seven nine
point nine nine" by either engine.
"""
import hashlib, json, os, pathlib, re, httpx

CACHE = pathlib.Path(__file__).parent / "cache"
CACHE.mkdir(exist_ok=True)
LEDGER = CACHE / "_ledger.json"

PROVIDER = os.getenv("TTS_PROVIDER", "browser")            # browser | eleven
VOICE    = os.getenv("ELEVEN_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")
MODEL    = os.getenv("ELEVEN_MODEL", "eleven_turbo_v2_5")
BUDGET   = int(os.getenv("ELEVEN_CHAR_BUDGET", "20000"))   # hard stop, characters

# 64 kbps mp3 is a big part of why synthesised speech sounds "robotic" — it
# smears sibilants into static. 128 is still tiny for one-sentence clips.
OUTPUT_FORMAT = "mp3_44100_128"

VOICE_SETTINGS = {
    "stability": 0.45,          # lower = more expressive, too low = wobbly
    "similarity_boost": 0.80,
    "style": 0.35,              # the difference between "reading" and "talking"
    "use_speaker_boost": True,
    "speed": 1.0,
}


# ── Spoken-form normalisation ───────────────────────────────────────────────
def _money(m: re.Match) -> str:
    d = int(m.group(1).replace(",", ""))
    c = int(m.group(2)) if m.group(2) else 0
    dollars = "1 dollar" if d == 1 else f"{d} dollars"
    if c == 0:
        return dollars
    return f"{dollars} and {c} cent" + ("" if c == 1 else "s")


def spoken(text: str) -> str:
    """Turn written text into something worth reading aloud."""
    t = text.strip()
    t = re.sub(r"[*_`#]+", "", t)                      # stray markdown
    t = re.sub(r"\$([\d,]+)(?:\.(\d{2}))?", _money, t)
    t = re.sub(r"(\d)\s*%", r"\1 percent", t)
    t = re.sub(r"(\d)\s*°\s*C\b", r"\1 degrees", t)
    t = re.sub(r"(\d)\s*°\s*F\b", r"\1 degrees", t)
    t = t.replace("—", ", ").replace("–", ", ")
    t = re.sub(r"\bvs\.?\b", "versus", t, flags=re.I)
    t = re.sub(r"\s+([,.;:!?])", r"\1", t)         # " ," left behind by the dashes
    t = re.sub(r"([,;:])\1+", r"\1", t)
    t = re.sub(r"\s{2,}", " ", t)
    return t.strip()


def _key(text: str) -> str:
    return hashlib.sha256(f"{text}|{VOICE}|{MODEL}|{OUTPUT_FORMAT}".encode()).hexdigest()[:16]


def _spent() -> int:
    if LEDGER.exists():
        try:
            return json.loads(LEDGER.read_text()).get("chars", 0)
        except json.JSONDecodeError:
            return 0
    return 0


def _charge(n: int):
    LEDGER.write_text(json.dumps({"chars": _spent() + n}))


def cached(text: str):
    p = CACHE / f"{_key(text)}.mp3"
    return p.read_bytes() if p.exists() else None


def synth(text: str, force: bool = False):
    """Returns (audio_bytes, source, spoken_text).

    audio_bytes is None when the page should speak it with the browser voice —
    in which case spoken_text is what it should say.
    """
    said = spoken(text)

    hit = cached(said)
    if hit:
        return hit, "cache", said
    if PROVIDER != "eleven" and not force:
        return None, "browser", said
    if not os.getenv("ELEVENLABS_API_KEY"):
        return None, "browser", said
    if _spent() + len(said) > BUDGET:
        print(f"[tts] budget exhausted ({_spent()}/{BUDGET} chars) -> browser voice")
        return None, "browser", said

    try:
        r = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}",
            params={"output_format": OUTPUT_FORMAT},
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
            json={"text": said, "model_id": MODEL, "voice_settings": VOICE_SETTINGS},
            timeout=20,
        )
    except Exception as e:
        print(f"[tts] eleven unreachable ({type(e).__name__}) -> browser voice")
        return None, "browser", said

    if r.status_code != 200:
        print(f"[tts] eleven {r.status_code}: {r.text[:200]} -> browser voice")
        return None, "browser", said

    (CACHE / f"{_key(said)}.mp3").write_bytes(r.content)
    _charge(len(said))
    print(f"[tts] synthesized {len(said)} chars ({_spent()}/{BUDGET} used)")
    return r.content, "eleven", said


def budget_status():
    return {"provider": PROVIDER, "model": MODEL, "voice": VOICE,
            "format": OUTPUT_FORMAT, "spent": _spent(), "budget": BUDGET,
            "key": bool(os.getenv("ELEVENLABS_API_KEY")),
            "cached_lines": len(list(CACHE.glob("*.mp3")))}
