"""Speech out: Grok first, ElevenLabs second, the browser voice last.

  1. Disk cache      — every line ever spoken is kept; repeats cost nothing.
  2. Grok TTS        — xAI's /v1/tts. First choice: we are in xAI's track.
  3. ElevenLabs      — when Grok has no key, errors, or is unreachable.
  4. Browser voice   — the final fallback; the page speaks it itself.

Prewarmed lines (server/prewarm.py) fill the cache ahead of the demo.

Text is normalised to spoken form first, and the browser path is handed the
SAME normalised string, so "$79.99" is never read out as "dollar seven nine
point nine nine" by any engine.
"""
import hashlib, json, os, pathlib, re, httpx

CACHE = pathlib.Path(__file__).parent / "cache"
CACHE.mkdir(exist_ok=True)
LEDGER = CACHE / "_ledger.json"

# First choice: grok | eleven | browser. Each falls through to the next.
PROVIDER = os.getenv("TTS_PROVIDER", "grok")
CHAINS   = {"grok": ["grok", "eleven"], "eleven": ["eleven"], "browser": []}

XAI_VOICE  = os.getenv("XAI_TTS_VOICE", "eve")
XAI_BUDGET = int(os.getenv("XAI_TTS_CHAR_BUDGET", "100000"))

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


def chain(force: bool = False) -> list[str]:
    """Providers to try in order. `force` (prewarm) tries every one we have."""
    return ["grok", "eleven"] if force else CHAINS.get(PROVIDER, ["grok", "eleven"])


def _key(text: str, provider: str = "eleven") -> str:
    # The ElevenLabs key is unchanged so lines already cached stay valid.
    if provider == "grok":
        return hashlib.sha256(f"grok|{text}|{XAI_VOICE}|{OUTPUT_FORMAT}".encode()).hexdigest()[:16]
    return hashlib.sha256(f"{text}|{VOICE}|{MODEL}|{OUTPUT_FORMAT}".encode()).hexdigest()[:16]


def _ledger() -> dict:
    if LEDGER.exists():
        try:
            return json.loads(LEDGER.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def _spent(provider: str = "eleven") -> int:
    return _ledger().get("chars" if provider == "eleven" else f"{provider}_chars", 0)


def _charge(n: int, provider: str = "eleven"):
    led = _ledger()
    field = "chars" if provider == "eleven" else f"{provider}_chars"
    led[field] = led.get(field, 0) + n
    LEDGER.write_text(json.dumps(led))


def cached(text: str, force: bool = False):
    for provider in chain(force) or ["grok", "eleven"]:
        p = CACHE / f"{_key(text, provider)}.mp3"
        if p.exists():
            return p.read_bytes()
    return None


def _grok(said: str):
    if not os.getenv("XAI_API_KEY"):
        return None
    if _spent("grok") + len(said) > XAI_BUDGET:
        print(f"[tts] grok budget exhausted ({_spent('grok')}/{XAI_BUDGET} chars) -> next")
        return None
    try:
        r = httpx.post(
            "https://api.x.ai/v1/tts",
            headers={"Authorization": f"Bearer {os.environ['XAI_API_KEY']}"},
            json={"text": said, "voice_id": XAI_VOICE, "language": "en",
                  "output_format": {"codec": "mp3", "sample_rate": 44100, "bit_rate": 128000}},
            timeout=20,
        )
    except Exception as e:
        print(f"[tts] grok unreachable ({type(e).__name__}) -> next")
        return None
    if r.status_code != 200 or not r.headers.get("content-type", "").startswith("audio/"):
        print(f"[tts] grok {r.status_code}: {r.text[:200]} -> next")
        return None
    return r.content


def _eleven(said: str):
    if not os.getenv("ELEVENLABS_API_KEY"):
        return None
    if _spent("eleven") + len(said) > BUDGET:
        print(f"[tts] eleven budget exhausted ({_spent('eleven')}/{BUDGET} chars) -> next")
        return None
    try:
        r = httpx.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE}",
            params={"output_format": OUTPUT_FORMAT},
            headers={"xi-api-key": os.environ["ELEVENLABS_API_KEY"]},
            json={"text": said, "model_id": MODEL, "voice_settings": VOICE_SETTINGS},
            timeout=20,
        )
    except Exception as e:
        print(f"[tts] eleven unreachable ({type(e).__name__}) -> next")
        return None
    if r.status_code != 200:
        print(f"[tts] eleven {r.status_code}: {r.text[:200]} -> next")
        return None
    return r.content


ENGINES = {"grok": _grok, "eleven": _eleven}


def synth(text: str, force: bool = False):
    """Returns (audio_bytes, source, spoken_text).

    audio_bytes is None when the page should speak it with the browser voice —
    in which case spoken_text is what it should say.
    """
    said = spoken(text)

    hit = cached(said, force)
    if hit:
        return hit, "cache", said
    for provider in chain(force):
        audio = ENGINES[provider](said)
        if audio:
            (CACHE / f"{_key(said, provider)}.mp3").write_bytes(audio)
            _charge(len(said), provider)
            print(f"[tts] {provider} synthesized {len(said)} chars")
            return audio, provider, said
    return None, "browser", said


def budget_status():
    live = [p for p in chain() if os.getenv("XAI_API_KEY" if p == "grok" else "ELEVENLABS_API_KEY")]
    return {"provider": live[0] if live else "browser", "chain": chain() + ["browser"],
            "grok": {"voice": XAI_VOICE, "key": bool(os.getenv("XAI_API_KEY")),
                     "spent": _spent("grok"), "budget": XAI_BUDGET},
            # ElevenLabs fields stay at the top level for anything already reading them.
            "model": MODEL, "voice": VOICE, "format": OUTPUT_FORMAT,
            "spent": _spent("eleven"), "budget": BUDGET,
            "key": bool(os.getenv("ELEVENLABS_API_KEY")),
            "cached_lines": len(list(CACHE.glob("*.mp3")))}
