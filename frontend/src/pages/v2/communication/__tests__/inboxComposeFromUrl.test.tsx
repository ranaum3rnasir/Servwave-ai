/// <reference types="@testing-library/jest-dom/vitest" />
// V7-07a (C-27): the Email page opens its compose window from the address (`?compose=1&to=&subject=&body=...`), once,
// fills it, and removes what could hold a pay link (subject, body) from the address. The mailbox parameter is left alone.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { useAuthStore } from '@/stores/auth.store';
import api from '@/lib/axios';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
  useEntitlementsReady: () => true,
}));

import InboxPage from '@/pages/v2/communication/InboxPage';

function Probe() {
  return <output data-testid="address">{useLocation().search}</output>;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockImplementation(((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u1', email: 'jane@test.com', first_name: 'Jane', last_name: 'Smith', role: 'DISPATCHER', organization_id: 'org-1', org_features: ['email', 'phone'] },
      isAuthenticated: true, isLoading: false, error: null,
    })) as typeof useAuthStore,
  );
  vi.mocked(api.get).mockImplementation(async (url: string, config?: { params?: unknown }) => {
    if (url === '/api/communication/sending-identity') {
      return { data: { status: 'active', address: 'jane.acme@mail.example.test', name: 'Jane at Acme', sendingEnabled: true } };
    }
    if (url === '/api/communication/emails') return { data: { emails: [] } };
    if (url === '/api/communication/mailboxes') {
      const selected = (config?.params as { selected?: string } | undefined)?.selected ?? 'mine';
      return { data: { scope: 'attached', selected, selected_label: null, selected_unread: 0, total_unread: 0, mine: { id: 'box-mine', unread: 0 }, held: [], main: { id: 'box-main', unread: 0 }, people: null } };
    }
    if (url === '/api/communication/email-groups') return { data: { groups: [] } };
    if (url === '/api/communication/forward-rules') return { data: { rules: [] } };
    if (url === '/api/communication/team-members') return { data: { members: [] } };
    return { data: {} };
  });
});

const ENTRY =
  '/communication/inbox?compose=1&to=dana%40example.com&subject=Bank+payment+failed+-+Invoice+INV-7&body=Pay+here%3A+https%3A%2F%2Fpay.test%2Fp%2Ftok&customerId=c-1&invoiceId=i-1&mailbox=box-main';

function open(entry = ENTRY) {
  renderWithProviders(<><InboxPage /><Probe /></>, { ability, initialEntries: [entry] });
}

describe('Email page compose-by-address', () => {
  it('opens the compose window filled with the recipient, subject and body', async () => {
    open();
    expect(await screen.findByPlaceholderText('Recipients')).toHaveValue('dana@example.com');
    expect(screen.getByPlaceholderText('Subject')).toHaveValue('Bank payment failed - Invoice INV-7');
    expect(document.querySelector('textarea')).toHaveValue('Pay here: https://pay.test/p/tok');
  });

  it('removes subject, body and the other compose parameters from the address, and keeps the mailbox', async () => {
    open();
    await screen.findByPlaceholderText('Recipients');
    await waitFor(() => expect(screen.getByTestId('address').textContent).not.toContain('body'));
    const search = screen.getByTestId('address').textContent ?? '';
    expect(search).not.toContain('subject');
    expect(search).not.toContain('pay.test');
    expect(search).not.toContain('compose');
    expect(search).toContain('mailbox=box-main');
  });

  it('opens it once: closing the window does not bring it back', async () => {
    open();
    await screen.findByPlaceholderText('Recipients');
    await waitFor(() => expect(screen.getByTestId('address').textContent).not.toContain('compose'));
    screen.getByRole('button', { name: 'Close' }).click();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByPlaceholderText('Recipients')).not.toBeInTheDocument();
  });

  it('does nothing without compose=1', async () => {
    open('/communication/inbox?to=dana%40example.com');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByPlaceholderText('Recipients')).not.toBeInTheDocument();
  });
});
