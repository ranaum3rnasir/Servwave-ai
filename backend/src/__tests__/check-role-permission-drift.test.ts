import { describe, it, expect } from 'vitest';
import { diffGrants, emitSyncSql, shouldFail } from '../scripts/check-role-permission-drift';

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

describe('emitSyncSql', () => {
  it('returns a no-op comment when given no grants', () => {
    expect(emitSyncSql([])).toBe('-- no grants to sync');
  });

  it('emits an idempotent cross-join insert with conditions as jsonb-castable text', () => {
    const sql = emitSyncSql([
      { role: 'SALES', action: 'read', subject: 'Customer' },
      { role: 'TECHNICIAN', action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    expect(sql).toContain('FROM organizations o');
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING;');
    expect(sql).toContain("('SALES','read','Customer',NULL)");
    expect(sql).toContain(`('TECHNICIAN','read','Job','{"assignees":{"some":{"user_id":"{{userId}}"}}}')`);
  });

  it('escapes single quotes in string fields to prevent malformed SQL', () => {
    const sql = emitSyncSql([{ role: 'SALES', action: 'read', subject: "Weird'Subject" }]);
    expect(sql).toContain("'Weird''Subject'");
  });
});

describe('shouldFail', () => {
  it('never fails in non-strict mode, regardless of changed count', () => {
    expect(shouldFail(5, false)).toBe(false);
  });

  it('does not fail in strict mode when there are no changed-condition findings', () => {
    expect(shouldFail(0, true)).toBe(false);
  });

  it('fails in strict mode when there is at least one changed-condition finding', () => {
    expect(shouldFail(1, true)).toBe(true);
  });
});
