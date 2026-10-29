/**
 * A5 (#2090, Ran's ruling 2026-09-19) — the customer's link dies when the DOCUMENT changes, and
 * the next send mints a replacement.
 *
 *   "As long as it's the same estimate, resending it works... The moment something changed in the
 *    estimate and a new URL was created, that's when the old URL gets revoked."
 *
 * Rotation is conditional on CHANGE, not on the act of re-sending. Today's code already had the
 * timing right — a material edit nulls the token, the next send mints a fresh one, an unchanged
 * re-send reuses it — but the PREDICATE only looked at the four totals columns. A changed
 * description, item type, scope prose, or a quantity-and-price swap that nets to the same figure
 * moved the customer's document and revoked nothing.
 *
 * HARNESS. These are behaviour tests through the real doors, never assertions on a helper's
 * return value: a staff edit goes in through the HTTP endpoint a rep actually uses, and the
 * verdict is read off `GET /api/estimates/:id/public?token=...` — literally the page the customer
 * opens. A 404 there IS the revocation; a 200 IS "their link still works".
 *
 * Two estimate rows are seeded, not one, because the ruling is scoped to a single row: the sibling
 * proves nothing here reaches across to another tab's token.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { sendEstimateEmail } from '../lib/email';
import { mockAuthAs, authHeader, ESTIMATE_SENT_FIXTURE, TEST_USERS, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = Record<string, any>;

const mockPrisma = prisma as unknown as Record<string, any>;
const emailMock = sendEstimateEmail as unknown as ReturnType<typeof vi.fn>;

const MAIN_ID = 'f0000000-0000-0000-0000-0000000005a1';
const SIB_ID = 'f0000000-0000-0000-0000-0000000005a2';
const MAIN_TOKEN = 'aa5a0000-0000-0000-0000-0000000005a1';
const SIB_TOKEN = 'bb5a0000-0000-0000-0000-0000000005a2';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000005a0';
const DEPOSIT_INVOICE_ID = 'd0000000-0000-0000-0000-0000000005a0';
const DEPOSIT_TOKEN = 'dd5a0000-0000-0000-0000-0000000005a0';

const LINE_A = 'aa000000-0000-0000-0000-0000000005a1';
const LINE_OPT = 'aa000000-0000-0000-0000-0000000005a2';
const SCOPE_ID = 'cc000000-0000-0000-0000-0000000005a1';

/** Every document in play, keyed by id. Mutated in place by the harness's writes. */
let docs: Record<string, Doc>;
/** The kind=DEPOSIT invoice minted at the first send, with its OWN public link. */
let depositInvoice: Doc;

function lineRow(over: Partial<Doc>): Doc {
  return {
    estimate_id: MAIN_ID,
    sequence: 1,
    description: 'Replace opener',
    quantity: 2,
    unit_price: 100,
    unit_cost: null,
    markup_percent: null,
    is_taxable: false,
    line_total: 200,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    is_optional: false,
    is_selected: true,
    rep_selected: null,
    price_book_item: null,
    ...over,
  };
}

function scopeBlock(over: Partial<Doc>): Doc {
  return {
    id: SCOPE_ID,
    title: 'Site preparation',
    body: 'We clear the bay and protect the floor.',
    flat_price: 0,
    is_taxable: false,
    internal_cost: null,
    is_optional: false,
    is_selected: true,
    ...over,
  };
}

function estimateDoc(over: Partial<Doc>): Doc {
  const doc: Doc = {
    ...ESTIMATE_SENT_FIXTURE,
    id: MAIN_ID,
    organization_id: ALPHA_ORG_ID,
    estimate_number: 'E-A5-01',
    status: 'SENT',
    public_token: MAIN_TOKEN,
    valid_until: new Date('2099-01-01'),
    sent_at: new Date('2026-09-01'),
    modified_after_send: false,
    version: 3,
    created_by: TEST_USERS.admin.id,
    customer_id: CUSTOMER_ID,
    lead_id: null,
    lead: null,
    job_id: null,
    job: null,
    job_link: null,
    customer: {
      id: CUSTOMER_ID, first_name: 'Pat', last_name: 'Buyer', company_name: null,
      email: 'pat@example.com', phone: null, tax_exempt: false, service_locations: [],
    },
    service_location: null,
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    discount_name: null,
    discount_amount: 0,
    deposit_type: null,
    deposit_value: null,
    subtotal: 200,
    tax_amount: 0,
    total_amount: 200,
    scope_notes: 'Two visits, morning slots only.',
    scopes: [scopeBlock({})],
    line_items: [lineRow({ id: LINE_A })],
    send_config: null,
    invoices: [],
    scope_photos: [],
    snapshot_terms: 'T',
    snapshot_notes: 'N',
    snapshot_payment_terms: 'P',
    organization: { lock_on_send: false },
    terms_accepted: false,
    terms_accepted_at: null,
    approved_at: null,
    declined_at: null,
    signature_data: null,
    signature_at: null,
    created_at: new Date('2026-09-01'),
    ...over,
  };
  doc._count = { line_items: doc.line_items.length };
  return doc;
}

