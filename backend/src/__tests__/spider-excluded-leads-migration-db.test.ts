/* =============================================================================
   #3434: the exclusion-list migration, run for real.

   spider_settings.excluded_lead_ids is filled from the old selection, so each company keeps watching exactly the open
   leads it watched before:
     - "Auto-select new leads" on (watch_all_leads true): empty, whatever selected_lead_ids holds;
     - a selected list: the company's OPEN leads that are not selected. Won, Lost and cancelled leads are never in it,
       and neither is another company's lead;
     - an empty selected list with "Auto-select new leads" off: every open lead;
     - the old columns are kept unchanged, and a second run changes nothing.

   Runs the migration's own SQL file against the database TEST_DATABASE_URL points at, on rows of its own companies.
   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION_SQL = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '20261110090000_spider_excluded_lead_ids', 'migration.sql'),
  'utf8',
);

/** The file's statements, comments stripped (Prisma runs them one by one too). */
const STATEMENTS = MIGRATION_SQL.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

suite('Spider exclusion-list migration (real database)', () => {
  // Built only when the suite runs: the skipped suite must not need a database URL.
  const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);
  const orgs: string[] = [];

  afterAll(async () => {
    await db.lead.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.customer.deleteMany({ where: { organization_id: { in: orgs } } });
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  /** A company with one customer and these leads: { name: open | won | lost | cancelled }. */
  async function companyWith(leads: Record<string, 'open' | 'won' | 'lost' | 'cancelled'>) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-excl-${tag}`, email: `org-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', is_demo: true,
      },
    });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const ids: Record<string, string> = {};
    const now = new Date();
    for (const [name, state] of Object.entries(leads)) {
      const id = randomUUID();
      ids[name] = id;
      await db.lead.create({
        data: {
          id, organization_id: org, customer_id: customer, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door',
          status: state === 'won' ? 'WON' : state === 'lost' ? 'LOST' : 'NEW',
          won_at: state === 'won' ? now : null,
          lost_at: state === 'lost' ? now : null,
          cancelled_at: state === 'cancelled' ? now : null,
        },
      });
    }
    return { org, ids };
  }

  /** The old shape, as rows stored before this migration hold it (the new column at its default). */
  const oldShape = (organization_id: string, watch_all_leads: boolean, selected_lead_ids: string[]) =>
    db.spiderSettings.create({
      data: {
        organization_id, is_active: true, activated_at: new Date('2026-11-01T12:00:00.000Z'),
        status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' } },
        channels: { in_app: true, red_frame: true, email: false, text: false },
        recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
        watch_all_leads, selected_lead_ids,
      },
    });

  const run = async () => {
    for (const statement of STATEMENTS) await db.$executeRawUnsafe(statement);
  };
  const reread = (organization_id: string) => db.spiderSettings.findUniqueOrThrow({ where: { organization_id } });
  const sorted = (ids: (string | undefined)[]) => [...ids].sort();

  it('fills both old shapes, leaves the old columns alone, and a second run changes nothing', async () => {
    const leads = { a: 'open', b: 'open', c: 'open', won: 'won', lost: 'lost', cancelled: 'cancelled' } as const;
    const watchAll = await companyWith(leads);
    const selected = await companyWith(leads);
    const noneSelected = await companyWith(leads);
    const neighbour = await companyWith({ x: 'open' });
    await oldShape(watchAll.org, true, [watchAll.ids.a!]);
    await oldShape(selected.org, false, [selected.ids.a!, selected.ids.won!]);
    await oldShape(noneSelected.org, false, []);
    const before = await reread(selected.org);

    await run();

    expect((await reread(watchAll.org)).excluded_lead_ids).toEqual([]);
    expect(sorted((await reread(selected.org)).excluded_lead_ids)).toEqual(sorted([selected.ids.b, selected.ids.c]));
    expect(sorted((await reread(noneSelected.org)).excluded_lead_ids)).toEqual(sorted([noneSelected.ids.a, noneSelected.ids.b, noneSelected.ids.c]));
    // Another company's open lead never lands in a list.
    for (const org of [watchAll.org, selected.org, noneSelected.org]) {
      expect((await reread(org)).excluded_lead_ids).not.toContain(neighbour.ids.x);
    }
    // The old columns are kept as they were.
    const after = await reread(selected.org);
    expect({ w: after.watch_all_leads, s: after.selected_lead_ids }).toEqual({ w: before.watch_all_leads, s: before.selected_lead_ids });

    // Idempotent: the second run finds the same lists.
    const once = await Promise.all([watchAll.org, selected.org, noneSelected.org].map(reread));
    await run();
    expect(await Promise.all([watchAll.org, selected.org, noneSelected.org].map(reread))).toEqual(once);
  });

  it('never touches a row that already holds an exclusion list', async () => {
    const co = await companyWith({ a: 'open', b: 'open' });
    await oldShape(co.org, false, []);
    await db.spiderSettings.update({ where: { organization_id: co.org }, data: { excluded_lead_ids: [co.ids.a!] } });
    await run();
    expect((await reread(co.org)).excluded_lead_ids).toEqual([co.ids.a]);
  });
});
