import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { CopilotContext } from '@/components/copilot/CopilotContext';
import type { CopilotSessionApi } from '@/components/copilot/voice/useServyCopilot';
import CopilotPanel from '@/components/copilot/CopilotPanel';
import { useCopilotStore } from '@/stores/copilotStore';

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
  useCopilotStore.setState({
    open: true,
    mode: 'text',
    micActive: false,
    transcript: [],
    interim: { user: '', assistant: '' },
    pendingApproval: null,
    error: null,
    statusText: null,
  });
});

describe('CopilotPanel', () => {
  it('renders nothing when closed', () => {
    useCopilotStore.setState({ open: false });
    const { container } = renderWith(<CopilotPanel />, mockApi());
    expect(container.firstChild).toBeNull();
  });

  it('renders as a complementary region with a labeled composer', () => {
    renderWith(<CopilotPanel />, mockApi());
    expect(screen.getByRole('complementary', { name: 'Servy copilot' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Message Servy' })).toBeInTheDocument();
  });

  it('shows example prompts that send a message', async () => {
    const user = userEvent.setup();
    const api = mockApi();
    renderWith(<CopilotPanel />, api);
    const example = screen.getByRole('button', { name: /morning briefing/i });
    await user.click(example);
    expect(api.sendText).toHaveBeenCalledWith("What's my morning briefing?");
  });

  it('closes via the close button', async () => {
    const user = userEvent.setup();
    renderWith(<CopilotPanel />, mockApi());
    await user.click(screen.getByRole('button', { name: 'Close Servy' }));
    expect(useCopilotStore.getState().open).toBe(false);
  });
});
