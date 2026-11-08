import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { CopilotContext } from '@/components/copilot/CopilotContext';
import type { CopilotSessionApi } from '@/components/copilot/voice/useServyCopilot';
import ApprovalCard from '@/components/copilot/ApprovalCard';
import { useCopilotStore } from '@/stores/copilotStore';
import { prepareAction } from '@/components/copilot/tools/approval';

function mockApi(): CopilotSessionApi {
  return {
    ensureConnected: vi.fn(),
    retry: vi.fn(),
    sendText: vi.fn(),
    startVoice: vi.fn(),
    stopVoice: vi.fn(),
    stopSpeaking: vi.fn(),
    confirmApproval: vi.fn(),
    cancelApproval: vi.fn(),
    disconnect: vi.fn(),
  };
}

function renderWith(ui: ReactElement, api: CopilotSessionApi) {
  return render(<CopilotContext.Provider value={api}>{ui}</CopilotContext.Provider>);
}

beforeEach(() => {
  useCopilotStore.setState({ pendingApproval: null });
});

describe('ApprovalCard', () => {
  it('renders nothing when there is no pending approval', () => {
    const { container } = renderWith(<ApprovalCard />, mockApi());
    expect(container.firstChild).toBeNull();
  });

  it('shows the resolved payload, focuses Confirm, and wires the buttons', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    useCopilotStore.setState({
      pendingApproval: {
        action: prepareAction({
          capabilityId: 'create_lead',
          toolName: 'create_lead',
          summary: 'Create a lead for John Doe',
          detail: [{ label: 'Request', value: 'AC not cooling' }],
          endpoint: { method: 'POST', path: '/api/leads' },
          payload: { service_request: 'AC not cooling' },
        }),
      },
    });

    renderWith(<ApprovalCard />, api);

    expect(screen.getByText(/Create a lead for John Doe/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is saved until you confirm/)).toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toHaveFocus();

    await user.click(confirm);
    expect(api.confirmApproval).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.cancelApproval).toHaveBeenCalledTimes(1);
  });
});
