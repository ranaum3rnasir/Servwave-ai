/**
 * Normalising a picked photo before it is uploaded (#2029).
 *
 * A file in, a file out: whatever the salesperson picks — JPG, JPEG, PNG or HEIC — what leaves
 * the phone is a JPEG at a size suited to a document rather than a camera sensor. Doing it in the
 * browser means it is not a step anyone can forget, and the bytes are already small before they
 * cross the network.
 *
 * WHY CLIENT-SIDE. The server's image library reads HEIC metadata but cannot decode HEIC pixels:
 * sharp's prebuilt binary is compiled without the HEVC codec for licensing reasons, and building
 * a custom one is not viable on the current platform base image. A server-side decode was
 * investigated and rejected, as were third-party transformation services. Converting here
 * sidesteps all of it.
 *
 * The decisions live in `normaliseImageForUpload`; the pixels live in `browserImagePipeline`,
 * which is a thin canvas wrapper with no decisions in it. That split is deliberate: the decisions
 * are then testable without a canvas, which jsdom does not have.
 */

/**
 * The longest edge a stored photo may have. Sized for the document, not the sensor: the strip
 * shows up to four across, so a photo is rendered a few hundred CSS pixels wide at most, and the
 * PDF prints it smaller still. This lands a typical photo in the tens of kilobytes. A starting
 * value, deliberately easy to move.
 */
export const NORMALISED_MAX_EDGE = 480;

/** JPEG quality for the normalised output. High enough that the downscale is what you notice. */
const JPEG_QUALITY = 0.82;

/** The cap on the file the user PICKS, applied before any decode. */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

/**
 * The photo cap for one ESTIMATE, across all its scope blocks, and where the warning starts.
 * MIRRORS `ESTIMATE_PHOTO_CAP`/`ESTIMATE_PHOTO_WARN_AT` in
 * `backend/src/controllers/estimate-photos.controller.ts`, which is the one that actually
 * enforces it — this copy only decides when to warn. **Change both together.**
 */
export const ESTIMATE_PHOTO_CAP = 24;
export const ESTIMATE_PHOTO_WARN_AT = 16;

/** What the salesperson is allowed to pick. Everything becomes JPEG on the way out. */
const ACCEPTED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif'];
const ACCEPTED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.heic', '.heif'];

/** The pixel half. Injected so the decisions above can be tested without a canvas. */
export interface ImagePipeline {
  decode(file: File): Promise<{ width: number; height: number; source: CanvasImageSource }>;
  encodeJpeg(
    source: CanvasImageSource,
    width: number,
    height: number,
    quality: number,
  ): Promise<Blob>;
}

export interface NormalisedImage {
  file: File;
  width: number;
  height: number;
}

/** Thrown for anything the salesperson can act on: a wrong format, an oversize pick, a bad file. */
export class ImageNormaliseError extends Error {}

function looksLikeAcceptedImage(file: File): boolean {
  if (ACCEPTED_TYPES.includes(file.type.toLowerCase())) return true;
  // iOS sometimes hands over a HEIC with an empty `type`, so fall back to the extension rather
  // than refusing a photo the phone just took.
  const lower = file.name.toLowerCase();
  return file.type === '' && ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** The output dimensions: the longest edge capped, the ratio kept, and never upscaled. */
export function targetDimensions(
  width: number,
  height: number,
  maxEdge: number = NORMALISED_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function jpegName(originalName: string): string {
  const base = originalName.replace(/\.[^.]+$/, '') || 'photo';
  return `${base}.jpg`;
}

export async function normaliseImageForUpload(
  file: File,
  pipeline: ImagePipeline = browserImagePipeline,
): Promise<NormalisedImage> {
  if (!looksLikeAcceptedImage(file)) {
    throw new ImageNormaliseError('Pick a JPG, PNG or HEIC photo.');
  }
  // Checked BEFORE the decode: a 40MB pick should be refused on the spot, not after the browser
  // has spent seconds turning it into a bitmap.
  if (file.size > MAX_SOURCE_BYTES) {
    throw new ImageNormaliseError('That photo is larger than 8MB. Pick a smaller one.');
  }

  let decoded: { width: number; height: number; source: CanvasImageSource };
  try {
    decoded = await pipeline.decode(file);
  } catch {
    throw new ImageNormaliseError('That photo could not be read. Try a different file.');
  }

  const { width, height } = targetDimensions(decoded.width, decoded.height);
  const blob = await pipeline.encodeJpeg(decoded.source, width, height, JPEG_QUALITY);

  return {
    file: new File([blob], jpegName(file.name), { type: 'image/jpeg' }),
    width,
    height,
  };
}

// ─── The pixel half ──────────────────────────────────────────────────────────

/** True for a file only a HEIC decoder can open. */
function isHeic(file: File): boolean {
  const lower = file.name.toLowerCase();
  return /heic|heif/.test(file.type.toLowerCase()) || lower.endsWith('.heic') || lower.endsWith('.heif');
}

/**
 * The real pipeline. No decisions here — dimensions and quality arrive already decided.
 *
 * HEIC is decoded through `heic2any`, imported DYNAMICALLY so its wasm payload is fetched only by
 * a salesperson who actually picks a HEIC, and never enters the main bundle. Safari can decode
 * HEIC natively, so it is tried first and the library is the fallback for everything else.
 */
export const browserImagePipeline: ImagePipeline = {
  async decode(file) {
    const bitmapSource = isHeic(file) ? await heicToJpegBlob(file) : file;
    const bitmap = await createImageBitmap(bitmapSource);
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  },

  async encodeJpeg(source, width, height, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    ctx.drawImage(source, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) throw new Error('canvas encode returned no blob');
    return blob;
  },
};

async function heicToJpegBlob(file: File): Promise<Blob> {
  try {
    // Safari decodes HEIC itself — no reason to pull down a wasm decoder there.
    return await createImageBitmap(file).then(() => file);
  } catch {
    const { default: heic2any } = await import('heic2any');
    const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
    return Array.isArray(converted) ? converted[0]! : converted;
  }
}
