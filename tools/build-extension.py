"""Package the MV3 extension from source modules into dist/cue-extension."""
import json
import pathlib
import shutil

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / 'dist' / 'cue-extension'
FILES = [
    'extension/background.js', 'extension/content.js', 'extension/extract.js',
    'client/aura.js', 'client/avatar.js', 'client/badges.js', 'client/bus.js',
    'client/config.js', 'client/gaze.js', 'client/mic.js', 'client/overlay.css',
    'client/resolver.js', 'client/voice.js', 'client/product-memory.js', 'vendor/webgazer.js',
]


def main():
    if DEST.exists():
        shutil.rmtree(DEST)
    DEST.mkdir(parents=True)
    for name in FILES:
        target = DEST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)
    shutil.copytree(ROOT / 'vendor/models', DEST / 'vendor/models')
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Extension ready: {DEST}')


if __name__ == '__main__':
    main()
