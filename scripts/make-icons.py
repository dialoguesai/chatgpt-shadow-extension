#!/usr/bin/env python3
"""Resize the supplied transparent artwork into Chromium extension icons.

Install Pillow once with `python3 -m pip install Pillow`, then run this script.
The original square canvas and alpha channel are preserved.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "icons"
SIZES = (16, 32, 48, 128)


def main():
    with Image.open(ROOT / "icon-source.png") as source:
        artwork = source.convert("RGBA")
        if artwork.width != artwork.height:
            raise ValueError("Icon source must have a square canvas")
        for size in SIZES:
            artwork.resize((size, size), Image.Resampling.LANCZOS).save(
                ROOT / f"icon-{size}.png", optimize=True
            )


if __name__ == "__main__":
    main()
