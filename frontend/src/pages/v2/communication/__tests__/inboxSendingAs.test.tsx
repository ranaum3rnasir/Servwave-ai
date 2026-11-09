import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { mailboxBody, renderInbox, serveInbox, signInDispatcher } from '@/__tests__/harness/inboxPage';
import { buildAbility } from '@/lib/ability';
import userEvent from '@testing-library/user-event';
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

// Roles & Permissions, PRD 10, slice S10.11 - the "Sending as" line on the ROUTED Email page (/communication/inbox renders
// this InboxPage), in the compose window and in the inline reply.
//
// The REAL data hooks run; only the network layer is faked (the S10.7 lesson: stubbing the hooks hides what a real query
// does). Every email a person writes by hand goes out from their OWN address, so the line shows that address and the name
// the recipient sees, in a new email and in a reply to a conversation of any mailbox, and a person with no address of
// their own reads the address-needed sentence with Send disabled and its reason readable by a screen reader.

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'create', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

const NEEDED_SENTENCE = "You don't have an email address yet. An admin needs to set one before you can send email.";
const OWN_ADDRESS = 'jane.smith.acme@mail.example.test';
const OWN_NAME = 'Jane Smith at Acme';

type Identity = { status: 'active' | 'address_needed'; address: string | null; name: string | null; sendingEnabled: boolean };
const ACTIVE: Identity = { status: 'active', address: OWN_ADDRESS, name: OWN_NAME, sendingEnabled: true };
const NEEDED: Identity = { status: 'address_needed', address: null, name: null, sendingEnabled: true };

// A conversation sitting in somebody else's mailbox (a colleague's, or the main one): the reply still goes out as the sender.
const INBOUND = {
  id: 'e1', threadId: 't1', account: 'user',
  from: { name: 'Maria Garcia', email: 'maria.garcia@example.com' }, to: 'colleague.jones.acme@mail.example.test',
  subject: 'Quote request', snippet: 'Can you quote the vault hardware?', body: ['Can you quote the vault hardware?'],
  at: 'May 1', ts: 1, unread: false, starred: false, folder: 'inbox', direction: 'in',
};

let identity: Identity = ACTIVE;
let assignee: string | null = null;
const posts: { url: string; body: unknown }[] = [];

function answerNetwork() {
  serveInbox({
    sendingIdentity: () => identity,
    myMailbox: () => ({ mailbox: { status: identity.status, address: identity.address } }),
    emails: () => [{ ...INBOUND, threadAssignedToUserId: assignee }],
    mailboxes: (params) => mailboxBody(params),
    teamMembers: [{ id: 'u2', name: 'Colin Jones', email: 'colin@test.com', role: 'DISPATCHER' }],
  });
  vi.mocked(api.post).mockImplementation(async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: { email: {} } };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  posts.length = 0;
  identity = ACTIVE;
  assignee = null;
  signInDispatcher();
  answerNetwork();
});

async function openCompose() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderInbox({ ability, entry: '/communication/inbox' });
  await user.click(await screen.findByRole('button', { name: /Compose/ }));
  return user;
}

async function openReply() {
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  renderInbox({ ability, entry: '/communication/inbox' });
  await user.click(await screen.findByText('Quote request'));
  // Reply is in the toolbar and again under the thread: either opens the inline composer.
  await user.click((await screen.findAllByRole('button', { name: /^Reply$/ })).at(-1)!);
  return user;
}

const sendButton = () => screen.getByRole('button', { name: /^Send$/ });

describe('the Email page: "Sending as" in a new email', () => {
  it('shows the sender\'s own address and the name the recipient will see, and Send works', async () => {
    await openCompose();

    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(within(line).getByText(OWN_NAME)).toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
    // No From choice: the line is text, not a picker.
    expect(within(line).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(line).queryByRole('button')).not.toBeInTheDocument();
  });

  it('reads the address-needed sentence for a person with no address, and disables Send with the reason readable', async () => {
    identity = NEEDED;
    await openCompose();

    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(NEEDED_SENTENCE)).toBeInTheDocument());
    const send = sendButton();
    expect(send).toBeDisabled();
    // The design system's disabled-with-reason pattern: the reason is the button's accessible description.
    expect(send).toHaveAccessibleDescription(NEEDED_SENTENCE);
    expect(within(line).queryByText(OWN_ADDRESS, { exact: false })).not.toBeInTheDocument();
    expect(posts).toEqual([]);
  });

  it('keeps Send disabled, with its reason, while the company has outgoing email off', async () => {
    identity = { ...ACTIVE, sendingEnabled: false };
    await openCompose();

    await waitFor(() => expect(sendButton()).toBeDisabled());
    expect(sendButton()).toHaveAccessibleDescription('Email sending is off for this organization');
    // The address is still the person's own.
    expect(screen.getByText(OWN_NAME)).toBeInTheDocument();
  });
});

describe('the Email page: "Sending as" in a reply', () => {
  it('shows the sender\'s own address in a conversation that sits in someone else\'s mailbox', async () => {
    await openReply();

    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(OWN_ADDRESS, { exact: false })).toBeInTheDocument());
    expect(within(line).getByText(OWN_NAME)).toBeInTheDocument();
    // The mailbox the conversation sits in is not the one the reply goes out from.
    expect(line).not.toHaveTextContent('colleague.jones.acme');
    expect(sendButton()).toBeEnabled();
  });

  it('reads the address-needed sentence and disables Send for a person with no address', async () => {
    identity = NEEDED;
    await openReply();

    const line = (await screen.findByText('Sending as')).parentElement!;
    await waitFor(() => expect(within(line).getByText(NEEDED_SENTENCE)).toBeInTheDocument());
    expect(sendButton()).toBeDisabled();
    expect(sendButton()).toHaveAccessibleDescription(NEEDED_SENTENCE);
  });
});

describe('the main mailbox: a conversation somebody replied first in', () => {
  async function openMailbox(query: string) {
    renderInbox({ ability, entry: `/communication/inbox${query}` });
    return screen.findByText('Quote request');
  }

  it('stays listed, marked with the person who has it', async () => {
    assignee = 'u2';
    await openMailbox('?mailbox=box-main');
    expect(await screen.findByText('Assigned to Colin Jones')).toBeInTheDocument();
  });

  it('reads "you" when the signed-in person has it', async () => {
    assignee = 'u1';
    await openMailbox('?mailbox=box-main');
    expect(await screen.findByText('Assigned to you')).toBeInTheDocument();
  });

  it('shows no mark on a conversation nobody has taken', async () => {
    assignee = null;
    await openMailbox('?mailbox=box-main');
    expect(screen.queryByText(/^Assigned to/)).not.toBeInTheDocument();
  });

  it('shows no mark in the person\'s own mailbox, where every conversation is theirs anyway', async () => {
    assignee = 'u1';
    await openMailbox('');
    expect(screen.queryByText(/^Assigned to/)).not.toBeInTheDocument();
  });
});

describe('copy', () => {
  it('names no email provider or other vendor', async () => {
    identity = NEEDED;
    await openCompose();
    await screen.findByText('Sending as');
    expect(document.body.innerHTML).not.toMatch(/resend|ctm|calltracking|supabase|render\.com|stripe|twilio/i);
  });
});
