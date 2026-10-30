/* =============================================================================
   Roles & Permissions security fixes, ticket 33 (spec story 49): the reach-to-SQL compiler refuses what it does not
   compile.

   lib/permissions/reachSql.ts turns the reach `where` into SQL for the activity report. It compiles only the operators a
   reach rule uses today; anything else must throw, so a rule written with a new operator fails loudly instead of being
   half-applied. No database: the compiler reads the schema's relation map.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { whereSql } from '../lib/permissions/reachSql';

describe('the reach-to-SQL compiler refuses operators no reach rule uses', () => {
  it.each([
    ['NOT', { NOT: { lead_id: null } }],
    ['a to-many none', { visits: { none: { status: 'SCHEDULED' } } }],
    ['a to-many every', { visits: { every: { status: 'SCHEDULED' } } }],
    ['an empty OR', { OR: [] }],
    ['isNot with a condition', { estimate: { isNot: { lead_id: null } } }],
    ['a column operator it does not know', { job_number: { contains: 'J' } }],
    ['an unknown field', { not_a_column: 'x' }],
  ])('throws on %s', (_label, where) => {
    expect(() => whereSql('Job', where as Record<string, unknown>, 'rec')).toThrow(/reachSql/);
  });

  it('compiles what reach does use', () => {
    const sql = whereSql('Job', { OR: [{ salesperson_id: '00000000-0000-0000-0000-000000000001' }, { visits: { some: { assignees: { some: { user_id: '00000000-0000-0000-0000-000000000001' } } } } }] }, 'rec');
    expect(sql.sql).toMatch(/EXISTS/);
    expect(sql.values).toEqual(['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001']);
  });
});
