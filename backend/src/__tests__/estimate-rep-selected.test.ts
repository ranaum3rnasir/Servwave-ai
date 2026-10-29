/**
 * Publish-at-every-send: `rep_selected` is the REP'S RECOMMENDATION, and every send copies it
 * onto `is_selected` - the column the customer's own page, and the document's totals, are driven
 * by.
 *
 * The direction used to run the other way. Until slice A2 the send CAPTURED
 * `is_selected -> rep_selected` once, on the DRAFT-to-SENT transition, so the column was a
 * frozen record of what had gone out and the customer's later ticks moved the live document
 * underneath it. Ran's ruling of 2026-09-19 replaced that model: a re-send is a new estimate from
 * the customer's side, so the rep's recommendation is PUBLISHED - at every send, over whatever
 * the customer had ticked.
 *
 * The invariant this file pins:
 *   1. Every send (send, re-send, mark-sent) publishes `rep_selected -> is_selected`, for line
 *      items and for scope blocks, and recomputes the document's totals from the result.
 *   2. A row whose `rep_selected` is null is LEFT ALONE - null means the rep never expressed a
 *      preference there, and `is_selected` is already the right value for it.
 *   3. The SEND does not write `rep_selected`, and neither does anything the CUSTOMER can reach -
 *      not their public selection write, not duplicate(), not revise(). Slice A3 gave the column
 *      the writer it was always going to need: the rep's own tick, through the four staff write
 *      paths in `estimate-lines.controller.ts`. Section 4 below pins that, and the allowlist in
 *      section 2 was widened for it deliberately.
 *   4. It never reaches the customer-facing public payload. It is internal rep state.
 *
 * Harness. Slice A2 is a MODEL change - what the customer is looking at after a send - so the
 * first section drives the REAL doors (POST /send, POST /mark-sent, PATCH /public/selections)
 * over one in-memory estimate and reads the answer back off GET /public, which is literally the
 * page the customer opens. An assertion on `updateMany`'s ARGUMENTS would pass just as happily if
 * the statement never reached a row; the structural pin at the end of section 1 is kept as well,
 * but it is the belt, not the braces.
 *
 * Sections 2 and 3 keep their original harnesses: the estimate-lines scope-edit shim that
 * `estimate-optional-items.test.ts` also uses, and the duplicate/revise/public-payload mocks.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ESTIMATE_FIXTURE, ESTIMATE_SENT_FIXTURE, TEST_USERS, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  estimate: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  estimateLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  estimateSendConfig: { upsert: ReturnType<typeof vi.fn> };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  appSetting: { findUnique: ReturnType<typeof vi.fn> };
  invoice: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const SENT_ID = ESTIMATE_SENT_FIXTURE.id;
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000009';
const LINE_ID = 'aa000000-0000-0000-0000-000000000009';

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. Every send publishes the rep's recommendation
// ═════════════════════════════════════════════════════════════════════════════════════════════

// ── The stateful document harness ────────────────────────────────────────────────────────────

const A2_ID = 'f0000000-0000-0000-0000-0000000000a2';
const A2_TOKEN = 'a2000000-0000-0000-0000-0000000000a2';
const A2_CUSTOMER = 'c0000000-0000-0000-0000-0000000000a2';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Doc = Record<string, any>;

interface LineSeed {
  id: string;
  description: string;
  unit_price: number;
  is_optional: boolean;
  is_selected: boolean;
  rep_selected: boolean | null;
}

interface ScopeSeed {
  id: string;
  title: string;
  flat_price: number;
  is_optional: boolean;
  is_selected: boolean;
  /** Absent key = the legacy block that has never been offered under this feature. */
  rep_selected?: boolean;
}

function line(seed: LineSeed, sequence: number) {
  return {
    sequence,
    quantity: 1,
    is_taxable: false,
    line_total: seed.unit_price,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    unit_cost: null,
    markup_percent: null,
    ...seed,
  };
}

function scope(seed: ScopeSeed) {
  return { body: '', is_taxable: false, internal_cost: null, ...seed };
}

/** The document every section-1 test drives. Mutated in place by the harness's writes. */
let doc: Doc;
/** Every `invoice.update` the send made, in order - the deposit re-price is read off this. */
let depositUpdates: { where: Record<string, unknown>; data: Record<string, unknown> }[];
/** Every `invoice.create` payload - the first send's deposit document is read off this. */
let depositCreates: Doc[];
/** Every `estimateSendConfig.upsert` payload - the HELD deposit figure every surface reads. */
let sendConfigUpserts: Doc[];
/** Every `timelineEvent.create` payload - the DEPOSIT_REQUESTED copy is read off this. */
let timelineEvents: Doc[];

