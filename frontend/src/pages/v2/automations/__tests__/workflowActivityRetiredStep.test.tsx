/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { useWorkflowActivity, type ActivityRow } from '@/lib/api/workflows';

import WorkflowActivity from '../components/workflowActivity';
import { StepTypeTile, STEP_TYPE_META } from '../components/workflowVisuals';

/**
 * The routed v2 twin of components/workflows/WorkflowActivity.test.tsx's
 * historical-step guard.
 *
 * The retirement narrows what an admin may AUTHOR, not what history may hold:
 * the Postgres enum keeps the in-app label, so step runs recorded before the
 * retirement are still in the ledger. Both rendering maps deliberately keep the
 * key, and this is what says so out loud - without it, a later tidy-up of "the
 * last NOTIFY_TEAM references" would render real past runs as a bare enum name.
 */

vi.mock('@/lib/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/workflows')>();
  return { ...actual, useWorkflowActivity: vi.fn() };
});

const mockUseActivity = vi.mocked(useWorkflowActivity);

const legacyRow: ActivityRow = {
  id: 'r1',
  source: 'legacy',
  when: '2026-07-10T09:00:00.000Z',
  step_index: 0,
  step_type: 'NOTIFY_TEAM',
  status: 'SENT',
  recipient_summary: 'Dispatch',
  detail: 'Notified the dispatcher',
  entity_label: 'J00042',
  audience_outcomes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('workflowActivity (v2) - a historical in-app step still renders', () => {
  it('names the retired step in the feed rather than showing its raw type', () => {
    mockUseActivity.mockReturnValue({
      data: { rows: [legacyRow] },
      isLoading: false,
    } as ReturnType<typeof useWorkflowActivity>);

    renderWithProviders(<WorkflowActivity id="wf-1" />);

    expect(screen.getByText(/Step 1 · Notify the team/)).toBeInTheDocument();
    expect(screen.getByText('Notified the dispatcher')).toBeInTheDocument();
    expect(screen.queryByText(/NOTIFY_TEAM/)).not.toBeInTheDocument();
  });

  it('still has an icon tile for it', () => {
    expect(STEP_TYPE_META.NOTIFY_TEAM.label).toBe('Notify');

    const { container } = renderWithProviders(<StepTypeTile type="NOTIFY_TEAM" />);
    const tile = container.querySelector('[title="Notify"]');
    expect(tile).not.toBeNull();
    expect(tile?.querySelector('svg')).not.toBeNull();
  });
});
