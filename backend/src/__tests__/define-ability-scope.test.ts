import { describe, it, expect } from 'vitest';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

describe('defineAbilityFor — team/location scope', () => {
  const user = { id: 'u1', role: 'SALES', department_id: 'team-9', location_id: 'loc-3' };

  it('bakes teamId into a relation condition', () => {
    const ability = defineAbilityFor(user, [
      { action: 'read', subject: 'Job', conditions: { assigned_user: { department_id: '{{teamId}}' } } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Job');
    expect(rule?.conditions).toEqual({ assigned_user: { department_id: 'team-9' } });
  });

  it('bakes locationId into a relation condition', () => {
    const ability = defineAbilityFor(user, [
      { action: 'read', subject: 'Job', conditions: { assigned_user: { location_id: '{{locationId}}' } } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Job');
    expect(rule?.conditions).toEqual({ assigned_user: { location_id: 'loc-3' } });
  });

  it('still substitutes userId when dept/location omitted', () => {
    const ability = defineAbilityFor({ id: 'u1', role: 'SALES' }, [
      { action: 'read', subject: 'Lead', conditions: { assigned_to: '{{userId}}' } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Lead');
    expect(rule?.conditions).toEqual({ assigned_to: 'u1' });
  });

  it('FAIL-CLOSED: a Team-scoped grant on a dept-less user emits a match-nothing rule', () => {
    const ability = defineAbilityFor({ id: 'u1', role: 'SALES', department_id: null }, [
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Job');
    expect(rule?.conditions).toEqual({ id: { in: [] } });
  });
});
