/**
 * A catalog item picture uploaded by the item-image endpoint is DRAWN in the rendered document.
 *
 * This is the half of the contract that is easy to get silently wrong. The renderer refuses to
 * fetch anything that is not on the storage project's own host (the F-16 SSRF allowlist), caps the
 * bytes, and follows no redirects — and a fetch that fails is dropped quietly rather than failing
 * the document, so a picture stored on the wrong host looks like nothing at all rather than like
 * an error. That is exactly why the upload goes to the PUBLIC bucket on that project: a signed
 * private URL would both expire and overflow the canonical column's few-hundred-character cap.
 *
 * The URL exercised here is the shape the item-image controller stores — `getPublicUrl` on the
 * public bucket over its `<org>/price-book-items/<item>/<ts>-<name>` layout, which
 * price-book-item-image-replace.test.ts pins from the controller's own side. Here that URL is
 * pointed at a loopback origin standing in for the storage host, and the document is generated for
 * real: if the renderer would refuse the host, the request never arrives and the assertion fails.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

let baseHost = '';
vi.mock('../../../config/env', () => ({
  env: {
    get SUPABASE_URL() {
      return `http://${baseHost}`;
    },
  },
}));

// Imported AFTER the mock is registered so the module picks up the mocked env.
import { generateEstimatePdf } from '../index';
import { PREVIEW_ESTIMATE_FIXTURE } from '../preview-fixture';

const ORG_ID = 'aaaaaaaa-0000-0000-0000-00000000a1fa';
const ITEM_ID = 'b1000000-0000-0000-0000-000000002184';
const STORAGE_BUCKET = 'org-assets';
/** Exactly the object path `replaceItemImage` lays down. */
const OBJECT_PATH = `${ORG_ID}/price-book-items/${ITEM_ID}/1758000000000-lock.jpg`;
/** Exactly the `getPublicUrl` shape it stores in the canonical column. */
const publicUrl = () =>
  `http://${baseHost}/storage/v1/object/public/${STORAGE_BUCKET}/${OBJECT_PATH}`;

/** A real 1x1 JPEG — pdfmake decodes JPEG and PNG only. */
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL' +
    'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
    'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const ORG = {
  name: 'Test Org', address_line1: '1', address_line2: null,
  city: 'Hoboken', state: 'NJ', postal_code: '07030',
  email: 'a@b.c', phone: null, website: null, logo_url: null, brand_color: '#E11D2E',
  estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
};

function estimateWithItemImage(imageUrl: string) {
  const [first, ...rest] = PREVIEW_ESTIMATE_FIXTURE.line_items;
  return {
    ...PREVIEW_ESTIMATE_FIXTURE,
    line_items: [{ ...first, price_book_item: { image_url: imageUrl } }, ...rest],
  };
}

describe('a stored item image is drawn in the rendered document', () => {
  let server: http.Server;
  const requested: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      requested.push(req.url ?? '');
      res.setHeader('content-type', 'image/jpeg');
      res.end(TINY_JPEG);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseHost = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('fetches the object from the storage host and renders a PDF', async () => {
    requested.length = 0;

    const buf = await generateEstimatePdf(
      estimateWithItemImage(publicUrl()) as never,
      ORG as never,
    );

    expect(requested).toContain(`/storage/v1/object/public/${STORAGE_BUCKET}/${OBJECT_PATH}`);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('draws nothing, and still renders, when the picture is on some other host', async () => {
    // The failure mode this criterion exists to catch: the renderer refuses the host, drops the
    // image silently, and the customer's document is simply missing the picture.
    requested.length = 0;

    const buf = await generateEstimatePdf(
      estimateWithItemImage(
        `https://somewhere-else.example.com/storage/v1/object/public/${STORAGE_BUCKET}/${OBJECT_PATH}`,
      ) as never,
      ORG as never,
    );

    expect(requested).toEqual([]);
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
