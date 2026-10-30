/// <reference types="@testing-library/jest-dom/vitest" />
// Roles & Permissions, PRD 10, slice S10.7 - the mailbox list at the top of the ROUTED Email page's left rail
// (/communication/inbox renders this InboxPage): "My mailbox", each mailbox handed to the person, and, under Communication
// scope All, the main mailbox, "All mailboxes" and a searchable picker for one person's mailbox, each with an unread count.
// The chosen mailbox lives in the page address; the folders apply inside it; a company with hundreds of people never gets
// hundreds of rows in the rail.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import type { MailboxList } from '@/lib/api/communication';

const ability = buildAbility([
  { action: 'read', subject: 'Communication' },
  { action: 'update', subject: 'Communication' },
]);

// One array for every render: the page seeds its own state from these, and a fresh array each render would re-seed forever.
const NO_EMAILS: unknown[] = [];
const NOTHING: unknown[] = [];
type ListQuery = { selected: string; search?: string; offset?: number };
const listCalls: ListQuery[] = [];
const emailCalls: (string | null | undefined)[] = [];
let answer: (query: ListQuery) => MailboxList;

vi.mock('@/lib/api/communication', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/communication')>();
  return {
    ...actual,
    useEmails: (_assignment: unknown, mailbox?: string | null) => {
      emailCalls.push(mailbox);
      return { data: NO_EMAILS };
    },
    useMailboxList: (query: ListQuery) => {
      listCalls.push(query);
      const data = answer(query);
      return { data, isPending: data === undefined };
    },
    useEmailGroups: () => ({ data: NOTHING }),
    useForwardRules: () => ({ data: NOTHING }),
    useTeamMembers: () => ({ data: NOTHING }),
    useSendingIdentity: () => ({ data: undefined }),
    useMarkEmailThreadRead: () => ({ mutate: vi.fn() }),
    useMarkEmailThreadUnread: () => ({ mutate: vi.fn() }),
    useSendEmail: () => ({ mutate: vi.fn(), isPending: false }),
    useMyMailbox: () => ({ data: { mailbox: null } }),
  };
});

vi.mock('@/lib/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/entitlements')>()),
  useFeature: () => true,
}));

import InboxPage from '@/pages/v2/communication/InboxPage';

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}
const renderPage = (entry = '/communication/inbox') =>
  renderWithProviders(<><InboxPage /><Where /></>, { ability, initialEntries: [entry] });

const empty = { selected_label: null, selected_unread: 0, main: null, people: null } as const;
const NARROW: MailboxList = {
  ...empty, scope: 'linked_to_me', selected: 'mine', total_unread: 5, mine: { id: 'box-mine', unread: 3 },
  held: [{ id: 'box-handed', name: 'Jane Smith', unread: 2 }],
};

const PEOPLE = Array.from({ length: 300 }, (_, n) => ({
  id: `box-${n}`, name: `Person ${String(n).padStart(3, '0')}`, unread: n === 7 ? 4 : n === 207 ? 6 : 0, active: true,
}));
const WIDE = (query: ListQuery): MailboxList => {
  const matching = PEOPLE.filter((p) => p.name.toLowerCase().includes((query.search ?? '').toLowerCase()));
  const offset = query.offset ?? 0;
  const picked = PEOPLE.find((p) => p.id === query.selected);
  return {
    scope: 'all', selected: query.selected, selected_label: picked ? `${picked.name}'s mailbox` : null, selected_unread: picked?.unread ?? 0, total_unread: 9,
    mine: { id: 'box-mine', unread: 1 }, held: [], main: { id: 'box-main', unread: 2 },
    people: { items: matching.slice(offset, offset + 50), total: matching.length, offset, limit: 50 },
  };
};

beforeEach(() => {
  listCalls.length = 0;
  emailCalls.length = 0;
  answer = () => NARROW;
});

