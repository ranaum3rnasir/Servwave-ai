/**
 * The estimate-driven lead moves, with the two walkthrough statuses in play (walkthrough
 * lead-statuses PRD 6.3 and 12.2 items 9 and 10).
 *
 *   - Sending an estimate moves a lead to Estimate Sent from New, Contacted, Walkthrough Scheduled
 *     and Walkthrough Completed (the last two used to be refused, so a lead whose walkthrough was
 *     booked or done would never have reached Estimate Sent).
 *   - Approving an estimate on a Walkthrough Completed lead gives Won; voiding that approval gives
 *     Estimate Sent. Neither door needed a change; these tests are the proof that the new values
 *     pass through the existing guards correctly.
 *
 * The lead is a small in-memory row whose guarded status write honours the WHERE the one writer
 * sends (`status in` / `status notIn`), the way Postgres does, so what is asserted is the status
 * the lead ends at and the History row, not which mock was called.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, LEAD_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';
import { LeadStatus } from '@prisma/client';

vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

const mockPrisma = prisma as unknown as Record<string, any>;

const ESTIMATE_ID = '11110000-0000-0000-0000-0000000000e1';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-0000000000aa';

let leadStatus: string;
let timeline: Array<Record<string, any>>;
let leadWrites: Array<{ where: any; data: any }>;

/**
 * No lead-status History sentence may carry a raw enum value (PRD 12.6). Case-sensitive on the
 * upper-case values and the snake-case ones, plus the one value whose label is a different word
 * (`ESTIMATED` reads "Estimate Sent"), which an old description also wrote in lower case.
 */
const rawStatusIn = (text: string) =>
  [...Object.values(LeadStatus), 'estimated'].filter((v) => new RegExp(`\\b${v}\\b`).test(text));

const statusMoves = () => timeline.filter((e) => e.event_type === 'STATUS_CHANGE');

function estimateRow(over: Record<string, unknown> = {}) {
  return {
    id: ESTIMATE_ID,
    status: 'DRAFT',
    estimate_number: 'E00001',
    total_amount: 1062.5,
    lead_id: LEAD_FIXTURE.id,
    public_token: null,
    valid_until: null,
    modified_after_send: false,
    version: 1,
    deposit_type: null,
    deposit_value: null,
    created_by: null,
    customer_id: CUSTOMER_ID,
    customer: { id: CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
    _count: { line_items: 2 },
    lead: {
      lead_assignees: [],
      commission_owner_id: null,
      status: leadStatus,
      customer: { id: CUSTOMER_ID, first_name: 'John', last_name: 'Doe', company_name: null, email: 'john@doe.com' },
    },
    send_config: null,
    job_id: null,
    job: null,
    job_link: null,
    invoices: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  timeline = [];
  leadWrites = [];
  leadStatus = 'CONTACTED';

  mockPrisma.lead.updateMany.mockImplementation(async ({ where, data }: any) => {
    leadWrites.push({ where, data });
    if (where.status?.in && !where.status.in.includes(leadStatus)) return { count: 0 };
    if (where.status?.notIn && where.status.notIn.includes(leadStatus)) return { count: 0 };
    if (data.status !== undefined) leadStatus = data.status;
    return { count: 1 };
  });
  mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE });
  mockPrisma.timelineEvent.create.mockImplementation(async ({ data }: any) => { timeline.push(data); return data; });
  mockPrisma.estimate.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.estimate.findMany.mockResolvedValue([]);
  mockPrisma.estimate.count.mockResolvedValue(0);
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.invoice.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.count.mockResolvedValue(0);
});

