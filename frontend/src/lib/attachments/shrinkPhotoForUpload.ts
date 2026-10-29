/**
 * Shrink a camera photo before it crosses a phone connection (mobile slice 09, CMP-13).
 *
 * A phone photo is 3-8MB at 4032x3024. On a job site's cellular link that is the difference
 * between an upload that lands and one that times out. Estimate and catalog images have been
 * shrunk on the device for a while (`lib/image-normalise.ts`, `lib/image-upload.ts`); this does
 * the same for job and customer attachments, at a size that still reads as evidence.
 *
 * WHAT IT TOUCHES, AND WHAT IT NEVER DOES:
 *  - Only still photos in camera formats (JPEG, HEIC/HEIF). Video is never re-encoded: that was
 *    ruled out in the direct-upload PRD (slice 5) and nothing here changes it. Documents, and
 *    PNG (screenshots, transparency, text that JPEG would smear), go up as picked.
 *  - Only when the longest edge is above `ATTACHMENT_PHOTO_MAX_EDGE`. A photo already that size
 *    or smaller is sent as the very File the picker produced, so nothing is re-encoded for no
 *    gain.
 *  - Never blocks an upload. If the browser cannot decode or encode the photo, or the encoded
 *    copy is not actually smaller, the original goes up instead. Shrinking is a courtesy to the
 *    connection, not a gate.
 *
 * Runs at the SURFACE, before `uploadAttachment`. The seam itself still sends exactly the File
 * it is handed (its identity test stays as it is); what this module changes is which File the
 * job and customer surfaces hand it.
 */
import { browserImagePipeline, targetDimensions, type ImagePipeline } from '@/lib/image-normalise';

/**
 * The longest edge a job photo is sent at. Large enough to read a model plate or a serial number
 * when zoomed, small enough to land a typical photo in a few hundred kilobytes.
 */
export const ATTACHMENT_PHOTO_MAX_EDGE = 2048;

const JPEG_QUALITY = 0.85;

const SHRINKABLE_TYPES = ['image/jpeg', 'image/jpg', 'image/heic', 'image/heif'];
const SHRINKABLE_EXTENSIONS = ['.jpg', '.jpeg', '.heic', '.heif'];

function isShrinkablePhoto(file: File): boolean {
  const type = file.type.toLowerCase();
  if (SHRINKABLE_TYPES.includes(type)) return true;
  // iOS sometimes hands over a HEIC with an empty `type`.
  const lower = file.name.toLowerCase();
  return type === '' && SHRINKABLE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function jpegName(originalName: string): string {
  const base = originalName.replace(/\.[^.]+$/, '') || 'photo';
  return `${base}.jpg`;
}

export async function shrinkPhotoForUpload(
  file: File,
  pipeline: ImagePipeline = browserImagePipeline,
): Promise<File> {
  if (!isShrinkablePhoto(file)) return file;
  try {
    const decoded = await pipeline.decode(file);
    if (Math.max(decoded.width, decoded.height) <= ATTACHMENT_PHOTO_MAX_EDGE) return file;
    const { width, height } = targetDimensions(
      decoded.width,
      decoded.height,
      ATTACHMENT_PHOTO_MAX_EDGE,
    );
    const blob = await pipeline.encodeJpeg(decoded.source, width, height, JPEG_QUALITY);
    if (blob.size >= file.size) return file;
    return new File([blob], jpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  }
}