describe('the Email page: the mailbox list for a person on "Linked to me"', () => {
  it('lists "My mailbox" and each mailbox handed to the person, with their unread counts, above the folders', async () => {
    renderPage();
    const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
    expect(within(mailboxes).getByRole('button', { name: /My mailbox/ })).toHaveTextContent('3');
    expect(within(mailboxes).getByRole('button', { name: /Jane Smith's mailbox/ })).toHaveTextContent('2');
    expect(within(mailboxes).queryByRole('button', { name: /All mailboxes/ })).not.toBeInTheDocument();
    expect(within(mailboxes).queryByRole('button', { name: /Main mailbox/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pick a person/ })).not.toBeInTheDocument();

    const folders = screen.getByRole('button', { name: /^Drafts/ });
    expect(mailboxes.compareDocumentPosition(folders) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('names the scope "Linked to me", as the switch catalog spells it', async () => {
    renderPage();
    expect(await screen.findByText('Communication scope: Linked to me')).toBeInTheDocument();
  });

  it('spells the scope the way the switch catalog does', async () => {
    const catalog = readFileSync(join(__dirname, '../../../../../../backend/src/lib/permissions/switches/catalog.ts'), 'utf8');
    const entry = catalog.slice(catalog.indexOf("key: 'communication_scope'"));
    expect(entry.slice(0, entry.indexOf('presets:'))).toContain("'Linked to me (");
    renderPage();
    expect(await screen.findByText(/^Communication scope: Linked to me$/)).toBeInTheDocument();
  });

  it('shows the person\'s own mailbox by default, and asks the server for it', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'Mailboxes' });
    expect(screen.getByRole('button', { name: /My mailbox/ })).toHaveAttribute('aria-pressed', 'true');
    expect(emailCalls.at(-1)).toBe('mine');
  });

  it('puts the chosen mailbox in the page address and asks the server for that mailbox', async () => {
    const user = userEvent.setup();
    answer = (q) => ({ ...NARROW, selected: q.selected });
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Jane Smith's mailbox/ }));

    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/communication/inbox?mailbox=box-handed'));
    expect(emailCalls.at(-1)).toBe('box-handed');
    expect(screen.getByRole('button', { name: /Jane Smith's mailbox/ })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /My mailbox/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/communication\/inbox$/));
  });

  it('keeps a mailbox from the address on reload, and falls back to the person\'s own when the server says they may not open it', async () => {
    answer = (q) => ({ ...NARROW, selected: q.selected === 'box-handed' ? 'box-handed' : 'mine' });
    const kept = renderPage('/communication/inbox?mailbox=box-handed');
    await screen.findByRole('list', { name: 'Mailboxes' });
    expect(screen.getByTestId('where')).toHaveTextContent('?mailbox=box-handed');
    expect(emailCalls.at(-1)).toBe('box-handed');
    kept.unmount();

    renderPage('/communication/inbox?mailbox=someone-elses');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/communication\/inbox$/));
    expect(screen.getByRole('button', { name: /My mailbox/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('asks the server for no email while it does not yet know which mailbox the address names, instead of listing the whole scope', async () => {
    answer = () => undefined as unknown as MailboxList;
    renderPage('/communication/inbox?mailbox=box-handed');
    await screen.findByText('Compose');
    expect(emailCalls.length).toBeGreaterThan(0);
    expect(emailCalls.every((m) => m === null)).toBe(true);
  });
});

describe('the Email page: the mailbox list for a person on All', () => {
  beforeEach(() => { answer = WIDE; });

  it('adds the main mailbox, "All mailboxes" and a picker, and never lists every person in the rail', async () => {
    renderPage();
    const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
    expect(within(mailboxes).getByRole('button', { name: /Main mailbox/ })).toHaveTextContent('2');
    expect(within(mailboxes).getByRole('button', { name: /All mailboxes/ })).toHaveTextContent('9');
    expect(within(mailboxes).getByRole('button', { name: /Pick a person/ })).toBeInTheDocument();
    // 300 mailboxes in the company: the rail holds a handful of entries, not one row per person.
    expect(within(mailboxes).getAllByRole('button').length).toBeLessThanOrEqual(6);
    expect(screen.queryByText('Person 000')).not.toBeInTheDocument();
    expect(screen.getByText('Communication scope: All')).toBeInTheDocument();
  });

  it('shows every mailbox when "All mailboxes" is chosen', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /All mailboxes/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('?mailbox=all'));
    expect(emailCalls.at(-1)).toBe('all');
  });

  it('picks one person\'s mailbox from a searchable, paged list of its own, and keeps it in the rail while it is shown', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Pick a person/ }));

    const dialog = await screen.findByRole('dialog');
    const people = within(dialog).getByRole('list', { name: 'People' });
    expect(within(people).getAllByRole('button')).toHaveLength(50);
    expect(within(dialog).getByText('1–50 of 300')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(await within(dialog).findByRole('list', { name: 'People' })).getByText('Person 050')).toBeInTheDocument();
    expect(within(dialog).getByText('51–100 of 300')).toBeInTheDocument();

    await user.type(within(dialog).getByRole('searchbox', { name: 'Search people by name' }), 'person 207');
    await waitFor(() => expect(listCalls.some((q) => q.search === 'person 207')).toBe(true));
    const found = within(await within(dialog).findByRole('list', { name: 'People' })).getAllByRole('button');
    expect(found).toHaveLength(1);

    await user.click(found[0]!);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('?mailbox=box-207'));
    expect(emailCalls.at(-1)).toBe('box-207');
    expect(await screen.findByRole('button', { name: /Person 207's mailbox/ })).toHaveAttribute('aria-pressed', 'true');
    // The mailbox is on page 5 of the people, and the rail's own read asks for page 1: its count still shows.
    expect(await screen.findByRole('button', { name: /Person 207's mailbox/ })).toHaveTextContent('6');
  });

  it('shows the unread count of a person in the picker', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Pick a person/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: /Person 007/ })).toHaveTextContent('4');
  });
});

describe('the Email page: the mailbox list names no vendor', () => {
  it('shows no provider or vendor name', async () => {
    answer = WIDE;
    const { container } = renderPage();
    await screen.findByRole('list', { name: 'Mailboxes' });
    expect(container.innerHTML).not.toMatch(/resend|ctm|calltracking|supabase|render\.com|stripe|twilio/i);
  });
});

// S10.8: the main mailbox in the rail is for the people who READ it, whatever their scope. The server says who (a person the
// company linked to it, or a holder of Manage roles and permissions while nobody is linked, or anyone on All) by sending
// `main`; a person who does not read it gets null, sees no entry and falls back to "My mailbox".
describe('the Email page: the main mailbox for a person on "Linked to me" who reads it', () => {
  it('lists "Main mailbox" with its unread count in the rail', async () => {
    answer = () => ({ ...NARROW, main: { id: 'box-main', unread: 4 }, total_unread: 9 });
    renderPage();
    const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
    expect(within(mailboxes).getByRole('button', { name: /Main mailbox/ })).toHaveTextContent('4');
    expect(within(mailboxes).queryByRole('button', { name: /All mailboxes/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pick a person/ })).not.toBeInTheDocument();
  });

  it('asks for the main mailbox when it is picked, and shows it as the chosen one', async () => {
    answer = (query) => ({ ...NARROW, selected: query.selected, main: { id: 'box-main', unread: 4 } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: /Main mailbox/ }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toContain('mailbox=box-main'));
    expect(screen.getByRole('button', { name: /Main mailbox/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows no entry to a person who does not read it', async () => {
    renderPage();
    const mailboxes = await screen.findByRole('list', { name: 'Mailboxes' });
    expect(within(mailboxes).queryByRole('button', { name: /Main mailbox/ })).not.toBeInTheDocument();
  });
});
