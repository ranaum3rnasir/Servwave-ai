import { describe, it, expect } from 'vitest';
import { diffGrants } from '../lib/permissions/legacyGrantDiff';

describe('diffGrants', () => {
  it('reports grants present in defaults but absent from existing as missing', () => {
    const defaults = [
      { role: 'SALES', action: 'read', subject: 'Customer' },
      { role: 'SALES', action: 'read', subject: 'Lead', conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    ];
    const existing = [{ role: 'SALES', action: 'read', subject: 'Customer' }];
    const { missing, extra } = diffGrants(defaults, existing);
    expect(missing).toEqual([defaults[1]]);
    expect(extra).toEqual([]);
  });

  it('reports grants present in existing but absent from defaults as extra', () => {
    const defaults = [{ role: 'SALES', action: 'read', subject: 'Customer' }];
    const existing = [
      { role: 'SALES', action: 'read', subject: 'Customer' },
      { role: 'SALES', action: 'create', subject: 'Job' },
    ];
    const { missing, extra } = diffGrants(defaults, existing);
    expect(missing).toEqual([]);
    expect(extra).toEqual([{ role: 'SALES', action: 'create', subject: 'Job' }]);
  });

  it('does not confuse grants that share action/subject across different roles', () => {
    const defaults = [{ role: 'SALES', action: 'read', subject: 'Customer' }];
    const existing = [{ role: 'DISPATCHER', action: 'read', subject: 'Customer' }];
    const { missing, extra } = diffGrants(defaults, existing);
    expect(missing).toEqual(defaults);
    expect(extra).toEqual(existing);
  });

  it('matches on role/action/subject for missing/extra even when conditions shape differs', () => {
    const defaults = [{ role: 'TECHNICIAN', action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } }];
    const existing = [{ role: 'TECHNICIAN', action: 'read', subject: 'Job', conditions: { assigned_to: '{{userId}}' } }];
    const { missing, extra } = diffGrants(defaults, existing);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('flags a shared role/action/subject whose condition JSON differs as changed', () => {
    const defaults = [{ role: 'SALES', action: 'read', subject: 'Estimate', conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } }];
    const existing = [{ role: 'SALES', action: 'read', subject: 'Estimate', conditions: { lead: { assigned_user: { department_id: '{{teamId}}' } } } }];
    const { missing, extra, changed } = diffGrants(defaults, existing);
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
    expect(changed).toEqual([{ default: defaults[0], existing: existing[0] }]);
  });

  it('does not flag identical conditions (including both-null) as changed', () => {
    const defaults = [
      { role: 'SALES', action: 'read', subject: 'Customer' },
      { role: 'SALES', action: 'read', subject: 'Lead', conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    ];
    const existing = [
      { role: 'SALES', action: 'read', subject: 'Customer', conditions: null },
      { role: 'SALES', action: 'read', subject: 'Lead', conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    ];
    const { changed } = diffGrants(defaults, existing);
    expect(changed).toEqual([]);
  });
});
