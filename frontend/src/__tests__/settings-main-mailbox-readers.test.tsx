// Settings -> Sender Address, "People who read the main mailbox" (PRD 10, S10.8): the linked people as a short list with a
// Remove each, and an "Add person" picker with its own search and its own scroller, both paged by the server. The page
// renders from the route's own file (EmailSenderPage, /settings/email-sender).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { useAuthStore } from '@/stores/auth.store';
import { buildAbility } from '@/lib/ability';
import { renderWithProviders } from './helpers';
import EmailSenderPage from '@/pages/settings/EmailSenderPage';

const mockApi = vi.mocked(api);
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/use-toast', () => ({ toast: toastMock }));

const holderAbility = buildAbility([{ action: 'update', subject: 'Organization' }]);
const nonHolderAbility = buildAbility([{ action: 'read', subject: 'Job' }]);

const DOMAIN = 'mail.servwave.com';
const READERS = '/api/organization/email-sender/readers';
const NOBODY =
  'Nobody is linked. People who can manage roles and permissions read the main mailbox until you add someone.';

type Person = { id: string; name: string };
type Page = { items: Person[]; total: number; offset: number; limit: number };
const page = (all: Person[], offset = 0, limit = 50): Page => ({ items: all.slice(offset, offset + limit), total: all.length, offset, limit });

let linked: Person[];
let candidates: Person[];
let candidateCalls: { search?: string; offset?: number }[];

function mockServer() {
  mockApi.get.mockImplementation(async (url: string, config?: { params?: { search?: string; offset?: number } }) => {
    if (url === '/api/organization/email-sender') {
      return { data: { address: `acme@${DOMAIN}`, local_part: 'acme', local_part_is_custom: false, sender_domain: DOMAIN } };
    }
    if (url === READERS) return { data: page(linked, config?.params?.offset ?? 0) };
    if (url === `${READERS}/candidates`) {
      candidateCalls.push(config?.params ?? {});
      const search = (config?.params?.search ?? '').toLowerCase();
      return { data: page(candidates.filter((p) => p.name.toLowerCase().includes(search)), config?.params?.offset ?? 0) };
    }
    return { data: {} };
  });
}

function signIn() {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: 'u-1', email: 'holder@test.com', first_name: 'Test', last_name: 'Holder', role: 'ADMIN', org_features: ['email'] },
      isAuthenticated: true, isLoading: false, error: null,
    }),
  );
}

const render = (ability = holderAbility) => renderWithProviders(<EmailSenderPage />, { ability });
/** The block's own card: the heading's section, so a sentence on the sender address card above cannot satisfy a check. */
const block = async () => {
  const heading = await screen.findByRole('heading', { name: 'People who read the main mailbox' });
  return heading.parentElement!.parentElement as HTMLElement;
};

beforeEach(() => {
  vi.clearAllMocks();
  signIn();
  linked = [];
  candidates = [];
  candidateCalls = [];
  mockServer();
  mockApi.put.mockResolvedValue({ data: {} });
  mockApi.delete.mockResolvedValue({ data: {} });
});

