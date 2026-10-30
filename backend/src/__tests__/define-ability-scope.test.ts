import { describe, it, expect } from 'vitest';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

describe('defineAbilityFor — team scope', () => {
  const user = { id: 'u1', role: 'SALES', is_admin: false, department_id: 'team-9' };

  it('bakes teamId into a relation condition', () => {
    const ability = defineAbilityFor(user, [
      { action: 'read', subject: 'Job', conditions: { assigned_user: { department_id: '{{teamId}}' } } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Job');
    expect(rule?.conditions).toEqual({ assigned_user: { department_id: 'team-9' } });
  });

  it('still substitutes userId when the department is omitted', () => {
    const ability = defineAbilityFor({ is_admin: false, id: 'u1', role: 'SALES' }, [
      { action: 'read', subject: 'Lead', conditions: { assigned_to: '{{userId}}' } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Lead');
    expect(rule?.conditions).toEqual({ assigned_to: 'u1' });
  });

  it('FAIL-CLOSED: a Team-scoped grant on a dept-less user emits a match-nothing rule', () => {
    const ability = defineAbilityFor({ is_admin: false, id: 'u1', role: 'SALES', department_id: null }, [
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Job');
    expect(rule?.conditions).toEqual({ id: { in: [] } });
  });
});