function seedDocument(over: Partial<Doc>, lines: LineSeed[], scopes: ScopeSeed[] | null) {
  doc = {
    id: A2_ID,
    organization_id: ALPHA_ORG_ID,
    estimate_number: 'E-A2-01',
    status: 'DRAFT',
    public_token: null,
    valid_until: null,
    sent_at: null,
    modified_after_send: false,
    version: 1,
    created_by: TEST_USERS.admin.id,
    customer_id: A2_CUSTOMER,
    lead_id: null,
    lead: null,
    job_id: null,
    job: null,
    job_link: null,
    customer: { id: A2_CUSTOMER, first_name: 'Pat', last_name: 'Buyer', company_name: null, email: 'pat@example.com' },
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    deposit_type: null,
    deposit_value: null,
    subtotal: 0,
    tax_amount: 0,
    total_amount: 0,
    scopes: scopes ? scopes.map(scope) : null,
    line_items: lines.map(line),
    send_config: null,
    invoices: [],
    scope_photos: [],
    snapshot_terms: null,
    snapshot_notes: null,
    snapshot_payment_terms: null,
    /** The estimate's DEPOSIT invoice, if the test gave it one. */
    deposit: null,
    ...over,
  };
  doc._count = { line_items: doc.line_items.length };
  // The stored totals start at whatever the CURRENT (customer-facing) selection produces, which
  // is what a real row holds between sends.
  const stored = totalOf(doc.line_items, doc.scopes ?? [], (r: Doc) => r.is_selected);
  doc.subtotal = stored;
  doc.total_amount = stored;
  depositUpdates = [];
  depositCreates = [];
  sendConfigUpserts = [];
  timelineEvents = [];
}

/** The same predicate `countsTowardTotals` uses, over a chosen selection reader. */
function totalOf(lines: Doc[], scopes: Doc[], selected: (r: Doc) => boolean | null | undefined) {
  const rows = [...lines.map((l) => ({ price: Number(l.unit_price), row: l })), ...scopes.map((s) => ({ price: Number(s.flat_price), row: s }))];
  return rows.reduce((sum, { price, row }) => (row.is_optional === true && selected(row) === false ? sum : sum + price), 0);
}

function applyLineUpdateMany(stmt: { where: Record<string, unknown>; data: Record<string, unknown> }) {
  for (const l of doc.line_items) {
    if (Object.entries(stmt.where).every(([k, v]) => l[k] === v)) Object.assign(l, stmt.data);
  }
}

function applyUpdate(data: Record<string, any> | undefined) {
  for (const [k, v] of Object.entries(data ?? {})) {
    if (k === 'line_items') {
      const stmts = (v as any)?.updateMany;
      if (stmts) for (const s of (Array.isArray(stmts) ? stmts : [stmts])) applyLineUpdateMany(s);
      continue;
    }
    doc[k] = v;
  }
}

/** The `estimatePublicSelect`-shaped row GET /public and the selections door read back. */
function publicRow() {
  return {
    ...ESTIMATE_SENT_FIXTURE,
    id: doc.id,
    organization_id: doc.organization_id,
    status: doc.status,
    public_token: doc.public_token,
    valid_until: doc.valid_until,
    subtotal: doc.subtotal,
    tax_amount: doc.tax_amount,
    total_amount: doc.total_amount,
    scopes: doc.scopes,
    line_items: doc.line_items,
    send_config: null,
    invoices: [],
    scope_photos: [],
  };
}

function txClient() {
  return {
    estimate: {
      findUnique: vi.fn(async () => doc),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => { applyUpdate(args.data); return doc; }),
    },
    estimateLineItem: {
      findMany: vi.fn(async () => doc.line_items),
      // A3 - `addLine` is one of the four staff selection write paths, so the harness has to be
      // able to mint a row. Prisma assigns the id; the shim does the same.
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = { id: `aa000000-0000-0000-0000-0000000000c${doc.line_items.length}`, ...args.data };
        doc.line_items.push(row);
        doc._count = { line_items: doc.line_items.length };
        return row;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const l = doc.line_items.find((x: Doc) => x.id === args.where.id);
        if (l) Object.assign(l, args.data);
        return l;
      }),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        applyLineUpdateMany(args); return { count: 0 };
      }),
    },
    estimateSendConfig: {
      upsert: vi.fn(async (args: { create: Doc }) => { sendConfigUpserts.push(args.create); return {}; }),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    invoice: {
      findFirst: vi.fn(async () => doc.deposit),
      create: vi.fn(async (args: { data: Doc }) => { depositCreates.push(args.data); return { id: 'inv-a2' }; }),
      update: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        depositUpdates.push(args);
        if (doc.deposit) doc.deposit.total_amount = args.data.total_amount;
        return {};
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    timelineEvent: { create: vi.fn(async (args: { data: Doc }) => { timelineEvents.push(args.data); return {}; }) },
    lead: { update: vi.fn(async () => ({})) },
    numberSequence: { upsert: vi.fn(async () => ({ next_value: 7 })) },
    appSetting: { findUnique: vi.fn(async () => null) },
  };
}

function installHarness() {
  mockAuthAs('admin');
  mockPrisma.appSetting.findUnique.mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: ALPHA_ORG_ID, name: 'Test Org', logo_url: null, brand_color: null,
    email: null, phone: null, phone_ext: null, website: null,
    estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
    accepted_payment_methods: [], stripe_charges_enabled: false,
    deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
  });
  mockPrisma.estimate.findUnique.mockImplementation(async () => doc);
  mockPrisma.estimate.findFirst.mockImplementation(async (args: { where?: Record<string, unknown> }) => {
    const where = args?.where ?? {};
    if (where.id !== undefined && where.id !== doc.id) return null;
    if (where.public_token !== undefined && where.public_token !== doc.public_token) return null;
    return publicRow();
  });
  mockPrisma.estimate.update.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    applyUpdate(args.data); return doc;
  });
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(txClient());
    return Promise.all(arg as Promise<unknown>[]);
  });
}

function send() {
  return request(app).post(`/api/estimates/${A2_ID}/send`).set(authHeader('admin'))
    .send({ deposit_required: false, payment_methods: [] });
}

