import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import TestWorkflowDialog from './TestWorkflowDialog';
import { useTestWorkflow, type DryRunStep, type TestWorkflowResult } from '@/lib/api/workflows';

vi.mock('@/lib/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/workflows')>();
  return { ...actual, useTestWorkflow: vi.fn() };
});

const mockUseTestWorkflow = vi.mocked(useTestWorkflow);

const ALL_OUTCOMES: DryRunStep[] = [
  {
    step_index: 0,
    step_type: 'SEND_TEXT',
    outcome: 'would_send',
    detail: 'Would send to the customer',
    rendered: { body: 'Hi Sarah, thanks for choosing us!' },
  },
  { step_index: 1, step_type: 'WAIT', outcome: 'would_wait', detail: '1 day' },
  {
    step_index: 2,
    step_type: 'STOP_IF',
    outcome: 'would_check',
    detail: 'Keeps going unless the invoice is paid',
  },
  { step_index: 3, step_type: 'SEND_EMAIL', outcome: 'needs_setup', detail: 'Add a subject' },
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

function withData(steps: DryRunStep[], delivered: string[] = []): TestWorkflowResult {
  return { steps, delivered };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TestWorkflowDialog — the four outcome kinds', () => {
  it('renders would_send, would_wait, would_check and needs_setup', () => {
    mockUseTestWorkflow.mockReturnValue(mutationResult({ data: withData(ALL_OUTCOMES) }));
    renderWithProviders(
      <TestWorkflowDialog open workflowId="wf-1" onOpenChange={vi.fn()} onFixStep={vi.fn()} />,
    );

    expect(screen.getByText('Would send')).toBeInTheDocument();
    expect(screen.getByText('Would send to the customer')).toBeInTheDocument();
    expect(screen.getByText('Waits')).toBeInTheDocument();
    expect(screen.getByText('Waits 1 day here')).toBeInTheDocument();
    expect(screen.getByText('Guard check')).toBeInTheDocument();
    expect(screen.getByText('Keeps going unless the invoice is paid')).toBeInTheDocument();
    expect(screen.getByText('Needs setup')).toBeInTheDocument();
    expect(screen.getByText('Add a subject')).toBeInTheDocument();
  });

  it('opens on mount and calls useTestWorkflow with send_to_me: false', () => {
    const mutate = vi.fn();
    mockUseTestWorkflow.mockReturnValue(mutationResult({ mutate, data: withData(ALL_OUTCOMES) }));
    renderWithProviders(<TestWorkflowDialog open workflowId="wf-1" onOpenChange={vi.fn()} onFixStep={vi.fn()} />);
    expect(mutate).toHaveBeenCalledWith({ id: 'wf-1', send_to_me: false });
  });

  it('the "Preview message" toggle shows/hides the rendered body', async () => {
    mockUseTestWorkflow.mockReturnValue(mutationResult({ data: withData(ALL_OUTCOMES) }));
    renderWithProviders(<TestWorkflowDialog open workflowId="wf-1" onOpenChange={vi.fn()} onFixStep={vi.fn()} />);

    expect(screen.queryByText('Hi Sarah, thanks for choosing us!')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /preview message/i }));
    expect(screen.getByText('Hi Sarah, thanks for choosing us!')).toBeInTheDocument();
  });
});

describe('TestWorkflowDialog — needs_setup Fix it', () => {
  it('closes the dialog and invokes onFixStep with the step index', async () => {
    mockUseTestWorkflow.mockReturnValue(mutationResult({ data: withData(ALL_OUTCOMES) }));
    const onOpenChange = vi.fn();
    const onFixStep = vi.fn();
    renderWithProviders(
      <TestWorkflowDialog open workflowId="wf-1" onOpenChange={onOpenChange} onFixStep={onFixStep} />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Fix it' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onFixStep).toHaveBeenCalledWith(3);
  });
});

describe('TestWorkflowDialog — send a test to me', () => {
  it('re-calls the mutation with send_to_me: true', async () => {
    const mutate = vi.fn();
    mockUseTestWorkflow.mockReturnValue(mutationResult({ mutate, data: withData(ALL_OUTCOMES) }));
    renderWithProviders(<TestWorkflowDialog open workflowId="wf-1" onOpenChange={vi.fn()} onFixStep={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /send a test to me/i }));

    expect(mutate).toHaveBeenLastCalledWith(
      { id: 'wf-1', send_to_me: true },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it('never offers a real-customer send affordance', () => {
    mockUseTestWorkflow.mockReturnValue(mutationResult({ data: withData(ALL_OUTCOMES) }));
    renderWithProviders(<TestWorkflowDialog open workflowId="wf-1" onOpenChange={vi.fn()} onFixStep={vi.fn()} />);
    expect(screen.queryByText(/send to customer/i)).not.toBeInTheDocument();

    const dialog = screen.getByRole('dialog');
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.some((b) => /send to (the )?customer/i.test(b.textContent ?? ''))).toBe(false);
  });
});
