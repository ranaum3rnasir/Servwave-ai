/**
 * Client-side preparation for a CATALOG ITEM's picture, which is uploaded to storage.
 *
 * WHY THIS IS NOT `image-upload.ts`. That helper prepares pictures that get stored INLINE as data
 * URIs, and it serves four dialogs — item, brand, category and group. Only the item's picture
 * moved to storage, and it has two requirements the inline helper cannot meet: the result has to
 * be a `File` (multipart, not a JSON column), and it has to be in a type the item-image endpoint
 * stores. That endpoint's allowlist is JPEG and PNG, deliberately: the picture is drawn into the
 * rendered estimate document, and the renderer decodes nothing else. The inline helper encodes to
 * WebP, which is the right answer for the other three dialogs and the wrong one here.
 *
 * So item pictures get their own path rather than the four entity types getting migrated under
 * cover of one change. What IS shared is the accept/reject contract: the same source cap, the
 * same accepted picks, the same error type, the same "fit inside MAX_EDGE_PX" maths.
 *
 * Two behaviours carried over deliberately:
 *   • A full-resolution phone photo is ACCEPTED and downscaled, never refused. Downscaling also
 *     keeps the stored object inside the document renderer's own fetch ceiling, so an oversized
 *     original would otherwise be dropped from the PDF rather than drawn.
 *   • A VECTOR is passed through untouched. Rasterizing it throws away the only reason to upload
 *     one, and a vector is not storable through the item-image endpoint anyway (an SVG carries
 *     script, so no upload path in this product accepts one). It therefore stays inline, exactly
 *     as it is today — hence the two-shaped result below.
 */
import {
  ACCEPTED_IMAGE_MIMES,
  DECODE_TIMEOUT_MS,
  ImageUploadError,
  MAX_EDGE_PX,
  MAX_SOURCE_BYTES,
  TARGET_STORED_BYTES,
  dataUrlBytes,
  formatBytes,
  scaleToFit,
} from './image-upload';

/**
 * What the picker produced. `upload` goes to the item-image endpoint and ends up in the canonical
 * column; `inline` is a vector, which stays in the inline column as it always has.
 */
export type PreparedItemImage =
  | { kind: 'upload'; file: File; previewUrl: string }
  | { kind: 'inline'; dataUrl: string };

/** Exactly the item-image endpoint's allowlist. Kept beside the encoder that has to satisfy it. */
export const STORABLE_ITEM_IMAGE_MIMES = ['image/jpeg', 'image/png'] as const;

const VECTOR_MIME = 'image/svg+xml';

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const fail = () =>
      reject(new ImageUploadError("Couldn't read the file. Try a different image."));
    reader.onerror = fail;
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) return fail();
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
}

/** `data:<mime>;base64,<payload>` back into a File the multipart body can carry. */
function dataUrlToFile(dataUrl: string, name: string, type: string): File {
  const comma = dataUrl.indexOf(',');
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], name, { type });
}

/** `photo.heic` → `photo.jpg`. The endpoint stores what the bytes actually are. */
function renameFor(original: string, type: string): string {
  const ext = type === 'image/png' ? 'png' : 'jpg';
  const base = original.replace(/\.[^.]+$/, '') || 'item-image';
  return `${base}.${ext}`;
}

async function decode(
  file: File,
): Promise<{ width: number; height: number; source: CanvasImageSource } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { width: bitmap.width, height: bitmap.height, source: bitmap };
    } catch {
      // Fall through — Safari refuses HEIC here; the Image() path handles it.
    }
  }
  if (typeof Image !== 'function' || typeof URL?.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  try {
    // A decoder that fires NEITHER load nor error would hang the picker with no feedback, so the
    // wait is bounded.
    const el = await new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      const done = (value: HTMLImageElement | null) => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), DECODE_TIMEOUT_MS);
      img.onload = () => done(img);
      img.onerror = () => done(null);
      img.src = url;
    });
    if (!el) return null;
    return { width: el.naturalWidth, height: el.naturalHeight, source: el };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Validate, downscale, and return something the item dialog can save.
 *
 * Throws `ImageUploadError` with copy safe to show the user. An upload that cannot happen must
 * SAY so — a picker that quietly does nothing reads to the operator as a saved picture.
 */
export async function prepareItemImage(file: File): Promise<PreparedItemImage> {
  if (file.type && !ACCEPTED_IMAGE_MIMES.includes(file.type)) {
    throw new ImageUploadError("That file type isn't supported. Use PNG, JPG, SVG, WebP, or HEIC.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new ImageUploadError(
      `That image is ${formatBytes(file.size)}. Max ${formatBytes(MAX_SOURCE_BYTES)}.`,
    );
  }

  // Vector stays vector, and stays inline.
  if (file.type === VECTOR_MIME) return { kind: 'inline', dataUrl: await readAsDataUrl(file) };

  // PNG keeps its alpha; everything else (JPEG, WebP, HEIC, GIF) becomes a JPEG, which is both
  // far smaller for a photograph and one of the two types the endpoint stores.
  const target = file.type === 'image/png' ? 'image/png' : 'image/jpeg';

  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    decoded = null;
  }
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  const ctx = canvas?.getContext?.('2d') ?? null;

  if (!decoded || !canvas || !ctx || !decoded.width || !decoded.height) {
    // Nothing can be re-encoded here. Upload the pick untouched when it is ALREADY storable —
    // a picture that renders beats a hard failure, and the source cap still bounds it.
    if ((STORABLE_ITEM_IMAGE_MIMES as readonly string[]).includes(file.type)) {
      return { kind: 'upload', file, previewUrl: await readAsDataUrl(file) };
    }
    throw new ImageUploadError(
      "Couldn't prepare that image on this device. Try saving it as a JPG or PNG first.",
    );
  }

  const scale = scaleToFit(decoded.width, decoded.height, MAX_EDGE_PX);
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);

  let best: string | null = null;
  for (const quality of [0.85, 0.7, 0.55]) {
    let encoded: string;
    try {
      encoded = canvas.toDataURL(target, quality);
    } catch {
      break;
    }
    if (!encoded.startsWith(`data:${target}`)) break;
    best = encoded;
    if (dataUrlBytes(encoded) <= TARGET_STORED_BYTES) break;
    // PNG ignores the quality argument, so a second pass would return the identical payload.
    if (target === 'image/png') break;
  }

  if (!best) {
    if ((STORABLE_ITEM_IMAGE_MIMES as readonly string[]).includes(file.type)) {
      return { kind: 'upload', file, previewUrl: await readAsDataUrl(file) };
    }
    throw new ImageUploadError(
      "Couldn't prepare that image on this device. Try saving it as a JPG or PNG first.",
    );
  }

  return {
    kind: 'upload',
    file: dataUrlToFile(best, renameFor(file.name, target), target),
    previewUrl: best,
  };
}
