/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.11 - the customer decisions in the office review: POST
   /api/jobs/:id/review/decisions.

   Each live PRD 5 job contact entry is one customer item with a choice and its own tick. The tick records the choice
   shown (the default or the reviewer's pick) in the review's own table, against the history entry it was made against,
   so a correction to the entry un-checks it with no write. Changing the choice after the tick keeps it ticked. Decisions
   are only RECORDED here: nothing reaches the customer until Finish review (S06.12), and PRD 5's entries are never
   changed. Everything goes through the public interface (the job routes, called as people on custom roles holding
   exactly the switch values under test). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   Every org it creates is removed again.
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
const OPENING = { view_jobs: true, jobs_scope: 'all', view_invoices: true, invoices_scope: 'all' };

const PHONE = { value: '5551234567', extension: null, label: null };
const EMAIL = { value: 'tenant@example.test', extension: null, label: null };

interface Contact { entry_id: string; kind: string; intent: string; removed: boolean; options: string[]; default_choice: string | null; decision: string | null; choice: string | null; customer_current: string | null }
interface Item { key: string; kind: string; checked: boolean; checked_by: string | null; checked_at: string | null; latest_entry_id: string; contact?: Contact }
interface Review {
  summary: { checked: boolean; latest_entry_id: string | null };
  groups: { key: string; items: Item[] }[];
  totals: { items: number; checked: number; unusual: number };
}
const itemsOf = (r: Review): Item[] => r.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items);