/** A first send that asks the customer for a deposit, so the deposit document is minted. */
function sendWithDeposit() {
  return request(app).post(`/api/estimates/${A2_ID}/send`).set(authHeader('admin'))
    .send({ deposit_required: true, payment_methods: [] });
}

function markSentA2() {
  return request(app).post(`/api/estimates/${A2_ID}/mark-sent`).set(authHeader('admin'))
    .send({ deposit_required: false, payment_methods: [] });
}

/** What the CUSTOMER's page shows, read through the token door they were emailed. */
async function customerPage() {
  const res = await request(app).get(`/api/estimates/${A2_ID}/public?token=${doc.public_token}`);
  expect(res.status).toBe(200);
  const est = res.body.estimate;
  return {
    total: Number(est.total_amount),
    lines: Object.fromEntries((est.line_items as Doc[]).map((l) => [l.description, l.is_selected])),
    scopes: Object.fromEntries((est.scopes as Doc[] ?? []).map((s) => [s.title, s.is_selected])),
  };
}

/** The customer ticking a box on their own page, through their own door. */
async function customerTicks(lineId: string, isSelected: boolean) {
  const res = await request(app)
    .patch(`/api/estimates/${A2_ID}/public/selections?token=${doc.public_token}`)
    .send({ selections: [{ kind: 'line', id: lineId, is_selected: isSelected }] });
  expect(res.status).toBe(200);
}

// The rep's document: one required line plus one optional row of each recommendation state.
const BASE_LINE = 'aa000000-0000-0000-0000-0000000000b0';
const REP_SAYS_YES = 'aa000000-0000-0000-0000-0000000000b1';
const REP_SAYS_NO = 'aa000000-0000-0000-0000-0000000000b2';
const REP_SAYS_NOTHING = 'aa000000-0000-0000-0000-0000000000b3';

const REP_LINES: LineSeed[] = [
  { id: BASE_LINE, description: 'Base install', unit_price: 1000, is_optional: false, is_selected: true, rep_selected: null },
  // The rep recommends it; the document currently says no.
  { id: REP_SAYS_YES, description: 'Surge protector', unit_price: 200, is_optional: true, is_selected: false, rep_selected: true },
  // The rep does NOT recommend it; the document currently says yes.
  { id: REP_SAYS_NO, description: 'Extended warranty', unit_price: 300, is_optional: true, is_selected: true, rep_selected: false },
  // The rep never expressed a preference. `is_selected` is already right for it.
  { id: REP_SAYS_NOTHING, description: 'Duct cleaning', unit_price: 50, is_optional: true, is_selected: true, rep_selected: null },
];

const SCOPE_YES = 'cc000000-0000-0000-0000-0000000000b1';
const SCOPE_NO = 'cc000000-0000-0000-0000-0000000000b2';
const SCOPE_NOTHING = 'cc000000-0000-0000-0000-0000000000b3';

const REP_SCOPES: ScopeSeed[] = [
  { id: SCOPE_YES, title: 'Permit fee', flat_price: 400, is_optional: true, is_selected: false, rep_selected: true },
  { id: SCOPE_NO, title: 'Haul away', flat_price: 150, is_optional: true, is_selected: true, rep_selected: false },
  // No `rep_selected` key at all - a block written before this feature existed.
  { id: SCOPE_NOTHING, title: 'Site protection', flat_price: 25, is_optional: true, is_selected: true },
];

