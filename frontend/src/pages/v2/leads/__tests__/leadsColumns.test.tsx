/**
 * The Type column's badge has to stay inside its own cell.
 *
 * RED before the fix: job_type is unbounded org free text, and Badge's
 * inline-flex box floors its width at whitespace-nowrap's full-string
 * minimum, so a long value overflowed into the Status cell beside it.
 *
 * jsdom performs no layout, so this pins the MECHANISM, not the geometry: the
 * badge is clamped to the column and the inner span carries `truncate` (which
 * is what actually shrinks - "truncate" brings overflow-hidden, and that is
 * what zeroes a flex item's automatic minimum size). Whether the ellipsis
 * lands in the right place is a browser check, not this test.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CellContext } from '@tanstack/react-table';
import type { ReactElement } from 'react';

import { buildLeadColumns, type Lead } from '../leadsColumns';

const LONG_TYPE = 'Emergency Water Heater Replacement And Full System Diagnostic Visit';

function typeCellContext(job_type: string): CellContext<Lead, unknown> {
  return { row: { original: { job_type } } } as unknown as CellContext<Lead, unknown>;
}

describe('leads Type column containment', () => {
  it('clamps the badge to the column and truncates the value inside it', () => {
    const type = buildLeadColumns([], () => {}, 'America/New_York').find((c) => c.id === 'type')!;
    // meta.label and every column here defines `cell` as a render function,
    // never the plain-string form the union type also allows.
    const cell = type.cell as (ctx: CellContext<Lead, unknown>) => ReactElement;

    render(cell(typeCellContext(LONG_TYPE)));

    const badge = screen.getByTitle(LONG_TYPE);
    expect(badge).toHaveClass('max-w-full');

    const clipped = badge.querySelector('.truncate');
    expect(clipped).not.toBeNull();
    expect(clipped).toHaveTextContent(LONG_TYPE);
  });
});

/**
 * The Walkthrough column's scheduled date is an ORG fact (#1634) - when the
 * crew is going to the site, not when the viewer happens to be looking - so
 * it must render through the org zone like every other scheduling date on the
 * lead surfaces, not `new Date(...).toLocaleDateString()` reading the browser's.
 *
 * 2026-08-24T22:00:00Z is chosen deliberately: it is still Aug 24 in
 * America/New_York (a plausible CI runner zone) but has already rolled over
 * to Aug 25 in Asia/Manila, so this fails on browser-local rendering instead
 * of passing by coincidence.
 */
describe('leads Walkthrough column honours the org timezone', () => {
  function walkthroughCellContext(lead: Partial<Lead>): CellContext<Lead, unknown> {
    return { row: { original: lead } } as unknown as CellContext<Lead, unknown>;
  }

  it('renders the scheduled walkthrough on the org calendar day, not the browser one', () => {
    const walkthrough = buildLeadColumns([], () => {}, 'Asia/Manila').find((c) => c.id === 'walkthrough')!;
    const cell = walkthrough.cell as (ctx: CellContext<Lead, unknown>) => ReactElement;

    render(cell(walkthroughCellContext({
      status: 'CONTACTED',
      walkthrough_scheduled_at: '2026-08-24T22:00:00.000Z',
      walkthrough_completed_at: null,
    })));

    expect(screen.getByText('Aug 25, 2026')).toBeInTheDocument();
    expect(screen.queryByText('Aug 24, 2026')).not.toBeInTheDocument();
  });
});

/**
 * Visits slice 05: a closed lead needs no scheduling. The list's flat walkthrough fields no longer
 * carry a cancelled visit, so a lead marked lost (which cancels its walkthrough) arrives with no
 * walkthrough date - and must read "-", not the amber "Needs Sched." an open lead gets.
 */
describe('leads Walkthrough column: a closed lead never "Needs Sched."', () => {
  function renderWalkthrough(lead: Partial<Lead>) {
    const walkthrough = buildLeadColumns([], () => {}, 'America/New_York').find((c) => c.id === 'walkthrough')!;
    const cell = walkthrough.cell as (ctx: CellContext<Lead, unknown>) => ReactElement;
    return render(cell({ row: { original: lead } } as unknown as CellContext<Lead, unknown>));
  }

  it.each(['LOST', 'CANCELLED', 'WON'])('a %s lead with no live walkthrough shows "-"', (status) => {
    const { container } = renderWalkthrough({ status, walkthrough_scheduled_at: null, walkthrough_completed_at: null });
    expect(container).toHaveTextContent(/^-$/);
    expect(screen.queryByText('Needs Sched.')).toBeNull();
  });

  it('an open lead with no walkthrough still needs scheduling', () => {
    renderWalkthrough({ status: 'CONTACTED', walkthrough_scheduled_at: null, walkthrough_completed_at: null });
    expect(screen.getByText('Needs Sched.')).toBeInTheDocument();
  });

  it('a closed lead keeps its walkthrough history: a completed one still reads Done', () => {
    renderWalkthrough({ status: 'WON', walkthrough_scheduled_at: '2026-09-10T15:00:00.000Z', walkthrough_completed_at: '2026-09-10T16:00:00.000Z' });
    expect(screen.getByText('✓ Done')).toBeInTheDocument();
  });
});

/**
 * The Status column has to be wide enough for the longest lead status chip.
 *
 * RED before the fix: the column was 110 px, sized for the old short labels; the walkthrough
 * statuses' chips measure 136 and 139 px (nowrap, never shrinking), so they painted 42-45 px over
 * the Service Request text beside them.
 *
 * jsdom performs no layout, so the chip width is estimated from the measured browser figure
 * (139 px for the 21-character 'Walkthrough Completed' = 6.6 px per character, badge padding
 * included) and the cell's own 32 px of horizontal padding is added on top.
 */
describe('leads Status column fits every lead status chip', () => {
  const CHIP_PX_PER_CHAR = 6.6;
  const CELL_PADDING = 32;

  it('is at least as wide as the widest chip plus the cell padding', async () => {
    const { STATUS_REGISTRY } = await import('@/design-system/status-registry');
    const longest = Math.max(...Object.values(STATUS_REGISTRY.lead).map((s) => s.label.length));
    const status = buildLeadColumns([], () => {}, 'America/New_York').find((c) => c.id === 'status')!;

    expect(status.size).toBeGreaterThanOrEqual(Math.ceil(longest * CHIP_PX_PER_CHAR) + CELL_PADDING);
  });
});
