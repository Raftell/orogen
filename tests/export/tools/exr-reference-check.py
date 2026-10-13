#!/usr/bin/env python3
# Reads an OpenEXR file that Orogen wrote with the OpenEXR reference library itself, and compares every sample
# with the same field written as a headerless .r32 (export-unreal.md 4.5, 10.2). Run by hand; no test calls it.
#
#   python3 tests/export/tools/exr-reference-check.py <file.exr> <file.r32>
#
# The two files come from one build: two io/export-field nodes on one output, with the formats OpenEXR and
# Raw 32-bit float. The library is the shared one of the system (libOpenEXR 3.1 on Ubuntu 24.04), called through
# ctypes, so nothing has to be installed beside Python 3:
#   1. libOpenEXRCore, the C core: the header's storage, compression, line order and windows, the chunk table,
#      and the bytes of every scan line.
#   2. libOpenEXR, the C++ library, through its C interface ImfCRgbaFile: Header::sanityCheck and RgbaInputFile,
#      which returns a luminance file as halves in red, green and blue.
# Exit code 0: every sample is the one of the .r32.
import array
import ctypes
import sys

if len(sys.argv) != 3:
    raise SystemExit(__doc__ or 'usage: exr-reference-check.py <file.exr> <file.r32>')
exr_path, r32_path = sys.argv[1], sys.argv[2]
raw = open(r32_path, 'rb').read()


def library(*names):
    for name in names:
        try:
            return ctypes.CDLL(name)
        except OSError:
            pass
    raise SystemExit('none of %s can be loaded: the OpenEXR 3 reference library is not installed' % ', '.join(names))


core = library('libOpenEXRCore-3_1.so.30', 'libOpenEXRCore-3_2.so.31', 'libOpenEXRCore.so')
imf = library('libOpenEXR-3_1.so.30', 'libOpenEXR-3_2.so.31', 'libOpenEXR.so')


class Box2i(ctypes.Structure):
    _fields_ = [('min_x', ctypes.c_int32), ('min_y', ctypes.c_int32), ('max_x', ctypes.c_int32), ('max_y', ctypes.c_int32)]


class ChunkInfo(ctypes.Structure):   # exr_chunk_info_t of openexr_chunkio.h
    _fields_ = [('idx', ctypes.c_int32), ('start_x', ctypes.c_int32), ('start_y', ctypes.c_int32), ('height', ctypes.c_int32),
                ('width', ctypes.c_int32), ('level_x', ctypes.c_uint8), ('level_y', ctypes.c_uint8), ('type', ctypes.c_uint8),
                ('compression', ctypes.c_uint8), ('data_offset', ctypes.c_uint64), ('packed_size', ctypes.c_uint64),
                ('unpacked_size', ctypes.c_uint64), ('sample_count_data_offset', ctypes.c_uint64),
                ('sample_count_table_size', ctypes.c_uint64)]


def ok(result, what):
    if result != 0:
        raise SystemExit('libOpenEXRCore: %s failed with %d' % (what, result))


failed = False
ctx = ctypes.c_void_p()
core.exr_start_read.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_char_p, ctypes.c_void_p]
core.exr_read_scanline_chunk_info.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ChunkInfo)]
core.exr_read_chunk.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ChunkInfo), ctypes.c_void_p]
ok(core.exr_start_read(ctypes.byref(ctx), exr_path.encode(), None), 'exr_start_read')
parts, storage, compression, order = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
data, display = Box2i(), Box2i()
ok(core.exr_get_count(ctx, ctypes.byref(parts)), 'exr_get_count')
ok(core.exr_get_storage(ctx, 0, ctypes.byref(storage)), 'exr_get_storage')
ok(core.exr_get_compression(ctx, 0, ctypes.byref(compression)), 'exr_get_compression')
ok(core.exr_get_lineorder(ctx, 0, ctypes.byref(order)), 'exr_get_lineorder')
ok(core.exr_get_data_window(ctx, 0, ctypes.byref(data)), 'exr_get_data_window')
ok(core.exr_get_display_window(ctx, 0, ctypes.byref(display)), 'exr_get_display_window')
w, h = data.max_x - data.min_x + 1, data.max_y - data.min_y + 1
print('core: %d part, storage %d (0 is scan line), compression %d (0 is none), line order %d (0 is increasing y), data window %d x %d'
      % (parts.value, storage.value, compression.value, order.value, w, h))
if (parts.value, storage.value, compression.value, order.value) != (1, 0, 0, 0):
    raise SystemExit('the header is not that of export-unreal.md 4.5')
