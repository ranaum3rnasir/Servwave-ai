import { describe, it, expect } from 'vitest';
import { estimateHeaderWidth } from '@/components/data/data-table';

describe('estimateHeaderWidth', () => {
  it('floors a sortable identity header above its old truncating width', () => {
    // "Lead #" previously had size 90 and truncated to "LE…". The floor must exceed that.
    expect(estimateHeaderWidth('Lead #', true)).toBeGreaterThan(90);
  });

  it('fits a long non-sortable header (Walkthrough was clipped to "WALKTHRO…")', () => {
    // Old size was 120 and still truncated; the floor must be at least that wide.
    expect(estimateHeaderWidth('Walkthrough', false)).toBeGreaterThanOrEqual(120);
  });

  it('reserves extra room for the sort glyph on sortable columns', () => {
    expect(estimateHeaderWidth('Status', true)).toBeGreaterThan(
      estimateHeaderWidth('Status', false)
    );
  });

  it('scales with label length', () => {
    expect(estimateHeaderWidth('Service Request', false)).toBeGreaterThan(
      estimateHeaderWidth('Type', false)
    );
  });
});
