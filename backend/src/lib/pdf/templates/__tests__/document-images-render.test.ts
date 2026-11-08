/**
 * #2029 slice 4 — the templates draw the document's images.
 *
 * Both kinds, from the same view-model rows the public page reads: a line item's price-book image
 * beside it, and the scope photo strip beneath a scope block. Every image is referenced by NAME
 * from the docDefinition's image dictionary, never inlined as a data URI per reference, and every
 * one is sized with a `fit` box — setting width AND height together distorts it.
 */
import { describe, it, expect } from 'vitest';
import { buildAlphaClassicPdf } from '../alpha-classic';
import { buildCrmDefaultPdf } from '../crm-default';
import { PREVIEW_ESTIMATE_FIXTURE } from '../../preview-fixture';
import { imageKeyForRow, imageKeyForPhoto } from '../../document-images';
import { printer } from '../../fonts';

/**
 * A real 1x1 JPEG. pdfmake accepts JPEG and PNG ONLY and throws on anything else — which is why
 * #2029 slice 2's normalise-on-ingest is a correctness prerequisite for this slice and not an
 * optimisation.
 */
const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL' +
  'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const ORG = {
  name: 'Northwind Services', address_line1: '1', address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030',
  email: 'a@b.c', phone: null, website: null, logo_url: null, brand_color: '#E11D2E',
  estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
};

const SCOPE = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units.',
  flat_price: 2000,
  is_taxable: true,
};

const PHOTOS = [
  { id: 'sp-1', scope_id: 'scope-1', url: 'https://x.supabase.co/1.jpg', caption: null },
  { id: 'sp-2', scope_id: 'scope-1', url: 'https://x.supabase.co/2.jpg', caption: null },
];

/** A dictionary standing in for the fetched bytes. Keys are what the template must reference. */
const IMAGES = {
  [imageKeyForPhoto('sp-1')]: 'data:image/jpeg;base64,AAA',
  [imageKeyForPhoto('sp-2')]: 'data:image/jpeg;base64,BBB',
};

const TEMPLATES = [
  ['alpha-classic', buildAlphaClassicPdf] as const,
  ['crm-default', buildCrmDefaultPdf] as const,
];

/** Every `{ image: … }` node in a docDefinition, wherever it is nested. */
function imageNodes(doc: unknown): Array<Record<string, unknown>> {
  const found: Array<Record<string, unknown>> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.image === 'string') found.push(obj);
    Object.values(obj).forEach(walk);
  };
  walk(doc);
  return found;
}

describe.each(TEMPLATES)('%s — document images', (_name, build) => {
  it("draws a scope block's photos, referenced by name from the dictionary", () => {
    const doc = build(
      { ...PREVIEW_ESTIMATE_FIXTURE, scopes: [SCOPE], scope_photos: PHOTOS } as never,
      ORG as never,
      IMAGES,
    );

    const names = imageNodes(doc).map((n) => n.image);
    expect(names).toContain(imageKeyForPhoto('sp-1'));
    expect(names).toContain(imageKeyForPhoto('sp-2'));
  });

  it('sizes every image with a fit box, so none is distorted', () => {
    const doc = build(
      { ...PREVIEW_ESTIMATE_FIXTURE, scopes: [SCOPE], scope_photos: PHOTOS } as never,
      ORG as never,
      IMAGES,
    );

    for (const node of imageNodes(doc)) {
      expect(node.fit).toBeInstanceOf(Array);
      // width AND height together is exactly what distorts an image.
      expect(node.width == null || node.height == null).toBe(true);
    }
  });

  it('draws nothing for an image the fetch could not supply', () => {
    const doc = build(
      { ...PREVIEW_ESTIMATE_FIXTURE, scopes: [SCOPE], scope_photos: PHOTOS } as never,
      ORG as never,
      { [imageKeyForPhoto('sp-1')]: 'data:image/jpeg;base64,AAA' },
    );

    const names = imageNodes(doc).map((n) => n.image);
    expect(names).toContain(imageKeyForPhoto('sp-1'));
    // sp-2 is absent from the dictionary, so referencing it would make pdfmake throw.
    expect(names).not.toContain(imageKeyForPhoto('sp-2'));
  });

  it("draws a line item's price-book image when it has one", () => {
    const withImage = {
      ...PREVIEW_ESTIMATE_FIXTURE,
      line_items: [
        { ...PREVIEW_ESTIMATE_FIXTURE.line_items[0], id: 'li-1', price_book_item: { image_url: 'https://x.supabase.co/pb.jpg' } },
      ],
    };
    const doc = build(withImage as never, ORG as never, {
      [imageKeyForRow('li-1')]: 'data:image/jpeg;base64,CCC',
    });

    expect(imageNodes(doc).map((n) => n.image)).toContain(imageKeyForRow('li-1'));
  });

  it('leaves empty space, not a placeholder image, when the item has none', () => {
    const doc = build(PREVIEW_ESTIMATE_FIXTURE as never, ORG as never, {});

    expect(imageNodes(doc)).toHaveLength(0);
  });

  it('renders with no dictionary at all, exactly as it does today', () => {
    expect(() => build(PREVIEW_ESTIMATE_FIXTURE as never, ORG as never)).not.toThrow();
  });
});

describe('rendering a document that carries images', () => {
  it('completes without throwing, on a real printer with real fonts', async () => {
    const doc = buildAlphaClassicPdf(
      { ...PREVIEW_ESTIMATE_FIXTURE, scopes: [SCOPE], scope_photos: PHOTOS } as never,
      ORG as never,
      { [imageKeyForPhoto('sp-1')]: TINY_JPEG, [imageKeyForPhoto('sp-2')]: TINY_JPEG },
    );

    const pdfDoc = await printer.createPdfKitDocument(doc);
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      pdfDoc.on('data', (c: Buffer) => chunks.push(c));
      pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
      pdfDoc.on('error', reject);
      pdfDoc.end();
    });

    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
