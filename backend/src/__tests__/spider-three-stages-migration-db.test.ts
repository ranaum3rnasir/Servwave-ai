/* =============================================================================
   Spider: the three-stages migration (Ran, 15 Oct, D2), run for real.

   Walkthrough Scheduled and Estimate Sent are no longer watched, so the migration removes their
   stored limits from every company's spider_settings.status_limits and changes nothing else:
     - the two retired keys go, the three stages keep their limits exactly;
     - every other column of the row is untouched;
     - a row without either key, and a row whose limits are empty, are untouched;
     - a second run changes nothing.

   Runs the migration's own SQL file against the database TEST_DATABASE_URL points at, on rows of
   its own companies. Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION_SQL = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '20261015100000_spider_three_stages', 'migration.sql'),
  'utf8',
);

suite('Spider three-stages migration (real database)', () => {
  // Built only when the suite runs: the skipped suite must not need a database URL.
  const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);
  const orgs: string[] = [];

  afterAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: orgs } } });
    await db.$disconnect();
  });

  async function settingsRow(statusLimits: object) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-mig-${tag}`, email: `org-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', is_demo: true,
      },
    });
    return db.spiderSettings.create({
      data: {
        organization_id: org, is_active: true, activated_at: new Date('2026-10-01T12:00:00.000Z'),
        status_limits: statusLimits,
        channels: { in_app: true, red_frame: false, email: true, text: false },
        recipients: { roles: ['SALES'], user_ids: [], lead_owner: true },
        watch_all_leads: false,
      },
    });
  }

  const run = async () => {
    // The file is one statement plus comments.
    await db.$executeRawUnsafe(MIGRATION_SQL);
  };
  const reread = (organization_id: string) => db.spiderSettings.findUniqueOrThrow({ where: { organization_id } });

  it('drops the two retired limits, keeps the three stages and the rest of the row, and a second run changes nothing', async () => {
    const kept = {
      NEW: { enabled: true, value: 2, unit: 'HOUR' },
      CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
      WALKTHROUGH_COMPLETED: { enabled: true, value: 3, unit: 'DAY' },
    };
    const five = await settingsRow({
      ...kept,
      WALKTHROUGH_SCHEDULED: { enabled: true, value: 1, unit: 'DAY' },
      ESTIMATED: { enabled: true, value: 5, unit: 'DAY' },
    });
    const three = await settingsRow(kept);
    const empty = await settingsRow({});
    const threeBefore = await reread(three.organization_id);
    const emptyBefore = await reread(empty.organization_id);

    await run();

    const after = await reread(five.organization_id);
    expect(after.status_limits).toEqual(kept);
    const { status_limits: _a, updated_at: _b, ...rest } = after;
    const { status_limits: _c, updated_at: _d, ...restBefore } = five;
    expect(rest).toEqual(restBefore);
    expect(await reread(three.organization_id)).toEqual(threeBefore);
    expect(await reread(empty.organization_id)).toEqual(emptyBefore);

    // Idempotent: the second run finds nothing to change.
    const once = await reread(five.organization_id);
    await run();
    expect(await reread(five.organization_id)).toEqual(once);
  });
});
