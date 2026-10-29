import { describe, it, expect } from 'vitest';
import { subject } from '@casl/ability';
import { PERMISSION_CATALOG, isCatalogEntry } from '../lib/permissions/catalog';
import { substituteConditions } from '../lib/permissions/substituteConditions';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { isAssignable, isOwnerEligible } from '../lib/permissions/assignableRoles';

describe('Permission catalog', () => {
  it('has no duplicate (action, subject) pairs', () => {
    const keys = PERMISSION_CATALOG.map(e => `${e.action}:${e.subject}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('isCatalogEntry returns true for known pair', () => {
    expect(isCatalogEntry('read', 'Lead')).toBe(true);
  });

  it('isCatalogEntry returns false for unknown pair', () => {
    expect(isCatalogEntry('fly', 'Lead')).toBe(false);
  });

  it('every entry has description and category', () => {
    for (const e of PERMISSION_CATALOG) {
      expect(e.description).toBeTruthy();
      expect(e.category).toBeTruthy();
    }
  });

  // Entity-redesign §4 — the Estimate revise (recall-to-draft) action.
  it('includes revise:Estimate', () => {
    expect(isCatalogEntry('revise', 'Estimate')).toBe(true);
  });

  // Entity-redesign §8 deposit-refund FOLD (Phase 5): the legacy Estimate deposit
  // refund/reactivate actions are gone — the unified Invoice refund (kind=DEPOSIT)
  // replaces refund_deposit, and reactivate is retired.
  it('no longer contains refund_deposit / reactivate_deposit Estimate (the fold)', () => {
    expect(isCatalogEntry('refund_deposit', 'Estimate')).toBe(false);
    expect(isCatalogEntry('reactivate_deposit', 'Estimate')).toBe(false);
  });
});

describe('substituteConditions', () => {
  it('replaces {{userId}} with the actual user id', () => {
    const result = substituteConditions({ assigned_to: '{{userId}}' }, { userId: 'user-123' });
    expect(result).toEqual({ assigned_to: 'user-123' });
  });

  it('substitutes nested conditions', () => {
    const cond = { job: { assigned_to: '{{userId}}' } };
    expect(substituteConditions(cond, { userId: 'u1' })).toEqual({ job: { assigned_to: 'u1' } });
  });

  it('passes through non-token strings unchanged', () => {
    expect(substituteConditions({ status: 'ACTIVE' }, { userId: 'u1' })).toEqual({ status: 'ACTIVE' });
  });

  it('returns undefined for null/undefined conditions', () => {
    expect(substituteConditions(null, { userId: 'u1' })).toBeUndefined();
    expect(substituteConditions(undefined, { userId: 'u1' })).toBeUndefined();
  });

  it('throws on unknown tokens', () => {
    expect(() => substituteConditions({ x: '{{orgId}}' }, { userId: 'u1' })).toThrow('Unknown token');
  });
});

describe('defineAbilityFor', () => {
  it('admin gets manage all', () => {
    const ability = defineAbilityFor({ id: 'u1', role: 'ADMIN' }, []);
    expect(ability.can('read', 'Lead')).toBe(true);
    expect(ability.can('delete', 'Invoice')).toBe(true);
    expect(ability.can('refund', 'Invoice')).toBe(true);
    expect(ability.can('credit', 'Invoice')).toBe(true);
    expect(ability.can('void_payment', 'Invoice')).toBe(true);
  });

  it('admin can force_purge / archive / anonymize Customer (entity-redesign §10)', () => {
    const ability = defineAbilityFor({ id: 'u1', role: 'ADMIN' }, []);
    expect(ability.can('force_purge', 'Customer')).toBe(true);
    expect(ability.can('archive', 'Customer')).toBe(true);
    expect(ability.can('anonymize', 'Customer')).toBe(true);
  });

  it('delete Lead: admin yes, dispatcher yes, sales own-scoped, technician no (entity-redesign §10 4a)', () => {
    expect(isCatalogEntry('delete', 'Lead')).toBe(true);

    // ADMIN — manage all
    const admin = defineAbilityFor({ id: 'a1', role: 'ADMIN' }, []);
    expect(admin.can('delete', 'Lead')).toBe(true);

    // DISPATCHER — unconditional delete Lead grant
    const dispatcher = defineAbilityFor(
      { id: 'd1', role: 'DISPATCHER' },
      DEFAULT_GRANTS.filter(g => g.role === 'DISPATCHER'),
    );
    expect(dispatcher.can('delete', 'Lead')).toBe(true);

    // SALES — own-scoped via OWN_LEAD: own lead yes, another's no
    const sales = defineAbilityFor(
      { id: 'sales-user', role: 'SALES' },
      DEFAULT_GRANTS.filter(g => g.role === 'SALES'),
    );
    expect(sales.can('delete', subject('Lead', { lead_assignees: [{ user_id: 'sales-user' }] }) as any)).toBe(true);
    expect(sales.can('delete', subject('Lead', { lead_assignees: [{ user_id: 'other-user' }] }) as any)).toBe(false);

    // TECHNICIAN — no delete Lead grant
    const tech = defineAbilityFor(
      { id: 't1', role: 'TECHNICIAN' },
      DEFAULT_GRANTS.filter(g => g.role === 'TECHNICIAN'),
    );
    expect(tech.can('delete', 'Lead')).toBe(false);
  });

  it('deny-by-default for empty grants', () => {
    const ability = defineAbilityFor({ id: 'u1', role: 'SALES' }, []);
    expect(ability.can('read', 'Lead')).toBe(false);
  });

  it('grants unconditional action', () => {
    const ability = defineAbilityFor({ id: 'u1', role: 'SALES' }, [
      { action: 'read', subject: 'Estimate' },
    ]);
    expect(ability.can('read', 'Estimate')).toBe(true);
  });

  it('substitutes {{userId}} in conditions', () => {
    const ability = defineAbilityFor({ id: 'user-42', role: 'SALES' }, [
      { action: 'read', subject: 'Lead', conditions: { assigned_to: '{{userId}}' } },
    ]);
    expect(ability.can('read', 'Lead')).toBe(true);
  });
});

describe('DEFAULT_GRANTS', () => {
  it('has no ADMIN rows (admin is code-level manage all)', () => {
    expect(DEFAULT_GRANTS.filter((g: any) => g.role === 'ADMIN')).toHaveLength(0);
  });

  it('all grants reference valid catalog (action, subject) pairs', () => {
    for (const g of DEFAULT_GRANTS) {
      expect(isCatalogEntry(g.action, g.subject),
        `Unknown grant: ${g.action} ${g.subject}`).toBe(true);
    }
  });

  it('SALES cannot read Lead without conditions (own-scoped)', () => {
    const grants = DEFAULT_GRANTS.filter((g: any) => g.role === 'SALES' && g.action === 'read' && g.subject === 'Lead');
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect((g as any).conditions).toBeDefined();
    }
  });

  it('DISPATCHER can read Lead without conditions', () => {
    const grants = DEFAULT_GRANTS.filter((g: any) => g.role === 'DISPATCHER' && g.action === 'read' && g.subject === 'Lead');
    expect(grants.length).toBeGreaterThan(0);
    const unconditional = grants.find((g: any) => !g.conditions);
    expect(unconditional).toBeDefined();
  });

  it('DISPATCHER does NOT have void Invoice (admin-only)', () => {
    const grants = DEFAULT_GRANTS.filter((g: any) => g.role === 'DISPATCHER' && g.action === 'void' && g.subject === 'Invoice');
    expect(grants).toHaveLength(0);
  });

  it('no role has a refund_deposit / reactivate_deposit grant (folded into unified Invoice refund)', () => {
    const folded = DEFAULT_GRANTS.filter(
      (g: any) => g.action === 'refund_deposit' || g.action === 'reactivate_deposit',
    );
    expect(folded).toHaveLength(0);
  });

  it('DISPATCHER no longer has reactivate_deposit Estimate grant (the fold)', () => {
    const grants = DEFAULT_GRANTS.filter((g: any) => g.role === 'DISPATCHER' && g.action === 'reactivate_deposit' && g.subject === 'Estimate');
    expect(grants).toHaveLength(0);
  });

  it('DISPATCHER does NOT have credit Invoice (admin-only)', () => {
    const grants = DEFAULT_GRANTS.filter((g: any) => g.role === 'DISPATCHER' && g.action === 'credit' && g.subject === 'Invoice');
    expect(grants).toHaveLength(0);
  });

  it('DISPATCHER does NOT have void_payment Invoice (admin-only)', () => {
    const grants = DEFAULT_GRANTS.filter((g: any) => g.role === 'DISPATCHER' && g.action === 'void_payment' && g.subject === 'Invoice');
    expect(grants).toHaveLength(0);
  });

  it('DISPATCHER may archive Customer (lifecycle archive is dispatcher+admin)', () => {
    const grants = DEFAULT_GRANTS.filter((g: any) => g.role === 'DISPATCHER' && g.action === 'archive' && g.subject === 'Customer');
    expect(grants.length).toBeGreaterThan(0);
  });

  it('no non-admin role has force_purge or anonymize Customer (admin-only)', () => {
    for (const role of ['DISPATCHER', 'SALES', 'TECHNICIAN']) {
      for (const action of ['force_purge', 'anonymize']) {
        const grants = DEFAULT_GRANTS.filter(
          (g: any) => g.role === role && g.action === action && g.subject === 'Customer',
        );
        expect(grants, `${role} should not have ${action} Customer`).toHaveLength(0);
      }
    }
  });
});

// Bug #11 — owner-eligibility must equal the assignable pool so any user the
// AssignLeadDialog offers can actually be assigned as a lead owner.
// #366 — the pool is now ALL active-user roles (DISPATCHER included).
describe('assignableRoles owner-eligibility', () => {
  it('isOwnerEligible(TECHNICIAN) === true (mirrors the assignable pool)', () => {
    expect(isOwnerEligible('TECHNICIAN')).toBe(true);
  });

  it('owner-eligibility mirrors isAssignable for every role', () => {
    for (const role of ['ADMIN', 'SALES', 'TECHNICIAN', 'DISPATCHER']) {
      expect(isOwnerEligible(role)).toBe(isAssignable(role));
    }
  });

  it('DISPATCHER is assignable and owner-eligible (#366: all active-user roles)', () => {
    expect(isAssignable('DISPATCHER')).toBe(true);
    expect(isOwnerEligible('DISPATCHER')).toBe(true);
  });

  it('rejects corrupt/unknown role values', () => {
    expect(isAssignable('SUPERUSER')).toBe(false);
    expect(isOwnerEligible('SUPERUSER')).toBe(false);
  });
});
