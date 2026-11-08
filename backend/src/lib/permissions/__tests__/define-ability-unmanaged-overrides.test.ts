import { describe, it, expect, vi, beforeEach } from 'vitest';
import { defineAbilityFor, GRANDFATHERED_UNMANAGED_ALLOWS } from '../defineAbility';
import { isManagedCapability } from '../userCapabilities';
import { isCatalogEntry } from '../catalog';
import { overrideReadGrants } from '../enforce';
import { DEFAULT_GRANTS } from '../defaultGrants';
import { logger } from '../../logger';

// SRVW-101. defineAbility's `!cap` branch used to emit an UNCONDITIONAL `can` for any override row
// whose (action, subject) is absent from USER_CAPABILITIES. It now fails CLOSED, matching
// enforce.ts:105, for every pair outside GRANDFATHERED_UNMANAGED_ALLOWS.
//
// setup.ts:259-267 mocks ../lib/logger globally and nothing in the harness ever clears it
// (no clearMocks in vitest.config.ts, no global beforeEach). Without this, warn-call counts
// accumulate across the tests in this file and the `exactly once` assertions read a total.
beforeEach(() => {
  vi.clearAllMocks();
});

const grantsFor = (role: string) => DEFAULT_GRANTS.filter((g) => g.role === role);

