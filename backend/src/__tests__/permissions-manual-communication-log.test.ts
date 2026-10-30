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

const SUBJECT = 'Communication';
const ACTION = 'log_past';
const NON_ADMIN_ROLES = ['SALES', 'DISPATCHER', 'TECHNICIAN'] as const;

const grantsFor = (role: string) => DEFAULT_GRANTS.filter((g) => g.role === role);
const abilityFor = (role: string) => defineAbilityFor({ is_admin: role === 'ADMIN', id: 'user-1', role }, grantsFor(role));

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
