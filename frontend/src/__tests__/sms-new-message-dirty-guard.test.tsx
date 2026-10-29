/**
 * Mobile slice 43: the New-message dialog does not discard a typed message without asking.
 *
 * Before this, Cancel, Escape and a tap on the scrim all closed it and the half-written text was
 * gone. A clean dialog (nothing typed) still closes at once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { renderWithProviders, communicationSectionAbility } from './helpers';
import { SmsInboxView } from '@/components/communication/phone/SmsInboxView';
import type { MessageThread } from '@/lib/api/communication';

const mockApi = vi.mocked(api);

function Harness() {
  const [threads, setThreads] = useState<MessageThread[]>([]);
  return <SmsInboxView threads={threads} setThreads={setThreads} onToast={() => {}} />;
}

async function openComposeToNumber() {
  fireEvent.click(await screen.findByRole('button', { name: /new/i }));
  fireEvent.change(screen.getByLabelText('To phone number'), { target: { value: '(201) 555-0123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Use number' }));
  return screen.getByPlaceholderText('Write a message to (201) 555-0123…');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/organization') return { data: { phone_connected: true, ctm_account_id: true, ctm_sms_ready: true } };
    if (url === '/api/communication/contacts') return { data: { contacts: [] } };
    if (url === '/api/communication/agents') return { data: { agents: [] } };
    if (url === '/api/communication/threads') return { data: { threads: [] } };
    if (url === '/api/communication/numbers') {
      return { data: { numbers: [{ id: 'n1', e164: '+15512827064', sms_enabled: true, created_at: '2026-07-01T00:00:00Z' }] } };
    }
    return { data: {} };
  });
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: {
        id: '00000000-0000-0000-0000-000000000001',
        email: 'admin@test.com',
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        org_is_demo: true,
        organization_id: 'org-demo',
        org_features: ['phone'],
      },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    }),
  );
});

describe('NewMessageDialog dirty guard', () => {
  it('Cancel after typing a message asks first; Keep editing keeps the text', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />, { ability: communicationSectionAbility() });
    const box = await openComposeToNumber();
    fireEvent.change(box, { target: { value: 'Half a thought' } });

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByPlaceholderText('Write a message to (201) 555-0123…')).toHaveValue('Half a thought');
  });

  it('Escape after typing a message asks first; Discard closes it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />, { ability: communicationSectionAbility() });
    const box = await openComposeToNumber();
    fireEvent.change(box, { target: { value: 'Half a thought' } });

    await user.keyboard('{Escape}');
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(screen.queryByPlaceholderText('Write a message to (201) 555-0123…')).not.toBeInTheDocument();
  });

  it('closes at once when nothing was typed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />, { ability: communicationSectionAbility() });
    const box = await openComposeToNumber();
    expect(box).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Discard your changes?')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Write a message to (201) 555-0123…')).not.toBeInTheDocument();
  });
});
