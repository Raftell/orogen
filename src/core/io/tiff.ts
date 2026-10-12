import { fromArrayBuffer } from 'geotiff';
import { checkImageSize, exactBuffer, reasonOf } from './image.ts';
import type { DecodedImage } from './image.ts';

// TIFF Compression codes this decoder accepts: none, LZW, Deflate (both codes) and PackBits.
const COMPRESSIONS: ReadonlySet<number> = new Set([1, 5, 8, 32946, 32773]);
// PhotometricInterpretation: WhiteIsZero, BlackIsZero and RGB hold plain samples. Palette, CMYK, YCbCr and the others do not.
const PHOTOMETRICS: ReadonlySet<number> = new Set([0, 1, 2]);

const UNSIGNED = 1;
const SIGNED = 2;
const FLOAT = 3;

function cannotRead(error: unknown): Error {
  // A read past the end of the bytes surfaces from the library as a RangeError of DataView or of a typed array.
  if (error instanceof RangeError) return new Error('TIFF file is truncated');
  return new Error(`TIFF file cannot be decoded: ${reasonOf(error)}`);
}

/** The first image of the file (export-unreal.md 4.7). Uses geotiff, whose reading is asynchronous. */
export async function decodeTiff(bytes: Uint8Array): Promise<DecodedImage> {
  const buffer = exactBuffer(bytes);
  let image;
  let littleEndian;
  try {
    const tiff = await fromArrayBuffer(buffer);
    littleEndian = tiff.littleEndian;
    // geotiff 3.0.5 reads a strip or tile table that it loads lazily as little-endian, whatever the byte order of
    // the file. An eager parser reads every table together with the directory, in the file's byte order.
    tiff.parser.eager = true;
    image = await tiff.getImage(0);
  } catch (error) {
    throw cannotRead(error);
  }

  const width = image.getWidth();
  const height = image.getHeight();
  const samples = image.getSamplesPerPixel();
  if (samples !== 1 && samples !== 3 && samples !== 4) {
    throw new Error(`TIFF has ${samples} samples per pixel; 1, 3 and 4 are read`);
  }
  checkImageSize(width, height, samples);

  const directory = image.getFileDirectory();
  const compression: number = directory.getValue('Compression') ?? 1;
  if (!COMPRESSIONS.has(compression)) {
    throw new Error(`TIFF compression ${compression} is not supported; uncompressed, PackBits, LZW and Deflate are read`);
  }
  const photometric: number | undefined = directory.getValue('PhotometricInterpretation');
  if (photometric !== undefined && !PHOTOMETRICS.has(photometric)) {
    throw new Error(`TIFF photometric interpretation ${photometric} is not supported; grey and RGB are read`);
  }

  const bits = image.getBitsPerSample(0);
  const format = image.getSampleFormat(0);
  for (let s = 1; s < samples; s++) {
    if (image.getBitsPerSample(s) !== bits || image.getSampleFormat(s) !== format) {
      throw new Error('TIFF samples differ in size or type; every sample of a pixel must have the same');
    }
  }
  if (format === FLOAT) {
    if (bits !== 32) throw new Error(`TIFF has ${bits}-bit float samples; 32-bit float is read`);
  } else if (format === UNSIGNED || format === SIGNED) {
    if (bits !== 8 && bits !== 16 && bits !== 32) throw new Error(`TIFF has ${bits}-bit integer samples; 8, 16 and 32 bits are read`);
  } else {
    throw new Error(`TIFF sample format ${format} is not supported; integers and 32-bit float are read`);
  }

  // The library undoes horizontal differencing on the bytes as a little-endian machine sees them, rebuilds the
  // floats of predictor 3 in little-endian order, and applies no other predictor at all: each of these would give
  // wrong values without an error.
  const predictor: number = (await directory.loadValue('Predictor')) ?? 1;
  if (predictor !== 1 && predictor !== 2 && predictor !== 3) {
    throw new Error(`TIFF predictor ${predictor} is not supported; horizontal differencing and the floating-point predictor are read`);
  }
  if (!littleEndian && (predictor === 3 || (predictor === 2 && bits > 8))) {
    throw new Error(`TIFF is big-endian and uses predictor ${predictor} on ${bits}-bit samples; that is read in little-endian files only`);
  }

  let raster;
  try {
    // The library fills a strip that lies beyond the end of the bytes with whatever it finds: check first.
    const tiled = !directory.hasTag('StripOffsets');
    const offsets: ArrayLike<number | bigint> | undefined = await directory.loadValue(tiled ? 'TileOffsets' : 'StripOffsets');
    const counts: ArrayLike<number | bigint> | undefined = await directory.loadValue(tiled ? 'TileByteCounts' : 'StripByteCounts');
    if (!offsets || !counts || offsets.length !== counts.length) throw new Error('the strip or tile table is missing');
    for (let i = 0; i < offsets.length; i++) {
      if (Number(offsets[i]) + Number(counts[i]) > buffer.byteLength) throw new RangeError('a strip or tile lies beyond the end of the file');
    }
    raster = await image.readRasters({ interleave: true });
  } catch (error) {
    throw cannotRead(error);
  }
  const count = width * height * samples;
  if (raster.length !== count) throw new Error('TIFF file is truncated');

  if (raster instanceof Float32Array) {
    for (let i = 0; i < count; i++) if (!Number.isFinite(raster[i])) raster[i] = 0;
    return { width, height, channels: samples, data: raster };
  }
  // k-bit integers: unsigned as v / (2^k - 1), signed shifted by 2^(k-1) first.
  const max = 2 ** bits - 1;
  const bias = format === SIGNED ? 2 ** (bits - 1) : 0;
  const data = new Float32Array(count);
  for (let i = 0; i < count; i++) data[i] = (Number(raster[i]) + bias) / max;
  return { width, height, channels: samples, data };
}
