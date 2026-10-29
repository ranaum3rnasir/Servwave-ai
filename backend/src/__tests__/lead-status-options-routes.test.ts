/**
 * The server decides which lead statuses can be picked by hand (walkthrough lead-statuses PRD
 * 7.3). GET /api/leads/:id returns the menu's `status_options`; PATCH /api/leads/:id { status } runs
 * the same rules before writing anything and refuses a contradicting status with 409 and the lock
 * text, leaving the status, the History and the visits untouched.
 *
 * Mocked-Prisma route tests (they run in CI). The real-database run, which proves the "estimate
 * sent" and visit counting against actual rows, is lead-status-options.integration.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, LEAD_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

const db = prisma as any;

/** What the lead looks like to the rules: its status and how many visits / sent estimates it has. */
function leadWith(status: string, facts: { open?: number; finished?: number; estimatesSent?: number } = {}) {
  db.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status });
  db.lead.update.mockResolvedValue({ ...LEAD_FIXTURE, status });
  db.visit.count.mockImplementation(async (args: any) =>
    args.where.status === 'COMPLETED' ? (facts.finished ?? 0) : (facts.open ?? 0),
  );
  db.estimate.count.mockResolvedValue(facts.estimatesSent ?? 0);
}

function statusWrites() {
  return db.lead.updateMany.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a?.data?.status !== undefined);
}
function historyRows() {
  return db.timelineEvent.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.event_type === 'STATUS_CHANGE');
}

const ESTIMATE_SENT = "An estimate was already sent to this lead, so it can't go back to this step.";

beforeEach(() => {
  vi.resetAllMocks();
  clearPermissionCache();
  db.estimate.count.mockResolvedValue(0);
  db.estimate.findMany.mockResolvedValue([]);
  db.estimate.updateMany.mockResolvedValue({ count: 0 });
  db.visit.count.mockResolvedValue(0);
  db.visit.updateMany.mockResolvedValue({ count: 1 });
  db.lead.updateMany.mockResolvedValue({ count: 1 });
  db.timelineEvent.create.mockResolvedValue({});
  db.rolePermission.findMany.mockResolvedValue([]);
  db.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
});

describe('GET /api/leads/:id status_options', () => {
  it('returns all eight statuses in pipeline order, built from the lead\'s visits and estimates', async () => {
    mockAuthAs('admin');
    leadWith('CONTACTED', { open: 1 });

    const res = await request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.lead.status_options).toEqual([
      { status: 'NEW', available: false, reason: "This lead already has a walkthrough or an estimate, so it's past New." },
      { status: 'CONTACTED', available: true, reason: null },
      { status: 'WALKTHROUGH_SCHEDULED', available: true, reason: null },
      { status: 'WALKTHROUGH_COMPLETED', available: false, reason: 'A walkthrough visit is still booked on this lead.' },
      { status: 'ESTIMATED', available: false, reason: 'No estimate has been sent to this lead yet.' },
      { status: 'WON', available: true, reason: null },
      { status: 'LOST', available: true, reason: null },
      { status: 'CANCELLED', available: true, reason: null },
    ]);
  });

  it('locks the earlier steps with the estimate text once an estimate went out', async () => {
    mockAuthAs('admin');
    leadWith('ESTIMATED', { estimatesSent: 1 });

    const res = await request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin'));

    const byStatus = Object.fromEntries(res.body.lead.status_options.map((o: any) => [o.status, o]));
    expect(byStatus.NEW.reason).toBe(ESTIMATE_SENT);
    expect(byStatus.WALKTHROUGH_COMPLETED.reason).toBe(ESTIMATE_SENT);
    expect(byStatus.ESTIMATED).toEqual({ status: 'ESTIMATED', available: true, reason: null });
  });
});

