import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { mailboxBody, renderInbox, serveInbox, signInDispatcher } from '@/__tests__/harness/inboxPage';
import { buildAbility } from '@/lib/ability';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/lib/entitlements', async (importOriginal) =>
  (await import('@/__tests__/harness/inboxApiStub')).inboxEntitlements(await importOriginal<typeof import('@/lib/entitlements')>()));

// Each test starts from the setup file's signed-in user and bare client calls: reset them here, so a test states its own user
// and answers in its own `beforeEach` (`clearAllMocks` keeps implementations).
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useAuthStore).mockReset();
  vi.mocked(api.get).mockReset();
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.delete).mockReset();
});

describe('inboxComposeFromUrl', () => {
  // V7-07a (C-27): the Email page opens its compose window from the address (`?compose=1&to=&subject=&body=...`), once,
  // fills it, and removes what could hold a pay link (subject, body) from the address. The mailbox parameter is left alone.

  const ability = buildAbility([
    { action: 'read', subject: 'Communication' },
    { action: 'create', subject: 'Communication' },
    { action: 'update', subject: 'Communication' },
    { action: 'access_inbox', subject: 'Communication' },
  ]);

  function Probe() {
    return <output data-testid="address">{useLocation().search}</output>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    signInDispatcher();
    serveInbox({
      sendingIdentity: { status: 'active', address: 'jane.acme@mail.example.test', name: 'Jane at Acme', sendingEnabled: true },
      mailboxes: (params) => mailboxBody(params),
    });
  });

  const ENTRY =
    '/communication/inbox?compose=1&to=dana%40example.com&subject=Bank+payment+failed+-+Invoice+INV-7&body=Pay+here%3A+https%3A%2F%2Fpay.test%2Fp%2Ftok&customerId=c-1&invoiceId=i-1&mailbox=box-main';

  function open(entry = ENTRY) {
    renderInbox({ ability, entry, beside: <Probe /> });
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
});
