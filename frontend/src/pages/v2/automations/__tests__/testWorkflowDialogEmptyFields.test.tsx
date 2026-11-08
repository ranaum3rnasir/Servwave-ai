/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import { useTestWorkflow, type DryRunStep, type TestWorkflowResult } from '@/lib/api/workflows';

import TestWorkflowDialog from '../components/testWorkflowDialog';

/**
 * The dry run's "Sample data" / "Empty fields" toggle on the ROUTED dialog.
 *
 * Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
 * The empty-state preview is rendered by the SERVER through the same renderer and fallback map a
 * real send uses, so all the dialog does is re-run the dry run with `empty_fields: true`. What is
 * pinned here is that it asks for exactly that, and that sample data stays the default.
 */

vi.mock('@/lib/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/workflows')>();
  return { ...actual, useTestWorkflow: vi.fn() };
});

const mockUseTestWorkflow = vi.mocked(useTestWorkflow);

const SEND_STEP: DryRunStep[] = [
  {
    step_index: 0,
    step_type: 'SEND_EMAIL',
    outcome: 'would_send',
    detail: 'Would send to the customer',
    rendered: { subject: 'Visit', body: "Who's coming: Our team." },
  },
];

function mutationResult(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    reset: vi.fn(),
    isPending: false,
    data: undefined,
    ...overrides,
  } as unknown as ReturnType<typeof useTestWorkflow>;
}

function withData(steps: DryRunStep[]): TestWorkflowResult {
  return { steps, delivered: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('testWorkflowDialog (v2) - sample data vs empty fields', () => {
  it('opens on sample data and re-runs the dry run with empty_fields when toggled', async () => {
    const user = userEvent.setup();
    const result = mutationResult({ data: withData(SEND_STEP) });
    mockUseTestWorkflow.mockReturnValue(result);
    renderWithProviders(<TestWorkflowDialog open workflowId="wf-1" onOpenChange={vi.fn()} onFixStep={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Sample data' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Empty fields' })).toHaveAttribute('aria-pressed', 'false');
    expect(result.mutate).toHaveBeenLastCalledWith({ id: 'wf-1', send_to_me: false, empty_fields: false });

    await user.click(screen.getByRole('button', { name: 'Empty fields' }));

    expect(screen.getByRole('button', { name: 'Empty fields' })).toHaveAttribute('aria-pressed', 'true');
    expect(result.mutate).toHaveBeenLastCalledWith({ id: 'wf-1', send_to_me: false, empty_fields: true });
  });

  it('keeps the chosen state when sending a test to me', async () => {
    const user = userEvent.setup();
    const result = mutationResult({ data: withData(SEND_STEP) });
    mockUseTestWorkflow.mockReturnValue(result);
    renderWithProviders(<TestWorkflowDialog open workflowId="wf-1" onOpenChange={vi.fn()} onFixStep={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Empty fields' }));
    await user.click(screen.getByRole('button', { name: 'Send a test to me' }));

    expect(result.mutate).toHaveBeenLastCalledWith(
      { id: 'wf-1', send_to_me: true, empty_fields: true },
      expect.anything(),
    );
  });
});
