#!/usr/bin/env python3
"""Write flat grey ChatGPT Shadow PNG icons."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "icons"
SIZES = (16, 32, 48, 128)


def png(width: int, height: int, pixels: list[tuple[int, int, int, int]]) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b""
    for y in range(height):
        raw += b"\x00"
        for x in range(width):
            raw += bytes(pixels[y * width + x])
    return b"".join(
        [
            b"\x89PNG\r\n\x1a\n",
            chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)),
            chunk(b"IDAT", zlib.compress(raw, 9)),
            chunk(b"IEND", b""),
        ]
    )


def icon(size: int) -> bytes:
    pixels = []
    mid = (size - 1) / 2
    radius = size * 0.38
    for y in range(size):
        for x in range(size):
            dx = x - mid
            dy = y - mid
            inside = dx * dx + dy * dy <= radius * radius
            if inside:
                pixels.append((68, 68, 68, 255))
            else:
                pixels.append((0, 0, 0, 0))
    return png(size, size, pixels)


def main() -> None:
    ROOT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        (ROOT / f"icon-{size}.png").write_bytes(icon(size))


if __name__ == "__main__":
    main()