describe('per-user overrides - UNMANAGED (action, subject) rows fail CLOSED', () => {
  const tech = { id: 'tech-1', role: 'TECHNICIAN' };

  it('an unmanaged allow row (process LogisticOrder) on a TECHNICIAN grants nothing', () => {
    const ability = defineAbilityFor(tech, grantsFor('TECHNICIAN'), [
      { action: 'process', subject: 'LogisticOrder', effect: 'allow' },
    ]);
    // `process` is the stock-deducting verb behind logistic-order.routes.ts:34, whose controller
    // (logistic-order.controller.ts:815-844) does only a tenant lookup and a job-CANCELLED guard,
    // with no secondary role or ownership check - so the CASL verb alone is sufficient authority.
    expect(ability.can('process' as never, 'LogisticOrder' as never)).toBe(false);
    expect(ability.can('read' as never, 'LogisticOrder' as never)).toBe(false);
  });

  it('an invented pair in neither the catalog nor USER_CAPABILITIES grants nothing', () => {
    // Proves the guard is a general fail-closed rule, not a LogisticOrder special case.
    expect(isCatalogEntry('obliterate', 'Invoice')).toBe(false);
    expect(isManagedCapability('obliterate', 'Invoice')).toBe(false);
    const ability = defineAbilityFor(tech, grantsFor('TECHNICIAN'), [
      { action: 'obliterate', subject: 'Invoice', effect: 'allow' },
    ]);
    expect(ability.can('obliterate' as never, 'Invoice' as never)).toBe(false);
  });

  it('the two grandfathered pairs still emit an UNCONDITIONAL can, byte-identical to today', () => {
    const withLines = defineAbilityFor(tech, grantsFor('TECHNICIAN'), [
      { action: 'manage_lines', subject: 'Invoice', effect: 'allow' },
    ]);
    expect(withLines.can('manage_lines' as never, 'Invoice' as never)).toBe(true);
    const linesRule = withLines.rules.find(
      (r) => r.subject === 'Invoice' && r.action === 'manage_lines',
    );
    expect(linesRule?.conditions).toBeUndefined();
    expect(linesRule?.inverted).not.toBe(true);

    const withRead = defineAbilityFor(tech, grantsFor('TECHNICIAN'), [
      { action: 'read', subject: 'Estimate', effect: 'allow' },
    ]);
    expect(withRead.can('read' as never, 'Estimate' as never)).toBe(true);
    // Technician-ownership spec (2026-08-05): TECHNICIAN's OWN default grants now include a
    // CONDITIONAL `read Estimate` (OWN_ESTIMATE_VIA_LEAD_OR_CREATOR), so two rules compile for
    // this (action, subject) pair - the role's conditional one and the override's grandfathered
    // unconditional one. Find the unconditional one specifically; `.find()` alone would grab
    // whichever compiles first, which is no longer guaranteed to be the override's.
    const readRule = withRead.rules.find(
      (r) => r.subject === 'Estimate' && r.action === 'read' && r.conditions === undefined,
    );
    expect(readRule).toBeDefined();
    expect(readRule?.inverted).not.toBe(true);

    // No paired implied read is synthesized for manage_lines - the grandfathered branch emits the
    // bare verb only, exactly as the fail-open branch did. Measured against a no-override baseline.
    const baseline = defineAbilityFor(tech, grantsFor('TECHNICIAN'), []);
    expect(withLines.can('read' as never, 'Invoice' as never)).toBe(
      baseline.can('read' as never, 'Invoice' as never),
    );
  });

  it('GRANDFATHERED_UNMANAGED_ALLOWS holds exactly two pairs and neither is a managed capability', () => {
    expect(GRANDFATHERED_UNMANAGED_ALLOWS).toHaveLength(2);
    expect(GRANDFATHERED_UNMANAGED_ALLOWS).toEqual([
      { action: 'manage_lines', subject: 'Invoice' },
      { action: 'read', subject: 'Estimate' },
    ]);
    // Staying OUT of USER_CAPABILITIES is what keeps putPermissions (user.controller.ts:829)
    // 400ing these pairs and keeps getPermissions from rendering a new per-user admin toggle.
    expect(isManagedCapability('manage_lines', 'Invoice')).toBe(false);
    expect(isManagedCapability('read', 'Estimate')).toBe(false);
  });

  it('a skipped row is logged with action, subject and user id', () => {
    defineAbilityFor(tech, grantsFor('TECHNICIAN'), [
      { action: 'process', subject: 'LogisticOrder', effect: 'allow' },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(logger.warn).mock.calls[0][0]);
    expect(message).toContain('process');
    expect(message).toContain('LogisticOrder');
    expect(message).toContain('tech-1');

    vi.mocked(logger.warn).mockClear();
    defineAbilityFor(tech, grantsFor('TECHNICIAN'), [
      { action: 'manage_lines', subject: 'Invoice', effect: 'allow' },
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(0);
  });

  it('a deny row for an unmanaged pair still revokes (deny branch stays above the cap lookup)', () => {
    const ability = defineAbilityFor({ id: 'd1', role: 'DISPATCHER' }, grantsFor('DISPATCHER'), [
      { action: 'process', subject: 'LogisticOrder', effect: 'deny' },
    ]);
    expect(ability.can('process' as never, 'LogisticOrder' as never)).toBe(false);
  });

  it('CASL and enforce.ts now agree for an unmanaged pair; BOTH grandfathered asymmetries are documented', () => {
    const allowProcess = [
      { action: 'process', subject: 'LogisticOrder', effect: 'allow' as const },
    ];
    expect(overrideReadGrants(allowProcess, 'TECHNICIAN')).toEqual([]);
    expect(
      defineAbilityFor(tech, grantsFor('TECHNICIAN'), allowProcess).can(
        'process' as never,
        'LogisticOrder' as never,
      ),
    ).toBe(false);

    // The two builders still DISAGREE for the two grandfathered pairs: defineAbility grants the
    // verb unconditionally while overrideReadGrants (enforce.ts:105) synthesizes no SQL read scope.
    // Both asymmetries are deliberately preserved here and belong to a follow-up card, not to this
    // security close. `read Estimate` is safe today because TECHNICIAN holds no role `read Estimate`
    // grant, so scopeWhereForReq returns MATCH_NOTHING for lists and canAccessRow 403s foreign rows.
    const allowLines = [
      { action: 'manage_lines', subject: 'Invoice', effect: 'allow' as const },
    ];
    expect(overrideReadGrants(allowLines, 'TECHNICIAN')).toEqual([]);
    expect(
      defineAbilityFor(tech, grantsFor('TECHNICIAN'), allowLines).can(
        'manage_lines' as never,
        'Invoice' as never,
      ),
    ).toBe(true);

    const allowReadEstimate = [
      { action: 'read', subject: 'Estimate', effect: 'allow' as const },
    ];
    expect(overrideReadGrants(allowReadEstimate, 'TECHNICIAN')).toEqual([]);
    expect(
      defineAbilityFor(tech, grantsFor('TECHNICIAN'), allowReadEstimate).can(
        'read' as never,
        'Estimate' as never,
      ),
    ).toBe(true);
  });
});
