/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.10 - the checks on the office review's items: POST /api/jobs/:id/review/checks
   (one item) and POST /api/jobs/:id/review/checks/all (Mark all checked).

   A check is stored against the history entry the item had when it was made, so an item is checked only while that is
   still its latest entry: a later change un-checks it with no extra write. The job summary's check is tied to the job's
   latest history entry. Everything goes through the public interface (the job routes, called as people on custom roles
   holding exactly the switch values under test). Real migrated database (TEST_DATABASE_URL); the suite skips when it
   is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening the job and its invoices takes. */
const OPENING = { view_jobs: true, jobs_scope: 'all', view_invoices: true, leads_scope: 'all' };

interface Item { key: string; kind: string; checked: boolean; checked_by: string | null; checked_at: string | null; latest_entry_id: string }
interface Review {
  summary: { checked: boolean; checked_by: string | null; checked_at: string | null; latest_entry_id: string | null };
  groups: { key: string; items: Item[] }[];
  totals: { items: number; checked: number; unusual: number };
}
const itemsOf = (r: Review): Item[] => r.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items);

suite('the office review checks (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `job-review-checks-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  let clock = 0;
  /** A history entry on the job, in the shape the earlier slices write it. Each one lands a minute after the last. */
  async function history(org: string, jobId: string, event_type: string, metadata: object | null, over: { by?: string } = {}) {
    return db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'JOB', entity_id: jobId, event_type, description: event_type,
        metadata: (metadata ?? undefined) as never, created_by: over.by ?? null, created_at: new Date(Date.now() - 3_000_000 + ++clock * 60_000),
      },
    });
  }

  const line = (over: Record<string, unknown> = {}) => ({
    name: 'Spring', quantity: 1, unit_price: 100, line_total: 100, is_taxable: true,
    discount_type: null, discount_value: null, discount_amount: 0, ...over,
  });

  /** A job in Office review with its open round, the way the complete leaves it (the round's start entry included). */
  async function reviewJob(org: string, customer: string, opts: { status?: 'OFFICE_REVIEW' | 'READY_TO_CLOSE'; round?: boolean } = {}) {
    const job = await fx.addJob(org, customer, { status: opts.status ?? 'OFFICE_REVIEW' });
    if (opts.round !== false) {
      await db.jobReview.create({ data: { organization_id: org, job_id: job.id, window_start: new Date(Date.now() - 3_600_000) } });
    }
    await history(org, job.id, 'OFFICE_REVIEW_STARTED', { from: 'COMPLETED', to: 'OFFICE_REVIEW' });
    return job;
  }

  const read = async (api: Awaited<ReturnType<typeof fx.signedInAs>>, jobId: string): Promise<Review> => (await api.get(`/api/jobs/${jobId}/review`)).body.review;
  const checkOne = (api: Awaited<ReturnType<typeof fx.signedInAs>>, jobId: string, item: { key: string; latest_entry_id: string | null }) =>
    api.post(`/api/jobs/${jobId}/review/checks`, { item_key: item.key, entry_id: item.latest_entry_id });

  it('records who checked an item and when, and the review shows it checked', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const lineId = randomUUID();
    await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: lineId, old: line(), new: line({ unit_price: 90, line_total: 90 }) }, { by: admin.id });
    const api = await me.api();
    const before = itemsOf(await read(api, job.id))[0]!;
    expect(before.checked).toBe(false);

    const res = await checkOne(api, job.id, before);
    expect(res.status).toBe(200);
    const after = itemsOf(res.body.review as Review)[0]!;
    expect(after.checked).toBe(true);
    expect(after.checked_by).toBe(`${(await db.user.findUniqueOrThrow({ where: { id: me.id } })).first_name} ${(await db.user.findUniqueOrThrow({ where: { id: me.id } })).last_name}`);
    expect(new Date(after.checked_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(res.body.review.totals).toMatchObject({ items: 2, checked: 1 });
    // The stored answer is the same on the next read.
    expect(itemsOf(await read(api, job.id))[0]!.checked).toBe(true);
  });

  it('un-checks an item when it is edited again, with no write to the checks', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const lineId = randomUUID();
    await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: lineId, old: line(), new: line({ unit_price: 90, line_total: 90 }) }, { by: admin.id });
    const api = await me.api();
    await checkOne(api, job.id, itemsOf(await read(api, job.id))[0]!);
    const rows = await db.jobReviewItemCheck.findMany({ where: { organization_id: org } });

    await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: lineId, old: line({ unit_price: 90 }), new: line({ unit_price: 80, line_total: 80 }) }, { by: admin.id });
    const after = await read(api, job.id);
    expect(itemsOf(after)).toHaveLength(1);
    expect(itemsOf(after)[0]!.checked).toBe(false);
    expect(itemsOf(after)[0]!.checked_by).toBeNull();
    expect(after.totals.checked).toBe(0);
    expect(await db.jobReviewItemCheck.findMany({ where: { organization_id: org } })).toEqual(rows);

    // Checking it again, against the new entry, checks it.
    const again = await checkOne(api, job.id, itemsOf(after)[0]!);
    expect(itemsOf(again.body.review as Review)[0]!.checked).toBe(true);
    expect(await db.jobReviewItemCheck.count({ where: { organization_id: org } })).toBe(1);
  });

  it('checks the job summary, and any new history entry on the job un-checks it', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const api = await me.api();
    const summary = (await read(api, job.id)).summary;
    expect(summary.checked).toBe(false);

    const res = await api.post(`/api/jobs/${job.id}/review/checks`, { item_key: 'summary', entry_id: summary.latest_entry_id });
    expect(res.status).toBe(200);
    expect(res.body.review.summary.checked).toBe(true);
    expect(res.body.review.summary.checked_by).toBeTruthy();
    expect(res.body.review.totals).toMatchObject({ items: 1, checked: 1 });

    // Any entry on the job, even one that is not an item of its own, un-checks the summary.
    await history(org, job.id, 'JOB_UPDATED', { fields: ['scope_notes'] });
    const after = await read(api, job.id);
    expect(after.summary.checked).toBe(false);
    expect(after.totals).toMatchObject({ items: 1, checked: 0 });
  });

  it('refuses a check made against an entry that is no longer the latest, and stores nothing', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const lineId = randomUUID();
    await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: lineId, old: line(), new: line({ unit_price: 90, line_total: 90 }) }, { by: admin.id });
    const api = await me.api();
    const seen = itemsOf(await read(api, job.id))[0]!;
    await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: lineId, old: line({ unit_price: 90 }), new: line({ unit_price: 80, line_total: 80 }) }, { by: admin.id });

    const res = await checkOne(api, job.id, seen);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/changed/i);
    expect(await db.jobReviewItemCheck.count({ where: { organization_id: org } })).toBe(0);
  });

  it('refuses an item that is not in the review, and a customer item (confirmed one by one, later)', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const entry = await history(org, job.id, 'JOB_CONTACT_ENTRY_ADDED', { entry_id: randomUUID(), kind: 'PHONE', intent: 'ADDED', old: null, new: { value: '5551234567', extension: null, label: null } }, { by: admin.id });
    const api = await me.api();
    const missing = await api.post(`/api/jobs/${job.id}/review/checks`, { item_key: `line:${randomUUID()}`, entry_id: entry.id });
    expect(missing.status).toBe(404);
    const customerItem = itemsOf(await read(api, job.id)).find((i) => i.kind === 'contact')!;
    const res = await checkOne(api, job.id, customerItem);
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain('Customer changes are confirmed one by one.');
    expect(await db.jobReviewItemCheck.count({ where: { organization_id: org } })).toBe(0);
  });

  it('refuses a check on a money item the person cannot open, as if it were not there', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const job = await reviewJob(org, customer);
    const inv = await fx.addInvoice(org, customer, { jobId: job.id });
    const payment = await history(org, job.id, 'JOB_PAYMENT_RECORDED', { invoice_id: inv.id, invoice_number: 'INV-9', amount: 50, method: 'CASH', payment_id: randomUUID() }, { by: admin.id });
    const sees = await personWith(org, { ...OPENING, office_review: true });
    const blind = await personWith(org, { view_jobs: true, jobs_scope: 'all', office_review: true, view_invoices: false });
    const key = itemsOf(await read(await sees.api(), job.id)).find((i) => i.kind === 'payment')!.key;

    const res = await (await blind.api()).post(`/api/jobs/${job.id}/review/checks`, { item_key: key, entry_id: payment.id });
    expect(res.status).toBe(404);
    expect(await db.jobReviewItemCheck.count({ where: { organization_id: org } })).toBe(0);
    // The person who can open the invoice checks it.
    expect((await (await sees.api()).post(`/api/jobs/${job.id}/review/checks`, { item_key: key, entry_id: payment.id })).status).toBe(200);
  });

  it('refuses a custom role with Office review off, whatever else it holds', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: false, complete_jobs: true, close_jobs: true, edit_jobs: true });
    const job = await reviewJob(org, customer);
    const entry = await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: randomUUID(), old: line(), new: line({ unit_price: 90 }) }, { by: admin.id });
    const api = await me.api();
    const one = await api.post(`/api/jobs/${job.id}/review/checks`, { item_key: 'summary', entry_id: entry.id });
    const all = await api.post(`/api/jobs/${job.id}/review/checks/all`, { items: [{ item_key: 'summary', entry_id: entry.id }] });
    expect([one.status, all.status]).toEqual([403, 403]);
    expect(await db.jobReviewItemCheck.count({ where: { organization_id: org } })).toBe(0);
  });

  it('refuses a job the person cannot open under their jobs scope, and a job from another company', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    const scoped = await personWith(a.org, { ...OPENING, jobs_scope: 'attached', office_review: true });
    const jobA = await reviewJob(a.org, a.customer);
    const jobB = await reviewJob(b.org, b.customer);
    const api = await scoped.api();
    const entryA = await db.timelineEvent.findFirstOrThrow({ where: { entity_id: jobA.id } });
    const entryB = await db.timelineEvent.findFirstOrThrow({ where: { entity_id: jobB.id } });
    expect((await api.post(`/api/jobs/${jobA.id}/review/checks`, { item_key: 'summary', entry_id: entryA.id })).status).toBe(404);
    expect((await api.post(`/api/jobs/${jobB.id}/review/checks`, { item_key: 'summary', entry_id: entryB.id })).status).toBe(404);
    expect(await db.jobReviewItemCheck.count({ where: { organization_id: { in: [a.org, b.org] } } })).toBe(0);
  });

  it('refuses a check on a job that is not in Office review, or has no open round', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const api = await me.api();
    const ready = await reviewJob(org, customer, { status: 'READY_TO_CLOSE' });
    const noRound = await reviewJob(org, customer, { round: false });
    for (const job of [ready, noRound]) {
      const entry = await db.timelineEvent.findFirstOrThrow({ where: { entity_id: job.id } });
      const res = await api.post(`/api/jobs/${job.id}/review/checks`, { item_key: 'summary', entry_id: entry.id });
      expect(res.status).toBe(409);
    }
    expect(await db.jobReviewItemCheck.count({ where: { organization_id: org } })).toBe(0);
  });

  describe('Mark all checked', () => {
    it('checks the job summary and every non-customer item, leaves every customer item unchecked, and says so', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, office_review: true });
      const job = await reviewJob(org, customer);
      await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: randomUUID(), old: line(), new: line({ unit_price: 90 }) }, { by: admin.id });
      await history(org, job.id, 'ATTACHMENT_DELETED', { attachment_id: randomUUID(), file_name: 'a.png', display_name: 'Door.png', uploaded_by_name: 'Lee', deleted_by_name: 'Test Admin' }, { by: admin.id });
      await history(org, job.id, 'JOB_CONTACT_ENTRY_ADDED', { entry_id: randomUUID(), kind: 'PHONE', intent: 'ADDED', old: null, new: { value: '5551234567', extension: null, label: null } }, { by: admin.id });
      await history(org, job.id, 'JOB_CONTACT_ENTRY_ADDED', { entry_id: randomUUID(), kind: 'EMAIL', intent: 'ADDED', old: null, new: { value: 'tenant@example.test', extension: null, label: null } }, { by: admin.id });
      const api = await me.api();
      const before = await read(api, job.id);
      const snapshot = [{ item_key: 'summary', entry_id: before.summary.latest_entry_id }, ...itemsOf(before).map((i) => ({ item_key: i.key, entry_id: i.latest_entry_id }))];

      const res = await api.post(`/api/jobs/${job.id}/review/checks/all`, { items: snapshot });
      expect(res.status).toBe(200);
      const after = res.body.review as Review;
      expect(after.summary.checked).toBe(true);
      const items = itemsOf(after);
      expect(items.filter((i) => i.kind !== 'contact').every((i) => i.checked)).toBe(true);
      expect(items.filter((i) => i.kind === 'contact')).toHaveLength(2);
      expect(items.filter((i) => i.kind === 'contact').some((i) => i.checked)).toBe(false);
      expect(after.totals).toMatchObject({ items: 5, checked: 3 });
      expect(await db.jobReviewItemCheck.count({ where: { organization_id: org } })).toBe(3);
    });

    it('does not check an item that changed after the person read the review', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, office_review: true });
      const job = await reviewJob(org, customer);
      const lineId = randomUUID();
      await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: lineId, old: line(), new: line({ unit_price: 90 }) }, { by: admin.id });
      await history(org, job.id, 'ATTACHMENT_UPLOADED', { attachment_id: randomUUID(), file_name: 'a.png', display_name: 'Door.png' }, { by: admin.id });
      const api = await me.api();
      const seen = await read(api, job.id);
      const snapshot = [{ item_key: 'summary', entry_id: seen.summary.latest_entry_id }, ...itemsOf(seen).map((i) => ({ item_key: i.key, entry_id: i.latest_entry_id }))];
      await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: lineId, old: line({ unit_price: 90 }), new: line({ unit_price: 80 }) }, { by: admin.id });

      const after = (await api.post(`/api/jobs/${job.id}/review/checks/all`, { items: snapshot })).body.review as Review;
      // The new entry also moved the job's latest entry, so the summary is stale too: only the untouched attachment is checked.
      expect(after.summary.checked).toBe(false);
      expect(itemsOf(after).filter((i) => i.checked).map((i) => i.kind)).toEqual(['attachment']);
    });

    it('stores nothing for an item the person cannot see', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const job = await reviewJob(org, customer);
      const inv = await fx.addInvoice(org, customer, { jobId: job.id });
      const payment = await history(org, job.id, 'JOB_PAYMENT_RECORDED', { invoice_id: inv.id, invoice_number: 'INV-9', amount: 50, method: 'CASH', payment_id: randomUUID() }, { by: admin.id });
      const sees = await personWith(org, { ...OPENING, office_review: true });
      const blind = await personWith(org, { view_jobs: true, jobs_scope: 'all', office_review: true, view_invoices: false });
      const key = itemsOf(await read(await sees.api(), job.id)).find((i) => i.kind === 'payment')!.key;
      const api = await blind.api();
      const summary = (await read(api, job.id)).summary;
      const res = await api.post(`/api/jobs/${job.id}/review/checks/all`, {
        items: [{ item_key: 'summary', entry_id: summary.latest_entry_id }, { item_key: key, entry_id: payment.id }],
      });
      expect(res.status).toBe(200);
      expect(await db.jobReviewItemCheck.findMany({ where: { organization_id: org }, select: { item_key: true } })).toEqual([{ item_key: 'summary' }]);
    });

    it('checks a round of 150 items in one call', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, office_review: true });
      const job = await reviewJob(org, customer);
      for (let i = 0; i < 150; i += 1) {
        await history(org, job.id, 'JOB_LINE_ADDED', { line_id: randomUUID(), old: null, new: line({ name: `Part ${i}` }) });
      }
      const api = await me.api();
      const seen = await read(api, job.id);
      const snapshot = [{ item_key: 'summary', entry_id: seen.summary.latest_entry_id }, ...itemsOf(seen).map((i) => ({ item_key: i.key, entry_id: i.latest_entry_id }))];
      const res = await api.post(`/api/jobs/${job.id}/review/checks/all`, { items: snapshot });
      expect(res.status).toBe(200);
      expect(res.body.review.totals).toMatchObject({ items: 151, checked: 151 });
    });
  });
});
