import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import { renderInbox, serveInbox } from '@/__tests__/harness/inboxPage';
import { buildAbility } from '@/lib/ability';
import type { MailboxList, Email } from '@/lib/api/communication';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';

vi.mock('@/lib/api/communication', async (importOriginal) =>
  (await import('@/__tests__/harness/inboxApiStub')).communicationStubs(await importOriginal<typeof import('@/lib/api/communication')>()));
vi.mock('@/lib/entitlements', async (importOriginal) =>
  (await import('@/__tests__/harness/inboxApiStub')).inboxEntitlements(await importOriginal<typeof import('@/lib/entitlements')>()));

const answer = vi.hoisted(() => ({ held: [] as { id: string; name: string; unread: number }[] }));

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

describe('inboxHandedMailbox', () => {
  // Roles & Permissions, PRD 10, slice S10.22 - a mailbox handed to a person shows in THEIR mailbox list on the ROUTED Email
  // page (/communication/inbox renders this InboxPage) as "<owner>'s mailbox", under the original owner's name, with its own
  // unread count, and a mailbox that was moved on to someone else is simply not in the previous holder's list. The page runs
  // on the real mailbox-list and email-list queries; only the network layer answers. (The server's rule, that the holder
  // reads all of it and replies from their own address, is proved against the real routes in the backend
  // `permission-mailbox-handover-person-db.test.ts`.)

  const ability = buildAbility([
    { action: 'read', subject: 'Communication' },
    { action: 'update', subject: 'Communication' },
    { action: 'access_inbox', subject: 'Communication' },
  ]);

  const renderPage = () => renderInbox({ ability, entry: '/communication/inbox' });

  beforeEach(() => {
    answer.held = [];
    serveInbox({
      mailboxes: (params): MailboxList => ({
        scope: 'attached', selected: (params.selected as string | undefined) ?? 'mine', selected_label: null, selected_unread: 0, total_unread: 5,
        mine: { id: 'box-mine', unread: 3 }, held: answer.held, main: null, people: null,
      }),
      otherwise: { emails: [] },
    });
  });

  describe('the Email page: a mailbox handed to the person', () => {
    it('lists each one under its original owner\'s name, after "My mailbox", with its own unread count', async () => {
      answer.held = [
        { id: 'box-jane', name: 'Jane Smith', unread: 2 },
        { id: 'box-omar', name: 'Omar Other', unread: 0 },
      ];
      renderPage();

      const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
      const jane = await within(mailboxes).findByRole('button', { name: /Jane Smith's mailbox/ });
      expect(jane).toHaveTextContent('2');
      expect(within(mailboxes).getByRole('button', { name: /Omar Other's mailbox/ })).toBeInTheDocument();
      const labels = within(mailboxes).getAllByRole('button').map((b) => b.textContent ?? '');
      expect(labels[0]).toMatch(/^My mailbox/);
      expect(labels[1]).toMatch(/^Jane Smith's mailbox/);
    });

    it('shows nothing extra to a person who no longer holds it (it was moved on): only "My mailbox"', async () => {
      renderPage();

      const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
      expect(await within(mailboxes).findByRole('button', { name: /My mailbox/ })).toBeInTheDocument();
      expect(within(mailboxes).getAllByRole('button')).toHaveLength(1);
      expect(within(mailboxes).queryByRole('button', { name: /'s mailbox/ })).toBeNull();
    });

    it('names no email provider', async () => {
      answer.held = [{ id: 'box-jane', name: 'Jane Smith', unread: 2 }];
      renderPage();
      const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
      await within(mailboxes).findByRole('button', { name: /Jane Smith's mailbox/ });
      expect(mailboxes.textContent ?? '').not.toMatch(/resend|supabase|ctm|calltracking|render|twilio|stripe/i);
    });
  });
});

describe('inboxMailboxesQuery', () => {
  // Roles & Permissions, PRD 10, slice S10.7 - the Email page against the REAL mailbox-list and email-list queries.
  // inboxMailboxes.test.tsx stubs both hooks and answers at once, so it cannot see what a real query does while the next
  // answer is loading: the list keeps showing the previous answer, and the page must not read that as "the server refused
  // the mailbox" and send the person back to their own.

  const ability = buildAbility([
    { action: 'read', subject: 'Communication' },
    { action: 'update', subject: 'Communication' },
    { action: 'access_inbox', subject: 'Communication' },
  ]);

  let calls: ReturnType<typeof serveInbox>['reads'] = [];

  const WIDE = (selected: string): MailboxList => ({
    scope: 'all', selected, selected_label: selected === 'box-handed' ? "Jane Smith's mailbox" : null,
    selected_unread: 2, total_unread: 9, mine: { id: 'box-mine', unread: 1 },
    held: [{ id: 'box-handed', name: 'Jane Smith', unread: 2 }], main: { id: 'box-main', unread: 2 }, people: null,
  });

  // Every answer arrives late, as it does over a network, so there is a stretch where the new key has no answer yet.
  const later = <T,>(body: T) => new Promise<T>((resolve) => { setTimeout(() => resolve(body), 60); });

  function Where() {
    const location = useLocation();
    return <output data-testid="where">{location.pathname + location.search}</output>;
  }

  beforeEach(() => {
    calls = serveInbox({
      mailboxes: (params) => later(WIDE((params.selected as string | undefined) ?? 'mine')),
      emails: () => later([]),
      otherwise: () => later({ emails: [] }),
    }).reads;
  });

  describe('the Email page: choosing a mailbox while the next answer loads', () => {
    it('keeps the mailbox the person clicked and lists its mail, instead of snapping back to "My mailbox"', async () => {
      const user = userEvent.setup();
      renderInbox({ ability, entry: '/communication/inbox', beside: <Where /> });

      await user.click(await screen.findByRole('button', { name: /Jane Smith's mailbox/ }));
      await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('?mailbox=box-handed'));

      // Wait past the late answers: the address must still name the mailbox, and its mail must have been asked for.
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/emails') && c.params.mailbox === 'box-handed')).toBe(true));
      expect(screen.getByTestId('where')).toHaveTextContent('/communication/inbox?mailbox=box-handed');
      expect(screen.getByRole('button', { name: /Jane Smith's mailbox/ })).toHaveAttribute('aria-pressed', 'true');
    });

    it('asks for no mail of the new mailbox before it knows whether the server lets the person open it', async () => {
      const user = userEvent.setup();
      renderInbox({ ability, entry: '/communication/inbox', beside: <Where /> });
      await user.click(await screen.findByRole('button', { name: /Main mailbox/ }));
      await waitFor(() => expect(calls.some((c) => c.url.endsWith('/emails') && c.params.mailbox === 'box-main')).toBe(true));
      expect(screen.getByTestId('where')).toHaveTextContent('?mailbox=box-main');
    });
  });
});

describe('inboxRecordTie', () => {
  // Roles & Permissions, PRD 10, slice S10.9 - the Email page names the job or lead a record conversation is about.
  // The server answers at the API layer (the REAL email list query runs), so what is on screen is what the server sent:
  // the number to show and the record to link to. Nothing here works the record out.

  const ability = buildAbility([
    { action: 'read', subject: 'Communication' },
    { action: 'access_inbox', subject: 'Communication' },
  ]);

  const mail = (over: Partial<Email> & { id: string; subject: string }): Email => ({
    account: 'system', from: { name: 'Pat Payer', email: 'pat@example.com' }, to: 'office@example.com', snippet: 'Thanks, that works.',
    body: ['Thanks, that works.'], at: '9:41 AM', ts: 1, unread: true, starred: false, folder: 'inbox', direction: 'in', ...over,
  });

  const ROWS: Email[] = [
    mail({ id: 'on-job', subject: 'Re: Your appointment', threadId: 't1', ts: 5, recordTie: { kind: 'job', id: 'job-1', label: 'J-1042' } }),
    mail({ id: 'on-lead', subject: 'Re: Your estimate', threadId: 't2', ts: 4, recordTie: { kind: 'lead', id: 'lead-1', label: 'L-0377' } }),
    mail({ id: 'plain', subject: 'Question about pricing', threadId: 't3', ts: 3 }),
  ];

  const LIST: MailboxList = {
    scope: 'attached', selected: 'mine', selected_label: null, selected_unread: 3, total_unread: 3,
    mine: { id: 'box-mine', unread: 3 }, held: [], main: null, people: null,
  };

  beforeEach(() => {
    serveInbox({ mailboxes: LIST, emails: ROWS, otherwise: { emails: ROWS } });
  });

  const rowOf = async (subject: string) => {
    const row = (await screen.findByText(subject)).closest('[data-email-row]');
    expect(row).not.toBeNull();
    return row as HTMLElement;
  };

  describe('the Email page names the job or lead a record conversation belongs to', () => {
    it('shows the job number and the lead number on their rows, and nothing on a conversation about no record', async () => {
      renderInbox({ ability, entry: '/communication/inbox' });

      expect(within(await rowOf('Re: Your appointment')).getByText('J-1042')).toBeInTheDocument();
      expect(within(await rowOf('Re: Your estimate')).getByText('L-0377')).toBeInTheDocument();
      const plain = within(await rowOf('Question about pricing'));
      expect(plain.queryByText(/J-\d|L-\d/)).not.toBeInTheDocument();
      expect(plain.queryByText('no job')).not.toBeInTheDocument();
    });

    it('links the open conversation to its job or lead, from the number the server sent', async () => {
      const user = userEvent.setup();
      renderInbox({ ability, entry: '/communication/inbox' });

      await user.click(await screen.findByText('Re: Your appointment'));
      expect(await screen.findByRole('link', { name: /J-1042/ })).toHaveAttribute('href', '/jobs/job-1');

      await user.click(await screen.findByText('Re: Your estimate'));
      expect(await screen.findByRole('link', { name: /L-0377/ })).toHaveAttribute('href', '/leads/lead-1');
    });
  });
});