function seed(mainOver: Partial<Doc> = {}) {
  docs = {
    [MAIN_ID]: estimateDoc(mainOver),
    [SIB_ID]: estimateDoc({
      id: SIB_ID,
      estimate_number: 'E-A5-02',
      public_token: SIB_TOKEN,
      line_items: [lineRow({ id: 'aa000000-0000-0000-0000-0000000005b1', estimate_id: SIB_ID })],
    }),
  };
  depositInvoice = {
    id: DEPOSIT_INVOICE_ID,
    invoice_number: 'DEP-A5-01',
    organization_id: ALPHA_ORG_ID,
    estimate_id: MAIN_ID,
    kind: 'DEPOSIT',
    status: 'SENT',
    public_token: DEPOSIT_TOKEN,
    subtotal: 100, discount_amount: 0, tax_amount: 0, deposit_credit: 0,
    total_amount: 100, amount_due: 100,
    due_date: null, sent_at: new Date('2026-09-01'), paid_at: null, created_at: new Date('2026-09-01'),
    customer: { first_name: 'Pat', last_name: 'Buyer', company_name: null },
    job: null,
    line_items: [{ id: 'il-1', sequence: 1, description: 'Deposit', quantity: 1, unit_price: 100, is_taxable: false, line_total: 100 }],
    payments: [],
  };
}

function byId(id: unknown): Doc | null {
  return (typeof id === 'string' && docs[id]) || null;
}

/**
 * Real Prisma sorts when — and ONLY when — the read asks it to. Both real reads of an estimate's
 * lines do ask (`estimateGuardSelect.line_items` and `recomputeAndPersist`'s own `findMany`), and
 * A5 compares the customer's rows POSITIONALLY, which is why `sequence` itself is not in the
 * predicate. So order is the contract, and this mock has to model the CONDITION as well as the
 * sort: a mock that sorted unconditionally would keep every reorder assertion below green even if
 * production dropped its `orderBy` — the same blind spot as never sorting, just better hidden.
 *
 * Unordered therefore means insertion order here, which is as good a stand-in as any for the heap
 * order Postgres is entitled to return, and is reliably wrong after a reorder.
 */
function sortsBySequence(orderBy: unknown): boolean {
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return clauses.some((c) => (c as Doc)?.sequence !== undefined);
}

function readLines(lines: Doc[], orderBy: unknown): Doc[] {
  return sortsBySequence(orderBy)
    ? [...lines].sort((a, b) => Number(a.sequence) - Number(b.sequence))
    : [...lines];
}

/** Apply a prisma `data` payload to an in-memory document, including nested line-item writes. */
function applyUpdate(doc: Doc, data: Record<string, any> | undefined) {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k === 'line_items') {
      const nested = v as any;
      if (nested?.deleteMany) doc.line_items = [];
      if (nested?.create) {
        const rows = Array.isArray(nested.create) ? nested.create : [nested.create];
        rows.forEach((r: Doc, i: number) => doc.line_items.push({
          ...lineRow({}), id: `new-${i}`, estimate_id: doc.id, ...r,
        }));
      }
      for (const stmt of [].concat(nested?.updateMany ?? [])) {
        const s = stmt as unknown as { where: Doc; data: Doc };
        // `id: { in: [...] }` is how the pre-dispatch publish's rollback addresses its rows.
        const idIn = (s.where?.id as Doc)?.in as string[] | undefined;
        for (const l of doc.line_items) {
          const matches = Object.entries(s.where).every(([wk, wv]) => (
            wk === 'id' && idIn ? idIn.includes(l.id) : l[wk] === wv
          ));
          if (matches) Object.assign(l, s.data);
        }
      }
      continue;
    }
    doc[k] = v;
  }
  doc._count = { line_items: doc.line_items.length };
  return doc;
}

