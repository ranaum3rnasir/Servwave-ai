/**
 * The images a rendered document carries (#2029 slice 4).
 *
 * Two kinds, both from the same view-model rows the public web page reads, so the two surfaces
 * cannot drift: a line item's price-book image, and the photos beneath a scope-of-work block.
 * Nothing else — never the lead's attachments, never the job's, never the estimate's own file
 * panel.
 *
 * WHY A NAMED DICTIONARY. pdfmake takes a docDefinition-level `images` map and lets content
 * reference an entry by name. The bytes are then stored ONCE however many times the document
 * points at them, which an inline data URI per reference is not. Measured on the installed
 * renderer with twenty-four full-resolution photos, the delivery mechanism was worth ~1.2x and
 * downscaling on ingest ~30x — this is an image-size problem wearing an architecture problem's
 * clothes, and slice 2 is what actually solved it. The dictionary is the cheap half that is still
 * worth having.
 *
 * A broken image must never cost the customer their estimate: a fetch that fails leaves its key
 * absent, and a renderer skips what it cannot find. Same policy the org logo has always had.
 */
import { logger } from '../logger';
import type { DocumentRow } from '../estimate-document-view';

export interface DocumentImageRef {
  key: string;
  url: string;
}

/** The dictionary pdfmake is handed: name → embeddable data URI. */
export type DocumentImages = Record<string, string>;

/** Dictionary key for a line item's price-book image. */
export function imageKeyForRow(rowKey: string): string {
  return `row-${rowKey}`;
}

/** Dictionary key for one scope photo. Keyed on the PHOTO, not the block it hangs under, so the
 *  same photo referenced twice is still stored once. */
export function imageKeyForPhoto(photoId: string): string {
  return `photo-${photoId}`;
}

/** Every image the document points at, deduped, in the order it will be drawn. */
export function documentImageRefs(rows: DocumentRow[]): DocumentImageRef[] {
  const refs = new Map<string, DocumentImageRef>();
  for (const row of rows) {
    if (row.imageUrl) {
      const key = imageKeyForRow(row.key);
      if (!refs.has(key)) refs.set(key, { key, url: row.imageUrl });
    }
    for (const photo of row.photos) {
      const key = imageKeyForPhoto(photo.id);
      if (photo.url && !refs.has(key)) refs.set(key, { key, url: photo.url });
    }
  }
  return [...refs.values()];
}

export interface ImageResolver {
  fetchImage(url: string): Promise<string>;
}

/**
 * Fetch every referenced image into the dictionary. Failures are logged and dropped, never
 * thrown: a 410 on one photo is not a reason to refuse the whole document.
 */
export async function resolveDocumentImages(
  refs: DocumentImageRef[],
  resolver: ImageResolver,
): Promise<DocumentImages> {
  if (refs.length === 0) return {};

  const entries = await Promise.all(
    refs.map(async (ref) => {
      try {
        return [ref.key, await resolver.fetchImage(ref.url)] as const;
      } catch (err) {
        logger.warn(`PDF image skipped (${ref.key}): ${(err as Error).message}`);
        return null;
      }
    }),
  );

  const images: DocumentImages = {};
  for (const entry of entries) {
    if (entry) images[entry[0]] = entry[1];
  }
  return images;
}