describe('Sender Address page: People who read the main mailbox', () => {
  it('says, in the PRD\'s words, that record replies go to the record\'s people and only other mail to the main address comes here', async () => {
    render();
    const section = await block();
    expect(within(section).getByText(
      /Replies to emails about a job, lead, estimate or invoice go to that record's people\. Only other mail to the main address comes here\./,
    )).toBeInTheDocument();
  });

  it('reads exactly the PRD\'s sentence while nobody is linked, and lists nobody', async () => {
    render();
    const section = await block();
    expect(await within(section).findByText(NOBODY)).toBeInTheDocument();
    expect(within(section).queryByRole('list', { name: 'People who read the main mailbox' })).not.toBeInTheDocument();
  });

  it('lists the linked people by name, with a Remove each, and not the sentence for nobody', async () => {
    linked = [{ id: 'u-1', name: 'Jane Smith' }, { id: 'u-2', name: 'Omar Haddad' }];
    render();
    const list = await screen.findByRole('list', { name: 'People who read the main mailbox' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Jane SmithRemove', 'Omar HaddadRemove']);
    expect(screen.queryByText(NOBODY)).not.toBeInTheDocument();
  });

  it('removes a person with one request for that person, and shows the sentence for nobody once the list is empty', async () => {
    linked = [{ id: 'u-9', name: 'Jane Smith' }];
    // The server drops the link, so the refetch the page asks for next finds nobody.
    mockApi.delete.mockImplementation(async () => { linked = []; return { data: {} }; });
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: 'Remove Jane Smith' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`${READERS}/u-9`));
    expect(await screen.findByText(NOBODY)).toBeInTheDocument();
  });

  it('adds a person from the picker with one request for that person, and keeps the picker open for the next', async () => {
    candidates = [{ id: 'c-1', name: 'Amy Adams' }, { id: 'c-2', name: 'Ben Brown' }];
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: /Add person/ }));
    const dialog = await screen.findByRole('dialog');
    await user.click(await within(dialog).findByRole('button', { name: 'Add Amy Adams' }));

    await waitFor(() => expect(mockApi.put).toHaveBeenCalledWith(`${READERS}/c-1`));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('searches the picker by name on the server, not in the browser', async () => {
    candidates = [{ id: 'c-1', name: 'Amy Adams' }, { id: 'c-2', name: 'Ben Brown' }];
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: /Add person/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('button', { name: 'Add Amy Adams' });
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search people by name' }), 'ben');

    await waitFor(() => expect(candidateCalls.some((c) => c.search === 'ben')).toBe(true));
    expect(await within(dialog).findByRole('button', { name: 'Add Ben Brown' })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Add Amy Adams' })).not.toBeInTheDocument());
  });

  it('says so when no one matches the search, and when everyone is already linked', async () => {
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: /Add person/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Everyone is already linked.')).toBeInTheDocument();
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search people by name' }), 'zzz');
    expect(await within(dialog).findByText('No one matches that name.')).toBeInTheDocument();
  });

  it('shows a company of 300 people one page at a time: 50 rows in the picker, never 300, with a way to the next page', async () => {
    candidates = Array.from({ length: 300 }, (_, n) => ({ id: `c-${n}`, name: `Person ${String(n).padStart(3, '0')}` }));
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: /Add person/ }));
    const dialog = await screen.findByRole('dialog');
    const rows = await within(dialog).findAllByRole('button', { name: /^Add Person/ });
    expect(rows).toHaveLength(50);
    expect(within(dialog).getByText('1–50 of 300')).toBeInTheDocument();
    // The list has a scroller of its own, so the page behind it never grows with the company.
    expect(within(dialog).getByRole('list', { name: 'People' }).className).toMatch(/overflow-y-auto/);

    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(candidateCalls.some((c) => c.offset === 50)).toBe(true));
    expect(await within(dialog).findByRole('button', { name: 'Add Person 050' })).toBeInTheDocument();
    expect(within(dialog).getByText('51–100 of 300')).toBeInTheDocument();
  });

  it('pages the linked list too: 300 linked people are 50 rows with a way to the next page', async () => {
    linked = Array.from({ length: 300 }, (_, n) => ({ id: `l-${n}`, name: `Linked ${String(n).padStart(3, '0')}` }));
    const user = userEvent.setup();
    render();
    const list = await screen.findByRole('list', { name: 'People who read the main mailbox' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText('1–50 of 300')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Linked 050')).toBeInTheDocument();
  });

  it('shows a refusal plainly, in the server\'s own words, and changes nothing on the page', async () => {
    candidates = [{ id: 'c-1', name: 'Amy Adams' }];
    mockApi.put.mockRejectedValue({ response: { status: 403, data: { error: 'Insufficient permissions' } } });
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: /Add person/ }));
    await user.click(await screen.findByRole('button', { name: 'Add Amy Adams' }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ description: 'Insufficient permissions' })));
    expect(await screen.findByText(NOBODY)).toBeInTheDocument();
  });

  it('shows a refused remove the same way', async () => {
    linked = [{ id: 'u-9', name: 'Jane Smith' }];
    mockApi.delete.mockRejectedValue({ response: { status: 403, data: { error: 'Insufficient permissions' } } });
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: 'Remove Jane Smith' }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ description: 'Insufficient permissions' })));
    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
  });

  it('shows an error line instead of the list when it cannot be loaded', async () => {
    mockApi.get.mockImplementation(async (url: string) => {
      if (url === READERS) throw new Error('boom');
      return { data: { address: `acme@${DOMAIN}`, local_part: 'acme', local_part_is_custom: false, sender_domain: DOMAIN } };
    });
    render();
    expect(await screen.findByText(/Could not load the people who read the main mailbox/)).toBeInTheDocument();
    expect(screen.queryByText(NOBODY)).not.toBeInTheDocument();
  });

  it('shows no list, and asks for nothing, for a person without Company settings: the page says they have no access', async () => {
    render(nonHolderAbility);
    expect(await screen.findByRole('heading', { name: /you don.t have access to this page/i })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'People who read the main mailbox' })).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith(READERS, expect.anything());
  });

  it('names no email provider or vendor, and fits a phone: long names break instead of running off the screen', async () => {
    linked = [{ id: 'u-1', name: 'Alexandria Montgomery-Featherstonehaugh' }];
    candidates = [{ id: 'c-1', name: 'Bartholomew Wolfeschlegelsteinhausenbergerdorff' }];
    const user = userEvent.setup();
    const { container } = render();
    const list = await screen.findByRole('list', { name: 'People who read the main mailbox' });
    expect(within(list).getByText('Alexandria Montgomery-Featherstonehaugh').className).toMatch(/break-words/);
    expect(within(list).getByRole('listitem').className).toMatch(/gap-2/);
    await user.click(screen.getByRole('button', { name: /Add person/ }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findByText('Bartholomew Wolfeschlegelsteinhausenbergerdorff')).className).toMatch(/break-words/);
    expect(`${container.textContent}${dialog.textContent}`).not.toMatch(/resend|ctm|calltracking|supabase|render\.com|twilio|stripe|sendgrid|mailgun|postmark|ses\b/i);
  });
});