suite('the office review customer decisions (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(org: string, values: Record<string, SwitchValue>, base: Role = 'DISPATCHER') {
    const key = `job-review-decisions-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
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

  /** A job in Office review with its open round, the way the complete leaves it. */
  async function reviewJob(org: string, customer: string, opts: { status?: 'OFFICE_REVIEW' | 'READY_TO_CLOSE'; round?: boolean } = {}) {
    const job = await fx.addJob(org, customer, { status: opts.status ?? 'OFFICE_REVIEW' });
    if (opts.round !== false) {
      await db.jobReview.create({ data: { organization_id: org, job_id: job.id, window_start: new Date(Date.now() - 3_600_000) } });
    }
    await history(org, job.id, 'OFFICE_REVIEW_STARTED', { from: 'COMPLETED', to: 'OFFICE_REVIEW' });
    return job;
  }

  const added = (org: string, jobId: string, kind: 'PHONE' | 'EMAIL', by?: string) =>
    history(org, jobId, 'JOB_CONTACT_ENTRY_ADDED', { entry_id: randomUUID(), kind, intent: 'ADDED', old: null, new: kind === 'PHONE' ? PHONE : EMAIL }, { by });
  const changed = (org: string, jobId: string, kind: string, from: string, to: string, by?: string) =>
    history(org, jobId, 'JOB_CONTACT_ENTRY_CHANGED', { entry_id: randomUUID(), kind, intent: 'CHANGED', old: { value: from, extension: null, label: null }, new: { value: to, extension: null, label: null } }, { by });

  const read = async (api: Api, jobId: string): Promise<Review> => (await api.get(`/api/jobs/${jobId}/review`)).body.review;
  const contactItems = (r: Review) => itemsOf(r).filter((i) => i.kind === 'contact');
  /** What the panel sends when the reviewer ticks an item: the entry it saw and the choice it showed. */
  const decide = (api: Api, jobId: string, item: Item, choice?: string) =>
    api.post(`/api/jobs/${jobId}/review/decisions`, { item_key: item.key, entry_id: item.latest_entry_id, ...(choice ? { choice } : {}) });

  it('offers the choices by kind: Add and This job only for an added phone or email; all three for a changed one; This job only and Update for a name; none for a removed entry', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    await added(org, job.id, 'PHONE', admin.id);
    await added(org, job.id, 'EMAIL', admin.id);
    await changed(org, job.id, 'PHONE', '5550001111', '5552223333', admin.id);
    await changed(org, job.id, 'EMAIL', 'old@example.test', 'new@example.test', admin.id);
    await changed(org, job.id, 'FIRST_NAME', 'Pat', 'Patricia', admin.id);
    await changed(org, job.id, 'COMPANY_NAME', 'Old Co', 'New Co', admin.id);
    const gone = await added(org, job.id, 'EMAIL', admin.id);
    await history(org, job.id, 'JOB_CONTACT_ENTRY_REMOVED', { entry_id: (gone.metadata as { entry_id: string }).entry_id, kind: 'EMAIL', intent: 'ADDED', old: EMAIL, new: null, restored_customer_value: null }, { by: admin.id });

    const offered = contactItems(await read(await me.api(), job.id)).map((i) => [i.contact!.kind, i.contact!.intent, i.contact!.removed, i.contact!.options, i.contact!.default_choice, i.contact!.choice]);
    expect(offered).toEqual([
      ['PHONE', 'ADDED', false, ['ADD', 'THIS_JOB_ONLY'], 'ADD', 'ADD'],
      ['EMAIL', 'ADDED', false, ['ADD', 'THIS_JOB_ONLY'], 'ADD', 'ADD'],
      ['PHONE', 'CHANGED', false, ['ADD', 'UPDATE', 'THIS_JOB_ONLY'], 'ADD', 'ADD'],
      ['EMAIL', 'CHANGED', false, ['ADD', 'UPDATE', 'THIS_JOB_ONLY'], 'ADD', 'ADD'],
      ['FIRST_NAME', 'CHANGED', false, ['THIS_JOB_ONLY', 'UPDATE'], 'THIS_JOB_ONLY', 'THIS_JOB_ONLY'],
      ['COMPANY_NAME', 'CHANGED', false, ['THIS_JOB_ONLY', 'UPDATE'], 'THIS_JOB_ONLY', 'THIS_JOB_ONLY'],
      ['EMAIL', 'ADDED', true, [], null, null],
    ]);
  });

  it('shows the customer\'s current value beside the job\'s changed name', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    await changed(org, job.id, 'LAST_NAME', 'Old', 'Newer', admin.id);
    const row = await db.customer.findUniqueOrThrow({ where: { id: customer }, select: { last_name: true } });
    const item = contactItems(await read(await me.api(), job.id))[0]!;
    expect(item.contact!.customer_current).toBe(row.last_name);
  });

  it('ticks an item with the choice shown, recording who and when in the review\'s own table, and the counts follow', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    await added(org, job.id, 'PHONE', admin.id);
    const api = await me.api();
    const item = contactItems(await read(api, job.id))[0]!;
    expect(item.checked).toBe(false);

    const res = await decide(api, job.id, item, 'ADD');
    expect(res.status).toBe(200);
    const after = contactItems(res.body.review as Review)[0]!;
    expect(after).toMatchObject({ checked: true, contact: { decision: 'ADD', choice: 'ADD' } });
    expect(after.checked_by).toBeTruthy();
    expect(new Date(after.checked_at!).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(res.body.review.totals).toMatchObject({ items: 2, checked: 1 });
    const rows = await db.jobReviewCustomerDecision.findMany({ where: { organization_id: org } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entry_id: item.contact!.entry_id, event_id: item.latest_entry_id, choice: 'ADD', decided_by_id: me.id, applied: false, applied_at: null });
    // The same on the next read.
    expect(contactItems(await read(api, job.id))[0]!.checked).toBe(true);
  });

  it('records the default when the reviewer ticks without picking, and a pick when they picked', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    await changed(org, job.id, 'FIRST_NAME', 'Pat', 'Patricia', admin.id);
    await changed(org, job.id, 'PHONE', '5550001111', '5552223333', admin.id);
    const api = await me.api();
    const [name, phone] = contactItems(await read(api, job.id));
    await decide(api, job.id, name!, name!.contact!.default_choice!);
    await decide(api, job.id, phone!, 'UPDATE');
    const stored = await db.jobReviewCustomerDecision.findMany({ where: { organization_id: org }, orderBy: { choice: 'asc' } });
    expect(stored.map((r) => r.choice)).toEqual(['THIS_JOB_ONLY', 'UPDATE']);
  });

  it('keeps the item ticked with the new choice when the choice is changed after the tick', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    await changed(org, job.id, 'PHONE', '5550001111', '5552223333', admin.id);
    const api = await me.api();
    const item = contactItems(await read(api, job.id))[0]!;
    await decide(api, job.id, item, 'ADD');
    const res = await decide(api, job.id, item, 'THIS_JOB_ONLY');
    expect(res.status).toBe(200);
    expect(contactItems(res.body.review as Review)[0]).toMatchObject({ checked: true, contact: { decision: 'THIS_JOB_ONLY', choice: 'THIS_JOB_ONLY' } });
    const rows = await db.jobReviewCustomerDecision.findMany({ where: { organization_id: org } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.choice).toBe('THIS_JOB_ONLY');
  });

  it('un-checks the item when the PRD 5 entry is corrected, with no write, and the earlier pick stays shown', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const first = await added(org, job.id, 'PHONE', admin.id);
    const api = await me.api();
    const item = contactItems(await read(api, job.id))[0]!;
    await decide(api, job.id, item, 'THIS_JOB_ONLY');
    const before = await db.jobReviewCustomerDecision.findMany({ where: { organization_id: org } });

    await history(org, job.id, 'JOB_CONTACT_ENTRY_CORRECTED', { entry_id: (first.metadata as { entry_id: string }).entry_id, kind: 'PHONE', intent: 'ADDED', old: PHONE, new: { ...PHONE, value: '5551234568' } }, { by: admin.id });
    const after = await read(api, job.id);
    expect(contactItems(after)[0]).toMatchObject({ checked: false, checked_by: null, contact: { decision: 'THIS_JOB_ONLY', choice: 'THIS_JOB_ONLY' } });
    expect(after.totals.checked).toBe(0);
    expect(await db.jobReviewCustomerDecision.findMany({ where: { organization_id: org } })).toEqual(before);

    // Ticking again, against the corrected entry, checks it.
    const again = await decide(api, job.id, contactItems(after)[0]!, 'THIS_JOB_ONLY');
    expect(contactItems(again.body.review as Review)[0]!.checked).toBe(true);
    expect(await db.jobReviewCustomerDecision.count({ where: { organization_id: org } })).toBe(1);
  });

  it('ticks an entry removed before the review with no choice, and it applies nothing', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const gone = await added(org, job.id, 'EMAIL', admin.id);
    await history(org, job.id, 'JOB_CONTACT_ENTRY_REMOVED', { entry_id: (gone.metadata as { entry_id: string }).entry_id, kind: 'EMAIL', intent: 'ADDED', old: EMAIL, new: null, restored_customer_value: null }, { by: admin.id });
    const api = await me.api();
    const item = contactItems(await read(api, job.id))[0]!;
    expect(item.contact!.removed).toBe(true);

    expect((await decide(api, job.id, item, 'ADD')).status).toBe(400);
    const res = await decide(api, job.id, item);
    expect(res.status).toBe(200);
    expect(contactItems(res.body.review as Review)[0]!.checked).toBe(true);
    expect((await db.jobReviewCustomerDecision.findFirstOrThrow({ where: { organization_id: org } })).choice).toBe('NONE');
  });

  it('refuses a choice the change does not offer, and a missing choice where one is offered', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    await added(org, job.id, 'PHONE', admin.id);
    await changed(org, job.id, 'LAST_NAME', 'Old', 'Newer', admin.id);
    const api = await me.api();
    const [phone, name] = contactItems(await read(api, job.id));
    expect((await decide(api, job.id, phone!, 'UPDATE')).status).toBe(400); // nothing to replace
    expect((await decide(api, job.id, name!, 'ADD')).status).toBe(400); // the customer holds one value
    expect((await decide(api, job.id, phone!, 'SOMETHING')).status).toBe(400);
    expect((await decide(api, job.id, phone!)).status).toBe(400);
    expect(await db.jobReviewCustomerDecision.count({ where: { organization_id: org } })).toBe(0);
  });

  it('refuses a tick made against an entry that is no longer the latest, and stores nothing', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const first = await added(org, job.id, 'PHONE', admin.id);
    const api = await me.api();
    const seen = contactItems(await read(api, job.id))[0]!;
    await history(org, job.id, 'JOB_CONTACT_ENTRY_CORRECTED', { entry_id: (first.metadata as { entry_id: string }).entry_id, kind: 'PHONE', intent: 'ADDED', old: PHONE, new: { ...PHONE, value: '5551234568' } }, { by: admin.id });
    const res = await decide(api, job.id, seen, 'ADD');
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/changed/i);
    expect(await db.jobReviewCustomerDecision.count({ where: { organization_id: org } })).toBe(0);
  });

  it('refuses an item that is not a customer item, and one that is not in the review', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    const lineEntry = await history(org, job.id, 'JOB_LINE_CHANGED', { line_id: randomUUID(), old: { name: 'Spring', quantity: 1, unit_price: 100, line_total: 100 }, new: { name: 'Spring', quantity: 1, unit_price: 90, line_total: 90 } }, { by: admin.id });
    const api = await me.api();
    const lineItem = itemsOf(await read(api, job.id)).find((i) => i.kind === 'line')!;
    expect((await decide(api, job.id, lineItem, 'ADD')).status).toBe(400);
    const missing = await api.post(`/api/jobs/${job.id}/review/decisions`, { item_key: `contact:${randomUUID()}`, entry_id: lineEntry.id, choice: 'ADD' });
    expect(missing.status).toBe(404);
    expect(await db.jobReviewCustomerDecision.count({ where: { organization_id: org } })).toBe(0);
  });

  it('keeps the S06.10 check routes refusing a customer item, and Mark all checked skipping it', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    await added(org, job.id, 'PHONE', admin.id);
    const api = await me.api();
    const seen = await read(api, job.id);
    const item = contactItems(seen)[0]!;
    const one = await api.post(`/api/jobs/${job.id}/review/checks`, { item_key: item.key, entry_id: item.latest_entry_id });
    expect(one.status).toBe(400);
    expect(String(one.body.error)).toContain('Customer changes are confirmed one by one.');
    const all = await api.post(`/api/jobs/${job.id}/review/checks/all`, {
      items: [{ item_key: 'summary', entry_id: seen.summary.latest_entry_id }, { item_key: item.key, entry_id: item.latest_entry_id }],
    });
    expect(all.status).toBe(200);
    expect(contactItems(all.body.review as Review)[0]!.checked).toBe(false);
  });

  it('lets a custom role with Office review on and Edit customers off decide, and writes nothing to the customer or to PRD 5\'s entries', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true, edit_customers: false, view_customers: true });
    const job = await reviewJob(org, customer);
    const ev = await added(org, job.id, 'PHONE', admin.id);
    const entry = await db.recordContactEntry.create({
      data: { id: (ev.metadata as { entry_id: string }).entry_id, organization_id: org, job_id: job.id, kind: 'PHONE', intent: 'ADDED', value: PHONE.value },
    });
    const customerBefore = await db.customer.findUniqueOrThrow({ where: { id: customer }, include: { phones: true, extra_emails: true } });
    const historyBefore = await db.timelineEvent.count({ where: { organization_id: org, entity_type: 'CUSTOMER', entity_id: customer } });
    const jobHistoryBefore = await db.timelineEvent.count({ where: { organization_id: org, entity_type: 'JOB', entity_id: job.id } });
    const api = await me.api();
    const item = contactItems(await read(api, job.id))[0]!;
    const res = await decide(api, job.id, item, 'ADD');
    expect(res.status).toBe(200);
    expect(contactItems(res.body.review as Review)[0]!.checked).toBe(true);

    expect(await db.recordContactEntry.findUniqueOrThrow({ where: { id: entry.id } })).toEqual(entry);
    expect(await db.customer.findUniqueOrThrow({ where: { id: customer }, include: { phones: true, extra_emails: true } })).toEqual(customerBefore);
    expect(await db.timelineEvent.count({ where: { organization_id: org, entity_type: 'CUSTOMER', entity_id: customer } })).toBe(historyBefore);
    // Nothing is written to the job's history either, so the summary's check is not undone by a tick.
    expect(await db.timelineEvent.count({ where: { organization_id: org, entity_type: 'JOB', entity_id: job.id } })).toBe(jobHistoryBefore);
  });

  it('refuses a custom role with Office review off, whatever else it holds', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: false, view_customers: true, edit_customers: true, edit_jobs: true, complete_jobs: true, close_jobs: true });
    const job = await reviewJob(org, customer);
    const ev = await added(org, job.id, 'PHONE', admin.id);
    const res = await (await me.api()).post(`/api/jobs/${job.id}/review/decisions`, { item_key: `contact:${(ev.metadata as { entry_id: string }).entry_id}`, entry_id: ev.id, choice: 'ADD' });
    expect(res.status).toBe(403);
    expect(await db.jobReviewCustomerDecision.count({ where: { organization_id: org } })).toBe(0);
  });

  it('refuses a job the person cannot open under their jobs scope, and a job from another company', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    const scoped = await personWith(a.org, { ...OPENING, jobs_scope: 'attached', office_review: true });
    const jobA = await reviewJob(a.org, a.customer);
    const jobB = await reviewJob(b.org, b.customer);
    const evA = await added(a.org, jobA.id, 'PHONE');
    const evB = await added(b.org, jobB.id, 'PHONE');
    const api = await scoped.api();
    const body = (ev: { id: string; metadata: unknown }) => ({ item_key: `contact:${(ev.metadata as { entry_id: string }).entry_id}`, entry_id: ev.id, choice: 'ADD' });
    expect((await api.post(`/api/jobs/${jobA.id}/review/decisions`, body(evA))).status).toBe(403);
    expect((await api.post(`/api/jobs/${jobB.id}/review/decisions`, body(evB))).status).toBe(404);
    expect(await db.jobReviewCustomerDecision.count({ where: { organization_id: { in: [a.org, b.org] } } })).toBe(0);
  });

  it('refuses a decision on a job that is not in Office review, or has no open round', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const api = await me.api();
    const ready = await reviewJob(org, customer, { status: 'READY_TO_CLOSE' });
    const noRound = await reviewJob(org, customer, { round: false });
    for (const job of [ready, noRound]) {
      const ev = await added(org, job.id, 'PHONE');
      const res = await api.post(`/api/jobs/${job.id}/review/decisions`, { item_key: `contact:${(ev.metadata as { entry_id: string }).entry_id}`, entry_id: ev.id, choice: 'ADD' });
      expect(res.status).toBe(409);
    }
    expect(await db.jobReviewCustomerDecision.count({ where: { organization_id: org } })).toBe(0);
  });

  it('keeps a round\'s decisions apart: a second round starts with none', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { ...OPENING, office_review: true });
    const job = await reviewJob(org, customer);
    await added(org, job.id, 'PHONE', admin.id);
    const api = await me.api();
    await decide(api, job.id, contactItems(await read(api, job.id))[0]!, 'ADD');
    // A newer round on the same job: the earlier round's decision does not tick this round's item.
    await db.jobReview.create({ data: { organization_id: org, job_id: job.id, window_start: new Date(Date.now() - 3_700_000) } });
    expect(contactItems(await read(api, job.id))[0]).toMatchObject({ checked: false, contact: { decision: null } });
  });
});
