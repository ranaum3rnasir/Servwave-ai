/**
 * #2029 slice 2 — normalising a picked photo before it is uploaded.
 *
 * A salesperson picks a photo — JPG, JPEG, PNG or HEIC — and what reaches storage is always a
 * JPEG at a size suited to a document rather than a camera sensor. Conversion and downscaling
 * happen in the browser, so it is not a step anyone can forget and the file is smaller before it
 * leaves the phone. (A server-side decode was investigated and rejected: sharp's prebuilt binary
 * reads HEIC metadata but cannot decode HEIC pixels, having been compiled without the HEVC codec.)
 *
 * The decisions — what to resize to, what to preserve, what to emit, what to say when a file
 * cannot be read — are tested here against an injected pipeline. The real pipeline is a thin
 * canvas wrapper with no decisions in it, which is the half jsdom cannot run.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  normaliseImageForUpload,
  NORMALISED_MAX_EDGE,
  MAX_SOURCE_BYTES,
  type ImagePipeline,
} from './image-normalise';

/** A pipeline that decodes to whatever dimensions the test names, and records the encode call. */
function fakePipeline(width: number, height: number) {
  const encode = vi.fn(async (_src: unknown, w: number, h: number) =>
    new Blob([new Uint8Array(w * h)], { type: 'image/jpeg' }),
  );
  const pipeline: ImagePipeline = {
    decode: async () => ({ width, height, source: {} as CanvasImageSource }),
    encodeJpeg: encode,
  };
  return { pipeline, encode };
}

function pick(name: string, type: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

describe('normalising a picked photo', () => {
  it('stores a JPEG whatever was picked', async () => {
    const { pipeline } = fakePipeline(400, 300);

    const picks: Array<[string, string]> = [
      ['photo.jpg', 'image/jpeg'],
      ['photo.jpeg', 'image/jpeg'],
      ['photo.png', 'image/png'],
      ['IMG_0421.HEIC', 'image/heic'],
    ];
    for (const [name, type] of picks) {
      const out = await normaliseImageForUpload(pick(name, type), pipeline);
      expect(out.file.type).toBe('image/jpeg');
      expect(out.file.name).toMatch(/\.jpg$/);
    }
  });

  it('names the output after the file the salesperson picked', async () => {
    const { pipeline } = fakePipeline(400, 300);

    const out = await normaliseImageForUpload(pick('IMG_0421.HEIC', 'image/heic'), pipeline);

    expect(out.file.name).toBe('IMG_0421.jpg');
  });

  it('downscales an oversized photo to within the target edge', async () => {
    const { pipeline, encode } = fakePipeline(4032, 3024);

    const out = await normaliseImageForUpload(pick('big.jpg', 'image/jpeg'), pipeline);

    expect(Math.max(out.width, out.height)).toBe(NORMALISED_MAX_EDGE);
    expect(encode).toHaveBeenCalledWith(expect.anything(), out.width, out.height, expect.any(Number));
  });

  it('preserves the aspect ratio — no distortion', async () => {
    const { pipeline } = fakePipeline(4032, 3024); // 4:3

    const out = await normaliseImageForUpload(pick('big.jpg', 'image/jpeg'), pipeline);

    expect(out.width / out.height).toBeCloseTo(4032 / 3024, 2);
  });

  it('downscales a portrait photo by its longest edge, not its width', async () => {
    const { pipeline } = fakePipeline(3024, 4032);

    const out = await normaliseImageForUpload(pick('tall.jpg', 'image/jpeg'), pipeline);

    expect(out.height).toBe(NORMALISED_MAX_EDGE);
    expect(out.width).toBeLessThan(out.height);
  });

  it('leaves a photo already within the target alone rather than upscaling it', async () => {
    const { pipeline } = fakePipeline(200, 150);

    const out = await normaliseImageForUpload(pick('small.jpg', 'image/jpeg'), pipeline);

    expect(out).toMatchObject({ width: 200, height: 150 });
  });

  it('says clearly when the file cannot be read, rather than uploading something unusable', async () => {
    const pipeline: ImagePipeline = {
      decode: async () => { throw new Error('nope'); },
      encodeJpeg: async () => new Blob(),
    };

    await expect(normaliseImageForUpload(pick('broken.jpg', 'image/jpeg'), pipeline))
      .rejects.toThrow(/could not be read/i);
  });

  it('refuses a file over the eight-megabyte input cap before it is decoded', async () => {
    const { pipeline } = fakePipeline(400, 300);
    const decode = vi.spyOn(pipeline, 'decode');

    await expect(
      normaliseImageForUpload(pick('huge.jpg', 'image/jpeg', MAX_SOURCE_BYTES + 1), pipeline),
    ).rejects.toThrow(/8 ?MB/i);
    expect(decode).not.toHaveBeenCalled();
  });

  it('refuses a file that is not an image at all', async () => {
    const { pipeline } = fakePipeline(400, 300);

    await expect(normaliseImageForUpload(pick('contract.pdf', 'application/pdf'), pipeline))
      .rejects.toThrow(/JPG, PNG or HEIC/i);
  });
});
