/**
 * #2029 slice 4 — the images a document carries, and what it costs to render them.
 *
 * The PDF rendered no images at all. It gains both kinds — each line item's price-book image and
 * the scope photo strip beneath each scope block — from the same view-model rows the public page
 * reads, so the two surfaces cannot drift.
 *
 * Two renderer constraints, both measured rather than assumed: pdfmake accepts JPEG and PNG only
 * and throws on anything else (which is why slice 2's normalise-on-ingest is a correctness
 * prerequisite, not an optimisation), and bytes are supplied through pdfmake's named image
 * dictionary rather than repeated inline per reference.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  documentImageRefs,
  imageKeyForRow,
  imageKeyForPhoto,
  resolveDocumentImages,
} from '../document-images';
import type { DocumentRow } from '../../estimate-document-view';

function row(over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    kind: 'line_item',
    key: 'li-1',
    title: 'Keypad',
    detail: null,
    itemType: 'MATERIAL',
    quantity: 1,
    unitPrice: 200,
    grossAmount: null,
    netAmount: 200,
    discounted: false,
    discountType: null,
    discountValue: null,
    discountAmount: null,
    // #2053 - a plain, non-optional row: its money is inside the document's own Subtotal.
    optional: false,
    countsTowardTotals: true,
    imageUrl: null,
    photos: [],
    ...over,
  };
}

describe('the images a document references', () => {
  it('collects a line item\'s price-book image', () => {
    const refs = documentImageRefs([row({ imageUrl: 'https://x.supabase.co/a.jpg' })]);

    expect(refs).toEqual([{ key: imageKeyForRow('li-1'), url: 'https://x.supabase.co/a.jpg' }]);
  });

  it('collects nothing for a line item whose price-book item has no image', () => {
    expect(documentImageRefs([row()])).toEqual([]);
  });

  it("collects a scope block's photos, in order", () => {
    const refs = documentImageRefs([
      row({
        kind: 'scope',
        key: 'scope-1',
        photos: [
          { id: 'sp-1', url: 'https://x.supabase.co/1.jpg', caption: null },
          { id: 'sp-2', url: 'https://x.supabase.co/2.jpg', caption: null },
        ],
      }),
    ]);

    expect(refs.map((r) => r.key)).toEqual([imageKeyForPhoto('sp-1'), imageKeyForPhoto('sp-2')]);
  });

  it('references one photo once, however many rows it appears under', () => {
    const photo = { id: 'sp-1', url: 'https://x.supabase.co/1.jpg', caption: null };
    const refs = documentImageRefs([
      row({ kind: 'scope', key: 's1', photos: [photo] }),
      row({ kind: 'scope', key: 's2', photos: [photo] }),
    ]);

    expect(refs).toHaveLength(1);
  });
});

describe('resolving them into the document', () => {
  const fetchImage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchImage.mockImplementation(async (url: string) => `data:image/jpeg;base64,${url.length}`);
  });

  it('builds a NAMED dictionary, so bytes appear once however often they are referenced', async () => {
    const images = await resolveDocumentImages(
      [
        { key: 'a', url: 'https://x.supabase.co/1.jpg' },
        { key: 'b', url: 'https://x.supabase.co/2.jpg' },
      ],
      { fetchImage },
    );

    expect(Object.keys(images)).toEqual(['a', 'b']);
    expect(fetchImage).toHaveBeenCalledTimes(2);
  });

  it('drops an image it cannot fetch rather than failing the whole document', async () => {
    fetchImage.mockImplementation(async (url: string) => {
      if (url.endsWith('2.jpg')) throw new Error('410 gone');
      return 'data:image/jpeg;base64,AAA';
    });

    const images = await resolveDocumentImages(
      [
        { key: 'a', url: 'https://x.supabase.co/1.jpg' },
        { key: 'b', url: 'https://x.supabase.co/2.jpg' },
      ],
      { fetchImage },
    );

    // A broken photo must never cost the customer their estimate — the same policy the org logo
    // has always had. The key is simply absent, and the renderer skips what it cannot find.
    expect(images).toEqual({ a: 'data:image/jpeg;base64,AAA' });
  });

  it('fetches nothing when the document references no images', async () => {
    expect(await resolveDocumentImages([], { fetchImage })).toEqual({});
    expect(fetchImage).not.toHaveBeenCalled();
  });
});
