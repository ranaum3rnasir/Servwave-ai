/**
 * V7-04a fix round: the touch size of the Active / Archived control, a load failure that shows no false numbers,
 * focus after Archive, the organization refresh after every write, the reorder rollback, and the Most used tie-break.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { toast } from '@/ui-kit/components/ui/sonner';
import ListsPage from '@/pages/v2/settings/ListsPage';
import { useOrganization } from '@/lib/api/organization';
import { renderWithProviders } from './helpers';
import { installListsServer, row, savedToasts } from './listsFake';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

const mockApi = vi.mocked(api);
const toastMock = vi.mocked(toast);
const PAGE = buildAbility([{ action: 'update', subject: 'Organization' }]);

function OrgProbe() {
  useOrganization();
  return null;
}

let server: ReturnType<typeof installListsServer>;
beforeEach(() => {
  vi.clearAllMocks();
  server = installListsServer(
    mockApi,
    {
      '/api/job-types': { rows: [row('a', 'Alpha', { sort_order: 0 }), row('b', 'Bravo', { sort_order: 1 }), row('c', 'Charlie', { sort_order: 2 }), row('d', 'Old', { sort_order: 3, archived: true })] },
      '/api/lead-sources': { rows: [row('s1', 'Zed', { used_count: 3 }), row('s2', 'Alpha src', { sort_order: 1, used_count: 3 }), row('s3', 'Mid', { sort_order: 2, used_count: 5 })] },
    },
    (_m, url) => (url === '/api/organization' ? { id: 'o1' } : {}),
  );
});

const cardOf = (title: string) => screen.getByRole('heading', { name: title }).closest('[data-slot="card"]') as HTMLElement;
async function open(withProbe = false) {
  const user = userEvent.setup();
  renderWithProviders(<><ListsPage />{withProbe && <OrgProbe />}</>, { ability: PAGE });
  await screen.findByRole('heading', { name: 'Job types' });
  await within(cardOf('Job types')).findByText('Alpha');
  return { user, jt: cardOf('Job types') };
}
const orgFetches = () => mockApi.get.mock.calls.filter(([u]) => u === '/api/organization').length;

describe('Active / Archived control size', () => {
  it('carries the touch-size class, which the stylesheet makes 44px on a phone and on touch screens', async () => {
    const { jt } = await open();
    for (const name of ['Active 3', 'Archived 1']) expect(within(jt).getByRole('radio', { name }).classList.contains('lc-seg')).toBe(true);
    const css = readFileSync(resolve(__dirname, '../pages/v2/settings/lists/lists.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width: 640px\), \(pointer: coarse\)\s*\{\s*\.lc-seg\s*\{\s*min-height:\s*44px/);
  });
});

describe('a failed load', () => {
  it('shows no counts, no toggle and no Create row, and Retry brings the list back', async () => {
    const user = userEvent.setup();
    let fail = true;
    const inner = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(((url: string) =>
      fail && url === '/api/lead-sources' ? Promise.reject({ response: { status: 500, data: { error: 'boom' } } }) : inner(url)) as never);
    renderWithProviders(<ListsPage />, { ability: PAGE });
    const card = () => cardOf('Lead/Customer sources');
    expect(await within(card()).findByRole('alert')).toHaveTextContent('Could not load lead/customer sources.');
    expect(within(card()).queryByText(/\d+ sources?$/)).not.toBeInTheDocument();
    expect(within(card()).queryByRole('radio')).not.toBeInTheDocument();
    expect(within(card()).queryByRole('button', { name: 'Create source' })).not.toBeInTheDocument();

    fail = false;
    await user.click(within(card()).getByRole('button', { name: 'Retry' }));
    expect(await within(card()).findByText('Mid')).toBeInTheDocument();
    expect(within(card()).getByText('3 sources')).toBeInTheDocument();
    expect(within(card()).getByRole('button', { name: 'Create source' })).toBeInTheDocument();
  });
});

describe('focus after Archive', () => {
  const archive = async (user: ReturnType<typeof userEvent.setup>, jt: HTMLElement, name: string) => {
    await user.click(within(jt).getByRole('button', { name: `More actions for ${name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
  };

  it('goes to the next row, else the previous row, else the create row', async () => {
    const { user, jt } = await open();
    await archive(user, jt, 'Bravo');
    await waitFor(() => expect(within(jt).getByRole('button', { name: 'Rename Charlie' })).toHaveFocus());
    await archive(user, jt, 'Charlie');
    await waitFor(() => expect(within(jt).getByRole('button', { name: 'Rename Alpha' })).toHaveFocus());
    await archive(user, jt, 'Alpha');
    await waitFor(() => expect(within(jt).getByRole('button', { name: 'Create job type' })).toHaveFocus());
  });
});

describe('the organization record is refreshed after every write (the lead and job forms read their menus from it)', () => {
  it.each([
    ['create', async (user: ReturnType<typeof userEvent.setup>, jt: HTMLElement) => {
      await user.click(within(jt).getByRole('button', { name: 'Create job type' }));
      await user.type(within(jt).getByLabelText('Name of the new job type'), 'Delta{Enter}');
    }],
    ['rename', async (user: ReturnType<typeof userEvent.setup>, jt: HTMLElement) => {
      await user.click(within(jt).getByRole('button', { name: 'Rename Alpha' }));
      await user.type(within(jt).getByLabelText('Name of Alpha'), '2{Enter}');
    }],
    ['archive', async (user: ReturnType<typeof userEvent.setup>, jt: HTMLElement) => {
      await user.click(within(jt).getByRole('button', { name: 'More actions for Alpha' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    }],
    ['restore', async (user: ReturnType<typeof userEvent.setup>, jt: HTMLElement) => {
      await user.click(within(jt).getByRole('radio', { name: 'Archived 1' }));
      await user.click(within(jt).getByRole('button', { name: 'Restore' }));
    }],
    ['reorder', async (user: ReturnType<typeof userEvent.setup>, jt: HTMLElement) => {
      await user.click(within(jt).getByRole('button', { name: 'Move Alpha down' }));
    }],
    ['undo of create (delete)', async (user: ReturnType<typeof userEvent.setup>, jt: HTMLElement) => {
      await user.click(within(jt).getByRole('button', { name: 'Create job type' }));
      await user.type(within(jt).getByLabelText('Name of the new job type'), 'Delta{Enter}');
      await within(jt).findByText('Delta');
      await new Promise((r) => setTimeout(r, 50));
      mockApi.get.mockClear();
      await act(async () => (await savedToasts(toastMock)).at(-1)!.undo!());
    }],
  ])('%s', async (_name, act_) => {
    const { user, jt } = await open(true);
    await waitFor(() => expect(orgFetches()).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    const before = orgFetches();
    if (_name !== 'undo of create (delete)') mockApi.get.mockClear();
    await act_(user, jt);
    await waitFor(() => expect(orgFetches()).toBeGreaterThan(_name === 'undo of create (delete)' ? 0 : 0));
    expect(before).toBeGreaterThan(0);
  });
});

describe('reorder rollback', () => {
  it('puts the old order back when the save fails, even if the list cannot be refetched', async () => {
    const { user, jt } = await open();
    const inner = mockApi.get.getMockImplementation()!;
    const post = mockApi.post.getMockImplementation()!;
    // Nothing can refetch the list now, so only the rollback can restore the order.
    mockApi.get.mockImplementation(((url: string) => (url === '/api/job-types' ? new Promise(() => {}) : inner(url))) as never);
    mockApi.post.mockImplementation(((url: string, body?: unknown) =>
      url === '/api/job-types/reorder' ? Promise.reject({ response: { status: 400, data: { error: 'nope' } } }) : post(url, body)) as never);
    await user.click(within(jt).getByRole('button', { name: 'Move Alpha down' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('nope'));
    const names = within(jt).getAllByRole('listitem').map((li) => li.querySelector('.lc-nm')?.textContent);
    expect(names).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });
});

describe('Most used', () => {
  it('breaks a tie by name', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: PAGE });
    const c = () => cardOf('Lead/Customer sources');
    await within(c()).findByText('Zed');
    await user.click(within(c()).getByRole('combobox', { name: 'Sort lead/customer sources' }));
    await user.click(screen.getByRole('option', { name: 'Most used' }));
    expect(within(c()).getAllByRole('listitem').map((li) => li.querySelector('.lc-nm')?.textContent)).toEqual(['Mid', 'Alpha src', 'Zed']);
  });
});
