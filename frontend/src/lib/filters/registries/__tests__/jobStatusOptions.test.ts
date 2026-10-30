import { describe, it, expect } from 'vitest';
import { JOB_STATUSES, jobsRegistry } from '../jobs';
import { LIVE_VISIT_STATUSES } from '../../../visits';

/**
 * Multi-visit S4 (D17): the jobs list Status facet is the user-facing list of what a JOB can be.
 *
 * The API's jobs facet DROPS an unrecognised enum literal rather than 400ing, so a stale option
 * here would render, be selectable, and silently match nothing - the quietest of the possible
 * failures. Pinned to the exact eight values rather than "does not contain EN_ROUTE", so adding a
 * ninth is a deliberate edit.
 */
describe('the jobs Status facet offers only statuses a job can hold', () => {
  it('lists exactly the eight JobStatus values', () => {
    expect(JOB_STATUSES).toEqual([
      'UNSCHEDULED',
      'SCHEDULED',
      'IN_PROGRESS',
      'COMPLETED',
      'OFFICE_REVIEW',
      'READY_TO_CLOSE',
      'DONE',
      'CANCELLED',
    ]);
  });

  it('shows the close-out statuses under their own names in the Status facet', () => {
    const status = jobsRegistry.find((f) => f.key === 'status') as { options: { value: string; label: string }[] };
    const labelOf = (value: string) => status.options.find((o) => o.value === value)?.label;
    expect(labelOf('OFFICE_REVIEW')).toBe('Office review');
    expect(labelOf('READY_TO_CLOSE')).toBe('Ready to close');
    expect(labelOf('DONE')).toBe('Done');
    // Completed keeps its word; nothing on a job reads "Lost" or "Closed".
    expect(labelOf('COMPLETED')).toBe('Completed');
    for (const option of status.options) expect(option.label).not.toMatch(/lost|closed/i);
  });

  it('does not offer En route or On site, which are trip states', () => {
    expect(JOB_STATUSES).not.toContain('EN_ROUTE');
    expect(JOB_STATUSES).not.toContain('ON_SITE');
    // The information is not lost - it moved one level down, onto the visit.
    expect(LIVE_VISIT_STATUSES).toContain('EN_ROUTE');
    expect(LIVE_VISIT_STATUSES).toContain('ON_SITE');
  });
});
