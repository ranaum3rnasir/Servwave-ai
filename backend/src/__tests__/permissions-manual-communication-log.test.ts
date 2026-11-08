// Manual Communication Log — permission wiring (slices 1 and 4).
//
// Posture under test:
//   ADMIN                            — holds it, through the manage-all short-circuit and nothing
//                                      else. That is what made the capability usable in slice 1
//                                      with no roles-UI work.
//   SALES / DISPATCHER / TECHNICIAN  — do NOT hold it under DEFAULT_GRANTS, so the feature stays
//                                      off by default for every existing organisation with no
//                                      data migration. Slice 4 adds the way to turn it ON, and
//                                      changes nothing about the default.
//
// SLICE 4 is the round-trip below. The capability is surfaced as a SENSITIVE BUNDLE - the
// established mechanism for a single named checkbox outside the ten-module CRUD grid - and not as
// an eleventh matrix row, which would expose the baseline `create Communication` grant as an
// admin-editable cell whose unticking silently revokes click-to-call and outbound texts.
//
// And the part that actually matters: `log_past` is a NEW action, NOT a reuse of
// `create Communication`. That one sits in SHARED_BASELINE and gates click-to-call, sending
// texts, WhatsApp and email — a role losing it would lose the ability to contact customers at
// all — so the tests below pin that every non-admin role STILL holds it while lacking `log_past`.
//
// Pure, no HTTP, mirroring permissions-logistic-orders.test.ts. Note what is deliberately NOT
// asserted as evidence of anything: catalog.ts's own comments record that a test asserting only
// that an entry is or is not in PERMISSION_CATALOG is a placebo which stays green after the real
// gate is removed. The invariant here is therefore driven through viewModelToGrants — the emitter
// putRolePermissions actually persists from.
import { describe, it, expect } from 'vitest';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { isCatalogEntry } from '../lib/permissions/catalog';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import {
  MODULES,
  SENSITIVE,
  TOGGLES,
  assembleRoleViewModel,
  viewModelToGrants,
  type RoleViewModel,
  type ToggleKey,
} from '../lib/permissions/roleViewModel';
import type { Grant } from '../lib/permissions/defineAbility';

const SUBJECT = 'Communication';
const ACTION = 'log_past';
const NON_ADMIN_ROLES = ['SALES', 'DISPATCHER', 'TECHNICIAN'] as const;

const grantsFor = (role: string) => DEFAULT_GRANTS.filter((g) => g.role === role);
const abilityFor = (role: string) => defineAbilityFor({ id: 'user-1', role }, grantsFor(role));

describe('the ability resolves per role', () => {
  it('ADMIN can log a past communication (manage-all short-circuit)', () => {
    expect(abilityFor('ADMIN').can(ACTION as never, SUBJECT as never)).toBe(true);
  });

  for (const role of NON_ADMIN_ROLES) {
    it(`${role} cannot, under the default grants`, () => {
      expect(abilityFor(role).can(ACTION as never, SUBJECT as never)).toBe(false);
    });

    // The whole reason the action is new. If someone "simplifies" the route back onto
    // `create Communication`, this pair is what says why they must not.
    it(`${role} still holds create Communication, so contacting customers is untouched`, () => {
      expect(abilityFor(role).can('create' as never, SUBJECT as never)).toBe(true);
    });
  }

  it('no role holds it through a DEFAULT_GRANTS row - ADMIN reaches it without one', () => {
    expect(DEFAULT_GRANTS.filter((g) => g.subject === SUBJECT && g.action === ACTION)).toEqual([]);
  });
});

