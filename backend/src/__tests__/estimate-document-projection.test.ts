/**
 * #2028 slice 1 — one shared document projection.
 *
 * The three estimate-document surfaces (the previewed PDF, the PDF attached to the customer's
 * email, and the public web page) each used to select their own set of estimate fields. The
 * emailed PDF's set omitted `scopes`, `scope_notes` and both discount fields, so a document
 * whose money lives in a priced scope-of-work block printed line items summing to far less than
 * its own Sub total — Ran's reported "$200 line item under a $2,200 subtotal".
 *
 * These tests only bite because the prisma mock APPLIES the select the code passed (see
 * `applySelect`). A mock that returns the whole row regardless of select cannot fail when a
 * field is missing from a select, which is exactly the defect under test.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

const { resendSend } = vi.hoisted(() => ({ resendSend: vi.fn() }));

// setup.ts's env mock, widened with the RESEND_*/EMAIL_FROM keys lib/email.ts needs. A superset,
// not a replacement — app.ts (imported below for the previewed-PDF route) reads the rest.
vi.mock('../config/env', () => ({
  env: {
    PORT: 3000,
    NODE_ENV: 'test',
    FRONTEND_URL: 'http://localhost:5173',
    TAX_RATE: 0.0875,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    GEMINI_API_KEY: 'test-gemini-key',
    GEMINI_TEXT_MODEL: 'gemini-2.5-flash',
    GEMINI_LIVE_MODEL: 'gemini-2.5-flash-native-audio-preview-12-2025',
    COPILOT_VOICE_NAME: 'Puck',
    COPILOT_SESSION_MINUTES: 30,
    COPILOT_RATELIMIT_CAPACITY: 30,
    COPILOT_RATELIMIT_REFILL_PER_MIN: 15,
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
    EMAIL_FROM: 'Alpha <noreply@test.com>',
    EMAIL_FROM_BUSINESS: 'Alpha <noreply@test.com>',
    RESEND_API_KEY: 're_test_key',
  },
}));

vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  generateStatementPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  fetchAsBase64: vi.fn(),
}));

import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { generateEstimatePdf } from '../lib/pdf';
import { buildAlphaClassicPdf } from '../lib/pdf/templates/alpha-classic';
import { mockAuthAs, authHeader } from './helpers';
import { estimateDocumentSelect } from '../lib/estimate-document';

let sendEstimateEmail: typeof import('../lib/email')['sendEstimateEmail'];

beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  sendEstimateEmail = real.sendEstimateEmail;
});

// ─── A select-applying prisma mock ────────────────────────────────────────────

/**
 * Project a full row through a Prisma `select`, the way the database would. A field the caller
 * did not ask for comes back absent — so a test asserting on that field fails, instead of
 * silently passing on a mock that hands back everything.
 */
export function applySelect(row: unknown, select: unknown): unknown {
  if (row == null) return row;
  if (!select || typeof select !== 'object') return row;
  if (Array.isArray(row)) return row.map((r) => applySelect(r, select));
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(select as Record<string, unknown>)) {
    const value = (row as Record<string, unknown>)[key];
    if (spec === true) {
      out[key] = value === undefined ? null : value;
    } else if (spec && typeof spec === 'object') {
      out[key] = applySelect(value ?? null, (spec as { select?: unknown }).select);
    }
  }
  return out;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG = {
  id: 'org-1',
  name: 'Northwind Services LLC',
  address_line1: '1001 Willow Avenue',
  address_line2: null,
  city: 'Hoboken',
  state: 'NJ',
  postal_code: '07030',
  email: 'info@northwind.example.com',
  phone: null,
  website: null,
  logo_url: null,
  brand_color: '#E11D2E',
  estimate_template: 'alpha-classic',
  estimate_terms: 'Sample terms.',
  estimate_notes: '',
  estimate_payment_terms: '',
  email_sending_enabled: true,
};

/**
 * Ran's reported document, as the database holds it: $200 of line items, a $2,000 priced scope,
 * a $2,200 Sub total. `internal_cost` is present on the stored scope — the customer must never
 * see it.
 */
const PRICED_SCOPE = {
  id: 'scope-1',
  title: 'Install 3 commercial storefront doors',
  body: 'Remove existing units, install new frames and hardware.',
  flat_price: 2000,
  is_taxable: true,
  internal_cost: 900,
};