function txClient() {
  return {
    estimate: {
      findUnique: vi.fn(async (args: { where: { id: string }; select?: Doc }) => {
        const doc = byId(args.where.id);
        return doc ? { ...doc, line_items: readLines(doc.line_items, args.select?.line_items?.orderBy) } : null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Doc }) => {
        const doc = byId(args.where.id);
        return doc ? applyUpdate(doc, args.data) : null;
      }),
    },
    estimateLineItem: {
      findMany: vi.fn(async (args: { where?: { estimate_id?: string }; orderBy?: unknown }) => {
        const doc = byId(args?.where?.estimate_id) ?? docs[MAIN_ID];
        return readLines(doc.line_items, args?.orderBy);
      }),
      create: vi.fn(async (args: { data: Doc }) => {
        const row = { ...lineRow({}), id: `created-${Date.now()}`, ...args.data };
        (byId(args.data.estimate_id) ?? docs[MAIN_ID]).line_items.push(row);
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Doc }) => {
        for (const doc of Object.values(docs)) {
          const l = doc.line_items.find((x: Doc) => x.id === args.where.id);
          if (l) { Object.assign(l, args.data); return l; }
        }
        return null;
      }),
      updateMany: vi.fn(async (args: { where: Doc; data: Doc }) => {
        let count = 0;
        for (const doc of Object.values(docs)) {
          for (const l of doc.line_items) {
            const idIn = (args.where?.id as Doc)?.in;
            const matches = Object.entries(args.where ?? {}).every(([wk, wv]) => (
              wk === 'id' && idIn ? idIn.includes(l.id) : l[wk] === wv
            ));
            if (matches) { Object.assign(l, args.data); count += 1; }
          }
        }
        return { count };
      }),
      deleteMany: vi.fn(async (args: { where?: Doc }) => {
        const where = args?.where ?? {};
        let count = 0;
        for (const doc of Object.values(docs)) {
          const before = doc.line_items.length;
          doc.line_items = doc.line_items.filter((l: Doc) => !Object.entries(where).every(([wk, wv]) => l[wk] === wv));
          count += before - doc.line_items.length;
          doc._count = { line_items: doc.line_items.length };
        }
        return { count };
      }),
    },
    estimateSendConfig: {
      upsert: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    invoice: {
      findFirst: vi.fn(async () => depositInvoice),
      create: vi.fn(async () => ({ id: DEPOSIT_INVOICE_ID })),
      update: vi.fn(async (args: { data: Doc }) => { Object.assign(depositInvoice, args.data); return depositInvoice; }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    timelineEvent: { create: vi.fn(async () => ({})) },
    lead: { update: vi.fn(async () => ({})) },
    numberSequence: { upsert: vi.fn(async () => ({ next_value: 7 })) },
    appSetting: { findUnique: vi.fn(async () => null) },
  };
}

function installHarness() {
  mockAuthAs('admin');
  clearPermissionCache();
  emailMock.mockClear();
  emailMock.mockResolvedValue({ status: 'sent' });

  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: ALPHA_ORG_ID, name: 'Test Org', logo_url: null, brand_color: null,
    email: null, phone: null, phone_ext: null, website: null,
    estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
    accepted_payment_methods: [], stripe_charges_enabled: false,
    deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
  });
  // A SNAPSHOT, never the live object. Every guarded write path loads the pre-mutation row through
  // this door and then diffs its own result against it; handing back the same arrays the handler
  // is about to mutate would make before and after identical by construction, and every
  // revocation assertion below would pass for the wrong reason.
  mockPrisma.estimate.findUnique.mockImplementation(async (args: { where?: { id?: string }; select?: Doc }) => {
    const doc = byId(args?.where?.id);
    if (!doc) return null;
    return {
      ...doc,
      line_items: readLines(doc.line_items, args?.select?.line_items?.orderBy).map((l: Doc) => ({ ...l })),
      scopes: Array.isArray(doc.scopes) ? doc.scopes.map((s: Doc) => ({ ...s })) : doc.scopes,
    };
  });
  // THE CUSTOMER'S DOOR. `getPublic` matches on `{ id, public_token }` and nothing else, so a
  // nulled token is the 404 — exactly as a wrong token would be.
  mockPrisma.estimate.findFirst.mockImplementation(async (args: { where?: Doc }) => {
    const where = args?.where ?? {};
    const doc = byId(where.id);
    if (!doc) return null;
    if (where.public_token !== undefined && where.public_token !== doc.public_token) return null;
    return doc;
  });
  mockPrisma.estimate.update.mockImplementation(async (args: { where: { id: string }; data: Doc }) => {
    const doc = byId(args.where.id);
    return doc ? applyUpdate(doc, args.data) : null;
  });
  mockPrisma.estimateLineItem.findMany.mockImplementation(async (args: { where?: { estimate_id?: string }; orderBy?: unknown }) => (
    readLines((byId(args?.where?.estimate_id) ?? docs[MAIN_ID]).line_items, args?.orderBy)
  ));
  // Two callers share this delegate: the deposit-checkout guard looks the row up by estimate_id,
  // the customer's own deposit page by its token.
  mockPrisma.invoice.findFirst.mockImplementation(async (args: { where?: Doc }) => {
    const where = args?.where ?? {};
    if (where.public_token !== undefined) {
      return where.public_token === depositInvoice.public_token && where.id === depositInvoice.id
        ? { ...depositInvoice, estimate: { status: docs[MAIN_ID].status, modified_after_send: docs[MAIN_ID].modified_after_send, deposit_type: null, deposit_value: null, total_amount: docs[MAIN_ID].total_amount } }
        : null;
    }
    return null;
  });
  mockPrisma.priceBookItem.findMany.mockResolvedValue([]);
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(txClient());
    return Promise.all(arg as Promise<unknown>[]);
  });
}

// ── The doors ────────────────────────────────────────────────────────────────────────────────

/** The customer opening the link they were emailed. */
function customerOpens(id: string, token: string | null) {
  return request(app).get(`/api/estimates/${id}/public?token=${token}`);
}

/** The customer opening their DEPOSIT link — a different document with its own token. */
function customerOpensDeposit(token: string) {
  return request(app).get(`/api/invoices/${DEPOSIT_INVOICE_ID}/public?token=${token}`);
}

function patchLine(lineId: string, body: Doc, id = MAIN_ID) {
  return request(app).patch(`/api/estimates/${id}/line-items/${lineId}`).set(authHeader('admin')).send(body);
}

function patchScope(idx: number, body: Doc, id = MAIN_ID) {
  return request(app).patch(`/api/estimates/${id}/scopes/${idx}`).set(authHeader('admin')).send(body);
}

function patchDocument(body: Doc, id = MAIN_ID) {
  return request(app).patch(`/api/estimates/${id}`).set(authHeader('admin')).send(body);
}

function send(id = MAIN_ID) {
  return request(app).post(`/api/estimates/${id}/send`).set(authHeader('admin'))
    .send({ deposit_required: false, payment_methods: [] });
}

