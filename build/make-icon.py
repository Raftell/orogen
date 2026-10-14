#!/usr/bin/env python3
"""Makes build/icon.png and build/icon.ico from build/icon.svg.

    python3 build/make-icon.py

Needs what the development machine has: GdkPixbuf with its SVG loader (python3-gi) and Pillow. The two outputs are
committed, so nothing of this runs in a build. electron-builder takes build/icon.ico for the Windows package
(electron-builder.yml).

The .ico holds the sizes Windows asks for. The small ones are stored as bitmaps and the large ones as PNG, which is
the mix every reader of the format accepts.
"""
import io
import struct
import sys
from pathlib import Path

import gi

gi.require_version('GdkPixbuf', '2.0')
from gi.repository import GdkPixbuf  # noqa: E402
from PIL import Image  # noqa: E402

HERE = Path(__file__).resolve().parent
SIZES = [16, 24, 32, 48, 64, 128, 256]
BITMAP_UP_TO = 48


def bitmap(image):
    """A 32-bit device-independent bitmap as an .ico stores it: rows from the bottom, then an empty 1-bit mask."""
    size = image.width
    pixels = image.tobytes('raw', 'BGRA')
    rows = [pixels[y * size * 4:(y + 1) * size * 4] for y in range(size)]
    mask_row = bytes(((size + 31) // 32) * 4)
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, size * size * 4 + len(mask_row) * size, 0, 0, 0, 0)
    return header + b''.join(reversed(rows)) + mask_row * size


def png(image):
    out = io.BytesIO()
    image.save(out, format='PNG', optimize=True)
    return out.getvalue()


def main():
    pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(str(HERE / 'icon.svg'), 1024, 1024)
    pixbuf.savev(str(HERE / 'icon.png'), 'png', [], [])
    source = Image.open(HERE / 'icon.png').convert('RGBA')

    entries = []
    for size in SIZES:
        image = source.resize((size, size), Image.LANCZOS)
        entries.append((size, bitmap(image) if size <= BITMAP_UP_TO else png(image)))

    offset = 6 + 16 * len(entries)
    directory = struct.pack('<HHH', 0, 1, len(entries))
    for size, data in entries:
        directory += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    (HERE / 'icon.ico').write_bytes(directory + b''.join(data for _, data in entries))

    # Read back: a file that only its writer can read is no icon. Every size decodes, and the directory says 256,
    # which is what electron-builder requires of a Windows icon.
    held = sorted(Image.open(HERE / 'icon.ico').ico.sizes())
    wanted = [(size, size) for size in SIZES]
    if held != wanted:
        sys.exit(f'build/icon.ico holds {held}, not {wanted}')
    for size in SIZES:
        frame = Image.open(HERE / 'icon.ico')
        frame.size = (size, size)
        frame.load()
        if frame.size != (size, size) or frame.convert('RGBA').getpixel((size // 2, size // 2))[3] != 255:
            sys.exit(f'build/icon.ico: the {size} x {size} image does not decode to an opaque middle')
    written = (HERE / 'icon.ico').read_bytes()
    if written[:4] != b'\x00\x00\x01\x00' or max(written[6 + 16 * i] or 256 for i in range(len(SIZES))) != 256:
        sys.exit('build/icon.ico: the directory does not name a 256 x 256 image')
    print(f'build/icon.png 1024 x 1024; build/icon.ico with {", ".join(str(size) for size in SIZES)}')


if __name__ == '__main__':
    main()
