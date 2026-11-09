/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.3 - the person's own email address at the top of the ROUTED Email page
// (/communication/inbox renders this InboxPage). An active mailbox shows its address with a copy button; a mailbox in
// "address needed" shows the PRD's sentence and no address; neither shows while the company lacks the Email plan
// feature; and nothing on the page names an email provider.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderInbox } from '@/__tests__/harness/inboxPage';
import { buildAbility } from '@/lib/ability';

const readAbility = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

let mailbox: { status: string; address: string | null } | null = null;

vi.mock('@/lib/api/communication', async (importOriginal) =>
  (await import('@/__tests__/harness/inboxApiStub')).communicationStubs(await importOriginal<typeof import('@/lib/api/communication')>(), {
    leave: ['useMarkEmailThreadUnread'],
    hooks: {
      useEmails: () => ({ data: [] }),
      useMyMailbox: () => ({ data: mailbox === null ? { mailbox: null } : { mailbox } }),
    },
  }));

let emailFeature = true;
vi.mock('@/lib/entitlements', async (importOriginal) =>
  (await import('@/__tests__/harness/inboxApiStub')).inboxEntitlements(await importOriginal<typeof import('@/lib/entitlements')>(), {
    ready: false,
    feature: (key: string) => (key === 'email' ? emailFeature : true),
  }));

const NEEDED_SENTENCE = "You don't have an email address yet. An admin needs to set one before you can send email.";

beforeEach(() => {
  emailFeature = true;
  mailbox = null;
});

describe('the Email page: your own address', () => {
  it('shows the address at the top of the page, with a copy button that copies it', async () => {
    mailbox = { status: 'active', address: 'jane.smith.acme@mail.example.test' };
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    renderInbox({ ability: readAbility });

    expect(await screen.findByText('jane.smith.acme@mail.example.test')).toBeInTheDocument();
    expect(screen.getByText('Your email address')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy your email address' }));

    expect(writeText).toHaveBeenCalledWith('jane.smith.acme@mail.example.test');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy your email address' })).toHaveTextContent('Copied'));
    expect(screen.queryByText(NEEDED_SENTENCE)).not.toBeInTheDocument();
  });

  it('shows the address before the three panes (above the folder list)', async () => {
    mailbox = { status: 'active', address: 'jane.smith.acme@mail.example.test' };
    renderInbox({ ability: readAbility });
    const address = await screen.findByText('jane.smith.acme@mail.example.test');
    const inbox = screen.getByRole('button', { name: /^Drafts/ });
    expect(address.compareDocumentPosition(inbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says "You don\'t have an email address yet..." for a person in "address needed", with no address and no copy button', async () => {
    mailbox = { status: 'address_needed', address: null };
    renderInbox({ ability: readAbility });

    expect(await screen.findByText(NEEDED_SENTENCE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy your email address' })).not.toBeInTheDocument();
    expect(screen.queryByText('Your email address')).not.toBeInTheDocument();
  });

  it('shows nothing about an address for a person who has no mailbox', async () => {
    mailbox = null;
    renderInbox({ ability: readAbility });
    await screen.findByText('Compose');
    expect(screen.queryByText('Your email address')).not.toBeInTheDocument();
    expect(screen.queryByText(NEEDED_SENTENCE)).not.toBeInTheDocument();
  });

  it('shows neither while the company lacks the Email plan feature', async () => {
    emailFeature = false;
    for (const box of [{ status: 'active', address: 'jane.smith.acme@mail.example.test' }, { status: 'address_needed', address: null }]) {
      mailbox = box;
      const { unmount } = renderInbox({ ability: readAbility });
      await screen.findByText('Compose');
      expect(screen.queryByText('jane.smith.acme@mail.example.test')).not.toBeInTheDocument();
      expect(screen.queryByText(NEEDED_SENTENCE)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('names no email provider or other vendor', async () => {
    mailbox = { status: 'address_needed', address: null };
    const { container } = renderInbox({ ability: readAbility });
    await screen.findByText(NEEDED_SENTENCE);
    expect(container.innerHTML).not.toMatch(/resend|ctm|calltracking|supabase|render\.com|stripe|twilio/i);
  });
});
