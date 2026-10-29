/**
 * `prepareItemImage` — the catalog item picture's own client-side path.
 *
 * Item pictures now go to storage, so what the dialog hands the uploader has to be a FILE in a
 * type the item-image endpoint stores (JPEG or PNG), not the WebP data URI the shared inline
 * helper produces for the brand / category / group dialogs. Those four keep `prepareImageUpload`
 * exactly as it is; only item images moved.
 *
 * Two properties carried over from the inline helper and pinned here because losing either is a
 * silent regression: a full-resolution phone photo is still ACCEPTED (downscaled, not refused),
 * and a vector is still passed through WITHOUT rasterisation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageUploadError, MAX_SOURCE_BYTES } from '@/lib/image-upload';
import { prepareItemImage } from '@/lib/item-image-upload';

const file = (bytes: number, type: string, name = 'photo.jpg') =>
  new File([new Uint8Array(bytes)], name, { type });

/**
 * Stand in the browser bits jsdom does not implement: a decoder that answers with a big bitmap,
 * and a canvas that encodes to a fixed, much smaller payload. Without this the module takes its
 * documented "cannot rasterize" fallback, which is a different branch.
 */
function stubRasterizer(encoded = `data:image/jpeg;base64,${'A'.repeat(400)}`) {
  const drawImage = vi.fn();
  const toDataURL = vi.fn(() => encoded);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 4032, height: 3024 })));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage,
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(toDataURL);
  return { drawImage, toDataURL };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('raster pictures', () => {
  it('accepts a full-resolution phone photo — the thing people actually upload', async () => {
    const sixMegabytes = 6 * 1024 * 1024;
    expect(sixMegabytes).toBeLessThanOrEqual(MAX_SOURCE_BYTES);
    stubRasterizer();

    const prepared = await prepareItemImage(file(sixMegabytes, 'image/jpeg'));

    expect(prepared.kind).toBe('upload');
  });

  it('downscales before uploading, and hands over a type the endpoint stores', async () => {
    const { drawImage } = stubRasterizer();
    const source = file(6 * 1024 * 1024, 'image/jpeg');

    const prepared = await prepareItemImage(source);

    if (prepared.kind !== 'upload') throw new Error('expected an upload');
    expect(drawImage).toHaveBeenCalled();
    expect(prepared.file.size).toBeLessThan(source.size);
    expect(['image/jpeg', 'image/png']).toContain(prepared.file.type);
  });

  it('caps the longest edge rather than uploading the sensor resolution', async () => {
    stubRasterizer();
    const canvas: HTMLCanvasElement[] = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as HTMLElement;
      if (tag === 'canvas') canvas.push(el as HTMLCanvasElement);
      return el;
    });

    await prepareItemImage(file(1024, 'image/jpeg'));

    expect(canvas[0]!.width).toBe(1600);
    expect(canvas[0]!.height).toBe(1200);
  });

  it('still uploads a JPEG the browser cannot rasterize, rather than hard-failing', async () => {
    // No stub: jsdom has no encoder, which is the same branch a browser takes on a codec it
    // cannot decode. A picture that cannot be downscaled must still reach storage.
    const source = file(1024, 'image/jpeg');

    const prepared = await prepareItemImage(source);

    if (prepared.kind !== 'upload') throw new Error('expected an upload');
    expect(prepared.file).toBe(source);
  });
});

describe('vector pictures', () => {
  it('passes a vector through without rasterizing it, and never reaches the canvas', async () => {
    const { drawImage } = stubRasterizer();
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', {
      type: 'image/svg+xml',
    });

    const prepared = await prepareItemImage(svg);

    expect(prepared.kind).toBe('inline');
    if (prepared.kind !== 'inline') throw new Error('unreachable');
    expect(prepared.dataUrl.startsWith('data:image/svg+xml')).toBe(true);
    expect(drawImage).not.toHaveBeenCalled();
  });
});

describe('errors a user can act on', () => {
  it('refuses past the source cap and says how big the file actually was', async () => {
    await expect(prepareItemImage(file(MAX_SOURCE_BYTES + 1, 'image/jpeg'))).rejects.toThrow(
      /10\.0 MB/,
    );
  });

  it('refuses an unsupported type with copy safe to show a user', async () => {
    const err = await prepareItemImage(file(1024, 'application/pdf', 'spec.pdf')).catch((e) => e);
    expect(err).toBeInstanceOf(ImageUploadError);
    expect(err.message).toMatch(/isn't supported/);
  });

  it('refuses a codec it can neither rasterize nor upload as-is, instead of uploading bytes the endpoint will reject', async () => {
    const err = await prepareItemImage(file(1024, 'image/heic', 'IMG_0001.heic')).catch((e) => e);
    expect(err).toBeInstanceOf(ImageUploadError);
    expect(err.message.length).toBeGreaterThan(0);
  });
});
