"""Fixed benchmark harness for the Revis Mandelbrot demo.

This file is intentionally read-only for agents. It defines the target image,
validates exact output bytes, and measures wall-clock render time only.
"""

from __future__ import annotations

import argparse
import hashlib
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter

from render import render_mandelbrot

WIDTH = 2000
HEIGHT = 2000
MAX_ITER = 255
X_MIN = -2.25
X_MAX = 0.75
Y_MIN = -1.5
Y_MAX = 1.5
REFERENCE_SHA_PATH = Path(__file__).with_name("reference.sha256")
SAMPLE_COORDINATES = (
    (0, 0),
    (321, 777),
    (777, 321),
    (1000, 1000),
    (1500, 412),
    (1999, 1999),
)


@dataclass(frozen=True)
class BenchmarkResult:
    """One benchmark run over the fixed Mandelbrot target."""

    elapsed_seconds: float
    sha256: str
    correct: bool
    pixels: bytes


def benchmark_once() -> BenchmarkResult:
    """Render the fixed target once and validate its checksum."""

    started = perf_counter()
    pixels = render_mandelbrot(
        WIDTH,
        HEIGHT,
        MAX_ITER,
        X_MIN,
        X_MAX,
        Y_MIN,
        Y_MAX,
    )
    elapsed_seconds = perf_counter() - started

    digest = hashlib.sha256(pixels).hexdigest()
    reference_sha = REFERENCE_SHA_PATH.read_text(encoding="utf-8").strip()

    return BenchmarkResult(
        elapsed_seconds=elapsed_seconds,
        sha256=digest,
        correct=digest == reference_sha,
        pixels=pixels,
    )


def sample_pixel_values(pixels: bytes) -> list[tuple[tuple[int, int], int]]:
    """Return fixed sample pixels for quick human spot-checking."""

    samples: list[tuple[tuple[int, int], int]] = []

    for x, y in SAMPLE_COORDINATES:
        index = (y * WIDTH) + x
        samples.append(((x, y), pixels[index]))

    return samples


def write_png(path: Path, pixels: bytes) -> None:
    """Write the grayscale buffer as a colorized PNG for human viewing."""

    rows = bytearray()

    for y in range(HEIGHT):
        rows.append(0)

        row_start = y * WIDTH
        row = pixels[row_start : row_start + WIDTH]

        for value in row:
            rows.extend(colorize(value))

    compressed = zlib.compress(bytes(rows), level=9)

    path.write_bytes(
        b"".join(
            [
                b"\x89PNG\r\n\x1a\n",
                png_chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0)),
                png_chunk(b"IDAT", compressed),
                png_chunk(b"IEND", b""),
            ]
        )
    )


def colorize(value: int) -> bytes:
    """Map one escape count to a bright demo palette."""

    if value == 255:
        return bytes((0, 0, 0))

    if value < 32:
        t = value / 31.0
        return interpolate((6, 12, 40), (30, 86, 166), t)

    if value < 96:
        t = (value - 32) / 63.0
        return interpolate((30, 86, 166), (64, 196, 255), t)

    if value < 160:
        t = (value - 96) / 63.0
        return interpolate((64, 196, 255), (255, 214, 102), t)

    t = (value - 160) / 94.0
    return interpolate((255, 214, 102), (255, 94, 58), t)


def interpolate(start: tuple[int, int, int], end: tuple[int, int, int], t: float) -> bytes:
    """Blend two RGB colors with a scalar in the inclusive range [0, 1]."""

    red = round(start[0] + ((end[0] - start[0]) * t))
    green = round(start[1] + ((end[1] - start[1]) * t))
    blue = round(start[2] + ((end[2] - start[2]) * t))

    return bytes((red, green, blue))


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    """Return one PNG chunk with length and CRC."""

    crc = zlib.crc32(kind)
    crc = zlib.crc32(payload, crc)

    return (
        struct.pack(">I", len(payload))
        + kind
        + payload
        + struct.pack(">I", crc & 0xFFFFFFFF)
    )


def parse_args() -> argparse.Namespace:
    """Parse optional operator-facing benchmark flags."""

    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--write-png",
        type=Path,
        help="Write the rendered output as a PNG after benchmarking.",
    )
    return parser.parse_args()


def main() -> int:
    """Run the fixed benchmark and print parseable results."""

    args = parse_args()
    result = benchmark_once()

    print(f"elapsed_seconds={result.elapsed_seconds:.6f}")
    print(f"correct={'true' if result.correct else 'false'}")
    print(f"sha256={result.sha256}")

    for (x, y), value in sample_pixel_values(result.pixels):
        print(f"sample_pixel[{x},{y}]={value}")

    if args.write_png is not None:
        write_png(args.write_png, result.pixels)
        print(f"png_path={args.write_png}")

    return 0 if result.correct else 1


if __name__ == "__main__":
    raise SystemExit(main())
