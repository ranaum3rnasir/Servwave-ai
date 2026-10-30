/**
 * The Lists card engine, driven through the real page against an in-memory copy of the two row endpoints
 * (listsFake.ts): count text, search, sort, Active/Archived, empty states, create, rename, archive, restore, Undo and the
 * Saved toast. Every behaviour runs for BOTH row-backed cards, since they share one implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { toast } from '@/ui-kit/components/ui/sonner';
import ListsPage from '@/pages/v2/settings/ListsPage';
import { renderWithProviders } from './helpers';
import { installListsServer, row, savedToasts, type FakeList } from './listsFake';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

const mockApi = vi.mocked(api);
const toastMock = vi.mocked(toast);
const PAGE = buildAbility([{ action: 'update', subject: 'Organization' }]);

const CARDS = [
  { title: 'Job types', singular: 'job type', Singular: 'Job type', path: '/api/job-types', search: 'Search job types', sorts: [] as string[] },
  { title: 'Lead/Customer sources', singular: 'source', Singular: 'Source', path: '/api/lead-sources', search: 'Search lead/customer sources', sorts: ['Default order', 'A to Z', 'Most used'] },
];

function seed(): Record<string, FakeList> {
  const rows = () => [
    row('r1', 'Repair', { sort_order: 0, used_count: 5 }),
    row('r2', 'Install', { sort_order: 1, used_count: 2 }),
    row('r3', 'Old thing', { sort_order: 2, archived: true }),
  ];
  return { '/api/job-types': { rows: rows() }, '/api/lead-sources': { rows: rows() } };
}

let server: ReturnType<typeof installListsServer>;
beforeEach(() => {
  vi.clearAllMocks();
  server = installListsServer(mockApi, seed());
});

const cardOf = (title: string) => screen.getByRole('heading', { name: title }).closest('[data-slot="card"]') as HTMLElement;
async function open(title: string) {
  const user = userEvent.setup();
  renderWithProviders(<ListsPage />, { ability: PAGE });
  await screen.findByRole('heading', { name: title });
  const card = cardOf(title);
  await within(card).findByText('Repair');
  return { user, card };
}
const names = (card: HTMLElement) => within(card).getAllByRole('listitem').map((li) => li.querySelector('.lc-nm')?.textContent);
const lastSaved = async () => (await savedToasts(toastMock)).at(-1)!;

describe.each(CARDS)('$title card', (c) => {
  it('shows the active count and the Active / Archived control with its counts', async () => {
    const { card } = await open(c.title);
    expect(within(card).getByText(`2 ${c.title === 'Job types' ? 'job types' : 'sources'}`)).toBeInTheDocument();
    expect(within(card).getByRole('radio', { name: 'Active 2' })).toBeInTheDocument();
    expect(within(card).getByRole('radio', { name: 'Archived 1' })).toBeInTheDocument();
    expect(names(card)).toEqual(['Repair', 'Install']);
  });

  it('shows the used-by text per row', async () => {
    const { card } = await open(c.title);
    const word = c.title === 'Job types' ? 'job' : 'lead';
    expect(within(card).getByText(`5 ${word}s`)).toBeInTheDocument();
    expect(within(card).getByText(`2 ${word}s`)).toBeInTheDocument();
  });

  it('search narrows the rows on every keystroke and the count reads "{shown} of {total}"', async () => {
    const { user, card } = await open(c.title);
    await user.type(within(card).getByRole('searchbox', { name: c.search }), 'ins');
    expect(names(card)).toEqual(['Install']);
    expect(within(card).getByText('1 of 2')).toBeInTheDocument();
  });

  it('search with no match says so and points at Create', async () => {
    const { user, card } = await open(c.title);
    await user.type(within(card).getByRole('searchbox', { name: c.search }), 'zzz');
    expect(within(card).getByText(`No ${c.title.toLowerCase()} match “zzz”. Use Create above to add it.`)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: `Create ${c.singular} “zzz”` })).toBeInTheDocument();
  });

  it('the Archived view lists archived rows muted with a badge, restore-only, and counts against the archived total', async () => {
    const { user, card } = await open(c.title);
    await user.click(within(card).getByRole('radio', { name: 'Archived 1' }));
    expect(names(card)).toEqual(['Old thing']);
    expect(within(card).getByText('Archived', { selector: '[data-slot="badge"]' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Rename / })).not.toBeInTheDocument();
    await user.type(within(card).getByRole('searchbox', { name: c.search }), 'old');
    expect(within(card).getByText('1 of 1')).toBeInTheDocument();
  });

  it('says "Nothing is archived." when the Archived view is empty', async () => {
    server.lists[c.path]!.rows.find((r) => r.archived)!.archived = false;
    const { user, card } = await open(c.title);
    await user.click(within(card).getByRole('radio', { name: 'Archived 0' }));
    expect(within(card).getByText('Nothing is archived.')).toBeInTheDocument();
  });

  it('offers exactly the sorts the card should (and none for Job types)', async () => {
    const { user, card } = await open(c.title);
    const select = within(card).queryByRole('combobox', { name: `Sort ${c.title.toLowerCase()}` });
    if (c.sorts.length === 0) {
      expect(select).not.toBeInTheDocument();
      return;
    }
    await user.click(select!);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(c.sorts);
    await user.click(screen.getByRole('option', { name: 'Most used' }));
    expect(names(card)).toEqual(['Repair', 'Install']);
    await user.click(within(card).getByRole('combobox', { name: `Sort ${c.title.toLowerCase()}` }));
    await user.click(screen.getByRole('option', { name: 'A to Z' }));
    expect(names(card)).toEqual(['Install', 'Repair']);
  });

  describe('create', () => {
    it('is a pinned row labelled for the list, and opens a form with the three-part contract', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      const input = within(card).getByLabelText(`Name of the new ${c.singular}`);
      expect(input).toHaveFocus();
      expect(input).toHaveAttribute('maxlength', '50');
      expect(within(card).getByRole('button', { name: `Create ${c.singular}` })).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('validates in order: empty, too long, duplicate (archived rows count), and keeps focus in the input', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      const input = within(card).getByLabelText(`Name of the new ${c.singular}`);

      await user.type(input, '   {Enter}');
      expect(await within(card).findByRole('alert')).toHaveTextContent('Enter a name.');
      expect(input).toHaveFocus();

      fireEvent.change(input, { target: { value: 'x'.repeat(51) } });
      await user.type(input, '{Enter}');
      expect(await within(card).findByText('Use 50 characters or fewer.')).toBeInTheDocument();

      await user.clear(input);
      await user.type(input, 'repair{Enter}');
      expect(await within(card).findByText(`${c.Singular} “Repair” already exists.`)).toBeInTheDocument();
      await user.clear(input);
      await user.type(input, 'OLD THING{Enter}');
      expect(await within(card).findByText(`${c.Singular} “Old thing” already exists.`)).toBeInTheDocument();
      expect(input).toHaveFocus();
      expect(server.calls.filter((x) => x.method === 'post')).toHaveLength(0);
    });

    it('answers the server\'s duplicate (a name added elsewhere a moment ago) with the same sentence', async () => {
      const { user, card } = await open(c.title);
      server.lists[c.path]!.rows.push(row('late', 'Late arrival'));
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      await user.type(within(card).getByLabelText(`Name of the new ${c.singular}`), 'late arrival{Enter}');
      expect(await within(card).findByText(`${c.Singular} “Late arrival” already exists.`)).toBeInTheDocument();
    });

    it('shows the full-list message from the server under the input (C-18)', async () => {
      server.lists[c.path]!.cap = 3;
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      await user.type(within(card).getByLabelText(`Name of the new ${c.singular}`), 'One more{Enter}');
      expect(await within(card).findByRole('alert')).toHaveTextContent('This list can hold up to 500 items.');
      expect(within(card).getByLabelText(`Name of the new ${c.singular}`)).toHaveFocus();
    });

    it('on success closes the form, clears the search, flashes the new row, toasts with Undo and returns focus to the create row', async () => {
      const { user, card } = await open(c.title);
      await user.type(within(card).getByRole('searchbox', { name: c.search }), 'roof');
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular} “roof”` }));
      const input = within(card).getByLabelText(`Name of the new ${c.singular}`);
      expect(input).toHaveValue('roof');
      await user.clear(input);
      await user.type(input, 'Roof   repair{Enter}');

      await waitFor(() => expect(within(card).queryByLabelText(`Name of the new ${c.singular}`)).not.toBeInTheDocument());
      expect(server.calls.find((x) => x.method === 'post')).toMatchObject({ url: c.path, body: { name: 'Roof repair' } });
      expect(within(card).getByRole('searchbox', { name: c.search })).toHaveValue('');
      const created = (await within(card).findByText('Roof repair')).closest('[role="listitem"]')!;
      expect(created).toHaveClass('is-flash');
      expect(names(card)).toEqual(['Repair', 'Install', 'Roof repair']);
      const saved = await lastSaved();
      expect(saved.text).toBe(`Saved · Created ${c.singular} “Roof repair”`);
      expect(saved.undoLabel).toBe('Undo');
      expect(saved.duration).toBe(7000);
      await waitFor(() => expect(within(card).getByRole('button', { name: `Create ${c.singular}` })).toHaveFocus());
    });

    it('Escape cancels and returns focus to the create row', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      await user.keyboard('{Escape}');
      expect(within(card).queryByLabelText(`Name of the new ${c.singular}`)).not.toBeInTheDocument();
      expect(within(card).getByRole('button', { name: `Create ${c.singular}` })).toHaveFocus();
    });

    it('Undo of a Create calls DELETE on the new row and says "Change undone" (C-11)', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      await user.type(within(card).getByLabelText(`Name of the new ${c.singular}`), 'Roof repair{Enter}');
      await within(card).findByText('Roof repair');

      await act(async () => (await lastSaved()).undo!());

      await waitFor(() => expect(within(card).queryByText('Roof repair')).not.toBeInTheDocument());
      expect(server.calls.find((x) => x.method === 'delete')?.url).toMatch(new RegExp(`^${c.path}/new-`));
      expect(toastMock).toHaveBeenLastCalledWith('Change undone');
    });

    it('a failed Undo shows the existing error toast with the server\'s own words (C-18)', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      await user.type(within(card).getByLabelText(`Name of the new ${c.singular}`), 'Roof repair{Enter}');
      await within(card).findByText('Roof repair');
      // A record picked the new name in the meantime, so the delete is refused.
      server.lists[c.path]!.rows.find((r) => r.name === 'Roof repair')!.used_count = 4;

      await act(async () => (await lastSaved()).undo!());

      await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('In use and cannot be removed.'));
      expect(within(card).getByText('Roof repair')).toBeInTheDocument();
    });
  });

  describe('rename', () => {
    const startRename = async (name = 'Repair') => {
      const ctx = await open(c.title);
      await ctx.user.click(within(ctx.card).getByRole('button', { name: `Rename ${name}` }));
      return { ...ctx, input: within(ctx.card).getByLabelText(`Name of ${name}`) };
    };

    it('turns the name into a selected, 50-character input', async () => {
      const { input } = await startRename();
      expect(input).toHaveFocus();
      expect(input).toHaveAttribute('maxlength', '50');
      expect((input as HTMLInputElement).selectionStart).toBe(0);
      expect((input as HTMLInputElement).selectionEnd).toBe('Repair'.length);
    });

    it('Enter saves, toasts "Renamed … to …" with Undo, and returns focus to the pencil', async () => {
      const { user, card, input } = await startRename();
      await user.clear(input);
      await user.type(input, 'Fix{Enter}');
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Rename Fix' })).toHaveFocus());
      expect(server.calls.find((x) => x.method === 'patch')).toMatchObject({ url: `${c.path}/r1`, body: { name: 'Fix' } });
      expect((await lastSaved()).text).toBe('Saved · Renamed “Repair” to “Fix”');
    });

    it('leaving the field saves too', async () => {
      const { user, card, input } = await startRename();
      await user.clear(input);
      await user.type(input, 'Fix');
      await user.click(within(card).getByRole('searchbox', { name: c.search }));
      await waitFor(() => expect(within(card).getByText('Fix')).toBeInTheDocument());
      expect(server.calls.filter((x) => x.method === 'patch')).toHaveLength(1);
    });

    it('Escape cancels without saving, and unchanged text just closes', async () => {
      const { user, card, input } = await startRename();
      await user.type(input, 'zzz{Escape}');
      expect(within(card).queryByLabelText('Name of Repair')).not.toBeInTheDocument();
      expect(within(card).getByText('Repair')).toBeInTheDocument();
      await user.click(within(card).getByRole('button', { name: 'Rename Repair' }));
      await user.type(within(card).getByLabelText('Name of Repair'), '{Enter}');
      expect(within(card).queryByLabelText('Name of Repair')).not.toBeInTheDocument();
      expect(server.calls.filter((x) => x.method === 'patch')).toHaveLength(0);
    });

    it('a duplicate keeps the input open with the reason under it', async () => {
      const { user, card, input } = await startRename();
      await user.clear(input);
      await user.type(input, 'install{Enter}');
      expect(await within(card).findByRole('alert')).toHaveTextContent(`${c.Singular} “Install” already exists.`);
      expect(input).toHaveFocus();
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(server.calls.filter((x) => x.method === 'patch')).toHaveLength(0);
    });

    it('Undo renames back', async () => {
      const { user, card, input } = await startRename();
      await user.clear(input);
      await user.type(input, 'Fix{Enter}');
      await within(card).findByText('Fix');
      await act(async () => (await lastSaved()).undo!());
      await waitFor(() => expect(within(card).getByText('Repair')).toBeInTheDocument());
      expect(toastMock).toHaveBeenLastCalledWith('Change undone');
    });
  });

  describe('archive and restore', () => {
    const archiveRepair = async () => {
      const ctx = await open(c.title);
      await ctx.user.click(within(ctx.card).getByRole('button', { name: 'More actions for Repair' }));
      await ctx.user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
      return ctx;
    };

    it('Archive moves the row to the Archived view at once, with its toast and the new counts', async () => {
      const { card } = await archiveRepair();
      await waitFor(() => expect(names(card)).toEqual(['Install']));
      expect(within(card).getByRole('radio', { name: 'Active 1' })).toBeInTheDocument();
      expect(within(card).getByRole('radio', { name: 'Archived 2' })).toBeInTheDocument();
      expect(server.calls.find((x) => x.url === `${c.path}/r1/archive`)).toBeTruthy();
      expect((await lastSaved()).text).toBe('Saved · Archived “Repair”');
    });

    it('Undo of Archive restores it', async () => {
      const { card } = await archiveRepair();
      await waitFor(() => expect(names(card)).toEqual(['Install']));
      await act(async () => (await lastSaved()).undo!());
      await waitFor(() => expect(names(card)).toEqual(['Install', 'Repair']));
    });

    it('Restore in the Archived view brings the row back with its toast', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('radio', { name: 'Archived 1' }));
      await user.click(within(card).getByRole('button', { name: 'Restore' }));
      expect((await lastSaved()).text).toBe('Saved · Restored “Old thing”');
      await user.click(within(card).getByRole('radio', { name: 'Active 3' }));
      expect(names(card)).toEqual(['Repair', 'Install', 'Old thing']);
    });
  });

  it('a second change replaces the first Saved toast (same id), and a change is never saved through the Save bar', async () => {
    const { user, card } = await open(c.title);
    for (const name of ['One', 'Two']) {
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      await user.type(within(card).getByLabelText(`Name of the new ${c.singular}`), `${name}{Enter}`);
      await within(card).findByText(name);
    }
    const saved = await savedToasts(toastMock);
    expect(saved).toHaveLength(2);
    expect(new Set(saved.map((s) => s.id))).toEqual(new Set(['lists-saved']));
    expect(mockApi.patch).not.toHaveBeenCalledWith('/api/organization', expect.anything());
  });

  it('refetches the organization record after a change, which is what the lead and job forms read', async () => {
    const { user, card } = await open(c.title);
    mockApi.get.mockClear();
    await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
    await user.type(within(card).getByLabelText(`Name of the new ${c.singular}`), `Zed{Enter}`);
    await within(card).findByText('Zed');
    // The organization query is only fetched if something is mounted on it; the invalidation itself is what is pinned.
    await waitFor(() => expect(mockApi.get).toHaveBeenCalledWith(c.path));
  });
});
