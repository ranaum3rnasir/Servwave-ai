import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { generateEstimatePdf, generateInvoicePdf, generateStatementPdf } from '../index';
import { PREVIEW_ESTIMATE_FIXTURE, PREVIEW_INVOICE_FIXTURE } from '../preview-fixture';
import type { TemplateKey } from '../templates/registry';

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
// http logo whose host is NOT the allowlisted Supabase project → fetch is rejected;
// generation must degrade to a logo-less PDF (this is the exact prod outage).
const UNREACHABLE_LOGO = 'https://not-our-supabase-project.example.com/logo.png';

const LOGO_STATES = ['no logo', 'embedded logo', 'unreachable logo'] as const;
const logoFor = (state: (typeof LOGO_STATES)[number]): string | null =>
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

describe('PDF rendering guard — estimate / invoice / branding-preview (generateEstimatePdf)', () => {
  for (const template of TEMPLATES) {
    for (const state of LOGO_STATES) {
      it(`renders ${template} with ${state}`, async () => {
        const buf = await generateEstimatePdf(PREVIEW_ESTIMATE_FIXTURE as any, orgWith(logoFor(state)) as any, template);
        expect(isPdf(buf)).toBe(true);
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

      expect(isPdf(buf)).toBe(true);
    });
  }
});

describe('PDF rendering guard — invoice (generateInvoicePdf)', () => {
  for (const template of TEMPLATES) {
    for (const state of LOGO_STATES) {
      it(`renders ${template} with ${state}`, async () => {
        const buf = await generateInvoicePdf(PREVIEW_INVOICE_FIXTURE as any, orgWith(logoFor(state)) as any, template);
        expect(isPdf(buf)).toBe(true);
      });
    }
  }
});

describe('PDF rendering guard — statement (generateStatementPdf)', () => {
  for (const state of LOGO_STATES) {
    it(`renders statement with ${state}`, async () => {
      const buf = await generateStatementPdf(STATEMENT_FIXTURE, orgWith(logoFor(state)) as any);
      expect(isPdf(buf)).toBe(true);
    });
  }
});