if (data.min_x, data.min_y, display.min_x, display.min_y, display.max_x, display.max_y) != (0, 0, 0, 0, data.max_x, data.max_y):
    raise SystemExit('the data window and the display window are not (0, 0) to (w - 1, h - 1)')
if len(raw) != 4 * w * h:
    raise SystemExit('%s holds %d bytes, not the %d of %d x %d floats' % (r32_path, len(raw), 4 * w * h, w, h))
line = ctypes.create_string_buffer(4 * w)
differing = 0
for y in range(h):
    info = ChunkInfo()
    ok(core.exr_read_scanline_chunk_info(ctx, 0, y, ctypes.byref(info)), 'exr_read_scanline_chunk_info')
    if (info.start_y, info.height, info.width, info.packed_size, info.unpacked_size) != (y, 1, w, 4 * w, 4 * w):
        raise SystemExit('chunk %d is not one scan line of %d floats' % (y, w))
    ok(core.exr_read_chunk(ctx, 0, ctypes.byref(info), line), 'exr_read_chunk')
    if line.raw != raw[4 * w * y: 4 * w * (y + 1)]:
        differing += 1
print('core: %d of %d scan lines differ from the .r32' % (differing, h))
failed = failed or differing != 0
ok(core.exr_finish(ctypes.byref(ctx)), 'exr_finish')

imf.ImfOpenInputFile.restype = ctypes.c_void_p
imf.ImfOpenInputFile.argtypes = [ctypes.c_char_p]
imf.ImfInputHeader.restype = ctypes.c_void_p
imf.ImfInputHeader.argtypes = [ctypes.c_void_p]
imf.ImfHeaderDataWindow.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(ctypes.c_int)] * 4
imf.ImfInputSetFrameBuffer.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t]
imf.ImfInputReadPixels.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int]
imf.ImfInputChannels.argtypes = [ctypes.c_void_p]
imf.ImfCloseInputFile.argtypes = [ctypes.c_void_p]
imf.ImfErrorMessage.restype = ctypes.c_char_p
imf.ImfFloatToHalfArray.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
handle = imf.ImfOpenInputFile(exr_path.encode())
if not handle:
    raise SystemExit('libOpenEXR: ' + imf.ImfErrorMessage().decode())
x0, y0, x1, y1 = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
imf.ImfHeaderDataWindow(imf.ImfInputHeader(handle), ctypes.byref(x0), ctypes.byref(y0), ctypes.byref(x1), ctypes.byref(y1))
channels = imf.ImfInputChannels(handle)
print('RgbaInputFile: data window (%d, %d) to (%d, %d), channels %#x (0x10 is IMF_WRITE_Y)' % (x0.value, y0.value, x1.value, y1.value, channels))
if (x0.value, y0.value, x1.value, y1.value, channels) != (0, 0, w - 1, h - 1, 0x10):
    raise SystemExit('the file is not one luminance channel over (0, 0) to (w - 1, h - 1)')
# 8 bytes a pixel: the first rows, a block in the middle and the last rows of a large image, all of a small one.
rows = min(h, 256)
differing = checked = 0
for start in sorted({0, max(0, h // 2 - rows // 2), h - rows}):
    pixels = (ctypes.c_uint16 * (4 * w * rows))()
    # The frame buffer is addressed as base + x * xStride + y * yStride, in pixels, for the x and y of the file.
    if not imf.ImfInputSetFrameBuffer(handle, ctypes.addressof(pixels) - start * w * 8, 1, w):
        raise SystemExit('libOpenEXR: ' + imf.ImfErrorMessage().decode())
    if not imf.ImfInputReadPixels(handle, start, start + rows - 1):
        raise SystemExit('libOpenEXR: ' + imf.ImfErrorMessage().decode())
    floats = (ctypes.c_float * (w * rows)).from_buffer_copy(raw[4 * w * start: 4 * w * (start + rows)])
    halves = (ctypes.c_uint16 * (w * rows))()
    imf.ImfFloatToHalfArray(w * rows, floats, halves)
    found, expected = array.array('H', bytes(pixels)), array.array('H', bytes(halves))
    for i in range(w * rows):
        checked += 1
        if found[4 * i] != expected[i] or found[4 * i + 1] != expected[i] or found[4 * i + 2] != expected[i]:
            differing += 1
print('RgbaInputFile: %d of %d samples differ from the .r32 rounded to half' % (differing, checked))
failed = failed or differing != 0
imf.ImfCloseInputFile(handle)
sys.exit(1 if failed else 0)
