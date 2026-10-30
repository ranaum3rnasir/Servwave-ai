/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.3 (fix round) - the dry run and the proof check evaluate the migration's own
   hard-stop conditions. No database here: the real-database cases (the migration applied to fixtures built to trip
   each condition, and the dry run's prediction compared with what happened) are in
   __tests__/user-mailboxes-migration-db.test.ts. What this file pins:
     - the migration file raises exactly the errors the report knows how to predict, so a stop condition added to
       the file without a matching check in the report fails here (the file itself is frozen once applied);
     - what the printed report says: PASS or FAIL per condition, ids only, an exit code a release script can read,
       and a plain "already applied" answer.
   Expected texts are written out by hand from the migration file, never produced by the code under test.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  dryRunExitCode, formatDryRunReport, formatProofReport, stopConditionMessage, userMailboxMigrationSql,
  type DryRunReport, type ProofReport, type StopCondition,
} from '../user-mailbox-report';

const ORG = '11111111-1111-4111-8111-111111111111';
const BOX = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

const pass = (key: StopCondition['key']): StopCondition => ({
  key, rule: `rule of ${key}`, count: 0, pass: true, message: stopConditionMessage(key, 0), mailbox_ids: [], user_ids: [], company_ids: [],
});

function dryRun(over: Partial<DryRunReport> = {}): DryRunReport {
  return {
    ledger: 'not_recorded',
    alreadyApplied: false,
    companies: 1,
    existing: [],
    perCompany: [{ organization_id: ORG, users: 2, issue: 2, address_needed: 0, by_reason: { namesake: 0, taken: 0, no_name: 0, no_company_part: 0 } }],
    totals: { users: 2, issue: 2, address_needed: 0, by_reason: { namesake: 0, taken: 0, no_name: 0, no_company_part: 0 }, namesake_groups: 0 },
    namesakes: [],
    stopConditions: [pass('one_live_mailbox_per_user'), pass('every_active_user_has_a_mailbox'), pass('every_active_mailbox_has_a_primary_address')],
    ...over,
  };
}

describe('the stop conditions the migration raises', () => {
  it('are exactly the ones the report predicts, with the same words', () => {
    const raised = [...userMailboxMigrationSql().matchAll(/RAISE EXCEPTION '([^']*)'/g)].map((m) => m[1]);
    expect(raised).toEqual([
      'S10.3: % active users are left without a mailbox',
      'S10.3: % active user mailboxes are left without a primary address',
    ]);
    expect(stopConditionMessage('every_active_user_has_a_mailbox', 3)).toBe('S10.3: 3 active users are left without a mailbox');
    expect(stopConditionMessage('every_active_mailbox_has_a_primary_address', 1)).toBe(
      'S10.3: 1 active user mailboxes are left without a primary address',
    );
  });

  it('include the unique index the migration builds, which stops it when a user already has two live mailboxes', () => {
    expect(userMailboxMigrationSql()).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "mailboxes_one_live_per_user"');
    expect(stopConditionMessage('one_live_mailbox_per_user', 2)).toBe('could not create unique index "mailboxes_one_live_per_user"');
  });
});

describe('the dry run as printed', () => {
  it('shows PASS for every condition when nothing would stop the migration, and exits 0', () => {
    const report = dryRun();
    const text = formatDryRunReport(report).join('\n');
    expect(text.match(/^ {2}PASS /gm)).toHaveLength(3);
    expect(text).not.toContain('FAIL');
    expect(dryRunExitCode(report)).toBe(0);
  });

  it('shows FAIL with the count, the message the migration would stop with and the ids, and exits non-zero', () => {
    const failing: StopCondition = {
      key: 'every_active_mailbox_has_a_primary_address', rule: 'rule', count: 1, pass: false,
      message: 'S10.3: 1 active user mailboxes are left without a primary address',
      mailbox_ids: [BOX], user_ids: [USER], company_ids: [ORG],
    };
    const report = dryRun({ stopConditions: [pass('one_live_mailbox_per_user'), pass('every_active_user_has_a_mailbox'), failing] });
    const text = formatDryRunReport(report).join('\n');
    expect(text).toContain('FAIL');
    expect(text).toContain('S10.3: 1 active user mailboxes are left without a primary address');
    expect(text).toContain(BOX);
    expect(text).toContain(USER);
    expect(text).toContain(ORG);
    expect(dryRunExitCode(report)).toBe(1);
  });

  it('lists at most 50 ids of a kind in the text, and says how many more there are', () => {
    const many = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const failing: StopCondition = {
      key: 'every_active_mailbox_has_a_primary_address', rule: 'rule', count: 60, pass: false,
      message: stopConditionMessage('every_active_mailbox_has_a_primary_address', 60), mailbox_ids: many, user_ids: [], company_ids: [ORG],
    };
    const text = formatDryRunReport(dryRun({ stopConditions: [failing] })).join('\n');
    expect(text).toContain(many[49]!);
    expect(text).not.toContain(many[50]!);
    expect(text).toContain('and 10 more');
  });

  it('reports the mailboxes that already exist by state, per company', () => {
    const report = dryRun({
      existing: [{ organization_id: ORG, active_with_address: 4, active_without_address: 1, address_needed: 2, merged: 3 }],
    });
    const text = formatDryRunReport(report).join('\n');
    expect(text).toContain(`${ORG}: 4 active with an address, 1 active WITHOUT an address, 2 address needed, 3 merged`);
  });

  it('says plainly that it is already applied and prints no plan', () => {
    const report = dryRun({ ledger: 'applied', alreadyApplied: true, companies: 0, perCompany: [], stopConditions: [] });
    const lines = formatDryRunReport(report);
    expect(lines.join('\n')).toContain('already applied: nothing to do');
    expect(lines.join('\n')).not.toContain('mailboxes to issue');
    expect(dryRunExitCode(report)).toBe(0);
  });
});

describe('the proof as printed', () => {
  const proof = (over: Partial<ProofReport> = {}): ProofReport => ({
    perCompany: [], totals: { mailboxes: 0, active: 0, address_needed: 0 }, usersWithoutMailbox: 0, doubleMailboxes: 0, badAddresses: 0,
    sharedAddresses: 0, differences: [], stopConditions: [pass('every_active_user_has_a_mailbox'), pass('every_active_mailbox_has_a_primary_address')],
    ok: true, ...over,
  });

  it('prints each stop condition checked on the written state', () => {
    const text = formatProofReport(proof(), false).join('\n');
    expect(text.match(/^ {2}PASS /gm)).toHaveLength(2);
    expect(text.trim().endsWith('OK')).toBe(true);
  });

  it('prints FAIL with the ids when a condition is broken', () => {
    const failing: StopCondition = {
      key: 'every_active_user_has_a_mailbox', rule: 'rule', count: 1, pass: false,
      message: 'S10.3: 1 active users are left without a mailbox', mailbox_ids: [], user_ids: [USER], company_ids: [ORG],
    };
    const text = formatProofReport(proof({ stopConditions: [failing], usersWithoutMailbox: 1, ok: false }), false).join('\n');
    expect(text).toContain('FAIL');
    expect(text).toContain(USER);
    expect(text.trim().endsWith('NOT OK')).toBe(true);
  });
});
