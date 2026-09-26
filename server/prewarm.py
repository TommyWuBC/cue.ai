"""Generate the demo script's spoken lines once, into the disk cache.

Run this ONCE before rehearsing:  TTS_PROVIDER=eleven python3 server/prewarm.py
After that the demo speaks from disk and costs zero credits, however many times
you run it. Add any new fixed line here rather than paying for it live.
"""
import os, pathlib, sys
from dotenv import load_dotenv
load_dotenv(pathlib.Path(__file__).parent.parent / ".env")
os.environ["TTS_PROVIDER"] = "eleven"
sys.path.insert(0, str(pathlib.Path(__file__).parent))
import tts

LINES = [
    "Cue is ready. Look at something and ask me about it.",
    "Look at each dot and press space.",
    "Calibration done. I can see where you're looking.",
    "Calibration is a bit loose, but I can work with it. Look at something and ask me about it.",
    "Added.",
    "Okay.",
    "Sorry, say that again?",
    "Sorry, I lost my connection.",
    "Your cart is empty.",
    "I can't see that on the page.",
    "Which one do you mean, the first or the second?",
    "Look at the item you want first.",
    "Look at an item and I'll tell you about it.",
    "Look at one of them and I'll compare it with the other.",
    "That would put you over your budget.",
    "Order approved.",
    "Cancelled. Nothing was charged.",
]

if __name__ == "__main__":
    total = 0
    for line in LINES:
        said = tts.spoken(line)
        if tts.cached(said):
            print(f"  cached   {line[:54]}")
            continue
        audio, src, _ = tts.synth(line, force=True)
        print(f"  {'OK  ':8} {line[:54]}" if audio else f"  {'FAIL':8} {line[:54]}")
        total += len(said) if audio else 0
    print(f"\nspent {total} chars this run · {tts.budget_status()}")
