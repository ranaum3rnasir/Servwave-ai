/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '@/__tests__/helpers';
import { useWorkflowActivity, type ActivityRow } from '@/lib/api/workflows';

import WorkflowActivity from '../components/workflowActivity';

/**
 * Spec C slice 8. The feed printed "Text the customer" for EVERY text run, whoever the text
 * actually went to, so a step addressed to the assigned crew read as a customer message in
 * the one place an admin goes to find out what happened. The row already carries who it went
 * to, next to the action; the action fragment names the CHANNEL and stops guessing at the
 * audience.
 */

vi.mock('@/lib/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/workflows')>();
  return { ...actual, useWorkflowActivity: vi.fn() };
});

const mockUseActivity = vi.mocked(useWorkflowActivity);

function textRow(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: 'r1',
    source: 'run',
    when: '2026-08-27T09:00:00.000Z',
    step_index: 1,
    step_type: 'SEND_TEXT',
    status: 'SENT',
    recipient_summary: 'Ada Lovelace',
    detail: 'On our way',
    entity_label: 'J00042',
    ...overrides,
  } as ActivityRow;
}

beforeEach(() => {
  vi.clearAllMocks();
});

function render(row: ActivityRow) {
  mockUseActivity.mockReturnValue({ data: { rows: [row] }, isLoading: false } as ReturnType<
    typeof useWorkflowActivity
  >);
  renderWithProviders(<WorkflowActivity id="wf-1" />);
}

describe('workflowActivity (v2) - a text run does not claim the customer got it', () => {
  it('names the channel, not an audience', () => {
    render(textRow());

    expect(screen.getByText(/Step 2 · Send a text/)).toBeInTheDocument();
    expect(screen.queryByText(/Text the customer/)).not.toBeInTheDocument();
  });

  it('still says who it actually went to', () => {
    render(textRow({ recipient_summary: 'Ada Lovelace, Grace Hopper' }));
    expect(screen.getByText(/To Ada Lovelace, Grace Hopper/)).toBeInTheDocument();
  });

  it('leaves the email step’s label alone', () => {
    render(textRow({ step_type: 'SEND_EMAIL', id: 'r2' }));
    expect(screen.getByText(/Step 2 · Send an email/)).toBeInTheDocument();
  });
});