const SCOPE_PHOTO = {
  id: 'sp-1',
  scope_id: 'scope-1',
  storage_path: 'org/estimate_scope/est-1/scope-1/1-a.jpg',
  mime_type: 'image/jpeg',
  caption: 'Existing frame',
  uploaded_at: new Date('2026-09-01T00:00:00Z'),
  uploaded_by: 'Rep',
  size_bytes: 2048,
};

const ESTIMATE_ROW = {
  id: 'est-1',
  public_token: 'tok-1',
  scope_photos: [SCOPE_PHOTO],
  estimate_number: 'E00042',
  status: 'SENT',
  created_at: new Date('2026-09-01T00:00:00Z'),
  organization_id: ORG.id,
  subtotal: 2200,
  discount_type: null,
  discount_value: null,
  discount_name: null,
  discount_amount: 0,
  tax_rate: 0,
  tax_amount: 0,
  total_amount: 2200,
  signature_data: null,
  signature_at: null,
  snapshot_terms: 'Snapshot terms.',
  snapshot_notes: '',
  snapshot_payment_terms: '',
  scope_notes: 'Work is performed during business hours.',
  scopes: [PRICED_SCOPE],
  created_by: 'user-1',
  customer: {
    // #1997 — every real customer row has one, and the redaction verdict fails closed without it
    // (`isCustomerReadable`). A fixture without an id made the staff PDF preview redact for an
    // ADMIN, which no production row can do.
    id: 'cust-1',
    first_name: 'Jane',
    last_name: 'Doe',
    company_name: null,
    email: 'jane@example.com',
    phone: '5551234567',
  },
  service_location: null,
  lead: null,
  line_items: [
    {
      id: 'li-1',
      sequence: 0,
      description: 'Keypad',
      item_type: 'MATERIAL',
      quantity: 1,
      unit_price: 200,
      is_taxable: true,
      line_total: 200,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  (prisma.organization.findUnique as Mock).mockResolvedValue(ORG);
  (prisma.estimate.findUnique as Mock).mockImplementation(
    async (args: { select?: unknown }) => applySelect(ESTIMATE_ROW, args?.select),
  );
  (prisma.estimate.findFirst as Mock).mockImplementation(
    async (args: { select?: unknown }) => applySelect(ESTIMATE_ROW, args?.select),
  );
  (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
  (prisma.email.create as Mock).mockResolvedValue({});
  resendSend.mockResolvedValue({ data: { id: 're_1' }, error: null });
});

const SEND_PARAMS = {
  estimateId: 'est-1',
  org: ORG,
  to: 'jane@example.com',
  customerName: 'Jane Doe',
  estimateNumber: 'E00042',
  total: '$2,200.00',
  publicUrl: 'https://app.servwave.com/e/est-1',
};

/** The estimate row that actually reached the PDF renderer on the last send. */
function renderedEstimate(): any {
  const call = vi.mocked(generateEstimatePdf).mock.calls.at(-1);
  if (!call) throw new Error('generateEstimatePdf was never called');
  return call[0];
}

describe('the emailed estimate PDF', () => {
  it("prints the priced scope block that its Sub total already contains", async () => {
    await sendEstimateEmail(SEND_PARAMS);

    const doc = buildAlphaClassicPdf(renderedEstimate(), ORG as any);
    const json = JSON.stringify(doc);

    expect(json).toContain('Install 3 commercial storefront doors');
    expect(json).toContain('$2,000.00');
    expect(json).toContain('$2,200.00');
  });

  it('prints the estimate-level discount that stands between its Sub total and its Total', async () => {
    (prisma.estimate.findUnique as Mock).mockImplementation(
      async (args: { select?: unknown }) =>
        applySelect(
          {
            ...ESTIMATE_ROW,
            discount_name: 'Repeat customer',
            discount_amount: 150,
            total_amount: 2050,
          },
          args?.select,
        ),
    );

    await sendEstimateEmail(SEND_PARAMS);

    const json = JSON.stringify(buildAlphaClassicPdf(renderedEstimate(), ORG as any));
    expect(json).toContain('Repeat customer');
    expect(json).toContain('\u2212$150.00');
  });

  // #2028 slice 5 — end to end: the projection carries scope_notes AND Alpha Classic now draws
  // it. Either half alone leaves the customer's document without the scope of work.
  it('prints the scope-of-work narrative the salesperson typed', async () => {
    await sendEstimateEmail(SEND_PARAMS);

    const json = JSON.stringify(buildAlphaClassicPdf(renderedEstimate(), ORG as any));
    expect(json).toContain('Work is performed during business hours.');
  });

  it('prints a line-level discount as struck-through gross beside the net it contributes', async () => {
    (prisma.estimate.findUnique as Mock).mockImplementation(
      async (args: { select?: unknown }) =>
        applySelect(
          {
            ...ESTIMATE_ROW,
            line_items: [{ ...ESTIMATE_ROW.line_items[0], discount_amount: 50 }],
            subtotal: 2150,
            total_amount: 2150,
          },
          args?.select,
        ),
    );

    await sendEstimateEmail(SEND_PARAMS);

    const json = JSON.stringify(buildAlphaClassicPdf(renderedEstimate(), ORG as any));
    // $200.00 gross struck through, $150.00 net — the figure the Sub total actually contains.
    expect(json).toContain('"text":"$200.00","decoration":"lineThrough"');
    expect(json).toContain('$150.00');
  });
});

describe('the previewed PDF and the emailed PDF', () => {
  it('are the same document for the same estimate', async () => {
    mockAuthAs('admin');
    await request(app).get('/api/estimates/est-1/pdf').set(authHeader('admin')).expect(200);
    const previewed = renderedEstimate();

    vi.mocked(generateEstimatePdf).mockClear();
    await sendEstimateEmail(SEND_PARAMS);
    const emailed = renderedEstimate();

    // Compared as JSON: a pdfmake docDefinition carries `layout` callbacks, which are fresh
    // closures on every build and never reference-equal. The content is what "same document"
    // means here.
    expect(JSON.stringify(buildAlphaClassicPdf(emailed, ORG as any))).toEqual(
      JSON.stringify(buildAlphaClassicPdf(previewed, ORG as any)),
    );
  });
});

describe('the public estimate page', () => {
  const publicPage = () =>
    request(app).get('/api/estimates/est-1/public?token=tok-1').expect(200);

  it('carries the priced scope blocks its Sub total already contains', async () => {
    const res = await publicPage();

    expect(res.body.estimate.scopes).toEqual([
      expect.objectContaining({
        title: 'Install 3 commercial storefront doors',
        flat_price: 2000,
      }),
    ]);
  });

  it('never carries a scope\'s internal cost to the customer', async () => {
    const res = await publicPage();

    expect(JSON.stringify(res.body)).not.toContain('internal_cost');
    expect(JSON.stringify(res.body)).not.toContain('900');
  });

  it('reads an estimate with no scopes back as an empty list, not null', async () => {
    (prisma.estimate.findFirst as Mock).mockImplementation(
      async (args: { select?: unknown }) =>
        applySelect({ ...ESTIMATE_ROW, scopes: null }, args?.select),
    );

    const res = await publicPage();

    expect(res.body.estimate.scopes).toEqual([]);
  });
});

// ─── The projection is the contract ───────────────────────────────────────────

/**
 * Every key path the projection declares, e.g. `line_items.discount_amount`. Comparing paths
 * rather than whole objects lets a surface add its own fields (a deposit invoice, an
 * authorization anchor) while still being held to everything the document needs.
 */
function selectPaths(select: unknown, prefix = ''): string[] {
  if (!select || typeof select !== 'object') return [];
  return Object.entries(select as Record<string, unknown>).flatMap(([key, spec]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (spec === true) return [path];
    if (spec && typeof spec === 'object') {
      return selectPaths((spec as { select?: unknown }).select, path);
    }
    return [];
  });
}

/** The `select` each surface actually handed Prisma on the last call. */
function selectPassedTo(fn: Mock): unknown {
  const call = fn.mock.calls.at(-1);
  if (!call) throw new Error('prisma was never queried');
  return (call[0] as { select?: unknown }).select;
}

describe('every estimate-document surface', () => {
  const DOCUMENT_PATHS = selectPaths(estimateDocumentSelect);

  it('declares a non-trivial document (guards the guard)', () => {
    expect(DOCUMENT_PATHS).toContain('scopes');
    expect(DOCUMENT_PATHS).toContain('discount_amount');
    expect(DOCUMENT_PATHS).toContain('line_items.discount_amount');
    expect(DOCUMENT_PATHS.length).toBeGreaterThan(30);
  });

  it('asks the database for every field the projection declares — previewed PDF', async () => {
    mockAuthAs('admin');
    await request(app).get('/api/estimates/est-1/pdf').set(authHeader('admin')).expect(200);

    const asked = selectPaths(selectPassedTo(prisma.estimate.findUnique as Mock));
    expect(asked).toEqual(expect.arrayContaining(DOCUMENT_PATHS));
  });

  it('asks the database for every field the projection declares — emailed PDF', async () => {
    await sendEstimateEmail(SEND_PARAMS);

    const asked = selectPaths(selectPassedTo(prisma.estimate.findUnique as Mock));
    expect(asked).toEqual(expect.arrayContaining(DOCUMENT_PATHS));
  });

  /**
   * #1997 — the ONE documented carve-out from "every surface asks for the whole projection". The
   * public page is UNAUTHENTICATED (token-gated), so there is no requester for the contact
   * redaction to judge and it cannot run there; the customer's contact block is therefore kept
   * off the payload by the PROJECTION instead (`estimatePublicCustomerSelect`), exactly as
   * `invoice.controller.ts::getPublic` does ("F-55: display name only").
   *
   * Nothing in the carve-out is document CONTENT: not one of these fields is priced, so none can
   * make the printed rows disagree with the printed totals, which is the defect this whole guard
   * exists to catch. The PDF surfaces — including the customer's own token-gated PDF download,
   * whose Bill To block does render them — still ask for every one.
   */
  const PUBLIC_PAGE_CONTACT_CARVE_OUT = DOCUMENT_PATHS.filter(
    (path) => /^(lead\.)?customer\.(email|phone|service_locations\.)/.test(path),
  );

  it('withholds exactly the customer contact block from the public page, and nothing else', () => {
    // Guards the guard: a carve-out that silently grew to cover priced content would make the
    // assertion below vacuous.
    expect(PUBLIC_PAGE_CONTACT_CARVE_OUT.sort()).toEqual([
      'customer.email',
      'customer.phone',
      'lead.customer.email',
      'lead.customer.phone',
      'lead.customer.service_locations.address_line1',
      'lead.customer.service_locations.address_line2',
      'lead.customer.service_locations.city',
      'lead.customer.service_locations.is_primary',
      'lead.customer.service_locations.state',
      'lead.customer.service_locations.zip',
    ]);
  });

  it('asks the database for every field the projection declares — public web page', async () => {
    await request(app).get('/api/estimates/est-1/public?token=tok-1').expect(200);

    const asked = selectPaths(selectPassedTo(prisma.estimate.findFirst as Mock));
    const required = DOCUMENT_PATHS.filter((path) => !PUBLIC_PAGE_CONTACT_CARVE_OUT.includes(path));
    expect(asked).toEqual(expect.arrayContaining(required));
    // And the carve-out really is carved out — not merely tolerated.
    for (const path of PUBLIC_PAGE_CONTACT_CARVE_OUT) {
      expect(asked, `public page must not ask for ${path}`).not.toContain(path);
    }
  });

  it('asks the database for every field the projection declares — the customer\'s PDF download', async () => {
    await request(app).get('/api/estimates/est-1/public/pdf?token=tok-1').expect(200);

    const asked = selectPaths(selectPassedTo(prisma.estimate.findUnique as Mock));
    expect(asked).toEqual(expect.arrayContaining(DOCUMENT_PATHS));
  });
});

// ─── #2029 slice 3 — scope photos reach the customer ─────────────────────────

describe("the public page's scope photos", () => {
  const publicPage = () =>
    request(app).get('/api/estimates/est-1/public?token=tok-1').expect(200);

  it('are carried on the payload, grouped by the scope they belong to', async () => {
    const res = await publicPage();

    expect(res.body.estimate.scope_photos).toEqual([
      expect.objectContaining({ id: 'sp-1', scope_id: 'scope-1', caption: 'Existing frame' }),
    ]);
  });

  it('carry a freshly-signed url and never the raw storage path', async () => {
    const res = await publicPage();

    const photo = res.body.estimate.scope_photos[0];
    expect(photo.url).toContain('/object/sign/');
    expect(photo).not.toHaveProperty('storage_path');
  });
});
