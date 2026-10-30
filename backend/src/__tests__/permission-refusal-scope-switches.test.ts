/* =============================================================================
   Pre-PR review CR-11 (AL-11, P18): a record found out of reach is logged as `access.hidden` naming the scope switch that
   would have opened it, so an Admin reading the log is pointed at the right switch.

   The table names every kind of record a row check can refuse, read from the source (the ScopeResource kinds the row checks
   take, and every kind outOfReachIsMissing.ts notes), so a new kind that is not decided here fails. The expected switches are
   the catalog's own scope switches, written out by hand.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { scopeSwitchesFor } from '../lib/permissions/refusalNote';
import { findSwitch } from '../lib/permissions/switches/catalog';

const EXPECTED: Record<string, string[]> = {
  Job: ['jobs_scope'],
  Lead: ['leads_scope'],
  // An estimate or an invoice follows its lead or job (P6); a customer comes with its leads and jobs.
  Estimate: ['jobs_scope', 'leads_scope'],
  Invoice: ['jobs_scope', 'leads_scope'],
  Customer: ['jobs_scope', 'leads_scope'],
  LogisticOrder: ['jobs_scope', 'leads_scope'],
  // A purchase order is reached through its job (orderOnJobReach).
  PurchaseOrder: ['jobs_scope'],
  Task: ['tasks_scope'],
  CalendarEntry: ['events_scope'],
  Asset: ['assets_scope'],
  Timesheet: ['timesheets_scope'],
};

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

/** Every kind a row check can be asked about or a reach probe notes, read from the source. */
function kindsInSource(): string[] {
  const scopeResource = /export type ScopeResource = ([^;]+);/.exec(src('lib/permissions/scopeWhereFor.ts'))![1]!;
  const reachSubject = /export type ReachSubject = ([^;]+);/.exec(src('lib/permissions/moduleReach.ts'))![1]!;
  const noted = [...src('lib/permissions/outOfReachIsMissing.ts').matchAll(/noteRowRefusal\(req, '([A-Za-z]+)'/g)].map((m) => m[1]!);
  const listed = [scopeResource, reachSubject].flatMap((t) => [...t.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!));
  return [...new Set([...listed, ...noted])].sort();
}

describe('the scope switch an access.hidden row names', () => {
  it('every kind a row check can refuse is decided in this table', () => {
    expect(kindsInSource()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [kind, switches] of Object.entries(EXPECTED)) {
    it(`${kind}: ${switches.join(', ')}`, () => {
      for (const key of switches) expect(findSwitch(key), key).toBeDefined();
      expect(scopeSwitchesFor(kind)).toEqual(switches);
    });
  }
});
