#!/usr/bin/env python3
"""Patch vendor/webgazer.js to load its models from us instead of tfhub.dev.

Why this exists
---------------
WebGazer 3.3.0 fetches three TF.js models from tfhub.dev on every cold start and
bundles none of them. Two consequences we cannot live with:

  1. Saturated venue wifi on demo morning means no gaze tracking at all.
  2. Inside a browser extension content script, the host page's CSP connect-src
     will block the fetch outright.

WebGazer's TFFaceMesh constructor hardcodes `{maxFaces: 1}` and never forwards
the `modelUrl` / `detectorModelUrl` / `irisModelUrl` options the underlying
face-landmarks-detection library accepts, so there is no supported way in. We
patch the bundle.

The patch is deliberately minimal and idempotent: each hardcoded URL becomes a
lookup on `globalThis.CUE_MODELS`, falling back to the original URL. Nothing
changes unless a page sets that global, so the unpatched behaviour is preserved
for anyone running this standalone without the local copies.

It also disables the iris model. WebGazer calls estimateFaces with
`predictIrises: false`, so iris is downloaded (2.6 MB of 6 MB) and never used.

Usage:  python3 tools/patch-webgazer.py [--check]
"""
import pathlib
import re
import sys

VENDOR = pathlib.Path(__file__).resolve().parent.parent / "vendor" / "webgazer.js"

MODELS = {
    "blazeface": "https://tfhub.dev/tensorflow/tfjs-model/blazeface/1/default/1",
    "facemesh":  "https://tfhub.dev/mediapipe/tfjs-model/facemesh/1/default/1",
    "iris":      "https://tfhub.dev/mediapipe/tfjs-model/iris/1/default/2",
}

MARKER = "globalThis.CUE_MODELS"


def patched_expr(key: str, url: str) -> str:
    # Kept on one line: the bundle is a single 14k-column line and we must not
    # introduce a newline into a string context.
    return f'((globalThis.CUE_MODELS&&globalThis.CUE_MODELS.{key})||"{url}")'


def apply(src: str) -> tuple[str, list[str]]:
    notes = []
    for key, url in MODELS.items():
        target = f'"{url}"'
        if target not in src:
            notes.append(f"  {key}: URL not found (already patched?)")
            continue
        src = src.replace(target, patched_expr(key, url))
        notes.append(f"  {key}: redirected to globalThis.CUE_MODELS.{key}")

    # Iris is loaded by default and never used (predictIrises is false in
    # getEyePatches), so 2.6 MB is downloaded and thrown away.
    before = src
    src = src.replace("(KP.mediapipeFacemesh,{maxFaces:1})",
                      "(KP.mediapipeFacemesh,{maxFaces:1,shouldLoadIrisModel:false})")
    notes.append("  iris: disabled (unused — predictIrises is false)"
                 if src != before else "  iris: already disabled")
    return src, notes


def main() -> int:
    if not VENDOR.exists():
        print(f"missing {VENDOR}", file=sys.stderr)
        return 1
    src = VENDOR.read_text(encoding="utf-8")
    already = MARKER in src

    if "--check" in sys.argv:
        print("patched" if already else "NOT patched")
        return 0 if already else 1

    if already:
        print("already patched; nothing to do")
        return 0

    out, notes = apply(src)
    backup = VENDOR.with_suffix(".orig.js")
    if not backup.exists():
        backup.write_text(src, encoding="utf-8")
        print(f"saved pristine copy -> {backup.name}")
    VENDOR.write_text(out, encoding="utf-8")
    print("patched vendor/webgazer.js")
    print("\n".join(notes))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
