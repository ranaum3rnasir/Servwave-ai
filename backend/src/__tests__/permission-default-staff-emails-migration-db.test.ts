/* =============================================================================
   Roles & Permissions security fixes, M4 follow-up (ticket 35), migration M15: the two built-in staff emails stop carrying
   carry no total.

   "Estimate approved - notify creator" and "Estimate declined - notify creator" were seeded as "... estimate E-1 ({{estimate.total}})."
   A teammate without See prices has the total left empty, which read "... estimate E-1 ()." The shipped wording is now
   "... estimate E-1." and nothing more: Ran ruled (2026-10-28) that these two staff emails carry no total for anyone. Migration
   20261028150000 writes that into the copies companies already hold, only where the copy still equals the old shipped text.

   Proved on real rows, the way the deploy runs the file:
     - a company holding the shipped copies gets the new wording in its step and in a NEW published version (history is kept);
     - a company that edited its copies keeps every word; a copy edited only as a draft keeps the draft and still moves its
       published version; the other built-in automations are not touched;
     - a second run changes nothing, and nothing is written to the audit table;
     - the email a teammate receives, rendered by the real executor from the stored version: the same one sentence whether or not
       they hold See prices, with no total, no "()" and no label;
     - a company seeded after this change already holds the new wording and the migration leaves it alone.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Only the mail provider's client is faked.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient, resendSend } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined, resendSend: vi.fn() };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: resendSend };
    domains = { create: vi.fn(), get: vi.fn(), verify: vi.fn(), remove: vi.fn() };
  },
}));
vi.mock('../lib/email', async (importOriginal) => {
  const { env } = await import('../config/env.js');
  Object.assign(env, {
    RESEND_API_KEY: 're_test_key', MAILBOX_DOMAIN: 'staging.mail.test.com', EMAIL_FROM_BUSINESS: 'no-reply@mail.test.com',
    EMAIL_REPLY_DOMAIN: 'reply.test.com',
  });
  return importOriginal();
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { seedDefaultAutomationsForOrg } from '../services/automations/seedDefaultAutomations';
import { DEFAULT_AUTOMATIONS } from '../services/automations/defaultAutomations';
import { DEFAULT_MERGE_FIELD_FALLBACKS } from '../services/automations/mergeFieldFallbacks';

const suite = realClient ? describe : describe.skip;
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028150000_default_staff_emails_without_empty_brackets', 'migration.sql');
const KEYS = ['default-estimate-approved-notify-creator', 'default-estimate-declined-notify-creator'] as const;
// The text those two entries shipped with until this migration (a literal, never read from the registry).
const OLD: Record<(typeof KEYS)[number], string> = {
  'default-estimate-approved-notify-creator': '{{customer.full_name}} approved estimate {{estimate.number}} ({{estimate.total}}).',
  'default-estimate-declined-notify-creator': '{{customer.full_name}} declined estimate {{estimate.number}} ({{estimate.total}}).',
};
const NEW: Record<(typeof KEYS)[number], string> = {
  'default-estimate-approved-notify-creator': '{{customer.full_name}} approved estimate {{estimate.number}}.',
  'default-estimate-declined-notify-creator': '{{customer.full_name}} declined estimate {{estimate.number}}.',
};
const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const SEE_PRICES = keyOf('See prices');

suite('migration M15: the built-in staff estimate emails lose their empty brackets (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['workflow_step_runs', 'workflow_enrollments', 'workflow_versions', 'workflow_steps', 'workflows', 'emails', 'email_threads', 'reply_tokens', 'mailbox_addresses', 'mailboxes']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });
  beforeEach(() => {
    resendSend.mockReset();
    resendSend.mockImplementation(async () => ({ data: { id: `re_${randomUUID()}` }, error: null }));
  });
  const run = () => db.$executeRawUnsafe(readFileSync(MIGRATION_SQL, 'utf8'));

  /** What a company seeded BEFORE this change holds: the old text, with the fallback map as it stood (no estimate.total). */
  async function holdOldCopies(org: string) {
    const oldFallbacks = { ...DEFAULT_MERGE_FIELD_FALLBACKS };
    for (const key of KEYS) {
      const wf = await db.workflow.findFirstOrThrow({ where: { organization_id: org, builtin_key: key }, include: { steps: true, versions: true } });
      const config = { ...(wf.steps[0]!.config as Record<string, unknown>), body: OLD[key], fallbacks: oldFallbacks };
      await db.workflowStep.update({ where: { id: wf.steps[0]!.id }, data: { config: config as never } });
      const definition = wf.versions[0]!.definition as { steps: Array<{ config: Record<string, unknown> }> };
      definition.steps[0]!.config = config;
      await db.workflowVersion.update({ where: { id: wf.versions[0]!.id }, data: { definition: definition as never } });
    }
  }
  async function company() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    await seedDefaultAutomationsForOrg(made.org);
    return made;
  }
  const rows = async (org: string, key: string) => {
    const wf = await db.workflow.findFirstOrThrow({ where: { organization_id: org, builtin_key: key }, include: { steps: true, versions: { orderBy: { version: 'asc' } } } });
    const published = wf.versions.find((v) => v.id === wf.published_version_id)!;
    return {
      wf,
      step: wf.steps[0]!.config as { body: string; fallbacks?: Record<string, string> },
      versions: wf.versions,
      published: (published.definition as { steps: Array<{ config: { body: string; fallbacks?: Record<string, string> } }> }).steps[0]!.config,
    };
  };
  const snapshot = async (org: string) => JSON.stringify(await db.workflow.findMany({
    where: { organization_id: org }, orderBy: { builtin_key: 'asc' }, include: { steps: true, versions: { orderBy: { version: 'asc' } } },
  }));

  it('moves the shipped copies to the new wording in the step and in a new published version, keeps the old version, and touches nothing else', async () => {
    const w = await company();
    await holdOldCopies(w.org);
    const others = async () => JSON.stringify(await db.workflow.findMany({
      where: { organization_id: w.org, builtin_key: { notIn: [...KEYS] } }, orderBy: { builtin_key: 'asc' }, include: { steps: true, versions: true },
    }));
    const otherBefore = await others();
    const auditBefore = await db.auditLog.count({ where: { org_id: w.org } });

    await run();

    for (const key of KEYS) {
      const r = await rows(w.org, key);
      expect(r.step.body, key).toBe(NEW[key]);
      // No fallback is added, and the shared defaults the step already carried are kept as they were.
      expect(r.step.fallbacks).toEqual({ ...DEFAULT_MERGE_FIELD_FALLBACKS });
      expect(r.step.fallbacks).not.toHaveProperty('estimate.total');
      // The published version is a NEW one; version 1 keeps the text it was sent with.
      expect(r.versions.map((v) => v.version)).toEqual([1, 2]);
      expect(r.wf.published_version_id).toBe(r.versions[1]!.id);
      expect(r.published.body).toBe(NEW[key]);
      expect(r.published.fallbacks).toEqual({ ...DEFAULT_MERGE_FIELD_FALLBACKS });
      // The workflow reads as published just now, the way a publish leaves it.
      expect(r.wf.published_at!.getTime()).toBeGreaterThan(Date.now() - 600_000);
      expect((r.versions[0]!.definition as { steps: Array<{ config: { body: string } }> }).steps[0]!.config.body).toBe(OLD[key]);
    }
    expect(await others(), 'every other built-in automation is untouched').toBe(otherBefore);
    expect(await db.auditLog.count({ where: { org_id: w.org } }), 'nothing is written to the audit table').toBe(auditBefore);
  });

  it('keeps a company\'s edited copies word for word, and judges the draft step and the published version separately', async () => {
    const edited = await company();
    await holdOldCopies(edited.org);
    const draftOnly = await company();
    await holdOldCopies(draftOnly.org);
    // The first company changed both copies of the approved email (any change at all, even one character).
    const approved = await db.workflow.findFirstOrThrow({ where: { organization_id: edited.org, builtin_key: KEYS[0] }, include: { steps: true, versions: true } });
    const custom = `${OLD[KEYS[0]]} Thanks!`;
    for (const [id, table] of [[approved.steps[0]!.id, 'step'], [approved.versions[0]!.id, 'version']] as const) {
      if (table === 'step') {
        const cfg = approved.steps[0]!.config as Record<string, unknown>;
        await db.workflowStep.update({ where: { id }, data: { config: { ...cfg, body: custom } as never } });
      } else {
        const def = approved.versions[0]!.definition as { steps: Array<{ config: Record<string, unknown> }> };
        def.steps[0]!.config.body = custom;
        await db.workflowVersion.update({ where: { id }, data: { definition: def as never } });
      }
    }
    // The second company edited only the DRAFT step of the declined email; its published version is still the shipped text.
    const declined = await db.workflow.findFirstOrThrow({ where: { organization_id: draftOnly.org, builtin_key: KEYS[1] }, include: { steps: true } });
    await db.workflowStep.update({ where: { id: declined.steps[0]!.id }, data: { config: { ...(declined.steps[0]!.config as object), body: 'Heads up: {{customer.full_name}} declined {{estimate.number}}' } as never } });

    const approvedBefore = JSON.stringify(await rows(edited.org, KEYS[0]));
    await run();

    expect(JSON.stringify(await rows(edited.org, KEYS[0])), 'edited in both places: untouched').toBe(approvedBefore);
    expect((await rows(edited.org, KEYS[0])).versions).toHaveLength(1);
    // Its other (declined) automation, still the shipped text, moved as usual.
    expect((await rows(edited.org, KEYS[1])).step.body).toBe(NEW[KEYS[1]]);

    const d = await rows(draftOnly.org, KEYS[1]);
    expect(d.step.body, 'the draft the company wrote is kept').toBe('Heads up: {{customer.full_name}} declined {{estimate.number}}');
    expect(d.published.body, 'the published version, still the shipped text, moved').toBe(NEW[KEYS[1]]);
    expect(d.versions).toHaveLength(2);
  });

  // The read-only preview of the migration record (M15-default-staff-emails.md), word for word: how many copies each company holds,
  // and how many of them the migration would change.
  const PREVIEW = `
    WITH d(builtin_key, old_body) AS (VALUES
      ('default-estimate-approved-notify-creator', '{{customer.full_name}} approved estimate {{estimate.number}} ({{estimate.total}}).'),
      ('default-estimate-declined-notify-creator', '{{customer.full_name}} declined estimate {{estimate.number}} ({{estimate.total}}).'))
    SELECT o.id AS organization_id, d.builtin_key,
           count(*) AS copies_held,
           count(*) FILTER (WHERE s.config ->> 'body' = d.old_body) AS steps_to_change,
           count(*) FILTER (WHERE pv.definition #>> '{steps,0,config,body}' = d.old_body) AS published_versions_to_change
      FROM workflows w
      JOIN d ON d.builtin_key = w.builtin_key
      JOIN organizations o ON o.id = w.organization_id
      LEFT JOIN workflow_steps s ON s.workflow_id = w.id AND s.position = 0
      LEFT JOIN workflow_versions pv ON pv.id = w.published_version_id
     GROUP BY o.id, d.builtin_key
     ORDER BY o.id, d.builtin_key`;

  it('the preview in the migration record counts what the migration changes, per company, and reads zero after it', async () => {
    const old = await company();
    await holdOldCopies(old.org);
    const approved = await db.workflow.findFirstOrThrow({ where: { organization_id: old.org, builtin_key: KEYS[0] }, include: { steps: true } });
    await db.workflowStep.update({ where: { id: approved.steps[0]!.id }, data: { config: { ...(approved.steps[0]!.config as object), body: 'Edited by the company' } as never } });
    type Row = { organization_id: string; builtin_key: string; copies_held: bigint; steps_to_change: bigint; published_versions_to_change: bigint };
    const mine = async () => (await db.$queryRawUnsafe<Row[]>(PREVIEW)).filter((r) => r.organization_id === old.org)
      .map((r) => `${r.builtin_key}:${r.copies_held}:${r.steps_to_change}:${r.published_versions_to_change}`);
    expect(await mine()).toEqual([`${KEYS[0]}:1:0:1`, `${KEYS[1]}:1:1:1`]);
    await run();
    expect(await mine()).toEqual([`${KEYS[0]}:1:0:0`, `${KEYS[1]}:1:0:0`]);
  });

  it('a second run changes nothing, and a company seeded after this change already holds the new wording and is left alone', async () => {
    const old = await company();
    await holdOldCopies(old.org);
    const fresh = await company(); // seeded from the registry as it is now
    for (const key of KEYS) {
      const r = await rows(fresh.org, key);
      expect(r.step.body).toBe(NEW[key]);
      expect(r.step.fallbacks).not.toHaveProperty('estimate.total');
      expect(r.versions).toHaveLength(1);
    }
    expect(DEFAULT_AUTOMATIONS.find((d) => d.builtin_key === KEYS[0])!.body).toBe(NEW[KEYS[0]]);

    await run();
    const afterFirst = [await snapshot(old.org), await snapshot(fresh.org)];
    expect((await rows(fresh.org, KEYS[0])).versions, 'the fresh company got no new version').toHaveLength(1);
    await run();
    expect([await snapshot(old.org), await snapshot(fresh.org)]).toEqual(afterFirst);
  });

  describe('the email a teammate receives, from the stored version, after the migration', () => {
    async function teammate(org: string, seesPrices: boolean): Promise<Person> {
      const key = `m15-role-${randomUUID().slice(0, 6)}`;
      const role = await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
      const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false])) as Record<string, SwitchValue>;
      await setRoleSwitchValues({ organizationId: org, roleKey: key, actorId: null, reason: 'manual', values: { ...allOff, view_estimates: true, [SEE_PRICES]: seesPrices } });
      return fx.addUser(org, `m15${randomUUID().slice(0, 5)}`, 'TECHNICIAN', { customRoleId: role.id });
    }
    async function mailed(org: string, customer: string, key: (typeof KEYS)[number], seesPrices: boolean) {
      const creator = await teammate(org, seesPrices);
      const part = `co${org.slice(0, 6)}`;
      await db.organization.update({ where: { id: org }, data: { email_sending_enabled: true, email_sender_local_part: part } });
      const main = await db.mailbox.create({ data: { organization_id: org, kind: 'main', status: 'active' }, select: { id: true } });
      await db.mailboxAddress.create({ data: { local_part: part, organization_id: org, mailbox_id: main.id, is_primary: true } });
      const est = await fx.addEstimate(org, customer, creator.id);
      await db.estimate.update({ where: { id: est.id }, data: { total_amount: 100 } });
      const number = (await db.estimate.findUniqueOrThrow({ where: { id: est.id } })).estimate_number;
      const { published } = await rows(org, key);
      const { loadExecutionBundle } = await import('../services/automations/context.js');
      const { executeAction } = await import('../services/automations/executors.js');
      const loaded = await loadExecutionBundle({ entityType: 'estimate', entityId: est.id, organizationId: org, dedupeKey: `m15:${randomUUID()}` });
      const def = DEFAULT_AUTOMATIONS.find((d) => d.builtin_key === key)!;
      const res = await executeAction(
        { id: randomUUID(), name: def.name, action_type: 'SEND_EMAIL', action_config: { ...published, recipients: ['creator'], subject: def.subject }, organization_id: org } as never,
        loaded!.bundle,
      );
      expect(res.status).toBe('SENT');
      const sent = resendSend.mock.calls.map((c) => c[0] as { to: string; text: string; html: string }).find((m) => m.to === creator.email)!;
      return { sent, number };
    }

    // Ran, 2026-10-28: these two staff emails carry NO total for anyone, so the text is the same whatever the reader holds.
    it.each([[KEYS[0], 'approved', false], [KEYS[0], 'approved', true], [KEYS[1], 'declined', false], [KEYS[1], 'declined', true]] as const)(
      '%s (%s) reads one complete sentence with no total, no brackets and no dangling label, whether or not the reader sees prices (%s)',
      async (key, word, seesPrices) => {
        const w = await company();
        await holdOldCopies(w.org);
        await run();
        const { sent, number } = await mailed(w.org, w.customer, key, seesPrices);
        expect(sent.text).toBe(`Pat Payer ${word} estimate ${number}.`);
        for (const part of [sent.text, sent.html]) {
          expect(part).not.toContain('()');
          expect(part).not.toMatch(/\$\s*\d/);
          expect(part).not.toMatch(/Total:/i);
        }
      },
    );

    it('before the migration the same copy reads "()" for a teammate without See prices (what this fixes)', async () => {
      const w = await company();
      await holdOldCopies(w.org);
      const { sent } = await mailed(w.org, w.customer, KEYS[0], false);
      expect(sent.text).toContain('()');
    });
  });
});
