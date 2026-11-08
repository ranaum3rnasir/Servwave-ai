import { describe, it, expect } from 'vitest';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

// RBAC Phase 2: per-user permission overrides layered on the role grant.
//   effect 'allow' → grant a capability the role lacks (unconditional)
//   effect 'deny'  → revoke a capability the role grants (cannot, wins over the role can)
// ADMIN is `manage all` and is never affected by overrides.
describe('defineAbilityFor — per-user overrides (allow/deny)', () => {
  const sales = { id: 'u1', role: 'SALES' }; // role lacks `create Invoice`
  const dispatcher = { id: 'u2', role: 'DISPATCHER' };
  const admin = { id: 'a1', role: 'ADMIN' };
  const roleHasInvoiceCreate = [{ action: 'create', subject: 'Invoice' }];

  it('allow-override grants a capability the role lacks', () => {
    const ability = defineAbilityFor(sales, [], [{ action: 'create', subject: 'Invoice', effect: 'allow' }]);
    expect(ability.can('create', 'Invoice')).toBe(true);
  });

  it('deny-override revokes a capability the role grants', () => {
    const ability = defineAbilityFor(dispatcher, roleHasInvoiceCreate, [
      { action: 'create', subject: 'Invoice', effect: 'deny' },
    ]);
    expect(ability.can('create', 'Invoice')).toBe(false);
  });

  it('no overrides → role grant alone decides (regression)', () => {
    expect(defineAbilityFor(dispatcher, roleHasInvoiceCreate).can('create', 'Invoice')).toBe(true);
    expect(defineAbilityFor(sales, []).can('create', 'Invoice')).toBe(false);
  });

  it('ADMIN is never restricted by a deny-override', () => {
    const ability = defineAbilityFor(admin, [], [{ action: 'create', subject: 'Invoice', effect: 'deny' }]);
    expect(ability.can('create', 'Invoice')).toBe(true); // manage all
  });

  it('allow-override does not leak to other subjects/actions', () => {
    const ability = defineAbilityFor(sales, [], [{ action: 'create', subject: 'Invoice', effect: 'allow' }]);
    expect(ability.can('create', 'Invoice')).toBe(true);
    expect(ability.can('create', 'Job')).toBe(false);
    expect(ability.can('delete', 'Invoice')).toBe(false);
  });

  // Phase B (technician redesign): an allow-override for a MANAGED capability is now own-scoped —
  // it emits a CONDITIONAL `can` (the capability's OWN_* condition, {{userId}} substituted) plus
  // the paired own-scoped `read <subject>` (impliesRead), NOT a bare unconditional `can`. The
  // bare-subject route-guard contract (can('create','Invoice') === true) still holds (asserted
  // above) because CASL treats a conditional rule as applicable when no fields are forced.
  it('allow-override is own-scoped + emits a paired read (managed capability)', () => {
    const ability = defineAbilityFor(sales, [], [{ action: 'create', subject: 'Invoice', effect: 'allow' }]);
    const createRule = ability.rules.find((r) => r.subject === 'Invoice' && r.action === 'create');
    expect(createRule).toBeTruthy();
    expect(createRule?.inverted).toBeFalsy();
    // create Invoice → own via parent job (job.assignees ∋ me).
    expect(createRule?.conditions).toEqual({ job: { visits: { some: { assignees: { some: { user_id: 'u1' } } } } } });
    // impliesRead materialized the paired own-scoped read Invoice (so the grantee can see it).
    const readRule = ability.rules.find((r) => r.subject === 'Invoice' && r.action === 'read' && !r.inverted);
    expect(readRule?.conditions).toEqual({ job: { visits: { some: { assignees: { some: { user_id: 'u1' } } } } } });
  });

  it('deny-override emits an inverted (cannot) rule', () => {
    const ability = defineAbilityFor(dispatcher, roleHasInvoiceCreate, [
      { action: 'create', subject: 'Invoice', effect: 'deny' },
    ]);
    const denyRule = ability.rules.find((r) => r.subject === 'Invoice' && r.action === 'create' && r.inverted);
    expect(denyRule).toBeTruthy();
  });

  it('allow-override for an org-wide capability (PriceBook) is UNCONDITIONAL + implies read', () => {
    const ability = defineAbilityFor(sales, [], [{ action: 'create', subject: 'PriceBook', effect: 'allow' }]);
    expect(ability.can('create', 'PriceBook')).toBe(true);
    expect(ability.can('read', 'PriceBook')).toBe(true); // impliesRead
    const createRule = ability.rules.find((r) => r.subject === 'PriceBook' && r.action === 'create');
    expect(createRule?.conditions).toBeUndefined(); // org-wide: no own-scope condition
  });
});