describe('PATCH /api/leads/:id { status } is checked against the lead\'s data', () => {
  it('refuses a status the data contradicts: 409 with the exact text, and nothing is written', async () => {
    mockAuthAs('admin');
    leadWith('CONTACTED'); // no visits

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'WALKTHROUGH_SCHEDULED' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "There's no walkthrough booked on this lead right now." });
    // Nothing written: no status, no History row, no cancelled visits, no lead update at all.
    expect(statusWrites()).toHaveLength(0);
    expect(historyRows()).toHaveLength(0);
    expect(db.visit.updateMany).not.toHaveBeenCalled();
    expect(db.lead.update).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a status the data supports: 200, the status moves, one History row', async () => {
    mockAuthAs('admin');
    leadWith('CONTACTED', { open: 1 });

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'WALKTHROUGH_SCHEDULED' });

    expect(res.status).toBe(200);
    expect(statusWrites()).toHaveLength(1);
    expect(statusWrites()[0].data.status).toBe('WALKTHROUGH_SCHEDULED');
    expect(historyRows()).toHaveLength(1);
    expect(historyRows()[0].metadata).toMatchObject({ from: 'CONTACTED', to: 'WALKTHROUGH_SCHEDULED' });
  });

  it('refuses Walkthrough Completed while a visit is still booked, and Estimate Sent with no estimate', async () => {
    mockAuthAs('admin');
    leadWith('CONTACTED', { open: 1, finished: 1 });
    let res = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'WALKTHROUGH_COMPLETED' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A walkthrough visit is still booked on this lead.');

    res = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'ESTIMATED' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('No estimate has been sent to this lead yet.');
    expect(statusWrites()).toHaveLength(0);
  });

  it('moves a Won lead with an approved estimate to Estimate Sent (200), and refuses Contacted with the estimate text', async () => {
    mockAuthAs('admin');
    leadWith('WON', { estimatesSent: 1 });

    const ok = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'ESTIMATED' });
    expect(ok.status).toBe(200);
    expect(statusWrites()).toHaveLength(1);
    expect(historyRows()[0].metadata).toMatchObject({ from: 'WON', to: 'ESTIMATED' });

    db.lead.updateMany.mockClear();
    db.timelineEvent.create.mockClear();
    const refused = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'CONTACTED' });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ error: ESTIMATE_SENT });
    expect(statusWrites()).toHaveLength(0);
    expect(historyRows()).toHaveLength(0);
  });

  it('lets Won be picked on a New lead with no estimate, and stamps won_at', async () => {
    mockAuthAs('admin');
    leadWith('NEW');

    const res = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'WON' });

    expect(res.status).toBe(200);
    expect(statusWrites()[0].data.status).toBe('WON');
    const wonStamp = db.lead.updateMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a.data?.won_at);
    expect(wonStamp).toBeTruthy();
  });

  it('applies the same rules to a closed lead (no closed-lead lock)', async () => {
    mockAuthAs('admin');
    leadWith('LOST', { finished: 1 });

    const res = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'WALKTHROUGH_COMPLETED' });

    expect(res.status).toBe(200);
    expect(statusWrites()[0].data.status).toBe('WALKTHROUGH_COMPLETED');
  });

  it('never refuses the lead\'s own status, even when its rule would lock it', async () => {
    mockAuthAs('admin');
    leadWith('WALKTHROUGH_SCHEDULED'); // nothing booked, but it is the current status

    const res = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'WALKTHROUGH_SCHEDULED' });

    expect(res.status).toBe(200);
  });

  it('does not read visits or estimates when the request carries no status', async () => {
    mockAuthAs('admin');
    leadWith('NEW');

    const res = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ service_request: 'New wording' });

    expect(res.status).toBe(200);
    expect(db.visit.count).not.toHaveBeenCalled();
  });

  it('keeps Lost and Cancelled available: the availability check never blocks closing a lead', async () => {
    mockAuthAs('admin');
    leadWith('NEW', { estimatesSent: 1, open: 1 });

    const res = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'CANCELLED' });

    expect(res.status).not.toBe(409);
  });
});
