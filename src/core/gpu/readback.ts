import { deviceLostError, type GpuContext } from './device.ts';
import { CHANNELS } from './field.ts';
import { BYTES_PER_TEXEL, type PoolTexture } from './pool.ts';
import { guarded } from './scopes.ts';
import type { CommandStream } from './stream.ts';
import { TEXEL_ENCODING, unpackTexels } from './texels.ts';

/** The one implementation behind ctx.read, Engine.read and the statistics readback (runtime.md 5.7). */
export interface Readback {
  /**
   * The texture's contents as float32, row-major and tightly packed, whatever its format; `rows` limits it to
   * rows y0 <= y < y1. Encodes for the stream's current owner, waits for all earlier work, and serialises with
   * other reads. Rejects with the abort reason of `signal` or DeviceLostError.
   */
  read(texture: PoolTexture, rows?: readonly [y0: number, y1: number], signal?: AbortSignal): Promise<Float32Array<ArrayBuffer>>;
  /** Destroys the staging buffer. Not called for a lost device. */
  dispose(): void;
}

export interface ReadbackOptions {
  readonly gpu: GpuContext;
  /** `current` and `use`: a read of several strips encodes after an await, and must do so for the owner that asked. */
  readonly stream: Pick<CommandStream, 'encode' | 'flush' | 'track' | 'use' | 'current'>;
  /** The ledger, for the staging buffer (runtime.md 2.4). */
  readonly reserve: (bytes: number, label: string) => { release(): void };
  /** The most bytes one strip copies; 64 MiB (runtime.md 5.7 rule 1). A test passes less to read small fields in several strips. */
  readonly stripBytes?: number;
}

/** runtime.md 5.7 rules 1 and 2. */
const STAGING_MAX_BYTES = 67_108_864;
/** The staging buffer grows in steps of this size, so a small read does not commit the whole 64 MiB to the ledger. */
const STAGING_STEP_BYTES = 65_536;

const align256 = (bytes: number): number => Math.ceil(bytes / 256) * 256;

export function createReadback(opts: ReadbackOptions): Readback {
  const { gpu, stream } = opts;
  const device = gpu.device;
  const stripBytes = Math.min(opts.stripBytes ?? STAGING_MAX_BYTES, STAGING_MAX_BYTES);
  let staging: { readonly buffer: GPUBuffer; readonly size: number; readonly reservation: { release(): void } } | null = null;
  /** Reads are serialised: the one staging buffer is mapped by one read at a time. */
  let busy = 0;
  let tail: Promise<unknown> = Promise.resolve();

  function stagingBuffer(bytes: number): GPUBuffer {
    if (!staging || staging.size < bytes) {
      if (staging) {
        staging.buffer.destroy();
        staging.reservation.release();
      }
      const size = Math.min(Math.ceil(bytes / STAGING_STEP_BYTES) * STAGING_STEP_BYTES, Math.max(STAGING_MAX_BYTES, bytes));
      const made = guarded(device, () => device.createBuffer({ label: 'orogen readback staging', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }));
      stream.track(made.scopes);
      staging = { buffer: made.value, size, reservation: opts.reserve(size, 'readback staging') };
    }
    return staging.buffer;
  }

  async function read(
    owner: NonNullable<CommandStream['current']>, texture: PoolTexture, y0: number, y1: number, signal: AbortSignal | undefined,
  ): Promise<Float32Array<ArrayBuffer>> {
    const channels = CHANNELS[texture.kind];
    const encoding = TEXEL_ENCODING[texture.format]!;
    const rowBytes = texture.width * BYTES_PER_TEXEL[texture.format as keyof typeof BYTES_PER_TEXEL];
    const paddedRow = align256(rowBytes);
    const rowsPerStrip = Math.max(1, Math.floor(stripBytes / paddedRow));
    const rowFloats = texture.width * channels;
    const out = new Float32Array(rowFloats * (y1 - y0));

    for (let y = y0; y < y1; y += rowsPerStrip) {
      const rows = Math.min(rowsPerStrip, y1 - y);
      const bytes = paddedRow * rows;
      // After the first strip this runs behind an await: the owner that asked is made current again.
      stream.use(owner);
      const buffer = stagingBuffer(bytes);
      stream.encode((encoder) => encoder.copyTextureToBuffer(
        { texture: texture.texture, origin: [0, y, 0] }, { buffer, bytesPerRow: paddedRow, rowsPerImage: rows }, [texture.width, rows, 1],
      ));
      await stream.flush();
      signal?.throwIfAborted();
      try {
        await buffer.mapAsync(GPUMapMode.READ, 0, bytes);
      } catch (thrown) {
        // Measured on Dawn: mapAsync is the one call that rejects on a lost device.
        if (gpu.lost) throw deviceLostError(gpu);
        throw thrown;
      }
      try {
        if (gpu.lost) throw deviceLostError(gpu);
        signal?.throwIfAborted();
        const mapped = buffer.getMappedRange(0, bytes);
        for (let r = 0; r < rows; r++) {
          unpackTexels(encoding, mapped, r * paddedRow, rowFloats, out, (y - y0 + r) * rowFloats);
        }
      } finally {
        buffer.unmap();
      }
    }
    return out;
  }

  return {
    read(texture, rows, signal) {
      const [y0, y1] = rows ?? [0, texture.height];
      if (!Number.isInteger(y0) || !Number.isInteger(y1) || y0 < 0 || y1 > texture.height || y0 >= y1) {
        return Promise.reject(new RangeError(`rows [${y0}, ${y1}) are not rows of a texture ${texture.height} high`));
      }
      const owner = stream.current;
      if (!owner) return Promise.reject(new Error('No stream owner is current: call use(owner) before reading'));
      // With no read in progress the first copy is encoded now, in the order of the calls (engine.md 3.11).
      const start = (): Promise<Float32Array<ArrayBuffer>> => read(owner, texture, y0, y1, signal);
      const result = busy === 0 ? start() : tail.then(start);
      busy++;
      tail = result.then(() => { busy--; }, () => { busy--; });
      return result;
    },
    dispose() {
      if (staging) {
        staging.buffer.destroy();
        staging.reservation.release();
        staging = null;
      }
    },
  };
}
