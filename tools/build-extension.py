"""Build an unpacked MV3 extension and a Chrome Web Store upload ZIP."""
import argparse
import json
import math
import pathlib
import shutil
import struct
import urllib.parse
import zlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEST = ROOT / 'dist' / 'cue-extension'
FILES = [
    'extension/background.js', 'extension/content.js', 'extension/extract.js',
    'extension/popup.html', 'extension/popup.css', 'extension/popup.js',
    'extension/privacy.html', 'extension/assets/cue-splash.jpg',
    'client/aura.js', 'client/avatar.js', 'client/badges.js', 'client/bus.js',
    'client/config.js', 'client/gaze.js', 'client/intent.js', 'client/mic.js', 'client/overlay.css',
    'client/resolver.js', 'client/shopper.js', 'client/site.js', 'client/splash.js',
    'client/voice.js', 'client/product-memory.js', 'vendor/webgazer.js',
]


def server_origin(value: str) -> str:
    url = urllib.parse.urlsplit(value)
    if (url.scheme not in ('http', 'https') or not url.hostname or url.username or
            url.password or url.path not in ('', '/') or url.query or url.fragment):
        raise ValueError('Server URL must be an HTTP(S) origin with no path, query, or credentials.')
    if url.scheme == 'http' and url.hostname not in ('localhost', '127.0.0.1', '[::1]', '::1'):
        raise ValueError('A non-local Cue server must use HTTPS.')
    return f'{url.scheme}://{url.netloc}'


def icon(size: int, *, full_bleed: bool = False) -> bytes:
    """Draw the Cue eye as a crisp squircle. iOS masks apple-touch icons, so those stay full-bleed."""
    scale = 8
    canvas = size * scale
    radius = canvas * .22
    # A stroke under two output pixels disappears when Chrome scales the toolbar icon.
    stroke = max(size * .085, 2.0) * scale
    charcoal = (32, 32, 34, 255)
    white = (248, 248, 246, 255)
    half = canvas / 2

    def covered(x: float, y: float) -> bool:
        if not full_bleed:
            dx = abs(x - half) - (half - radius)
            dy = abs(y - half) - (half - radius)
            if math.hypot(max(dx, 0), max(dy, 0)) > radius:
                return False
        def arc(cx: float, cy: float, ring: float) -> bool:
            px, py = x - cx, y - cy
            return abs(math.hypot(px, py) - ring) < stroke / 2 and abs(math.atan2(py, px)) > .62
        return (
            arc(canvas * .50, canvas * .50, canvas * .30) or
            arc(canvas * .42, canvas * .50, canvas * .16) or
            math.hypot(x - canvas * .60, y - canvas * .50) < stroke * .72
        )

    plate = [[False] * canvas for _ in range(canvas)]
    mark = [[False] * canvas for _ in range(canvas)]
    for y in range(canvas):
        for x in range(canvas):
            inside = full_bleed or math.hypot(
                max(abs(x + .5 - half) - (half - radius), 0),
                max(abs(y + .5 - half) - (half - radius), 0)) <= radius
            plate[y][x] = inside
            mark[y][x] = inside and covered(x + .5, y + .5)

    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            p = m = 0
            for j in range(scale):
                row_p, row_m = plate[y * scale + j], mark[y * scale + j]
                for i in range(scale):
                    p += row_p[x * scale + i]
                    m += row_m[x * scale + i]
            if not p:
                raw.extend((0, 0, 0, 0))
                continue
            samples = scale * scale
            alpha = round(255 * p / samples)
            mix = m / p
            raw.extend((
                round(white[0] * mix + charcoal[0] * (1 - mix)),
                round(white[1] * mix + charcoal[1] * (1 - mix)),
                round(white[2] * mix + charcoal[2] * (1 - mix)),
                alpha,
            ))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))

    return (b'\x89PNG\r\n\x1a\n' +
            chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server-url', default='http://localhost:4173',
                        help='Cue backend origin (default: http://localhost:4173)')
    args = parser.parse_args()
    origin = server_origin(args.server_url)
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    manifest['host_permissions'] = [origin + '/*']
    manifest['icons'] = {str(size): f'icons/{size}.png' for size in (16, 32, 48, 128)}
    manifest['action']['default_icon'] = manifest['icons']

    if DEST.exists():
        shutil.rmtree(DEST)
    DEST.mkdir(parents=True)
    for name in FILES:
        target = DEST / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)
    shutil.copytree(ROOT / 'vendor/models', DEST / 'vendor/models')
    (DEST / 'extension/runtime.js').write_text(
        '// Generated by tools/build-extension.py.\n'
        f'export const SERVER_URL = {json.dumps(origin)};\n')
    (DEST / 'icons').mkdir()
    for size in (16, 32, 48, 128):
        (DEST / f'icons/{size}.png').write_bytes(icon(size))
    (DEST / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

    archive = DEST.parent / f'cue-extension-{manifest["version"]}.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED,
                         compresslevel=9) as out:
        for path in sorted(DEST.rglob('*')):
            if path.is_file():
                info = zipfile.ZipInfo(path.relative_to(DEST).as_posix(),
                                       date_time=(2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o644 << 16
                out.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED,
                             compresslevel=9)
    print(f'Unpacked extension: {DEST}')
    print(f'Upload package:     {archive}')
    print(f'Cue server:         {origin}')


if __name__ == '__main__':
    main()
