/**
 * Client-side preparation for pictures that get stored inline as data URIs
 * (price-book category / brand / group / item photos).
 *
 * WHY THIS EXISTS. Those surfaces used to refuse anything over 512 KB, which
 * rejects essentially every phone photo - the thing people actually try to
 * upload. Raising the cap alone would be worse, not better: the picture is
 * stored inline in the record, so a 10 MB file becomes ~13 MB of base64 and
 * blows the browser's storage quota.
 *
 * So the cap moves in both directions at once: accept a big SOURCE file
 * (`MAX_SOURCE_BYTES`), then downscale it to a small STORED payload
 * (`TARGET_STORED_BYTES`) before it ever reaches the form. A 6 MB camera
 * photo lands as ~200 KB of WebP - smaller than the old limit that rejected
 * it outright.
 *
 * SVG is passed through untouched: it is vector, already tiny, and
 * rasterizing it would throw away the only reason to upload one.
 */

/** Largest file a user may pick. Covers full-resolution phone photos. */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

/** What we aim to actually store, after downscaling. */
export const TARGET_STORED_BYTES = 600 * 1024;

/** Longest edge kept, in CSS pixels. 1600 stays crisp on a 2x hero banner. */
export const MAX_EDGE_PX = 1600;

/** How long to wait for the browser to decode a picked file before giving up. */
export const DECODE_TIMEOUT_MS = 8000;

export const ACCEPTED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
];

/** Human-readable size for error copy - "6.2 MB", "480 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class ImageUploadError extends Error {}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new ImageUploadError("Couldn't read the file. Try a different image."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) {
        reject(new ImageUploadError("Couldn't read the file. Try a different image."));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
}

/** Scale factor that fits `w x h` inside a MAX_EDGE_PX box, never upscaling. */
export function scaleToFit(w: number, h: number, maxEdge = MAX_EDGE_PX): number {
  const longest = Math.max(w, h);
  return longest <= maxEdge ? 1 : maxEdge / longest;
}

/** Rough decoded byte count of a data URI, ignoring the header. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return 0;
  const payload = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload * 3) / 4) - padding);
}

async function decode(file: File): Promise<{ width: number; height: number; source: CanvasImageSource } | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return { width: bitmap.width, height: bitmap.height, source: bitmap };
    } catch {
      // Fall through - Safari refuses HEIC here; the Image() path handles it.
    }
  }
  if (typeof Image !== "function" || typeof URL?.createObjectURL !== "function") return null;
  const url = URL.createObjectURL(file);
  try {
    // A decoder that fires NEITHER load nor error would otherwise hang the
    // picker with no feedback, so the wait is bounded and falls back to
    // storing the file as picked.
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
 * Validate, downscale, and return a data URI ready to store.
 *
 * Throws `ImageUploadError` with copy safe to show the user. Falls back to the
 * untouched file whenever the environment can't rasterize (no canvas, an
 * undecodable codec) - a picture that renders is better than a hard failure,
 * and the source cap still bounds the damage.
 */
export async function prepareImageUpload(file: File): Promise<string> {
  if (file.type && !ACCEPTED_IMAGE_MIMES.includes(file.type)) {
    throw new ImageUploadError("That file type isn't supported. Use PNG, JPG, SVG, WebP, or HEIC.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new ImageUploadError(
      `That image is ${formatBytes(file.size)}. Max ${formatBytes(MAX_SOURCE_BYTES)}.`,
    );
  }

  // Vector stays vector.
  if (file.type === "image/svg+xml") return readAsDataUrl(file);

  const original = await readAsDataUrl(file);

  let decoded: Awaited<ReturnType<typeof decode>>;
  try {
    decoded = await decode(file);
  } catch {
    decoded = null;
  }
  const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null;
  const ctx = canvas?.getContext?.("2d") ?? null;
  if (!decoded || !canvas || !ctx || !decoded.width || !decoded.height) {
    return original;
  }

  const scale = scaleToFit(decoded.width, decoded.height);
  canvas.width = Math.max(1, Math.round(decoded.width * scale));
  canvas.height = Math.max(1, Math.round(decoded.height * scale));
  ctx.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);

  // WebP first (best ratio), PNG as the transparency-safe fallback for
  // browsers that quietly ignore the requested type.
  let best = original;
  for (const quality of [0.85, 0.7, 0.55]) {
    let encoded: string;
    try {
      encoded = canvas.toDataURL("image/webp", quality);
    } catch {
      break;
    }
    if (!encoded.startsWith("data:image/")) break;
    best = encoded;
    if (dataUrlBytes(encoded) <= TARGET_STORED_BYTES) return encoded;
  }
  // Even the lowest quality missed the target - still return the smaller of
  // the two rather than the untouched original.
  return dataUrlBytes(best) < dataUrlBytes(original) ? best : original;
}