// The rep's recommendation, priced: 1000 base + 200 surge + 50 duct + 400 permit + 25 protection.
const PUBLISHED_TOTAL = 1675;
// What the rows said BEFORE the send: 1000 + 300 warranty + 50 duct + 150 haul + 25 protection.
const PRE_PUBLISH_TOTAL = 1525;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('a send publishes the rep\'s recommendation onto the customer\'s document', () => {
  it('opens the customer\'s page on exactly the rows the rep had ticked, on a FIRST send', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);

    expect((await send()).status).toBe(200);

    const page = await customerPage();
    expect(page.lines).toEqual({
      'Base install': true,
      'Surge protector': true,      // the rep recommended it
      'Extended warranty': false,   // the rep did not
      'Duct cleaning': true,        // no recommendation - untouched
    });
  });

  it('shows the rep\'s CURRENT ticks on a re-send, and loses the tick the customer had made', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect((await send()).status).toBe(200);

    // The customer changes their mind about the row the rep had NOT recommended.
    await customerTicks(REP_SAYS_NO, true);
    expect((await customerPage()).lines['Extended warranty']).toBe(true);

    // A re-send is a new estimate from the customer's side (Ran, 2026-09-19): the rep's
    // recommendation is the whole offer again, and the customer's tick does not survive it.
    expect((await send()).status).toBe(200);

    const page = await customerPage();
    expect(page.lines['Extended warranty']).toBe(false);
    expect(page.lines['Surge protector']).toBe(true);
  });

  it('leaves a null-recommendation row alone across a send, keeping the answer it already had', async () => {
    installHarness();
    // Seeded TICKED. Both directions are asserted here on purpose: a one-sided version of this
    // test (seed unticked, assert unticked) is satisfied by "nothing was published" AND by
    // "null was published as false", which is the whole thing it is meant to tell apart.
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect(REP_LINES.find((l) => l.id === REP_SAYS_NOTHING)!.is_selected).toBe(true);

    expect((await send()).status).toBe(200);

    // Direction 1: null is not "false". A send that published a null recommendation as unticked
    // would have flipped this row, and would silently drop the row out of the totals with it.
    expect((await customerPage()).lines['Duct cleaning']).toBe(true);

    // Direction 2: null is not "true" either. The customer unticks it; the next send still has
    // no opinion, so their answer is the one that survives.
    await customerTicks(REP_SAYS_NOTHING, false);
    expect((await send()).status).toBe(200);
    expect((await customerPage()).lines['Duct cleaning']).toBe(false);
  });

  it('leaves the estimate total equal to the total the rep\'s recommendation prices out', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect(Number(doc.total_amount)).toBe(PRE_PUBLISH_TOTAL);

    expect((await send()).status).toBe(200);

    expect((await customerPage()).total).toBe(PUBLISHED_TOTAL);
  });

  it('publishes the scopes JSONB half exactly as it publishes the line half', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);

    expect((await send()).status).toBe(200);

    expect((await customerPage()).scopes).toEqual({
      'Permit fee': true,        // the rep recommended it
      'Haul away': false,        // the rep did not
      'Site protection': true,   // no `rep_selected` key - untouched
    });
  });

  it('publishes on mark-sent exactly as it publishes on send', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);

    expect((await markSentA2()).status).toBe(200);

    const page = await customerPage();
    expect(page.lines).toEqual({
      'Base install': true,
      'Surge protector': true,
      'Extended warranty': false,
      'Duct cleaning': true,
    });
    expect(page.scopes).toEqual({ 'Permit fee': true, 'Haul away': false, 'Site protection': true });
    expect(page.total).toBe(PUBLISHED_TOTAL);
  });

  it('mints the first send\'s deposit document off the PUBLISHED total, and says so on the timeline', async () => {
    installHarness();
    // A 25% deposit override, DELIBERATELY not the org's 50% default (`installHarness`). Equal
    // figures would make this test pass just as happily against code that dropped the estimate's
    // own override and fell back to the org's, which is a different bug it must not hide: 25% of
    // the published total is 418.75, the org default would produce 837.50.
    //
    // The publish RAISES the total from 1525 to 1675, so the deposit the customer is asked for is
    // 418.75 — not the 381.25 the pre-publish total produced. Priced off the stale figure the
    // document would say 1675, the payable invoice would ask 381.25, and the history line would
    // claim that is 25% when it is 22.8%.
    seedDocument({ status: 'DRAFT', deposit_type: 'PERCENTAGE', deposit_value: 25 }, REP_LINES, REP_SCOPES);

    expect((await sendWithDeposit()).status).toBe(200);

    expect((await customerPage()).total).toBe(PUBLISHED_TOTAL);

    // The payable document.
    expect(depositCreates).toHaveLength(1);
    const deposit = depositCreates[0];
    expect(Number(deposit.subtotal)).toBe(418.75);
    expect(Number(deposit.total_amount)).toBe(418.75);
    expect(Number(deposit.amount_due)).toBe(418.75);
    expect(Number(deposit.line_items.create[0].line_total)).toBe(418.75);
    expect(Number(deposit.line_items.create[0].unit_price)).toBe(418.75);

    // The HELD figure every deposit surface reads.
    expect(sendConfigUpserts).toHaveLength(1);
    expect(Number(sendConfigUpserts[0].deposit_amount)).toBe(418.75);
    expect(Number(sendConfigUpserts[0].deposit_percentage)).toBe(25);

    // User-visible copy: it must not state a percentage the figure beside it does not satisfy.
    const requested = timelineEvents.find((e) => e.event_type === 'DEPOSIT_REQUESTED');
    expect(requested).toBeDefined();
    expect(requested!.description).toBe('Deposit of $418.75 requested (25%)');
  });

  it('re-prices an unpaid deposit invoice off the PUBLISHED total, not the pre-publish one', async () => {
    installHarness();
    // A sent estimate whose customer ticked a $500 add-on the rep does not recommend. The
    // re-send drops it, so the total FALLS from 1500 to 1000 and the 50% deposit must follow it
    // down to 500. Priced off the pre-publish figure it would still read 750 - and, worse, the
    // re-price would short-circuit as ALREADY_CURRENT and write nothing at all.
    seedDocument(
      {
        status: 'SENT',
        public_token: A2_TOKEN,
        valid_until: new Date('2099-12-31'),
        send_config: { id: 'sc-a2' },
        deposit: { id: 'dep-a2', invoice_number: 'INV-A2', status: 'SENT', total_amount: 750, _count: { payments: 0 } },
      },
      [
        { id: BASE_LINE, description: 'Base install', unit_price: 1000, is_optional: false, is_selected: true, rep_selected: null },
        { id: REP_SAYS_NO, description: 'Extended warranty', unit_price: 500, is_optional: true, is_selected: true, rep_selected: false },
      ],
      null,
    );
    expect(Number(doc.total_amount)).toBe(1500);

    expect((await send()).status).toBe(200);

    expect((await customerPage()).total).toBe(1000);
    expect(depositUpdates).toHaveLength(1);
    expect(Number(depositUpdates[0].data.total_amount)).toBe(500);
    expect(Number(depositUpdates[0].data.amount_due)).toBe(500);
  });
});

// ── The structural pin, inverted ─────────────────────────────────────────────────────────────
//
// The belt to the behavioural braces above: the exact pair of statements the publish is written
// as. It was the CAPTURE pair (`where is_selected -> data rep_selected`) until slice A2; it is
// the PUBLISH pair now, and the predicate being `rep_selected` is what leaves a null row alone
// without a read - Prisma's `where` never matches NULL.

