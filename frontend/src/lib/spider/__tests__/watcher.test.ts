/**
 * The contractor's Configuration-tab defaults (lib/spider/watcher.ts). His browser-side stage rules and
 * overdue maths were removed with the lead list they served (#3436): the server answers both.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_LEAD_STAGES, DEFAULT_ASSIGNMENTS_CONFIG } from '../watcher';

describe('his defaults (D3)', () => {
  it('are all four roles and the owner, and three stages that start off, in minutes', () => {
    expect(DEFAULT_ASSIGNMENTS_CONFIG).toEqual({ adminRoles: ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'], owner: true, users: [] });
    expect(DEFAULT_LEAD_STAGES.map((s) => [s.id, s.label, s.duration, s.unit])).toEqual([
      ['NEW', 'New → Contacted', undefined, 'Minute'],
      ['CONTACTED', 'Contacted → Walkthrough Scheduled', undefined, 'Minute'],
      ['WALKTHROUGH_COMPLETED', 'Walkthrough Completed → Estimate', undefined, 'Minute'],
    ]);
  });
});