describe('sending an estimate (POST /api/estimates/:id/send)', () => {
  beforeEach(() => {
    mockPrisma.estimate.findUnique.mockImplementation(async () => estimateRow());
    mockPrisma.estimate.update.mockResolvedValue({ ...estimateRow(), status: 'SENT' });
    mockPrisma.estimateVersionSnapshot.create.mockResolvedValue({});
    // The send door's commit phase reaches for models the default `fn(prisma)` transaction does not
    // carry, so the transaction client is spelled out; `lead` and `timelineEvent` are DELEGATED to
    // the shared in-memory mocks above.
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: mockPrisma.estimate.update, findUnique: mockPrisma.estimate.findUnique },
        estimateSendConfig: { upsert: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
        deposit: { create: vi.fn().mockResolvedValue({}) },
        invoice: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: 'dep-inv-1' }),
          update: vi.fn().mockResolvedValue({}),
        },
        invoiceLineItem: { create: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
        lead: { update: mockPrisma.lead.update, updateMany: mockPrisma.lead.updateMany },
      }),
    );
    mockPrisma.appSetting.findUnique.mockResolvedValue(null);
    mockPrisma.organization.findUnique.mockResolvedValue({
      id: ALPHA_ORG_ID, name: 'Test Org', logo_url: null, brand_color: null,
      estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
      deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: 0,
    });
  });

  const send = () =>
    request(app).post(`/api/estimates/${ESTIMATE_ID}/send`).set(authHeader('admin')).send({ deposit_required: false, payment_methods: [] });

  for (const from of ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED']) {
    it(`moves a ${from} lead to Estimate Sent, with the existing History sentence and the on-screen label`, async () => {
      leadStatus = from;
      const res = await send();

      expect(res.status).toBe(200);
      expect(leadStatus).toBe('ESTIMATED');
      expect(statusMoves()).toHaveLength(1);
      expect(statusMoves()[0].metadata).toMatchObject({ from, to: 'ESTIMATED', via: 'estimate_sent' });
      expect(statusMoves()[0].description).toBe('Lead transitioned to Estimate Sent — estimate E00001 sent');
      expect(rawStatusIn(statusMoves()[0].description)).toEqual([]);
    });
  }

  it('asks the database to move the lead only from the four early statuses', async () => {
    leadStatus = 'WALKTHROUGH_COMPLETED';
    await send();

    const statusWrite = leadWrites.find((w) => w.data.status === 'ESTIMATED')!;
    expect(statusWrite.where.status.in).toEqual(['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED']);
  });

  for (const stays of ['ESTIMATED', 'WON', 'LOST', 'CANCELLED']) {
    it(`leaves a ${stays} lead where it is and writes no status row`, async () => {
      leadStatus = stays;
      const res = await send();

      expect(res.status).toBe(200);
      expect(leadStatus).toBe(stays);
      expect(statusMoves()).toHaveLength(0);
    });
  }
});

describe('approving and voiding an approval on a Walkthrough Completed lead', () => {
  it('approve-internal moves a Walkthrough Completed lead to Won, stamping won_at', async () => {
    leadStatus = 'WALKTHROUGH_COMPLETED';
    mockPrisma.estimate.findUnique.mockImplementation(async () => estimateRow({ status: 'SENT' }));
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: { update: vi.fn().mockResolvedValue({ ...estimateRow(), status: 'WON' }) },
        lead: { updateMany: mockPrisma.lead.updateMany },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
        estimateSendConfig: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
        estimateReservation: { findFirst: vi.fn().mockResolvedValue({ id: 'existing-reservation' }) },
      }),
    );

    const res = await request(app).post(`/api/estimates/${ESTIMATE_ID}/approve-internal`).set(authHeader('admin')).send({});

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('WON');
    expect(statusMoves()).toHaveLength(1);
    expect(statusMoves()[0].metadata).toMatchObject({ from: 'WALKTHROUGH_COMPLETED', to: 'WON', via: 'internal_approval' });
    expect(leadWrites.some((w) => w.data.won_at instanceof Date)).toBe(true);
  });

  it('voiding that approval moves the Won lead to Estimate Sent', async () => {
    leadStatus = 'WON';
    mockPrisma.estimate.findUnique.mockImplementation(async () => estimateRow({ status: 'WON' }));
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          update: vi.fn().mockResolvedValue({ id: ESTIMATE_ID, status: 'SENT' }),
          count: vi.fn().mockResolvedValue(0),
        },
        lead: { updateMany: mockPrisma.lead.updateMany },
        timelineEvent: { create: mockPrisma.timelineEvent.create },
      }),
    );

    const res = await request(app).post(`/api/estimates/${ESTIMATE_ID}/void-approval`).set(authHeader('admin')).send();

    expect(res.status).toBe(200);
    expect(leadStatus).toBe('ESTIMATED');
    expect(statusMoves()).toHaveLength(1);
    expect(statusMoves()[0].metadata).toMatchObject({ from: 'WON', to: 'ESTIMATED', via: 'void_approval' });
    expect(statusMoves()[0].description).toBe('Lead returned to Estimate Sent — the last won estimate had its approval voided');
    expect(rawStatusIn(statusMoves()[0].description)).toEqual([]);
  });
});