/** Runs mark-sent over the harness and returns every `estimate.update` payload it wrote. */
async function markSentUpdates(lines: LineSeed[], scopes: ScopeSeed[] | null) {
  installHarness();
  seedDocument({ status: 'DRAFT' }, lines, scopes);
  const updates: Record<string, unknown>[] = [];
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    const tx = txClient();
    const inner = tx.estimate.update;
    tx.estimate.update = vi.fn(async (args: { data: Record<string, unknown> }) => {
      updates.push(args.data);
      return inner(args);
    });
    return (arg as (t: unknown) => unknown)(tx);
  });
  const res = await markSentA2();
  return { res, estimateUpdates: updates };
}

describe('commitFirstSend: the publish statements', () => {
  it('publishes every line item\'s rep_selected onto its is_selected, in the same write that flips the status to SENT', async () => {
    const { res, estimateUpdates } = await markSentUpdates(REP_LINES, null);

    expect(res.status).toBe(200);
    const sendWrite = estimateUpdates.find((d) => d.status === 'SENT');
    expect(sendWrite).toBeDefined();
    expect(sendWrite!.line_items).toEqual({
      updateMany: [
        { where: { rep_selected: true }, data: { is_selected: true } },
        { where: { rep_selected: false }, data: { is_selected: false } },
      ],
    });
  });

  it('publishes every scope block\'s is_selected from its rep_selected, leaving a key-less legacy block alone', async () => {
    const { res, estimateUpdates } = await markSentUpdates(REP_LINES, [
      { id: SCOPE_ID, title: 'Permit fee', flat_price: 200, is_optional: true, is_selected: false, rep_selected: true },
      // No `rep_selected` key, and no `is_optional`/`is_selected` either: the pre-feature block.
      { id: 'cc000000-0000-0000-0000-00000000000a', title: 'Legacy', flat_price: 50 } as ScopeSeed,
    ]);

    expect(res.status).toBe(200);
    const scopeWrite = estimateUpdates.find((d) => d.scopes !== undefined);
    expect(scopeWrite).toBeDefined();
    expect(scopeWrite!.scopes).toEqual([
      expect.objectContaining({ id: SCOPE_ID, rep_selected: true, is_selected: true }),
      // Untouched: no recommendation was ever recorded for it, so the send has no opinion.
      { id: 'cc000000-0000-0000-0000-00000000000a', title: 'Legacy', flat_price: 50, body: '', is_taxable: false, internal_cost: null },
    ]);
  });

  it('writes no scopes at all when the estimate has none', async () => {
    const { res, estimateUpdates } = await markSentUpdates(REP_LINES, null);

    expect(res.status).toBe(200);
    expect(estimateUpdates.some((d) => d.scopes !== undefined)).toBe(false);
  });
});

// ── rep scope-edit harness (estimate-lines.controller) ───────────────────────────────────────

function setupLinesTransaction() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
        estimateLineItem: {
          findMany: mockPrisma.estimateLineItem.findMany,
          update: mockPrisma.estimateLineItem.update,
        },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

function guardRow(scopes: unknown[] | null) {
  return {
    id: SENT_ID,
    status: 'SENT',
    version: 1,
    tax_rate: 0,
    discount_type: null,
    discount_value: null,
    subtotal: 1000,
    tax_amount: 0,
    total_amount: 1000,
    discount_amount: 0,
    scopes,
    organization: { lock_on_send: false },
    invoices: [],
    line_items: [],
  };
}

