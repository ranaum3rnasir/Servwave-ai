import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import WorkflowSettings from './WorkflowSettings';
import { useDeleteWorkflow } from '@/lib/api/workflows';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('@/lib/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/workflows')>();
  return { ...actual, useDeleteWorkflow: vi.fn() };
});

const mockUseDeleteWorkflow = vi.mocked(useDeleteWorkflow);

function mutationResult(overrides: Record<string, unknown> = {}) {
  return { mutate: vi.fn(), isPending: false, ...overrides } as unknown as ReturnType<typeof useDeleteWorkflow>;
}

function props(overrides: Partial<React.ComponentProps<typeof WorkflowSettings>> = {}) {
  return {
    id: 'wf-1',
    name: 'Review request follow-up',
    onSetName: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkflowSettings — name', () => {
  it('propagates name edits', async () => {
    const onSetName = vi.fn();
    mockUseDeleteWorkflow.mockReturnValue(mutationResult());
    renderWithProviders(<WorkflowSettings {...props({ onSetName })} />);

    await userEvent.type(screen.getByLabelText('Automation name (Settings)'), '!');
    expect(onSetName).toHaveBeenCalled();
  });
});

describe('WorkflowSettings — the per-automation send window is gone', () => {
  it('renders no send-window control anywhere on the surface', () => {
    mockUseDeleteWorkflow.mockReturnValue(mutationResult());
    renderWithProviders(<WorkflowSettings {...props()} />);

    expect(screen.queryByText(/when can it send/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /business hours/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /any time/i })).not.toBeInTheDocument();
  });

  it('the props type no longer accepts sendWindow/onSetSendWindow at all (narrowed, not just unused)', () => {
    type Props = React.ComponentProps<typeof WorkflowSettings>;
    type StillHasSendWindow = 'sendWindow' extends keyof Props ? true : false;
    type StillHasSetter = 'onSetSendWindow' extends keyof Props ? true : false;
    const sendWindowGone: StillHasSendWindow = false;
    const setterGone: StillHasSetter = false;
    expect([sendWindowGone, setterGone]).toEqual([false, false]);
  });
});

describe('WorkflowSettings — delete flow', () => {
  it('flows through the confirm dialog before calling deleteWorkflow, then navigates to /automations', async () => {
    const remove = mutationResult({
      mutate: vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
    });
    mockUseDeleteWorkflow.mockReturnValue(remove);
    renderWithProviders(<WorkflowSettings {...props()} />);

    await userEvent.click(screen.getByRole('button', { name: /delete this automation/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete "Review request follow-up"?')).toBeInTheDocument();
    expect(within(dialog).getByText('Its activity history is removed too. This can\'t be undone.')).toBeInTheDocument();
    expect(remove.mutate).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(remove.mutate).toHaveBeenCalledWith('wf-1', expect.objectContaining({ onSuccess: expect.any(Function) }));
    expect(mockNavigate).toHaveBeenCalledWith('/automations');
  });

  it('cancelling the confirm dialog does not delete', async () => {
    const remove = mutationResult();
    mockUseDeleteWorkflow.mockReturnValue(remove);
    renderWithProviders(<WorkflowSettings {...props()} />);

    await userEvent.click(screen.getByRole('button', { name: /delete this automation/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(remove.mutate).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('disables delete for an unsaved (never-persisted) draft', () => {
    mockUseDeleteWorkflow.mockReturnValue(mutationResult());
    renderWithProviders(<WorkflowSettings {...props({ id: undefined })} />);
    expect(screen.getByRole('button', { name: /delete this automation/i })).toBeDisabled();
  });
});
