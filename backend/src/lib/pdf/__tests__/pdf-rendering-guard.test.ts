import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { PDFDocument, PDFName } from 'pdf-lib';
import { generateEstimatePdf, generateInvoicePdf, generateStatementPdf } from '../index';
import { PREVIEW_ESTIMATE_FIXTURE, PREVIEW_INVOICE_FIXTURE } from '../preview-fixture';
import type { TemplateKey } from '../templates/registry';
import { inspectPdfImages, expectLogoDrawn, expectNoLogoDrawn } from './pdf-image-inspector';

/**
 * PDF RENDERING GUARD — runs in CI (backend "build + tests").
 *
 * Exercises the REAL generator (never mocked) for EVERY place the app renders a PDF,
 * so generation can't silently break again. It has broken before: a stale logo host
 * after a DB clone made `fetchAsBase64` throw and the whole document 500'd. A mocked
 * generator in the controller test hid it (see learning-db-clone-drops-storage /
 * learning-mocked-transaction-hides-connection-bugs).
 *
 * Every PDF in the app funnels through these three functions:
 *   - Estimate PDF        download / email / preview            → generateEstimatePdf
 *   - Invoice PDF          download / email / preview            → generateInvoicePdf
 *   - Branding preview    GET /api/organization/preview-pdf      → generateEstimatePdf / generateInvoicePdf
 *   - Statement PDF       account/job statement                   → generateStatementPdf
 *
 * Each is tested across both templates and all three logo states. The "unreachable
 * logo" case is the exact prod failure — it MUST degrade to a logo-less PDF, never throw.
 *
 * WHAT CHANGED, AND WHY. This suite used to assert only `isPdf(buf)` — that the buffer
 * starts with `%PDF`. That assertion is byte-for-byte identical on a document whose logo
 * was silently dropped, so it could not detect a logo regression at all: a test that
 * cannot fail, which is this repo's dominant defect class (see
 * memory/a-test-that-cannot-fail-is-the-dominant-defect-class.md). Every logo state now
 * carries a STRUCTURAL assertion parsed out of the rendered document by
 * `./pdf-image-inspector`, which checks two claims because either alone is insufficient:
 *
 *   1. PRESENT — an image XObject exists in the page's /Resources.
 *   2. DRAWN   — a content stream actually issues that XObject's `Do` operator.
 *
 * The logo-less states assert the NEGATIVE of both, which is what makes the positive
 * assertion meaningful: the same verifier returns present+drawn on a logo'd document and
 * absent+unpainted on a logo-less one, so it demonstrably discriminates. The verifier's
 * own ability to fail is guarded by the last describe in this file.
 *
 * The frontend display path (PDF shown as a `blob:` <iframe> in the estimate dialog,
 * Branding preview, and Org Settings) is guarded separately by
 * frontend/src/__tests__/csp-pdf-preview.test.ts (CSP frame-src must allow blob:).
 */

// A real, valid JPEG (generated with sharp, the same lib the app uses for logos) as a
// data: URI → embeds deterministically, no network needed. Mirrors a real org logo.
let embeddedLogo: string;
beforeAll(async () => {
  const jpg = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 12, g: 45, b: 58 } } })
    .jpeg()
    .toBuffer();
  embeddedLogo = `data:image/jpeg;base64,${jpg.toString('base64')}`;
});
// http logo whose host is NOT the allowlisted storage project → fetch is rejected;
// generation must degrade to a logo-less PDF (this is the exact prod outage).
const UNREACHABLE_LOGO = 'https://not-our-storage-project.example.com/logo.png';

const LOGO_STATES = ['no logo', 'embedded logo', 'unreachable logo'] as const;
type LogoState = (typeof LOGO_STATES)[number];
const logoFor = (state: LogoState): string | null =>
  state === 'embedded logo' ? embeddedLogo : state === 'unreachable logo' ? UNREACHABLE_LOGO : null;
const TEMPLATES: TemplateKey[] = ['alpha-classic', 'crm-default'];

const orgWith = (logo_url: string | null) => ({
  name: 'Guard Co', address_line1: '1 Main St', address_line2: null, city: 'Hoboken',
  state: 'NJ', postal_code: '07030', email: 'a@b.com', phone: null, website: 'https://x.com',
  logo_url, brand_color: '#0C2D3A', estimate_terms: 'Terms.', estimate_notes: '- note',
  estimate_payment_terms: '- Net 30', invoice_terms: 'Invoice terms.', invoice_notes: '- note',
  invoice_payment_terms: '- Net 30',
});

const STATEMENT_FIXTURE = {
  scope: 'customer' as const,
  title: 'Account Statement',
  party: { name: 'Jane Doe', email: 'jane@example.com' },
  lines: [],
  totals: { billed: 0, paid: 0, refunded: 0, credited: 0, balance: 0 },
};

const isPdf = (buf: Buffer) => buf instanceof Buffer && buf.subarray(0, 4).toString() === '%PDF';

/**
 * The assertion every logo state gets. `embedded logo` must prove the image is embedded
 * AND painted; the two degraded states must prove the document came out logo-less — and
 * still renders, which is the non-negotiable half of the prod outage.
 */
async function expectRenderedWithLogoState(buf: Buffer, state: LogoState, label: string) {
  expect(isPdf(buf), `${label}: not a PDF buffer`).toBe(true);
  if (state === 'embedded logo') await expectLogoDrawn(buf, `${label} [${state}]`);
  else await expectNoLogoDrawn(buf, `${label} [${state}]`);
}