describe('the Roles UI grants it deliberately, and can never grant it by accident', () => {
  /** Every cell on, every bundle on, every toggle on: the maximal Save the editor can request. */
  const fullyEnabledVm = (): RoleViewModel => {
    const matrix: RoleViewModel['matrix'] = {};
    for (const m of MODULES) matrix[m.subject] = { read: true, create: true, update: true, delete: true };
    const toggles = {} as Record<ToggleKey, boolean>;
    for (const key of Object.keys(TOGGLES) as ToggleKey[]) toggles[key] = true;
    return {
      role: 'DISPATCHER',
      matrix,
      sensitive: {
        seeFinancials: true,
        managePayments: true,
        viewReports: true,
        editRecordIds: true,
        logPastCommunications: true,
        accessCommunicationSection: true,
        assignOthers: true,
      },
      toggles,
      scope: {},
      general: { description: '' },
    };
  };

  it('emits a non-empty grant set (guards against a vacuously-passing assertion below)', () => {
    expect(viewModelToGrants(fullyEnabledVm()).length).toBeGreaterThan(0);
  });

  // Communication IS a CRUD matrix row, and slice 4 adds `log_past` beside those four - from the
  // sensitive bundle, never from a matrix cell. #2046 (slice 1) adds a second sensitive-bundle
  // verb, `access_inbox` (the Communication SECTION gate) - same treatment, same reason. This
  // assertion is what goes red if someone later tries to expose either as a CRUD column, or adds
  // a stray verb by accident.
  it('a maximal Save emits Communication as read/create/update/delete plus log_past/access_inbox, and nothing else', () => {
    const actions = viewModelToGrants(fullyEnabledVm())
      .filter((g) => g.subject === SUBJECT)
      .map((g) => g.action)
      .sort();
    expect(actions).toEqual(['access_inbox', 'create', 'delete', 'log_past', 'read', 'update']);
  });

  // The CRUD half in isolation: with the bundle OFF, the matrix alone can still never produce it.
  it('the CRUD matrix alone never emits log_past, on Communication or any other subject', () => {
    const vm = fullyEnabledVm();
    vm.sensitive.logPastCommunications = false;
    expect(viewModelToGrants(vm).filter((g) => g.action === ACTION)).toEqual([]);
  });

  it('log_past is emitted on Communication and on NO other subject', () => {
    const subjects = viewModelToGrants(fullyEnabledVm())
      .filter((g) => g.action === ACTION)
      .map((g) => g.subject);
    expect(subjects).toEqual([SUBJECT]);
  });

  // The SECOND gate: putRolePermissions drops every emitted grant that fails isCatalogEntry, so
  // the entry has to exist for the bundle to persist anything at all. Stated as a fact about the
  // write path, not offered as evidence that the gate works - see the header.
  it('is a catalog entry, so the bundle has something to persist', () => {
    expect(isCatalogEntry(ACTION, SUBJECT)).toBe(true);
  });

  it('every grant a maximal Save emits is a catalog entry (the filter stays a no-op today)', () => {
    expect(viewModelToGrants(fullyEnabledVm()).filter((g) => !isCatalogEntry(g.action, g.subject))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SLICE 4 — THE ROUND TRIP, which is the assertion that counts.
//
// catalog.ts's own comments record that a test asserting only that an entry IS or IS NOT in
// PERMISSION_CATALOG is a placebo: it stays green after the real gate is removed. So nothing
// below reads the catalog. Everything drives the two functions the write path actually runs -
// `assembleRoleViewModel` (stored rows -> what the checkbox shows) and `viewModelToGrants` (what
// the checkbox posts -> the rows putRolePermissions persists) - and, where it matters, both in
// sequence, because a bundle that emits but does not re-assemble reads back as OFF the moment
// the admin reloads the page.
//
// The other half of every one of these is what must NOT move. `create Communication` sits in
// SHARED_BASELINE and gates click-to-call, sending texts, WhatsApp and email; "See financial
// data" and "Record & refund payments" are unrelated grants an admin never touched. A bundle
// that quietly disturbs any of them is a worse defect than one that fails to save.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const key = (g: { action: string; subject: string }) => `${g.action}:${g.subject}`;

/** A view model with every CRUD cell on and every sensitive/toggle bundle OFF - the baseline the
 *  specs below flip exactly one switch on, so any other movement is attributable. */
function baselineVm(overrides: Partial<RoleViewModel['sensitive']> = {}): RoleViewModel {
  const matrix: RoleViewModel['matrix'] = {};
  for (const m of MODULES) matrix[m.subject] = { read: true, create: true, update: true, delete: true };
  const toggles = {} as Record<ToggleKey, boolean>;
  for (const k of Object.keys(TOGGLES) as ToggleKey[]) toggles[k] = false;
  return {
    role: 'SALES',
    matrix,
    sensitive: {
      seeFinancials: false,
      managePayments: false,
      viewReports: false,
      editRecordIds: false,
      logPastCommunications: false,
      accessCommunicationSection: false,
      assignOthers: false,
      ...overrides,
    },
    toggles,
    scope: {},
    general: { description: '' },
  };
}

describe('the sensitive bundle persists and un-persists the capability', () => {
  it('ticking it emits log_past Communication, org-wide', () => {
    const emitted = viewModelToGrants(baselineVm({ logPastCommunications: true }));
    expect(emitted).toContainEqual({ action: ACTION, subject: SUBJECT, conditions: null });
  });

  it('leaving it unticked emits nothing of the kind', () => {
    expect(viewModelToGrants(baselineVm()).filter((g) => g.action === ACTION)).toEqual([]);
  });

  it('assembles ON from stored rows that carry the grant', () => {
    const stored: Grant[] = [{ action: ACTION, subject: SUBJECT, conditions: null }];
    expect(assembleRoleViewModel('SALES', stored).sensitive.logPastCommunications).toBe(true);
  });

  it('assembles OFF from stored rows that do not', () => {
    const stored: Grant[] = [{ action: 'create', subject: SUBJECT, conditions: null }];
    expect(assembleRoleViewModel('SALES', stored).sensitive.logPastCommunications).toBe(false);
  });

  // BOTH DIRECTIONS IN SEQUENCE. A bundle that emits but does not re-assemble reads back as OFF
  // on the next page load, so the admin ticks it, saves, reloads, and finds it unticked.
  for (const on of [true, false]) {
    it(`survives a full save-then-reload with the switch ${on ? 'on' : 'off'}`, () => {
      const vm = baselineVm({ logPastCommunications: on });
      const reloaded = assembleRoleViewModel(vm.role, viewModelToGrants(vm));
      expect(reloaded.sensitive.logPastCommunications).toBe(on);
    });
  }
});

describe('toggling it disturbs nothing else', () => {
  // THE ONE THAT MATTERS MOST. `create Communication` is SHARED_BASELINE and gates click-to-call,
  // texts, WhatsApp and email. It is governed by the Communication MATRIX cell and by nothing
  // else; the bundle must be invisible to it in both directions.
  it('leaves the baseline create Communication grant exactly as the matrix set it', () => {
    const off = viewModelToGrants(baselineVm({ logPastCommunications: false }));
    const on = viewModelToGrants(baselineVm({ logPastCommunications: true }));
    const created = (gs: Grant[]) => gs.filter((g) => key(g) === `create:${SUBJECT}`);

    expect(created(off)).toHaveLength(1);
    expect(created(on)).toEqual(created(off));
  });

  it('a role with the capability and NO Communication matrix cells still cannot create one', () => {
    // The inverse of the pair above: the bundle grants log_past and log_past ONLY, so turning it
    // on for a role whose Communication row is empty does not hand back the baseline verb.
    const vm = baselineVm({ logPastCommunications: true });
    vm.matrix[SUBJECT] = { read: false, create: false, update: false, delete: false };
    const emitted = viewModelToGrants(vm);

    expect(emitted).toContainEqual({ action: ACTION, subject: SUBJECT, conditions: null });
    expect(emitted.filter((g) => g.subject === SUBJECT).map((g) => g.action)).toEqual([ACTION]);
  });

  it('leaves See financial data and Record & refund payments untouched, in both directions', () => {
    const others = [...SENSITIVE.seeFinancials, ...SENSITIVE.managePayments].map(key);
    const emittedOthers = (vm: RoleViewModel) =>
      viewModelToGrants(vm).filter((g) => others.includes(key(g))).map(key).sort();

    // Both bundles on, the new one flipped underneath them.
    const withThem = { seeFinancials: true, managePayments: true };
    expect(emittedOthers(baselineVm({ ...withThem, logPastCommunications: true })))
      .toEqual(emittedOthers(baselineVm({ ...withThem, logPastCommunications: false })));
    // Guards against a vacuous pass: those bundles really do emit something.
    expect(emittedOthers(baselineVm(withThem)).length).toBe(others.length);

    // Both bundles off, likewise - the new one must not drag them in.
    expect(emittedOthers(baselineVm({ logPastCommunications: true }))).toEqual([]);
  });

  it('reads the other two back unchanged after a save-then-reload that flips only this one', () => {
    const before = assembleRoleViewModel(
      'SALES',
      viewModelToGrants(baselineVm({ seeFinancials: true, managePayments: true })),
    ).sensitive;
    const after = assembleRoleViewModel(
      'SALES',
      viewModelToGrants(baselineVm({ seeFinancials: true, managePayments: true, logPastCommunications: true })),
    ).sensitive;

    expect(after.seeFinancials).toBe(before.seeFinancials);
    expect(after.managePayments).toBe(before.managePayments);
    expect(before.seeFinancials).toBe(true); // not vacuous
    expect(after.logPastCommunications).toBe(true);
    expect(before.logPastCommunications).toBe(false);
  });
});

// DEFAULT STATE IS UNCHANGED. This is the acceptance criterion that protects every existing
// organisation: the switch exists, and it starts off for the three roles that have DEFAULT_GRANTS
// rows at all. Driven through the assembler - what an admin opening the page would actually see -
// rather than through a DEFAULT_GRANTS filter, which would restate the fixture back at itself.
describe('the checkbox starts OFF for every role that has default grants', () => {
  for (const role of NON_ADMIN_ROLES) {
    it(`${role} opens the Roles page with the switch unticked`, () => {
      expect(assembleRoleViewModel(role, grantsFor(role)).sensitive.logPastCommunications).toBe(false);
    });

    // …and the row beside it is untouched: the same role still holds the baseline verb, which is
    // the whole reason `log_past` is a new action rather than a reuse of `create`.
    it(`${role} still shows the Communication create cell ticked`, () => {
      expect(assembleRoleViewModel(role, grantsFor(role)).matrix[SUBJECT].create).toBe(true);
    });
  }
});
