/* =============================================================================
   #3468: every way a lead is written keeps its watch row right, in the same statement.

   The watch list is kept by triggers on leads, not by the app, because the ten columns Spider's stage rules read are
   written from many files (a status change, a contact, a walkthrough booked or completed, an estimate sent, Won, Lost,
   a reopen, imports, scripts). So the ways in are the ways a row of `leads` can be written at all, and this table runs
   each of them: a single create, a bulk create, a single update, a bulk update, an upsert (both branches), raw SQL
   (UPDATE, and INSERT ... SELECT), and the deletes. After each, the lead's watch row must say exactly what
   `spiderStageOf` says about the lead as it now is (deleted: no row).

   And the row's two bookkeeping columns follow the rule: a new stage or a new entry instant sets pending = true and
   changed_at = now (UTC); any other save leaves the row exactly as it was.

   As the database's own superuser (no row-level security; the tenant guard is spider-lead-watch-rls-db.test.ts).
   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient, type Prisma } from '@prisma/client';
import { spiderStageOf, SPIDER_LEAD_TIMES_SELECT } from '../services/spider/config';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

interface WatchRow {
  organization_id: string;
  stage: string | null;
  entered_at: string | null;
  pending: boolean;
  changed_at: string;
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

suite('Spider watch list: every way a lead is written (real database)', () => {
  const db = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];

  afterAll(async () => {
    await db.lead.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.customer.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  async function company() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-watch-${tag}`, email: `org-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', is_demo: true,
      },
    });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    return { org, customer };
  }
  type Company = Awaited<ReturnType<typeof company>>;

  const leadData = (c: Company, extra: Partial<Prisma.LeadUncheckedCreateInput> = {}): Prisma.LeadUncheckedCreateInput => {
    const id = randomUUID();
    return { id, organization_id: c.org, customer_id: c.customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door', created_at: ago(48), ...extra };
  };
  const newLead = async (c: Company, extra: Partial<Prisma.LeadUncheckedCreateInput> = {}) => (await db.lead.create({ data: leadData(c, extra) })).id;

  async function watchOf(leadId: string): Promise<WatchRow | undefined> {
    const [row] = await db.$queryRawUnsafe<WatchRow[]>(
      `SELECT organization_id::text, stage, to_char(entered_at, ${ISO}) AS entered_at, pending, to_char(changed_at, ${ISO}) AS changed_at
         FROM spider_lead_watch WHERE lead_id = $1::uuid`, leadId);
    return row;
  }

  /** What Spider's own rules say about the lead as it is now. */
  async function expected(leadId: string) {
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { ...SPIDER_LEAD_TIMES_SELECT, organization_id: true } });
    const s = spiderStageOf(lead);
    return { organization_id: lead.organization_id, stage: s?.stage ?? null, entered_at: s?.enteredAt.toISOString() ?? null };
  }

  async function expectRowMatchesLead(leadId: string) {
    const row = await watchOf(leadId);
    expect(row, `lead ${leadId} has no watch row`).toBeDefined();
    expect({ organization_id: row!.organization_id, stage: row!.stage, entered_at: row!.entered_at }).toEqual(await expected(leadId));
  }

  /** Marks a row as claimed long ago, so a test can see whether a save touched it. */
  const claimLongAgo = (leadId: string) =>
    db.$executeRawUnsafe(`UPDATE spider_lead_watch SET pending = false, changed_at = '2000-01-01 00:00:00' WHERE lead_id = $1::uuid`, leadId);

  // ── Every way in ──────────────────────────────────────────────────────────────────────────────────────────────────

  const WAYS_IN: { way: string; write: (c: Company) => Promise<{ kept: string[]; gone?: string[] }> }[] = [
    {
      way: 'a single create (Prisma create)',
      write: async (c) => ({ kept: [await newLead(c)] }),
    },
    {
      way: 'a bulk create (Prisma createMany)',
      write: async (c) => {
        const rows = [leadData(c), leadData(c, { status: 'CONTACTED', contacted_at: ago(3) }), leadData(c, { status: 'WON', won_at: ago(1) })];
        await db.lead.createMany({ data: rows });
        return { kept: rows.map((r) => r.id!) };
      },
    },
    {
      way: 'a single update (Prisma update): New to Contacted by a contact',
      write: async (c) => {
        const id = await newLead(c);
        await db.lead.update({ where: { id }, data: { contacted_at: ago(2) } });
        return { kept: [id] };
      },
    },
    {
      way: 'a bulk update (Prisma updateMany): several leads won at once',
      write: async (c) => {
        const ids = [await newLead(c), await newLead(c, { status: 'CONTACTED' })];
        await db.lead.updateMany({ where: { id: { in: ids } }, data: { status: 'WON', won_at: ago(1) } });
        return { kept: ids };
      },
    },
    {
      way: 'an upsert, both branches (Prisma upsert)',
      write: async (c) => {
        const existing = await newLead(c);
        await db.lead.upsert({ where: { id: existing }, create: leadData(c), update: { last_visit_completed_at: ago(5), walkthrough_first_booked_at: ago(9), status: 'WALKTHROUGH_COMPLETED' } });
        const created = leadData(c, { returned_to_new_at: ago(4) });
        await db.lead.upsert({ where: { id: created.id! }, create: created, update: {} });
        return { kept: [existing, created.id!] };
      },
    },
    {
      way: 'raw SQL UPDATE: Lost',
      write: async (c) => {
        const id = await newLead(c);
        await db.$executeRawUnsafe(`UPDATE leads SET status = 'LOST', lost_at = now() WHERE id = $1::uuid`, id);
        return { kept: [id] };
      },
    },
    {
      way: 'raw SQL INSERT ... SELECT: an imported lead, past Estimate',
      write: async (c) => {
        const id = randomUUID();
        await db.$executeRawUnsafe(
          `INSERT INTO leads (id, organization_id, customer_id, lead_number, service_request, status, first_estimate_sent_at, updated_at)
           SELECT $1::uuid, $2::uuid, $3::uuid, $4, 'Imported', 'ESTIMATED', now(), now()`,
          id, c.org, c.customer, `L-${id.slice(0, 8)}`);
        return { kept: [id] };
      },
    },
    {
      way: 'a cancelled lead (the old Cancelled close, written by raw SQL as only scripts still can)',
      write: async (c) => {
        const id = await newLead(c, { contacted_at: ago(6) });
        await db.$executeRawUnsafe(`UPDATE leads SET cancelled_at = now() WHERE id = $1::uuid`, id);
        return { kept: [id] };
      },
    },
    {
      way: 'a single delete and a bulk delete (Prisma delete, deleteMany)',
      write: async (c) => {
        const one = await newLead(c);
        const many = [await newLead(c), await newLead(c, { contacted_at: ago(1) })];
        await db.lead.delete({ where: { id: one } });
        await db.lead.deleteMany({ where: { id: { in: many } } });
        return { kept: [], gone: [one, ...many] };
      },
    },
  ];

  it.each(WAYS_IN)('$way: the watch row says what spiderStageOf says, in the same statement', async ({ write }) => {
    const c = await company();
    const { kept, gone = [] } = await write(c);
    for (const id of kept) await expectRowMatchesLead(id);
    for (const id of gone) expect(await watchOf(id), `deleted lead ${id} still has a watch row`).toBeUndefined();
  });

  it('the table above reaches every stage and the closed state (so a match there means something)', async () => {
    const c = await company();
    const ids = [
      await newLead(c),
      await newLead(c, { contacted_at: ago(2) }),
      await newLead(c, { status: 'WALKTHROUGH_COMPLETED', walkthrough_first_booked_at: ago(9), last_visit_completed_at: ago(5) }),
      await newLead(c, { status: 'LOST', lost_at: ago(1) }),
    ];
    const stages = await Promise.all(ids.map(async (id) => (await watchOf(id))!.stage));
    expect(stages).toEqual(['NEW', 'CONTACTED', 'WALKTHROUGH_COMPLETED', null]);
  });

  // ── pending and changed_at ────────────────────────────────────────────────────────────────────────────────────────

  it('a new lead is pending from its creation, stamped with the current UTC time', async () => {
    const c = await company();
    const id = await newLead(c);
    const row = (await watchOf(id))!;
    expect(row.pending).toBe(true);
    expect(row.stage).toBe('NEW');
    expect(Math.abs(Date.parse(row.changed_at) - Date.now())).toBeLessThan(60_000);
  });

  it('a new stage is a new stay: pending again, changed_at now', async () => {
    const c = await company();
    const id = await newLead(c);
    await claimLongAgo(id);
    await db.lead.update({ where: { id }, data: { status: 'CONTACTED' } });
    const row = (await watchOf(id))!;
    expect(row.stage).toBe('CONTACTED');
    expect(row.pending).toBe(true);
    expect(Math.abs(Date.parse(row.changed_at) - Date.now())).toBeLessThan(60_000);
  });

  it('a new entry instant in the same stage is a new stay too (a lead moved back to New)', async () => {
    const c = await company();
    const id = await newLead(c);
    await claimLongAgo(id);
    const back = ago(1);
    await db.lead.update({ where: { id }, data: { returned_to_new_at: back } });
    const row = (await watchOf(id))!;
    expect(row.stage).toBe('NEW');
    expect(row.entered_at).toBe(back.toISOString());
    expect(row.pending).toBe(true);
    expect(row.changed_at).not.toBe('2000-01-01T00:00:00.000Z');
  });

  it('a closed lead leaves every stage: no stage, no entry instant', async () => {
    const c = await company();
    for (const close of [{ status: 'WON', won_at: ago(1) }, { status: 'LOST', lost_at: ago(1) }, { cancelled_at: ago(1) }] as const) {
      const id = await newLead(c, { contacted_at: ago(3) });
      await claimLongAgo(id);
      await db.lead.update({ where: { id }, data: close });
      expect(await watchOf(id)).toMatchObject({ stage: null, entered_at: null, pending: true });
    }
  });

  it('a save of one of the ten columns that changes neither the stage nor its entry instant leaves the row as it was', async () => {
    const c = await company();
    // New with a contact: Contacted from the contact. Moving its status to Contacted keeps both.
    const contacted = await newLead(c, { contacted_at: ago(3) });
    // Won, then also marked lost: still in no stage.
    const won = await newLead(c, { status: 'WON', won_at: ago(2) });
    for (const id of [contacted, won]) await claimLongAgo(id);
    const before = { contacted: await watchOf(contacted), won: await watchOf(won) };

    await db.lead.update({ where: { id: contacted }, data: { status: 'CONTACTED' } });
    await db.lead.update({ where: { id: won }, data: { lost_at: ago(1) } });

    expect(await watchOf(contacted)).toEqual(before.contacted);
    expect(await watchOf(won)).toEqual(before.won);
    expect(before.contacted).toMatchObject({ stage: 'CONTACTED', pending: false, changed_at: '2000-01-01T00:00:00.000Z' });
  });

  it('a save that touches none of the ten columns leaves the row as it was', async () => {
    const c = await company();
    const id = await newLead(c);
    await claimLongAgo(id);
    const before = await watchOf(id);
    await db.lead.update({ where: { id }, data: { service_request: 'Fix the gate', job_type: 'Repair', source: 'Phone' } });
    expect(await watchOf(id)).toEqual(before);
  });
});