describe('PDF rendering guard — estimate / invoice / branding-preview (generateEstimatePdf)', () => {
  for (const template of TEMPLATES) {
    for (const state of LOGO_STATES) {
      it(`renders ${template} with ${state}`, async () => {
        const buf = await generateEstimatePdf(PREVIEW_ESTIMATE_FIXTURE as any, orgWith(logoFor(state)) as any, template);
        await expectRenderedWithLogoState(buf, state, `estimate/${template}`);
      });
    }
  }
});

/**
 * #2053, Ran's call — an estimate that OFFERS something optional draws nodes no other document
 * has: a marker inside a row's description stack, and a note pulled up under the totals by a
 * negative top margin. pdfmake throws on a node it cannot resolve, and every other test in this
 * feature compares document DEFINITIONS rather than rendering them, so this is the only place
 * that proves the real generator survives them.
 */
describe('PDF rendering guard — an estimate offering an optional add-on', () => {
  const WITH_OPTIONAL_ADD_ON = {
    ...PREVIEW_ESTIMATE_FIXTURE,
    line_items: [
      ...(PREVIEW_ESTIMATE_FIXTURE as unknown as { line_items: unknown[] }).line_items,
      {
        id: 'li-guard-opt', description: 'Smart lock upgrade', item_type: 'MATERIAL',
        quantity: 1, unit_price: 500, line_total: 500, discount_amount: 0,
        is_optional: true, is_selected: false,
      },
    ],
  };

  for (const template of TEMPLATES) {
    it(`renders ${template} with an optional row marker and its totals note`, async () => {
      const buf = await generateEstimatePdf(WITH_OPTIONAL_ADD_ON as any, orgWith(null) as any, template);

      await expectRenderedWithLogoState(buf, 'no logo', `estimate-optional/${template}`);
    });
  }
});

describe('PDF rendering guard — invoice (generateInvoicePdf)', () => {
  for (const template of TEMPLATES) {
    for (const state of LOGO_STATES) {
      it(`renders ${template} with ${state}`, async () => {
        const buf = await generateInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, orgWith(logoFor(state)) as any, template);
        await expectRenderedWithLogoState(buf, state, `invoice/${template}`);
      });
    }
  }
});

describe('PDF rendering guard — statement (generateStatementPdf)', () => {
  for (const state of LOGO_STATES) {
    it(`renders statement with ${state}`, async () => {
      const buf = await generateStatementPdf(STATEMENT_FIXTURE, orgWith(logoFor(state)) as any);
      await expectRenderedWithLogoState(buf, state, 'statement');
    });
  }
});

/**
 * GUARDING THE GUARD.
 *
 * A verifier that silently passes on everything is exactly the defect this suite was
 * rewritten to remove, so the verifier's own ability to report failure is itself tested
 * here — against documents built to be wrong in each specific way.
 */
describe('PDF rendering guard — the logo verifier can actually fail', () => {
  /** A document whose image XObject IS in /Resources but which no `Do` operator paints. */
  async function imageEmbeddedButNeverPainted(): Promise<Buffer> {
    const jpg = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 12, g: 45, b: 58 } } })
      .jpeg()
      .toBuffer();
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 300]);
    const font = await doc.embedFont('Helvetica');
    page.drawText('this page paints no image', { x: 20, y: 150, size: 10, font });
    const img = await doc.embedJpg(jpg);
    page.node.setXObject(PDFName.of('I1'), img.ref);
    return Buffer.from(await doc.save());
  }

  it('reports PRESENT-but-not-DRAWN, so presence alone cannot carry the assertion', async () => {
    const report = await inspectPdfImages(await imageEmbeddedButNeverPainted());
    expect(report.imageXObjects).toEqual(['I1']);
    expect(report.drawnXObjects).toEqual([]);
    expect(report.drawnImages).toEqual([]);
  });

  it('rejects a document that embeds the image but never paints it', async () => {
    await expect(expectLogoDrawn(await imageEmbeddedButNeverPainted(), 'embedded-but-not-painted')).rejects.toThrow(
      /no `Do` operator paints it/,
    );
  });

  it('rejects a logo-less document when a logo is required', async () => {
    const logoless = await generateEstimatePdf(PREVIEW_ESTIMATE_FIXTURE as any, orgWith(null) as any, 'alpha-classic');
    await expect(expectLogoDrawn(logoless, 'null logo')).rejects.toThrow(/the logo was never embedded/);
  });

  it('rejects a logo-bearing document when logo-less was required', async () => {
    const withLogo = await generateEstimatePdf(
      PREVIEW_ESTIMATE_FIXTURE as any, orgWith(embeddedLogo) as any, 'alpha-classic',
    );
    await expect(expectNoLogoDrawn(withLogo, 'embedded logo')).rejects.toThrow(/expected a logo-less document/);
  });

  /**
   * The per-file sanity assertion: prove the extractor really read THIS document. If a
   * future parser change made it return nothing, every "no logo" assertion above would
   * pass vacuously — so the positive evidence is asserted directly.
   */
  it('proves the extractor read the document, so an absence is trustworthy', async () => {
    const withLogo = await generateEstimatePdf(
      PREVIEW_ESTIMATE_FIXTURE as any, orgWith(embeddedLogo) as any, 'alpha-classic',
    );
    const logoless = await generateEstimatePdf(PREVIEW_ESTIMATE_FIXTURE as any, orgWith(null) as any, 'alpha-classic');

    for (const [label, report] of [
      ['with logo', await inspectPdfImages(withLogo)],
      ['logo-less', await inspectPdfImages(logoless)],
    ] as const) {
      expect(report.pageCount, `${label}: pages`).toBeGreaterThan(0);
      expect(report.fontCount, `${label}: embedded fonts`).toBeGreaterThan(0);
      expect(report.contentLength, `${label}: inflated content stream`).toBeGreaterThan(1000);
      expect(report.drawsText, `${label}: text-showing operator`).toBe(true);
    }
  });
});