/** The whole-document PATCH's replacement list, as the editor posts it. */
function listOf(...over: Partial<Doc>[]) {
  return over.map((o) => ({
    description: 'Replace opener', quantity: 2, unit_price: 100, is_taxable: false,
    item_type: 'SERVICE', is_optional: false, is_selected: true, ...o,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  seed();
  installHarness();
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. What revokes the link
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('A5 — an edit the customer would SEE retires their link', () => {
  it('a changed line DESCRIPTION 404s the page the customer already has open', async () => {
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);

    const res = await patchLine(LINE_A, { description: 'Replace opener AND springs' });
    expect(res.status).toBe(200);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);
  });

  it('a rewritten SCOPE block 404s it too — the prose is the offer', async () => {
    const res = await patchScope(0, { body: 'We clear the bay, protect the floor AND haul away the old unit.' });
    expect(res.status).toBe(200);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);
  });

  it('a quantity-and-price swap that nets to the SAME total still 404s it', async () => {
    const res = await patchDocument({ line_items: listOf({ quantity: 1, unit_price: 200 }) });
    expect(res.status).toBe(200);
    // The figure the customer was quoted never moved...
    expect(Number(docs[MAIN_ID].total_amount)).toBe(200);
    // ...but the row they are reading did.
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);
  });

  it('rewritten SCOPE PROSE on the whole-document PATCH 404s it', async () => {
    const res = await patchDocument({ scope_notes: 'Afternoons only now.' });
    expect(res.status).toBe(200);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);
  });

  it('a changed ITEM TYPE 404s it — the document prints "Material" or "Service"', async () => {
    const res = await patchLine(LINE_A, { item_type: 'MATERIAL' });
    expect(res.status).toBe(200);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. What must NOT revoke it
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('A5 — an edit the customer CANNOT see leaves their link alone', () => {
  it('internal cost and markup on their own keep the link live', async () => {
    const res = await patchLine(LINE_A, { unit_cost: 40, markup_percent: 150 });
    expect(res.status).toBe(200);
    expect(docs[MAIN_ID].line_items[0].unit_cost).toBe(40);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });

  it("a rep's OPTIONAL TICK on a sent estimate keeps the link live (this is what A3 exists for)", async () => {
    docs[MAIN_ID].line_items.push(lineRow({
      id: LINE_OPT, sequence: 2, description: 'Keypad', unit_price: 50, quantity: 1, line_total: 50,
      is_optional: true, is_selected: false, rep_selected: null,
    }));
    docs[MAIN_ID]._count = { line_items: 2 };

    const res = await patchLine(LINE_OPT, { is_selected: true });
    expect(res.status).toBe(200);
    // It landed where A3 sends it: the rep's recommendation, not the customer's answer.
    const row = docs[MAIN_ID].line_items.find((l: Doc) => l.id === LINE_OPT);
    expect(row.rep_selected).toBe(true);
    expect(row.is_selected).toBe(false);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });

  it("a rep's tick on an optional SCOPE block keeps the link live too", async () => {
    docs[MAIN_ID].scopes = [scopeBlock({ is_optional: true, is_selected: false, flat_price: 75 })];

    const res = await patchScope(0, { is_selected: true });
    expect(res.status).toBe(200);
    expect(docs[MAIN_ID].scopes[0].rep_selected).toBe(true);
    expect(docs[MAIN_ID].scopes[0].is_selected).toBe(false);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });

  it('a no-op PATCH of the identical document keeps the link live', async () => {
    const res = await patchDocument({ line_items: listOf({}) });
    expect(res.status).toBe(200);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });
});

/**
 * Verifier round 1, RED-1. Two fields were in the projection that no customer surface renders, and
 * both retired live links. `DocumentRow` (lib/estimate-document-view.ts) carries neither: the
 * document's row order comes from the array it is built from, and `is_taxable` reaches the
 * customer only through `tax_amount`, which the projection already holds.
 *
 * The `sequence` one was the dangerous half. `deleteLine` does not resequence — only
 * `reorderLines` and the whole-document PATCH write a contiguous 1..n — so a stored `1,3` is an
 * ordinary state, while `update()` builds its replacement list with `sequence: idx + 1`. A
 * byte-identical re-save therefore compared [1,3] against [1,2] and revoked. Paired with the
 * PENDING signature rule, which nulls `signature_data` unrecoverably, a no-op Save after a line
 * delete could destroy a customer's signature.
 */
describe('A5 — a field the document does not render must not retire a link', () => {
  it('a middle-line delete, then a byte-identical Save, leaves the link live', async () => {
    docs[MAIN_ID].line_items.push(lineRow({ id: LINE_OPT, sequence: 2, description: 'Keypad', quantity: 1, unit_price: 50, line_total: 50 }));
    docs[MAIN_ID].line_items.push(lineRow({ id: 'aa000000-0000-0000-0000-0000000005a3', sequence: 3, description: 'Remote', quantity: 1, unit_price: 25, line_total: 25 }));
    docs[MAIN_ID].subtotal = 275;
    docs[MAIN_ID].total_amount = 275;
    docs[MAIN_ID]._count = { line_items: 3 };

    // The rep deletes the MIDDLE line. That genuinely changes the document, so the link goes...
    expect((await request(app).delete(`/api/estimates/${MAIN_ID}/line-items/${LINE_OPT}`).set(authHeader('admin'))).status).toBe(200);
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);
    // ...and the re-send hands them a new one. The stored sequences are now 1 and 3.
    expect((await send()).status).toBe(200);
    const live = docs[MAIN_ID].public_token;
    expect(docs[MAIN_ID].line_items.map((l: Doc) => l.sequence)).toEqual([1, 3]);
    expect((await customerOpens(MAIN_ID, live)).status).toBe(200);

    // Now the rep hits Save, changing nothing. The editor posts the list it is showing.
    const res = await patchDocument({
      line_items: [
        { description: 'Replace opener', quantity: 2, unit_price: 100, is_taxable: false, item_type: 'SERVICE', is_optional: false, is_selected: true },
        { description: 'Remote', quantity: 1, unit_price: 25, is_taxable: false, item_type: 'SERVICE', is_optional: false, is_selected: true },
      ],
    });
    expect(res.status).toBe(200);

    expect((await customerOpens(MAIN_ID, live)).status).toBe(200);
  });

  it('flipping is_taxable at a 0% rate leaves the link live — nothing rendered moves', async () => {
    expect((await patchLine(LINE_A, { is_taxable: true })).status).toBe(200);

    expect(Number(docs[MAIN_ID].tax_amount)).toBe(0);
    expect(Number(docs[MAIN_ID].total_amount)).toBe(200);
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });

  it("flipping a scope block's is_taxable at a 0% rate leaves the link live too", async () => {
    expect((await patchScope(0, { is_taxable: true })).status).toBe(200);

    expect(Number(docs[MAIN_ID].total_amount)).toBe(200);
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });

  it('REORDERING the lines still retires the link — order IS what the document renders', async () => {
    docs[MAIN_ID].line_items.push(lineRow({
      id: LINE_OPT, sequence: 2, description: 'Keypad', quantity: 1, unit_price: 50, line_total: 50,
    }));
    docs[MAIN_ID].subtotal = 250;
    docs[MAIN_ID].total_amount = 250;
    docs[MAIN_ID]._count = { line_items: 2 };

    const res = await request(app)
      .patch(`/api/estimates/${MAIN_ID}/line-items/reorder`).set(authHeader('admin'))
      .send({ order: [LINE_OPT, LINE_A] });
    expect(res.status).toBe(200);

    // Not one figure moved; the customer's list reads in a different order, and that is the offer.
    expect(Number(docs[MAIN_ID].total_amount)).toBe(250);
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);
  });

  /**
   * The other half of "order is the contract": BOTH sides of the comparison have to be read in the
   * same order, or a no-op edit looks like a reorder. Stored rows come back in whatever order the
   * database feels like unless the read says otherwise, so these seed a document whose array order
   * deliberately disagrees with its `sequence` values — which is exactly the shape that makes the
   * `orderBy` on the PRE-mutation reads load-bearing rather than decorative.
   */
  function seedStoredOutOfOrder() {
    docs[MAIN_ID].line_items = [
      lineRow({ id: LINE_OPT, sequence: 2, description: 'Keypad', quantity: 1, unit_price: 50, line_total: 50 }),
      lineRow({ id: LINE_A, sequence: 1 }),
    ];
    docs[MAIN_ID].subtotal = 250;
    docs[MAIN_ID].total_amount = 250;
    docs[MAIN_ID]._count = { line_items: 2 };
  }

  it('an invisible edit on a doc stored out of sequence order keeps the link — granular door', async () => {
    seedStoredOutOfOrder();

    expect((await patchLine(LINE_A, { unit_cost: 40 })).status).toBe(200);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });

  it('a byte-identical Save on a doc stored out of sequence order keeps the link — whole document', async () => {
    seedStoredOutOfOrder();

    const res = await patchDocument({
      line_items: [
        { description: 'Replace opener', quantity: 2, unit_price: 100, is_taxable: false, item_type: 'SERVICE', is_optional: false, is_selected: true },
        { description: 'Keypad', quantity: 1, unit_price: 50, is_taxable: false, item_type: 'SERVICE', is_optional: false, is_selected: true },
      ],
    });
    expect(res.status).toBe(200);

    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });

  it('is_taxable that DOES move the tax still retires the link', async () => {
    docs[MAIN_ID].tax_rate = 0.1;

    expect((await patchLine(LINE_A, { is_taxable: true })).status).toBe(200);

    expect(Number(docs[MAIN_ID].tax_amount)).toBe(20);
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. The send — reuse, or mint
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The link that actually went to the customer, read off the email the send dispatched. */
function emailedToken(): string {
  const { publicUrl } = emailMock.mock.calls.at(-1)![0] as { publicUrl: string };
  return new URL(publicUrl).searchParams.get('token')!;
}

describe('A5 — a re-send reuses the link, unless the document changed', () => {
  it('nothing changed: the same token goes out again and the old link keeps working', async () => {
    expect((await send()).status).toBe(200);

    expect(docs[MAIN_ID].public_token).toBe(MAIN_TOKEN);
    expect(emailedToken()).toBe(MAIN_TOKEN);
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });

  it('after a revoking edit the next send mints a NEW token, and the email carries it', async () => {
    await patchLine(LINE_A, { description: 'Replace opener AND springs' });
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);

    expect((await send()).status).toBe(200);

    const minted = docs[MAIN_ID].public_token;
    expect(minted).toEqual(expect.any(String));
    expect(minted).not.toBe(MAIN_TOKEN);
    // The customer only ever gets the link the EMAIL carried. A token persisted here that the
    // email did not name is a 404 for them (#1522).
    expect(emailedToken()).toBe(minted);
    expect((await customerOpens(MAIN_ID, minted)).status).toBe(200);
    // ...and the old one stays dead.
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(404);
  });

  it('the retired link 404s — no new "this estimate has been updated" surface (Q6)', async () => {
    await patchLine(LINE_A, { description: 'Replace opener AND springs' });

    const res = await customerOpens(MAIN_ID, MAIN_TOKEN);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Estimate not found' });
  });

  it('a SIBLING estimate keeps its own live link through all of it', async () => {
    await patchLine(LINE_A, { description: 'Replace opener AND springs' });
    await send();

    expect(docs[SIB_ID].public_token).toBe(SIB_TOKEN);
    expect((await customerOpens(SIB_ID, SIB_TOKEN)).status).toBe(200);
  });

  it('a terminal "send a copy" of a WON estimate never rotates (Q7)', async () => {
    docs[MAIN_ID].status = 'WON';

    expect((await send()).status).toBe(200);

    expect(docs[MAIN_ID].public_token).toBe(MAIN_TOKEN);
    expect(emailedToken()).toBe(MAIN_TOKEN);
    expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(200);
  });

  it('the ESTIMATE NUMBER never moves — this is not revise()', async () => {
    await patchLine(LINE_A, { description: 'Replace opener AND springs' });
    await send();

    expect(docs[MAIN_ID].estimate_number).toBe('E-A5-01');
    expect(docs[MAIN_ID].status).toBe('SENT');
    expect(docs[MAIN_ID].superseded_by_id).toBeUndefined();
  });

  it("the DEPOSIT invoice keeps its own link through a revocation and a re-send, and still pays", async () => {
    expect((await customerOpensDeposit(DEPOSIT_TOKEN)).status).toBe(200);

    await patchLine(LINE_A, { unit_price: 150 });
    await send();

    expect(depositInvoice.public_token).toBe(DEPOSIT_TOKEN);
    const res = await customerOpensDeposit(DEPOSIT_TOKEN);
    expect(res.status).toBe(200);
    expect(Number(res.body.invoice.amount_due)).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. The link and its expiry are one object
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('A5 — valid_until travels with the token', () => {
  it('a revoking edit clears the expiry alongside the token', async () => {
    await patchLine(LINE_A, { description: 'Replace opener AND springs' });

    expect(docs[MAIN_ID].public_token).toBeNull();
    expect(docs[MAIN_ID].valid_until).toBeNull();
  });

  it('the send that mints the replacement token mints a fresh expiry with it', async () => {
    await patchLine(LINE_A, { description: 'Replace opener AND springs' });
    await send();

    expect(docs[MAIN_ID].public_token).toEqual(expect.any(String));
    expect(docs[MAIN_ID].valid_until).toBeInstanceOf(Date);
    // A FRESH window (`estimate_validity_days`, defaulted to 30), not the fixture's far-future
    // date surviving untouched — which is what "is a Date in the future" would have accepted.
    const daysOut = (docs[MAIN_ID].valid_until.getTime() - Date.now()) / 86_400_000;
    expect(daysOut).toBeGreaterThan(29);
    expect(daysOut).toBeLessThan(31);
  });

  it('an unchanged re-send leaves the standing expiry alone', async () => {
    await send();

    expect(docs[MAIN_ID].public_token).toBe(MAIN_TOKEN);
    expect(new Date(docs[MAIN_ID].valid_until).getUTCFullYear()).toBe(2099);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5. One figure everywhere (Ran's A2 ruling, folded into A5)
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A send renders the PDF and composes the email BEFORE the commit transaction. Since A2 a send can
 * MOVE the total — it publishes the rep's recommendation over whatever the customer had ticked —
 * so the figure quoted to the customer and the figure on the document their link opens could
 * disagree. A5 carries the new link in that email, so the email is what brings them back to the
 * document, and the two have to agree.
 *
 * `renderEstimatePdfBuffer(estimateId)` (lib/email.ts) re-reads the estimate row, so the PDF's
 * figure IS the persisted `total_amount` at the moment the email is composed. That is what the
 * probe below captures.
 */
describe('A5 — the email and the PDF quote the PUBLISHED total, not the pre-publish one', () => {
  /** The estimate row as it stood when the email was composed — i.e. what the PDF printed. */
  let totalOnTheRowWhenThePdfWasRendered: number | null;

  beforeEach(() => {
    totalOnTheRowWhenThePdfWasRendered = null;
    emailMock.mockImplementation(async () => {
      totalOnTheRowWhenThePdfWasRendered = Number(docs[MAIN_ID].total_amount);
      return { status: 'sent' };
    });

    // The customer declined a $50 option; the rep is re-sending with it recommended back ON.
    docs[MAIN_ID].line_items.push(lineRow({
      id: LINE_OPT, sequence: 2, description: 'Keypad', unit_price: 50, quantity: 1, line_total: 50,
      is_optional: true, is_selected: false, rep_selected: true,
    }));
    docs[MAIN_ID]._count = { line_items: 2 };
    docs[MAIN_ID].subtotal = 200;
    docs[MAIN_ID].total_amount = 200;
    docs[MAIN_ID].deposit_type = 'PERCENTAGE';
    docs[MAIN_ID].deposit_value = 50;
  });

  it('the emailed figure is the one the send published', async () => {
    expect((await send()).status).toBe(200);

    // The publish put the declined option back on: 200 -> 250.
    expect(Number(docs[MAIN_ID].total_amount)).toBe(250);
    const { total } = emailMock.mock.calls.at(-1)![0] as { total: string };
    expect(total).toBe('$250.00');
  });

  it('the row the PDF renderer reads already carries the published figure', async () => {
    await send();

    expect(totalOnTheRowWhenThePdfWasRendered).toBe(250);
  });

  it('the deposit invoice behind the link is re-priced off the same figure', async () => {
    await send();

    // 50% of the PUBLISHED 250, not of the pre-publish 200.
    expect(Number(depositInvoice.total_amount)).toBe(125);
  });

  it("and the customer's page shows that same figure", async () => {
    await send();

    const res = await customerOpens(MAIN_ID, docs[MAIN_ID].public_token);
    expect(res.status).toBe(200);
    expect(Number(res.body.estimate.total_amount)).toBe(250);
  });
});

/**
 * D12 pairs the signature rule with the guardrail: a material edit to a PENDING (customer-signed)
 * estimate voids the stale signature and reverts to SENT, "rather than leave it attached to a
 * document the customer never actually approved". A5 does not change that rule — it changes what
 * counts as material, and the pairing carries the widening with it, which is the answer D12's own
 * rationale asks for. Pinned here so it is a decision and not an accident.
 */
describe('A5 — the PENDING signature rule keeps pairing with the guardrail', () => {
  beforeEach(() => {
    docs[MAIN_ID].status = 'PENDING';
    docs[MAIN_ID].signature_data = 'data:image/png;base64,iVBOR';
    docs[MAIN_ID].signature_at = new Date('2026-09-10');
  });

  it('a changed description voids the signature the customer gave on the old document', async () => {
    expect((await patchLine(LINE_A, { description: 'Replace opener AND springs' })).status).toBe(200);

    expect(docs[MAIN_ID].signature_data).toBeNull();
    expect(docs[MAIN_ID].signature_at).toBeNull();
    expect(docs[MAIN_ID].status).toBe('SENT');
  });

  it('an internal-cost edit leaves the signature exactly where it is', async () => {
    expect((await patchLine(LINE_A, { unit_cost: 40 })).status).toBe(200);

    expect(docs[MAIN_ID].signature_data).toBe('data:image/png;base64,iVBOR');
    expect(docs[MAIN_ID].status).toBe('PENDING');
  });
});

/**
 * Verifier round 1, RED-2. A5 moved the publish into the PREP phase so the PDF — which re-reads
 * the estimate row — could carry the figure the send produces. That must not cost the send's
 * oldest guarantee: **a send that fails leaves the document exactly as it was.**
 *
 * The failure is not hypothetical. A re-send publishes the rep's recommendation over the
 * customer's own ticks and moves the total. If the email then bounces, the rep is told the send
 * failed while the customer's EXISTING, un-rotated link now opens on the new figure — the precise
 * state Ran's ruling exists to forbid, reached by a path that never revokes anything.
 *
 * Nor is a first send exempt, which is what my own round-1 mitigation got wrong. It claimed a
 * DRAFT cannot diverge because both selection columns are written together. `buildStatusChangeData`
 * (lib/estimates/status-transitions.ts) falsifies that: recalling a SENT estimate to DRAFT nulls
 * `public_token`, the signature fields, `terms_accepted` and `modified_after_send`, and leaves the
 * two selection columns exactly where the customer's ticks left them. A recalled DRAFT is a
 * divergent DRAFT, and its first send publishes.
 */
describe('A5 — a send that fails leaves the document exactly as it was', () => {
  /** Everything the publish can move, plus the link, read straight off the stored row. */
  function documentState(id = MAIN_ID) {
    const d = docs[id];
    return {
      subtotal: Number(d.subtotal),
      tax_amount: Number(d.tax_amount),
      total_amount: Number(d.total_amount),
      discount_amount: Number(d.discount_amount),
      lineSelection: d.line_items.map((l: Doc) => [l.description, l.is_selected]),
      scopeSelection: (d.scopes ?? []).map((sc: Doc) => [sc.title, sc.is_selected]),
      public_token: d.public_token,
      valid_until: d.valid_until,
      status: d.status,
    };
  }

  /** The rep recommends back on the $50 option the customer declined: a send moves 200 -> 250. */
  function seedDivergentDocument(status: string) {
    docs[MAIN_ID].status = status;
    docs[MAIN_ID].line_items.push(lineRow({
      id: LINE_OPT, sequence: 2, description: 'Keypad', unit_price: 50, quantity: 1, line_total: 50,
      is_optional: true, is_selected: false, rep_selected: true,
    }));
    docs[MAIN_ID]._count = { line_items: 2 };
    docs[MAIN_ID].subtotal = 200;
    docs[MAIN_ID].total_amount = 200;
  }

  it('a bounced re-send changes nothing — not the total, not the ticks, not the link', async () => {
    seedDivergentDocument('SENT');
    const before = documentState();
    emailMock.mockResolvedValue({ status: 'failed', error: 'bounced' });

    const res = await send();
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('could not be emailed');

    expect(documentState()).toEqual(before);
    // And the link they already hold still opens on the document they were actually quoted.
    const page = await customerOpens(MAIN_ID, MAIN_TOKEN);
    expect(page.status).toBe(200);
    expect(Number(page.body.estimate.total_amount)).toBe(200);
  });

  it('a bounced FIRST send of a recalled DRAFT changes nothing either', async () => {
    // What `buildStatusChangeData` leaves behind on a recall: DRAFT, no token, ticks intact.
    seedDivergentDocument('DRAFT');
    docs[MAIN_ID].public_token = null;
    docs[MAIN_ID].valid_until = null;
    const before = documentState();
    emailMock.mockResolvedValue({ status: 'failed', error: 'bounced' });

    expect((await send()).status).toBe(502);

    // Compared on the half the publish owns. A first send ALSO writes the token and the T&C
    // snapshot before the email, and has always left those standing on a failed send — that is
    // base behaviour this slice did not introduce and is not fixing here (see the report's
    // follow-ups). Asserting it would be asserting a change nobody has agreed to.
    const publishOwned = ({ subtotal, tax_amount, total_amount, discount_amount, lineSelection, scopeSelection }: Doc) =>
      ({ subtotal, tax_amount, total_amount, discount_amount, lineSelection, scopeSelection });
    expect(publishOwned(documentState())).toEqual(publishOwned(before));
  });

  it('a send refused for a disabled org changes nothing', async () => {
    seedDivergentDocument('SENT');
    const before = documentState();
    emailMock.mockResolvedValue({ status: 'skipped', reason: 'org_disabled' });

    expect((await send()).status).toBe(409);

    expect(documentState()).toEqual(before);
  });

  it('a first send whose token/T&C write THROWS leaves the document unpublished', async () => {
    // The narrow one: a first send, a divergent DRAFT (only `backtodraft` produces one), and the
    // single statement that sits between the publish and the email failing outright. Nothing is
    // caught there, so the handler 500s — and must not 500 having moved the document.
    seedDivergentDocument('DRAFT');
    docs[MAIN_ID].public_token = null;
    docs[MAIN_ID].valid_until = null;
    const before = documentState();

    const realUpdate = mockPrisma.estimate.update.getMockImplementation()!;
    mockPrisma.estimate.update.mockImplementation(async (args: { where: { id: string }; data: Doc }) => {
      // The token + T&C snapshot write, identified by its own payload rather than by call order.
      if (args.data?.snapshot_terms !== undefined) throw new Error('write failed');
      return realUpdate(args);
    });

    expect((await send()).status).toBe(500);

    expect(documentState()).toEqual(before);
    expect(emailMock).not.toHaveBeenCalled();
  });

  it('...but a send that SUCCEEDS still publishes, and still carries the published figure', async () => {
    seedDivergentDocument('SENT');

    expect((await send()).status).toBe(200);

    expect(Number(docs[MAIN_ID].total_amount)).toBe(250);
    const { total } = emailMock.mock.calls.at(-1)![0] as { total: string };
    expect(total).toBe('$250.00');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6. The two doors cannot drift
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `update()`'s whole-document PATCH and `recomputeAndPersist`'s eight granular line/scope handlers
 * apply the identical ceremony from two different files. Before A5 they also each carried their
 * own idea of what "material" meant. The proof that they now share one is behavioural: the SAME
 * edit, expressed through either door, has to reach the customer the same way.
 */
describe('A5 — one predicate, both doors', () => {
  it.each([
    ['a changed description', 404,
      () => patchLine(LINE_A, { description: 'Replace opener AND springs' }),
      () => patchDocument({ line_items: listOf({ description: 'Replace opener AND springs' }) })],
    ['a changed internal cost', 200,
      () => patchLine(LINE_A, { unit_cost: 40 }),
      () => patchDocument({ line_items: listOf({ unit_cost: 40 }) })],
  ])('%s: both doors agree the link should answer %i', async (_label, expected, granular, wholeDocument) => {
    for (const door of [granular, wholeDocument]) {
      seed();
      installHarness();
      expect((await door()).status).toBe(200);
      expect((await customerOpens(MAIN_ID, MAIN_TOKEN)).status).toBe(expected);
    }
  });

  it('the predicate is declared in exactly one file, and both controllers import it', () => {
    const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
    const declaration = /export function customerVisibleDocumentChanged/;

    expect(declaration.test(read('lib/estimates/public-link.ts'))).toBe(true);
    for (const controller of ['controllers/estimate.controller.ts', 'controllers/estimate-lines.controller.ts']) {
      const source = read(controller);
      expect(declaration.test(source)).toBe(false);
      expect(source).toMatch(/import \{[^}]*customerVisibleDocumentChanged[^}]*\} from '\.\.\/lib\/estimates\/public-link'/);
    }
  });

  it('the guardrail retires the link through the SAME constant revise() uses', () => {
    const source = readFileSync(join(__dirname, '..', 'controllers/estimate.controller.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function materialChangeGuardrail'));
    expect(body.slice(0, body.indexOf('\n}'))).toContain('...REVOKE_PUBLIC_LINK');
  });
});

