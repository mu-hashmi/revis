"""Mandelbrot renderer.

Agents optimize this file only. The benchmark and correctness artifacts are fixed.
"""

from __future__ import annotations


def render_mandelbrot(
    width: int,
    height: int,
    max_iter: int,
    x_min: float,
    x_max: float,
    y_min: float,
    y_max: float,
) -> bytes:
    """Return grayscale Mandelbrot escape counts as row-major bytes."""

    pixels = bytearray(width * height)

    x_scale = (x_max - x_min) / (width - 1)
    y_scale = (y_max - y_min) / (height - 1)

    index = 0

    for y in range(height):
        cy = y_min + (y * y_scale)

        for x in range(width):
            cx = x_min + (x * x_scale)

            zx = 0.0
            zy = 0.0
            iteration = 0

            while iteration < max_iter and ((zx * zx) + (zy * zy)) <= 4.0:
                next_zx = (zx * zx) - (zy * zy) + cx
                zy = (2.0 * zx * zy) + cy
                zx = next_zx
                iteration += 1

            pixels[index] = iteration if iteration < 256 else 255
            index += 1

    return bytes(pixels)
