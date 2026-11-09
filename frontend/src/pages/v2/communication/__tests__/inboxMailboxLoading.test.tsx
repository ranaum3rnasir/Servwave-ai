import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { renderInbox, serveInbox, signInDispatcher } from '@/__tests__/harness/inboxPage';
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

// Roles & Permissions, PRD 10, slice S10.7 (scenario pass 3 fix) - picking a mailbox on the ROUTED Email page
// (/communication/inbox renders this InboxPage).
//
// The REAL data hooks run; only the network layer is faked, and each mailbox's answer is held back until the test lets it
// go, as the hosted server does for a couple of seconds. While a picked mailbox loads, the list says it is loading: it
// never reads "Nothing here." (which a person takes for an empty mailbox) and never shows the previous mailbox's mail under
// the new mailbox's name. A mailbox that really is empty still reads "Nothing here."

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
  { action: 'access_inbox', subject: 'Communication' },
]);

const mail = (id: string, subject: string) => ({
  id, threadId: `t-${id}`, account: 'user', from: { name: 'Maria Garcia', email: 'maria.garcia@example.com' },
  to: 'office@example.test', subject, snippet: `${subject} snippet`, body: [subject], at: 'May 1', ts: 1,
  unread: false, starred: false, folder: 'inbox', direction: 'in',
});

type Held = { resolve: (rows: unknown[]) => void };
/** The emails answer per mailbox: a mailbox in `held` waits for the test, any other answers at once. */
let rowsOf: Record<string, unknown[]>;
let held: Record<string, Held | undefined>;
let heldMailboxList: Held | undefined;

function answerNetwork() {
  serveInbox({
    mailboxes: (params) => {
      const selected = (params.selected as string | undefined) ?? 'mine';
      const body = {
        scope: 'attached', selected, selected_label: null, selected_unread: 0, total_unread: 0,
        mine: { id: 'box-mine', unread: 0 }, held: [{ id: 'box-handed', name: 'Jane Smith', unread: 0 }, { id: 'box-empty', name: 'Empty Person', unread: 0 }],
        main: null, people: null,
      };
      if (heldMailboxList && selected !== 'mine') return new Promise((resolve) => { heldMailboxList!.resolve = () => resolve(body); });
      return body;
    },
    emails: (params) => {
      const mailbox = (params.mailbox as string | undefined) ?? 'scope';
      const wait = held[mailbox];
      if (wait) return new Promise<unknown[]>((resolve) => { wait.resolve = (rows) => resolve(rows); });
      return rowsOf[mailbox] ?? [];
    },
    sendingIdentity: { status: 'active', address: 'jane@mail.example.test', name: 'Jane at Acme', sendingEnabled: true },
    myMailbox: { mailbox: { status: 'active', address: 'jane@mail.example.test' } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  rowsOf = { mine: [mail('m1', 'My own mail')], 'box-handed': [mail('h1', 'Handed mail')], 'box-empty': [] };
  held = {};
  heldMailboxList = undefined;
  signInDispatcher();
  answerNetwork();
});

const render = (entry = '/communication/inbox') => renderInbox({ ability, entry });
const loading = () => screen.queryByRole('status', { name: 'Loading mail' });

describe('the Email page while a picked mailbox loads', () => {
  it('says it is loading, not "Nothing here.", and never shows the last mailbox\'s mail, until the picked mailbox answers', async () => {
    const user = userEvent.setup();
    held['box-handed'] = { resolve: () => undefined };
    render();
    expect(await screen.findByText('My own mail')).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /Jane Smith's mailbox/ }));

    await waitFor(() => expect(loading()).toBeInTheDocument());
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();
    expect(screen.queryByText('My own mail')).not.toBeInTheDocument();

    await act(async () => held['box-handed']!.resolve([mail('h1', 'Handed mail')]));
    expect(await screen.findByText('Handed mail')).toBeInTheDocument();
    expect(loading()).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();
  });

  it('says it is loading while the page address\'s mailbox is still being looked up, and again never "Nothing here."', async () => {
    heldMailboxList = { resolve: () => undefined };
    render('/communication/inbox?mailbox=box-handed');

    await waitFor(() => expect(loading()).toBeInTheDocument());
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();

    await act(async () => heldMailboxList!.resolve([]));
    expect(await screen.findByText('Handed mail')).toBeInTheDocument();
    expect(loading()).not.toBeInTheDocument();
  });

  it('still reads "Nothing here." for a mailbox that really is empty', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText('My own mail');

    await user.click(await screen.findByRole('button', { name: /Empty Person's mailbox/ }));

    expect(await screen.findByText('Nothing here.')).toBeInTheDocument();
    expect(loading()).not.toBeInTheDocument();
    expect(screen.queryByText('My own mail')).not.toBeInTheDocument();
  });

  it('shows the mail of a mailbox it has already read at once when the person goes back to it', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText('My own mail');
    await user.click(await screen.findByRole('button', { name: /Jane Smith's mailbox/ }));
    await screen.findByText('Handed mail');

    await user.click(screen.getByRole('button', { name: /My mailbox/ }));
    expect(await screen.findByText('My own mail')).toBeInTheDocument();
    expect(screen.queryByText('Handed mail')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing here.')).not.toBeInTheDocument();
  });
});
