#!/usr/bin/env python3
"""Print the pixel dimensions of one or more PNG files."""
import struct, sys

def png_size(path):
    with open(path, 'rb') as f:
        magic = f.read(8)
        if magic != b'\x89PNG\r\n\x1a\n':
            return None, None
        f.read(4)           # chunk length
        f.read(4)           # IHDR
        w, h = struct.unpack('>II', f.read(8))
        return w, h

for path in sys.argv[1:]:
    w, h = png_size(path)
    if w is None:
        print(f'{path}: not a PNG')
    else:
        import os
        size = os.path.getsize(path)
        print(f'{path}: {w}x{h} ({size:,} bytes)')