/** A scope block the rep recommended, and that the customer has since unticked. */
function sentScope(over: Record<string, unknown> = {}) {
  return {
    id: SCOPE_ID,
    title: 'Permit fee',
    body: '',
    flat_price: 200,
    is_taxable: true,
    internal_cost: null,
    is_optional: true,
    is_selected: false,
    rep_selected: true,
    ...over,
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. Who may write it: the staff write paths and the send, and nobody else
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('rep_selected is the rep\'s own state, and only the rep\'s own doors reach it', () => {
  it('a rep editing a sent scope\'s title leaves its snapshot untouched', async () => {
    mockAuthAs('admin');
    setupLinesTransaction();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow([sentScope()]));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, id: SENT_ID, line_items: [], scopes: null });

    const res = await request(app)
      .patch(`/api/estimates/${SENT_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee (revised)' });

    expect(res.status).toBe(200);
    const written = mockPrisma.estimate.update.mock.calls
      .map((c) => c[0]?.data)
      .find((d: Record<string, unknown>) => d?.scopes !== undefined);
    expect(written.scopes[0]).toMatchObject({ title: 'Permit fee (revised)', rep_selected: true });
  });

  it('a rep cannot overwrite the snapshot by sending it in the scope-edit body', async () => {
    mockAuthAs('admin');
    setupLinesTransaction();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow([sentScope()]));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue({ ...ESTIMATE_SENT_FIXTURE, id: SENT_ID, line_items: [], scopes: null });

    const res = await request(app)
      .patch(`/api/estimates/${SENT_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', rep_selected: false });

    expect(res.status).toBe(200);
    const written = mockPrisma.estimate.update.mock.calls
      .map((c) => c[0]?.data)
      .find((d: Record<string, unknown>) => d?.scopes !== undefined);
    expect(written.scopes[0].rep_selected).toBe(true);
  });

  /**
   * The structural half of the invariant, and it is worth being precise about what it is and is
   * not. It is a NAMING-CONVENTION pin: it greps for the literal string, so it catches a new file
   * that writes the column the ordinary way, and it does NOT catch one that reaches the same
   * column through a computed key or a raw query. It is a tripwire, not a proof.
   *
   * Its cheapest green is therefore "add my file to `allowed`", which is exactly the move it is
   * meant to make someone stop and think about. See the note on the set below.
   */
  it('backend/src names rep_selected in only the files that are allowed to', () => {
    // WIDENING THIS SET IS A DESIGN DECISION, NOT A TEST FIX.
    //
    // The set was `{estimate.controller.ts, scopes.ts}` and the reason given was "written by
    // commitFirstSend and by nothing else", which is what made the frozen checkbox trustworthy.
    // Slice A3 (Ran's decision 12) deleted that freeze: the rep's checkbox is live again at
    // DRAFT, SENT and PENDING, and what it writes IS the recommendation. So the column needs a
    // writer, and `estimate-lines.controller.ts` - the four staff write paths, addLine /
    // updateLine / addScope / updateScope, all routed through its one `routeSelectionWrite` - was
    // added here deliberately, as part of that slice.
    //
    // What the set pins NOW is narrower and still worth pinning: `rep_selected` is written by the
    // STAFF write paths (estimate-lines.controller.ts) and published by the SEND
    // (estimate.controller.ts's `publishRepRecommendation`), and by nothing else. In particular
    // the customer's own public selection write must never reach it - that door writes
    // `is_selected`, which is the customer's answer, and a file appearing here that serves the
    // customer is the failure this catches. If you are here because this test went red, change
    // the code, or get the new writer agreed first.
    const allowed = new Set([
      'controllers/estimate.controller.ts',
      'controllers/estimate-lines.controller.ts',
      'lib/scopes.ts',
    ]);
    const WIDENING_IS_A_DESIGN_DECISION =
      'Widening the allowlist is a design decision, not a test fix: rep_selected is written by '
      + 'the staff write paths (estimate-lines.controller.ts) and published by the send '
      + '(estimate.controller.ts), and by nothing else - the customer-facing doors must never '
      + 'reach it. Change the code, or get the new writer agreed first.';
    const root = join(__dirname, '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry !== '__tests__') walk(full);
          continue;
        }
        if (!entry.endsWith('.ts')) continue;
        if (readFileSync(full, 'utf8').includes('rep_selected')) {
          hits.push(full.slice(root.length + 1));
        }
      }
    };
    walk(root);

    expect(hits.filter((h) => !allowed.has(h)), WIDENING_IS_A_DESIGN_DECISION).toEqual([]);
    expect(hits.sort(), WIDENING_IS_A_DESIGN_DECISION).toEqual([...allowed].sort());
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. A clone starts with no snapshot, and the customer never sees one
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe('clones and the public payload', () => {
  it('duplicate() carries the scope blocks forward WITHOUT the source\'s snapshot', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      lead_id: null,
      customer_id: 'c0000000-0000-0000-0000-0000000000aa',
      service_location_id: null,
      created_by: ESTIMATE_FIXTURE.created_by,
      scope_notes: null,
      scopes: [sentScope()],
      tax_rate: 0,
      discount_type: null,
      discount_value: null,
      discount_name: null,
      customer: { tax_exempt: false },
      lead: null,
      // A line that WAS sent ticked. Note the shape: `duplicate()`'s own source select is
      // field-by-field and does not name `rep_selected`, so in production this object never
      // carries it either. The fixture carries it anyway, which is the point - if the select and
      // the create are ever widened to a wholesale copy, this test sees the snapshot cross over.
      line_items: [{
        sequence: 1, description: 'Add-on', quantity: 1, unit_price: 100, is_taxable: false,
        line_total: 100, price_book_item_id: null, unit_cost: null, markup_percent: null,
        discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE',
        is_optional: true, is_selected: true, rep_selected: true,
      }],
    });

    let created: Record<string, unknown> | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
      estimate: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          created = args.data;
          return Promise.resolve({ ...ESTIMATE_FIXTURE, line_items: [], scopes: args.data.scopes });
        }),
      },
      numberSequence: { upsert: vi.fn().mockResolvedValue({ next_value: 7 }) },
      appSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    }));

    const res = await request(app)
      .post(`/api/estimates/${SENT_ID}/duplicate`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(201);
    expect(created).toBeDefined();
    const scopes = created!.scopes as Record<string, unknown>[];
    expect(scopes[0]).not.toHaveProperty('rep_selected');
    expect(scopes[0]).toMatchObject({ id: SCOPE_ID, is_selected: false });

    // The LINE half of the same rule. A duplicate is an unsent DRAFT, so its lines must start
    // with no snapshot and pick one up at their own first send; carrying the source's across
    // would make the new draft render a frozen checkbox before it had ever been sent.
    const lines = (created!.line_items as { create: Record<string, unknown>[] }).create;
    expect(lines[0]).not.toHaveProperty('rep_selected');
    expect(lines[0]).toMatchObject({ description: 'Add-on', is_optional: true, is_selected: true });
  });

  it('revise() carries the lines and scopes forward WITHOUT the source\'s snapshot', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue({
      id: SENT_ID,
      status: 'SENT',
      estimate_number: ESTIMATE_SENT_FIXTURE.estimate_number,
      lead_id: null,
      organization_id: 'org-test-1',
      customer_id: 'c0000000-0000-0000-0000-0000000000aa',
      service_location_id: null,
      created_by: ESTIMATE_FIXTURE.created_by,
      name: null, scope_name: null, scope_notes: null,
      scopes: [sentScope()],
      tax_rate: 0,
      discount_type: null, discount_value: null, discount_name: null, discount_amount: 0,
      deposit_type: null, deposit_value: null,
      subtotal: 100, tax_amount: 0, total_amount: 100,
      line_items: [{
        sequence: 1, description: 'Add-on', quantity: 1, unit_price: 100, is_taxable: false,
        line_total: 100, price_book_item_id: null, unit_cost: null, markup_percent: null,
        discount_type: null, discount_value: null, discount_amount: 0, item_type: 'SERVICE',
        is_optional: true, is_selected: false, rep_selected: true,
      }],
      lead: null,
    });

    let created: Record<string, unknown> | undefined;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn({
      estimate: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          created = args.data;
          return Promise.resolve({ ...ESTIMATE_FIXTURE, id: 'new-rev', line_items: [], scopes: args.data.scopes });
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      invoice: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      numberSequence: { upsert: vi.fn().mockResolvedValue({ next_value: 8 }) },
      appSetting: { findUnique: vi.fn().mockResolvedValue(null) },
    }));

    const res = await request(app)
      .post(`/api/estimates/${SENT_ID}/revise`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(created).toBeDefined();
    // A revision is a fresh DRAFT (`status: 'DRAFT'` on the created row) and takes its own
    // snapshot at its own send, so neither half inherits the superseded document's.
    expect(created!.status).toBe('DRAFT');
    expect((created!.scopes as Record<string, unknown>[])[0]).not.toHaveProperty('rep_selected');
    const revisedLines = (created!.line_items as { create: Record<string, unknown>[] }).create;
    expect(revisedLines[0]).not.toHaveProperty('rep_selected');
    expect(revisedLines[0]).toMatchObject({ description: 'Add-on', is_optional: true, is_selected: false });
  });

  it('the public estimate payload carries no rep_selected on a scope block', async () => {
    mockPrisma.estimate.findFirst.mockResolvedValue({
      ...ESTIMATE_SENT_FIXTURE,
      id: SENT_ID,
      organization_id: 'org-test-1',
      scopes: [sentScope()],
      line_items: [{ id: LINE_ID, sequence: 1, description: 'AC', quantity: 1, unit_price: 100, is_optional: true, is_selected: false }],
      send_config: null,
      invoices: [],
      scope_photos: [],
    });
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: 'org-test-1', name: 'Test Org', logo_url: null, brand_color: null,
      email: null, phone: null, phone_ext: null, website: null,
      estimate_terms: 'T', accepted_payment_methods: [], stripe_charges_enabled: false,
    });

    const res = await request(app)
      .get(`/api/estimates/${SENT_ID}/public?token=${ESTIMATE_SENT_FIXTURE.public_token}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('rep_selected');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4. The rep's own tick writes the recommendation, never the customer's live answer
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** The rep ticking a row's checkbox in the editor - the same PATCH the row's checkbox sends. */
function repTicksLine(lineId: string, isSelected: boolean) {
  return request(app)
    .patch(`/api/estimates/${A2_ID}/line-items/${lineId}`)
    .set(authHeader('admin'))
    .send({ is_selected: isSelected });
}

describe('the rep\'s tick after send leaves the customer\'s document alone', () => {
  it('changes nothing the customer can see, and leaves their open link working', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect((await sendWithDeposit()).status).toBe(200);

    // The link the customer is holding, captured before the tick: the whole point of this test is
    // that this exact token still opens the page afterwards.
    const emailedToken = doc.public_token;
    const before = await customerPage();
    const depositsAtSend = depositCreates.length;

    // The rep changes their mind about the add-on they had NOT recommended, on the estimate the
    // customer already has open.
    expect((await repTicksLine(REP_SAYS_NO, true)).status).toBe(200);

    // Nothing the customer can see moved: not their answers, not the total.
    expect(await customerPage()).toEqual(before);
    // ...and not the money they were asked for.
    expect(depositUpdates).toEqual([]);
    expect(depositCreates).toHaveLength(depositsAtSend);
    // THE REGRESSION. Until this slice the tick moved the totals, which tripped
    // `materialChangeGuardrail` and nulled `public_token` - 404ing the customer mid-decision.
    const stillOpen = await request(app).get(`/api/estimates/${A2_ID}/public?token=${emailedToken}`);
    expect(stillOpen.status).toBe(200);
  });
});

describe('the rep\'s tick is a recommendation, and the next send publishes it', () => {
  it('a line ticked AFTER the last send goes out on the re-send', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect((await send()).status).toBe(200);
    expect((await customerPage()).lines['Extended warranty']).toBe(false);

    // The rep now recommends the warranty after all.
    expect((await repTicksLine(REP_SAYS_NO, true)).status).toBe(200);
    expect((await customerPage()).lines['Extended warranty']).toBe(false); // not yet - not sent

    expect((await send()).status).toBe(200);
    expect((await customerPage()).lines['Extended warranty']).toBe(true);
  });

  it('a line ticked while DRAFT is still the rep\'s recommendation two sends later', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);

    // Before any send the two are the same thing, so this tick is BOTH the document's answer and
    // the rep's recommendation. The second half is what a DRAFT write that only touched
    // `is_selected` would lose.
    expect((await repTicksLine(REP_SAYS_NOTHING, false)).status).toBe(200);
    expect((await send()).status).toBe(200);
    expect((await customerPage()).lines['Duct cleaning']).toBe(false);

    // The customer disagrees...
    await customerTicks(REP_SAYS_NOTHING, true);
    expect((await customerPage()).lines['Duct cleaning']).toBe(true);

    // ...and the re-send puts the rep's offer back, because the DRAFT tick recorded one.
    expect((await send()).status).toBe(200);
    expect((await customerPage()).lines['Duct cleaning']).toBe(false);
  });

  /**
   * Slice A4 - the line dialog's Optional switch is one control doing two writes (marking a line
   * optional, and recommending it), so its PATCH carries BOTH keys at once. This is that wire
   * shape, which no other test here covers: the row checkbox only ever sends `is_selected`.
   *
   * The recommendation half is routed exactly as the checkbox's is. The `is_optional` half is
   * deliberately NOT routed - it IS the offer, not the customer's answer to it - so an optional
   * line becoming mandatory moves the document, and `is_selected` follows it because a
   * non-optional line is always on the document (`normalizeLineSelection`). That is the offer
   * changing, which is slice A5's subject, not a staff write leaking onto the customer's answer.
   */
  it('a line the dialog made mandatory records the recommendation too, and the re-send publishes it', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect((await send()).status).toBe(200);
    expect((await customerPage()).lines['Extended warranty']).toBe(false);

    // The rep opens the warranty in the line dialog and turns Optional off. The switch's coupling
    // makes that "recommended" in the same click, so both keys go out together.
    const res = await request(app)
      .patch(`/api/estimates/${A2_ID}/line-items/${REP_SAYS_NO}`)
      .set(authHeader('admin'))
      .send({ is_optional: false, is_selected: true });
    expect(res.status).toBe(200);

    // The recommendation landed - it had been false - and the next send is what publishes it.
    expect(doc.line_items.find((l: Doc) => l.id === REP_SAYS_NO).rep_selected).toBe(true);

    expect((await send()).status).toBe(200);
    expect((await customerPage()).lines['Extended warranty']).toBe(true);
  });
});

describe('the rep\'s tick on a DRAFT estimate, exactly as before this slice', () => {
  it('moves the estimate total', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect(Number(doc.total_amount)).toBe(PRE_PUBLISH_TOTAL);

    // The $300 extended warranty is currently on the document; the rep takes it off.
    const res = await repTicksLine(REP_SAYS_NO, false);

    expect(res.status).toBe(200);
    expect(Number(res.body.estimate.total_amount)).toBe(PRE_PUBLISH_TOTAL - 300);
  });
});

/** The scope twin of `repTicksLine` - the same checkbox, on a scope-of-work block. */
function repTicksScope(idx: number, isSelected: boolean) {
  return request(app)
    .patch(`/api/estimates/${A2_ID}/scopes/${idx}`)
    .set(authHeader('admin'))
    .send({ is_selected: isSelected });
}

describe('a scope block\'s checkbox follows the same rule', () => {
  it('a tick after send leaves the customer\'s page and link alone, and goes out on the re-send', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect((await send()).status).toBe(200);
    const emailedToken = doc.public_token;
    const before = await customerPage();
    expect(before.scopes['Haul away']).toBe(false);

    // Scope index 1 is 'Haul away' - the block the rep had NOT recommended.
    expect((await repTicksScope(1, true)).status).toBe(200);

    expect(await customerPage()).toEqual(before);
    expect((await request(app).get(`/api/estimates/${A2_ID}/public?token=${emailedToken}`)).status).toBe(200);

    expect((await send()).status).toBe(200);
    expect((await customerPage()).scopes['Haul away']).toBe(true);
  });
});

describe('a row added after the send records the rep\'s offer too', () => {
  it('addLine: an add-on the rep offered UNticked is still unticked at the next send', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect((await send()).status).toBe(200);

    const added = await request(app)
      .post(`/api/estimates/${A2_ID}/line-items`)
      .set(authHeader('admin'))
      .send({
        description: 'Gutter guards', quantity: 1, unit_price: 90, is_taxable: false,
        item_type: 'SERVICE', is_optional: true, is_selected: false,
      });
    expect(added.status).toBe(201);
    const addedId = doc.line_items.find((l: Doc) => l.description === 'Gutter guards').id;

    // The customer takes it up...
    await customerTicks(addedId, true);
    expect((await customerPage()).lines['Gutter guards']).toBe(true);

    // ...and the re-send restates the rep's offer, which was "on the menu, not included".
    expect((await send()).status).toBe(200);
    expect((await customerPage()).lines['Gutter guards']).toBe(false);
  });

  it('addScope: the new block carries the rep\'s offer', async () => {
    installHarness();
    seedDocument({ status: 'DRAFT' }, REP_LINES, REP_SCOPES);
    expect((await send()).status).toBe(200);

    const added = await request(app)
      .post(`/api/estimates/${A2_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Debris screen', flat_price: 60, is_taxable: false, is_optional: true, is_selected: false });

    expect(added.status).toBe(201);
    const block = (added.body.estimate.scopes as Doc[]).find((s) => s.title === 'Debris screen');
    expect(block?.rep_selected).toBe(false);
  });
});

describe('the signature lock still refuses the tick outright', () => {
  it('a WON estimate answers 409 and writes nothing', async () => {
    installHarness();
    seedDocument({ status: 'WON' }, REP_LINES, REP_SCOPES);

    const res = await repTicksLine(REP_SAYS_NOTHING, false);

    expect(res.status).toBe(409);
    expect(doc.line_items.find((l: Doc) => l.id === REP_SAYS_NOTHING).rep_selected).toBe(null);
  });
});
