"""Generate the demo script's spoken lines once, into the disk cache.

Run this ONCE before rehearsing:  .venv/bin/python server/prewarm.py
Each line goes through the same chain as live speech (Grok, then ElevenLabs),
so the cache holds whichever voice the demo will actually use. After that the
demo speaks from disk and costs nothing, however many times you run it. Add
any new fixed line here rather than paying for it live.
"""
import os, pathlib, sys
from dotenv import load_dotenv
load_dotenv(pathlib.Path(__file__).parent.parent / ".env")
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tts

LINES = [
    "Cue is ready. What are you after?",
    "Look at each dot and say Cue, next, or press space.",
    "Let's recalibrate your gaze.",
    "Calibration done. I can see where you're looking.",
    "Calibration is a bit loose, but I can work with it. What are you after?",
    "Added.",
    "Okay.",
    "Sorry, say that again?",
    "Sorry, I lost my connection.",
    "Your cart is empty.",
    "I can't see that on the page.",
    "Which one do you mean, the first or the second?",
    "Which one? Say its number.",
    "Say an item's number and I'll tell you about it.",
    "Tell me which two, by number, and I'll compare them.",
    "That would put you over your budget.",
    "Order approved.",
    "Cancelled. Nothing was charged.",
]

if __name__ == "__main__":
    total = 0
    for line in LINES:
        said = tts.spoken(line)
        if tts.cached(said, force=True):
            print(f"  cached   {line[:54]}")
            continue
        audio, src, _ = tts.synth(line, force=True)
        print(f"  {'OK  ':8} {line[:54]}" if audio else f"  {'FAIL':8} {line[:54]}")
        total += len(said) if audio else 0
    print(f"\nspent {total} chars this run · {tts.budget_status()}")
