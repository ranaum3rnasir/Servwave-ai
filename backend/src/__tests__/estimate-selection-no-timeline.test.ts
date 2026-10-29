/**
 * The 2026-09-18 optional-add-ons revision, decision 5: "the moment the customer clicks, we don't
 * need to record that. It's redundant." The per-tick record is dropped entirely, so NO path writes
 * a selection timeline event any more and no response carries the read-back key.
 *
 * This file is the inverse of the coverage #2088 shipped: it pins the ABSENCE of the write on the
 * rep-side scope tick (the line tick's twin lives in estimate-rep-line-tick-records-nothing.test.ts),
 * `selection_attribution` key on both rep-side PATCH responses and on the estimate detail GET, and
 * a source-level closed negative that no production file names the event type at all.
 *
 * Harness mirrors the suite it replaces (`estimate-selection-timeline.test.ts`): supertest against
 * `app`, prisma fully mocked (setup.ts), a $transaction shim handing the callback the same
 * top-level mocks as `tx` - deliberately INCLUDING `timelineEvent`, so a write would be observable
 * rather than silently swallowed by the controller's `tx.timelineEvent?.create` guard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ESTIMATE_SENT_FIXTURE, ESTIMATE_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  estimateLineItem: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = ESTIMATE_SENT_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000003';
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000003';

function setupLinesTransactionWithTimeline() {
  mockPrisma.$transaction.mockImplementation((arg: unknown) => {
    if (typeof arg === 'function') {
      return (arg as (tx: unknown) => unknown)({
        estimate: { findUnique: mockPrisma.estimate.findUnique, update: mockPrisma.estimate.update },
        estimateLineItem: {
          findMany: mockPrisma.estimateLineItem.findMany,
          update: mockPrisma.estimateLineItem.update,
        },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
      });
    }
    return Promise.all(arg as Promise<unknown>[]);
  });
}

function guardRow({
  scopes = null as unknown[] | null,
  lineItems = [] as unknown[],
} = {}) {
  return {
    id: ESTIMATE_ID,
    status: 'SENT',
    version: 1,
    tax_rate: 0.1,
    discount_type: null,
    discount_value: null,
    subtotal: 1000,
    tax_amount: 100,
    total_amount: 1100,
    discount_amount: 0,
    scopes,
    organization: { lock_on_send: false },
    invoices: [],
    line_items: lineItems,
  };
}

function line(over: Record<string, unknown> = {}) {
  return {
    id: LINE_ID,
    estimate_id: ESTIMATE_ID,
    sequence: 1,
    description: 'AC Unit',
    quantity: 1,
    unit_price: 1000,
    unit_cost: null,
    markup_percent: null,
    is_taxable: true,
    line_total: 1000,
    discount_type: null,
    discount_value: null,
    discount_amount: 0,
    item_type: 'SERVICE',
    price_book_item_id: null,
    is_optional: true,
    is_selected: false,
    ...over,
  };
}

function scope(over: Record<string, unknown> = {}) {
  return {
    id: SCOPE_ID,
    title: 'Permit fee',
    body: '',
    flat_price: 200,
    is_taxable: true,
    internal_cost: null,
    is_optional: true,
    is_selected: false,
    ...over,
  };
}

function respondingEstimate() {
  return { ...ESTIMATE_SENT_FIXTURE, id: ESTIMATE_ID, line_items: [], scopes: null };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
});

describe('the rep-side scope tick records nothing', () => {
  it('PATCH /api/estimates/:id/scopes/0 with is_selected writes no timeline event', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope({ is_optional: true, is_selected: false })] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ is_selected: true });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

describe('no response carries the read-back key', () => {
  it('the line PATCH response carries no selection_attribution key', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ lineItems: [line({ is_optional: true, is_selected: false })] }));
    mockPrisma.estimateLineItem.update.mockResolvedValue({});
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([line({ is_optional: true, is_selected: true })]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ is_selected: true });

    expect(res.status).toBe(200);
    expect(res.body.estimate).not.toHaveProperty('selection_attribution');
  });

  it('the scope PATCH response carries no selection_attribution key', async () => {
    setupLinesTransactionWithTimeline();
    mockPrisma.estimate.findUnique.mockResolvedValue(guardRow({ scopes: [scope({ is_optional: true, is_selected: false })] }));
    mockPrisma.estimateLineItem.findMany.mockResolvedValue([]);
    mockPrisma.estimate.update.mockResolvedValue(respondingEstimate());
    mockPrisma.timelineEvent.create.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ is_selected: true });

    expect(res.status).toBe(200);
    expect(res.body.estimate).not.toHaveProperty('selection_attribution');
  });

  it('GET /api/estimates/:id carries no selection_attribution key', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.estimate).not.toHaveProperty('selection_attribution');
  });
});

describe('closed negative: no production file names the event type', () => {
  function sourceFilesOutsideTests(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFilesOutsideTests(full, out);
      else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('no file under backend/src (tests aside) mentions SELECTION_CHANGED or selection_attribution', () => {
    const needle = ['SELECTION', 'CHANGED'].join('_');
    const offenders = sourceFilesOutsideTests(join(__dirname, '..')).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return source.includes(needle) || source.includes('selection_attribution');
    });

    expect(offenders).toEqual([]);
  });
});
