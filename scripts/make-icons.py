#!/usr/bin/env python3
"""Generate full app icons and transparent browser-toolbar icons.

Install Pillow once with `python3 -m pip install Pillow`, then run this script.
Each supplied original canvas is preserved.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "icons"
SIZES = (16, 32, 48, 128)


def main():
    for prefix in ("icon", "toolbar"):
        with Image.open(ROOT / f"{prefix}-source.png") as source:
            artwork = source.convert("RGBA")
            if artwork.width != artwork.height:
                raise ValueError("Icon source must have a square canvas")
            for size in SIZES:
                artwork.resize((size, size), Image.Resampling.LANCZOS).save(
                    ROOT / f"{prefix}-{size}.png", optimize=True
                )


if __name__ == "__main__":
    main()
