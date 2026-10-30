/**
 * The Tags and Task categories cards on the Lists page (V7-04b), driven through the real page against in-memory copies of
 * the tag and task-category routes (listsFake.ts). Both run on the same card engine as Job types and Sources, so the
 * shared behaviours are checked for both cards; what only one card has (usage tooltip, record counts) is checked on its own.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { toast } from '@/ui-kit/components/ui/sonner';
import ListsPage from '@/pages/v2/settings/ListsPage';
import { renderWithProviders } from './helpers';
import { category, installListsServer, row, savedToasts, tag, tagsAndCategoriesHandler, type TagsAndCategories } from './listsFake';

vi.mock('@/ui-kit/components/ui/sonner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/ui-kit/components/ui/sonner')>()),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
}));

const mockApi = vi.mocked(api);
const toastMock = vi.mocked(toast);
const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);

const CARDS = [
  { title: 'Tags', singular: 'tag', plural: 'tags', Singular: 'Tag', path: '/api/tags', search: 'Search tags', created: 'tag' },
  { title: 'Task categories', singular: 'task category', plural: 'task categories', Singular: 'Task category', path: '/api/task-categories', search: 'Search task categories', created: 'category' },
];

let data: TagsAndCategories;
let calls: ReturnType<typeof installListsServer>['calls'];

function seed(): TagsAndCategories {
  return {
    tags: [
      tag('t1', 'Urgent', { color: '#EF4444', usage_count: 38 }),
      tag('t2', 'VIP', { color: '#6B7280', usage_count: 1 }),
      tag('t3', 'Stale', { color: '#14B8A6', usage_count: 0 }),
    ],
    categories: [
      category('c1', 'Urgent', { color: '#EF4444', sort_order: 0, task_counts: { open: 2, done: 3 } }),
      category('c2', 'VIP', { color: '#6B7280', sort_order: 1, task_counts: { open: 1, done: 0 } }),
      category('c3', 'Stale', { color: '#14B8A6', sort_order: 2 }),
    ],
  };
}

function serve(next: TagsAndCategories = seed()) {
  data = next;
  const s = installListsServer(
    mockApi,
    { '/api/job-types': { rows: [row('j1', 'Repair')] }, '/api/lead-sources': { rows: [row('s1', 'Google')] } },
    tagsAndCategoriesHandler(data),
  );
  calls = s.calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  serve();
});

const cardOf = (title: string) => screen.getByRole('heading', { name: title }).closest('[data-slot="card"]') as HTMLElement;
const names = (card: HTMLElement) => within(card).getAllByRole('listitem').map((li) => li.querySelector('.lc-nm')?.textContent);
const lastSaved = async () => (await savedToasts(toastMock)).at(-1)!;

async function open(title: string) {
  const user = userEvent.setup();
  renderWithProviders(<ListsPage />, { ability: ADMIN });
  await screen.findByRole('heading', { name: title });
  const card = cardOf(title);
  await within(card).findByText('Urgent');
  return { user, card };
}

describe('the page', () => {
  it('shows the four cards in order, the new two with their exact titles and help behind a "?"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: ADMIN });
    await screen.findByRole('heading', { name: 'Tags' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Job types', 'Lead/Customer sources', 'Tags', 'Task categories']);

    const help = {
      Tags: 'Labels you put on customers, jobs and leads to group and filter them.',
      'Task categories': 'Labels that say what kind of task something is, such as Call back or Order parts. Shown on every task and used to filter the task list.',
    };
    for (const [title, text] of Object.entries(help)) {
      const heading = screen.getByRole('heading', { name: title });
      expect(heading.parentElement!.querySelectorAll('p')).toHaveLength(1);
      expect(screen.queryByText(text)).not.toBeInTheDocument();
      await user.click(within(heading.parentElement!).getByRole('button', { name: `More about ${title}` }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.queryByText(text)).not.toBeInTheDocument();
    }
  });

  it('shows no Tags card to someone who cannot update and delete tags, and no Task categories card without create and update', async () => {
    renderWithProviders(<ListsPage />, { ability: buildAbility([{ action: 'update', subject: 'Organization' }, { action: 'update', subject: 'Tag' }, { action: 'create', subject: 'Tag' }]) });
    await screen.findByRole('heading', { name: 'Job types' });
    expect(screen.queryByRole('heading', { name: 'Tags' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Task categories' })).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith('/api/tags');
  });
});

describe.each(CARDS)('$title card', (c) => {
  it('shows the count, A to Z order, no Active/Archived control and no grip', async () => {
    const { card } = await open(c.title);
    expect(within(card).getByText(`3 ${c.plural}`)).toBeInTheDocument();
    expect(names(card)).toEqual(['Stale', 'Urgent', 'VIP']);
    expect(within(card).queryByRole('radio', { name: /^Active/ })).not.toBeInTheDocument();
    expect(card.querySelector('[data-slot="lc-grip"]')).toBeNull();
    expect(within(card).queryByRole('button', { name: /^Move / })).not.toBeInTheDocument();
  });

  it('shows each name as a chip in its stored colour', async () => {
    const { card } = await open(c.title);
    const chip = within(card).getByText('Urgent').closest('.lc-chip') as HTMLElement;
    expect(chip.style.getPropertyValue('--c')).toBe('#EF4444');
  });

  it('offers exactly A to Z and Most used, A to Z first, and Most used puts the busiest first', async () => {
    const { user, card } = await open(c.title);
    await user.click(within(card).getByRole('combobox', { name: `Sort ${c.title.toLowerCase()}` }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['A to Z', 'Most used']);
    await user.click(screen.getByRole('option', { name: 'Most used' }));
    expect(names(card)[0]).toBe('Urgent');
  });

  it('search narrows on every keystroke and the count reads "{shown} of {total}"', async () => {
    const { user, card } = await open(c.title);
    await user.type(within(card).getByRole('searchbox', { name: c.search }), 'vi');
    expect(names(card)).toEqual(['VIP']);
    expect(within(card).getByText('1 of 3')).toBeInTheDocument();
  });

  it('an empty search says so and the create row quotes the text', async () => {
    const { user, card } = await open(c.title);
    await user.type(within(card).getByRole('searchbox', { name: c.search }), 'zzz');
    expect(within(card).getByText(`No ${c.title.toLowerCase()} match “zzz”. Use Create above to add it.`)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: `Create ${c.singular} “zzz”` })).toBeInTheDocument();
  });

  it('an empty list says to use Create', async () => {
    serve({ tags: [], categories: [] });
    renderWithProviders(<ListsPage />, { ability: ADMIN });
    const card = cardOf(c.title);
    expect(await within(card).findByText(`No ${c.title.toLowerCase()} yet. Use Create above to add one.`)).toBeInTheDocument();
  });

  describe('create', () => {
    it('opens a form with a named colour row and ten swatches, and a default colour', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      expect(within(card).getByLabelText(`Name of the new ${c.singular}`)).toHaveFocus();
      const group = within(card).getByRole('radiogroup', { name: 'Colour' });
      expect(within(group).getAllByRole('radio')).toHaveLength(10);
      // Tags start on Grey; a category starts on the first palette colour no category uses (Red and Grey and Teal are taken: Orange).
      const expected = c.title === 'Tags' ? 'Grey' : 'Orange';
      expect(within(group).getByRole('radio', { name: expected })).toBeChecked();
      expect(within(card).getByText(expected, { selector: '[data-slot="lc-new-colour-name"]' })).toBeInTheDocument();
    });

    it('validates empty, too long and a case-different duplicate, keeping focus in the input', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      const input = within(card).getByLabelText(`Name of the new ${c.singular}`);
      await user.type(input, '  {Enter}');
      expect(await within(card).findByRole('alert')).toHaveTextContent('Enter a name.');
      fireEvent.change(input, { target: { value: 'x'.repeat(51) } });
      await user.type(input, '{Enter}');
      expect(await within(card).findByText('Use 50 characters or fewer.')).toBeInTheDocument();
      await user.clear(input);
      await user.type(input, 'urgent{Enter}');
      expect(await within(card).findByText(`${c.Singular} “Urgent” already exists.`)).toBeInTheDocument();
      expect(input).toHaveFocus();
      expect(calls.filter((x) => x.method === 'post')).toHaveLength(0);
    });

    it('answers the server\'s plain 409 (a name added a moment ago) with the same sentence', async () => {
      const { user, card } = await open(c.title);
      if (c.title === 'Tags') data.tags.push(tag('late', 'Late arrival'));
      else data.categories.push(category('late', 'Late arrival'));
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      await user.type(within(card).getByLabelText(`Name of the new ${c.singular}`), 'late arrival{Enter}');
      expect(await within(card).findByText(`${c.Singular} “late arrival” already exists.`)).toBeInTheDocument();
    });

    it('creates with the picked colour, toasts with Undo, flashes the row and returns focus to the create row', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      await user.type(within(card).getByLabelText(`Name of the new ${c.singular}`), 'Warranty');
      await user.click(within(card).getByRole('radio', { name: 'Blue' }));
      expect(within(card).getByText('Blue', { selector: '[data-slot="lc-new-colour-name"]' })).toBeInTheDocument();
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));

      expect(await within(card).findByText('Warranty')).toBeInTheDocument();
      expect(calls.find((x) => x.method === 'post' && x.url === c.path)?.body).toEqual({ name: 'Warranty', color: '#3B82F6' });
      expect(within(card).getByText('Warranty').closest('[role="listitem"]')).toHaveClass('is-flash');
      const saved = await lastSaved();
      expect(saved.text).toBe(`Saved · Created ${c.singular} “Warranty”`);
      expect(saved.undoLabel).toBe('Undo');
      await waitFor(() => expect(within(card).getByRole('button', { name: `Create ${c.singular}` })).toHaveFocus());
    });

    it('Undo of a Create deletes the new row through the list\'s own DELETE', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: `Create ${c.singular}` }));
      await user.type(within(card).getByLabelText(`Name of the new ${c.singular}`), 'Warranty{Enter}');
      await within(card).findByText('Warranty');
      await act(async () => (await lastSaved()).undo!());
      await waitFor(() => expect(within(card).queryByText('Warranty')).not.toBeInTheDocument());
      expect(calls.find((x) => x.method === 'delete')?.url).toMatch(new RegExp(`^${c.path}/(tag|cat)-`));
      expect(toastMock).toHaveBeenLastCalledWith('Change undone');
    });
  });

  describe('rename', () => {
    it('Enter saves only the name, toasts with Undo and returns focus to the pencil', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: 'Rename VIP' }));
      const input = within(card).getByLabelText('Name of VIP');
      await user.clear(input);
      await user.type(input, 'Gold{Enter}');
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Rename Gold' })).toHaveFocus());
      expect(calls.find((x) => x.method === 'patch')?.body).toEqual({ name: 'Gold' });
      expect((await lastSaved()).text).toBe('Saved · Renamed “VIP” to “Gold”');
      await act(async () => (await lastSaved()).undo!());
      await waitFor(() => expect(within(card).getByText('VIP')).toBeInTheDocument());
    });

    it('a case-different duplicate keeps the input open with the reason', async () => {
      const { user, card } = await open(c.title);
      await user.click(within(card).getByRole('button', { name: 'Rename VIP' }));
      const input = within(card).getByLabelText('Name of VIP');
      await user.clear(input);
      await user.type(input, 'URGENT{Enter}');
      expect(await within(card).findByRole('alert')).toHaveTextContent(`${c.Singular} “Urgent” already exists.`);
      expect(input).toHaveFocus();
    });
  });

  describe('colour', () => {
    const openPopover = async (title: string) => {
      const ctx = await open(title);
      const button = within(ctx.card).getByRole('button', { name: 'Colour of VIP: Grey. Change colour' });
      await ctx.user.click(button);
      return { ...ctx, button, dialog: await screen.findByRole('dialog', { name: 'Colour for VIP' }) };
    };

    it('shows the dot and colour name on the button, and ten named swatches in order in the popover', async () => {
      const { button, dialog } = await openPopover(c.title);
      expect(button).toHaveAttribute('aria-haspopup', 'dialog');
      expect(button).toHaveAttribute('title', 'Grey. Change colour');
      const swatches = within(dialog).getAllByRole('radio');
      expect(swatches.map((s) => s.getAttribute('aria-label'))).toEqual(['Red', 'Orange', 'Yellow', 'Green', 'Cyan', 'Blue', 'Violet', 'Pink', 'Grey', 'Teal']);
      expect(swatches.map((s) => s.getAttribute('title'))).toEqual(swatches.map((s) => s.getAttribute('aria-label')));
      expect(within(dialog).getByRole('radio', { name: 'Grey' })).toBeChecked();
      expect(dialog).toHaveTextContent('Selected: Grey');
      expect(dialog.className).toContain('w-[252px]');
    });

    it('picking Green saves the hex, closes, and toasts the colour change with Undo', async () => {
      const { user, card, dialog } = await openPopover(c.title);
      await user.click(within(dialog).getByRole('radio', { name: 'Green' }));
      await waitFor(() => expect(calls.find((x) => x.method === 'patch')?.body).toEqual({ color: '#22C55E' }));
      expect(screen.queryByRole('dialog', { name: 'Colour for VIP' })).not.toBeInTheDocument();
      expect((await lastSaved()).text).toBe('Saved · Colour of “VIP” is now Green');
      await waitFor(() => expect(within(card).getByRole('button', { name: 'Colour of VIP: Green. Change colour' })).toBeInTheDocument());

      await act(async () => (await lastSaved()).undo!());
      await waitFor(() => expect(calls.filter((x) => x.method === 'patch').at(-1)?.body).toEqual({ color: '#6B7280' }));
    });

    it('picking the colour already set only closes the popover', async () => {
      const { user, dialog } = await openPopover(c.title);
      await user.click(within(dialog).getByRole('radio', { name: 'Grey' }));
      expect(screen.queryByRole('dialog', { name: 'Colour for VIP' })).not.toBeInTheDocument();
      expect(calls.filter((x) => x.method === 'patch')).toHaveLength(0);
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('Escape closes it and returns focus to the colour button', async () => {
      const { user, button } = await openPopover(c.title);
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: 'Colour for VIP' })).not.toBeInTheDocument();
      expect(button).toHaveFocus();
    });
  });
});

describe('Tags card', () => {
  it('shows how many records carry each tag ("1 record", "38 records", "0 records")', async () => {
    const { card } = await open('Tags');
    expect(within(card).getByText('38 records')).toBeInTheDocument();
    expect(within(card).getByText('1 record')).toBeInTheDocument();
    expect(within(card).getByText('0 records')).toBeInTheDocument();
  });

  it('reads the tag list on the single shared cache key, with no params', async () => {
    await open('Tags');
    expect(mockApi.get).toHaveBeenCalledWith('/api/tags');
  });

  it('More has a red "Delete…" and nothing else; the dialog names the count and Delete tag removes it with no Undo', async () => {
    const { user, card } = await open('Tags');
    await user.click(within(card).getByRole('button', { name: 'More actions for Urgent' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual(['Delete…']);
    await user.click(items[0]!);

    const dialog = await screen.findByRole('dialog', { name: 'Delete “Urgent”?' });
    expect(dialog).toHaveTextContent('This removes the tag from 38 records it is assigned to. This can’t be undone.');
    await user.click(within(dialog).getByRole('button', { name: 'Delete tag' }));

    await waitFor(() => expect(calls.find((x) => x.method === 'delete')?.url).toBe('/api/tags/t1'));
    await waitFor(() => expect(within(card).queryByText('Urgent')).not.toBeInTheDocument());
    const saved = await lastSaved();
    expect(saved.text).toBe('Saved · Deleted tag “Urgent”');
    expect(saved.undo).toBeUndefined();
    // The toast keeps a fixed id so a new one replaces the last, and the toaster MERGES options onto the toast it
    // replaces: a delete that merely omitted `action` would inherit the previous change's Undo button. It must say
    // "no action" outright.
    expect(toastMock.mock.calls.at(-1)![1]).toHaveProperty('action', undefined);
  });

  it('says "1 record" for a tag on one record, and Cancel deletes nothing', async () => {
    const { user, card } = await open('Tags');
    await user.click(within(card).getByRole('button', { name: 'More actions for VIP' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete “VIP”?' });
    expect(dialog).toHaveTextContent('from 1 record it is assigned to');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.filter((x) => x.method === 'delete')).toHaveLength(0);
  });

  it('drops every cached copy of a tag when it is renamed, recoloured or deleted', async () => {
    const KEYS = ['tags', 'customer', 'customers', 'lead', 'leads', 'estimate', 'estimates', 'job', 'jobs', 'invoice', 'invoices', 'schedule-jobs', 'schedule-walkthroughs', 'schedule-unassigned', 'schedule-unscheduled-walkthroughs'];
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<ListsPage />, { ability: ADMIN });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const card = await (async () => { await screen.findByRole('heading', { name: 'Tags' }); return cardOf('Tags'); })();
    await within(card).findByText('Urgent');
    const missing = () => {
      const seen = new Set(invalidate.mock.calls.map((x) => JSON.stringify(x[0]?.queryKey)));
      return KEYS.filter((k) => !seen.has(JSON.stringify([k])));
    };

    await user.click(within(card).getByRole('button', { name: 'Rename VIP' }));
    await user.type(within(card).getByLabelText('Name of VIP'), '2{Enter}');
    await waitFor(() => expect(calls.some((x) => x.method === 'patch')).toBe(true));
    await waitFor(() => expect(missing()).toEqual([]));

    invalidate.mockClear();
    await user.click(within(card).getByRole('button', { name: 'Colour of Stale: Teal. Change colour' }));
    await user.click(await screen.findByRole('radio', { name: 'Red' }));
    await waitFor(() => expect(missing()).toEqual([]));

    invalidate.mockClear();
    await user.click(within(card).getByRole('button', { name: 'More actions for Stale' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete tag' }));
    await waitFor(() => expect(missing()).toEqual([]));
  });

  it('150 tags: the card holds one rows area, search narrows over all of them and Most used puts the busiest first', async () => {
    serve({
      tags: [...Array.from({ length: 150 }, (_, i) => tag(`bulk-${i}`, `Label ${i + 1}`, { usage_count: i % 5 })), tag('top', 'Zzz busiest', { usage_count: 900 })],
      categories: [],
    });
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: ADMIN });
    const card = await (async () => { await screen.findByRole('heading', { name: 'Tags' }); return cardOf('Tags'); })();
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(151));
    expect(card.querySelectorAll('.lc-scroll')).toHaveLength(1);
    expect(within(card).getByText('151 tags')).toBeInTheDocument();
    await user.type(within(card).getByRole('searchbox', { name: 'Search tags' }), 'Label 14');
    expect(within(card).getAllByRole('listitem')).toHaveLength(11);
    expect(within(card).getByText('11 of 151')).toBeInTheDocument();
    await user.clear(within(card).getByRole('searchbox', { name: 'Search tags' }));
    await user.click(within(card).getByRole('combobox', { name: 'Sort tags' }));
    await user.click(screen.getByRole('option', { name: 'Most used' }));
    expect(within(card).getAllByRole('listitem')[0]).toHaveTextContent('Zzz busiest');
  });
});

describe('Task categories card', () => {
  it('shows how many tasks use each category, with an open/done tooltip', async () => {
    const { card } = await open('Task categories');
    expect(within(card).getByText('5 tasks')).toHaveAttribute('title', '2 open, 3 done');
    expect(within(card).getByText('1 task')).toHaveAttribute('title', '1 open, 0 done');
    expect(within(card).getByText('0 tasks')).toBeInTheDocument();
  });

  it('150 categories: one rows area, search narrows over all of them', async () => {
    serve({ tags: [], categories: Array.from({ length: 150 }, (_, i) => category(`bulk-${i}`, `Kind ${i + 1}`, { sort_order: i, task_counts: { open: i % 4, done: 0 } })) });
    const user = userEvent.setup();
    renderWithProviders(<ListsPage />, { ability: ADMIN });
    await screen.findByRole('heading', { name: 'Task categories' });
    const card = cardOf('Task categories');
    await waitFor(() => expect(within(card).getAllByRole('listitem')).toHaveLength(150));
    expect(card.querySelectorAll('.lc-scroll')).toHaveLength(1);
    await user.type(within(card).getByRole('searchbox', { name: 'Search task categories' }), 'Kind 14');
    expect(within(card).getAllByRole('listitem')).toHaveLength(11);
  });

  describe('delete', () => {
    const openDelete = async (name: string) => {
      const ctx = await open('Task categories');
      await ctx.user.click(within(ctx.card).getByRole('button', { name: `More actions for ${name}` }));
      await ctx.user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
      return { ...ctx, dialog: await screen.findByRole('dialog', { name: `Delete “${name}”?` }) };
    };

    it('a category no task uses: one button, and the toast says so', async () => {
      const { user, card, dialog } = await openDelete('Stale');
      expect(dialog).toHaveTextContent('No tasks use this category.');
      await user.click(within(dialog).getByRole('button', { name: 'Delete category' }));
      await waitFor(() => expect(within(card).queryByText('Stale')).not.toBeInTheDocument());
      expect(calls.find((x) => x.method === 'delete')?.body).toEqual({ mode: 'keep' });
      const saved = await lastSaved();
      expect(saved.text).toBe('Saved · Deleted category “Stale”');
      expect(saved.undo).toBeUndefined();
    });

    it('keep: toasts "Deleted …, tasks kept"', async () => {
      const { user, dialog } = await openDelete('Urgent');
      await user.click(within(dialog).getByRole('button', { name: 'Delete category' }));
      await waitFor(() => expect(calls.some((x) => x.method === 'delete')).toBe(true));
      expect((await lastSaved()).text).toBe('Saved · Deleted “Urgent”, tasks kept');
    });

    it('move: names the target in the toast', async () => {
      const { user, dialog } = await openDelete('Urgent');
      await user.click(within(dialog).getByRole('radio', { name: /Move them to another category/ }));
      await user.click(within(dialog).getByRole('combobox', { name: 'Move tasks to' }));
      await user.click(await screen.findByRole('option', { name: 'VIP' }));
      await user.click(within(dialog).getByRole('button', { name: 'Delete category' }));
      await waitFor(() => expect(calls.find((x) => x.method === 'delete')?.body).toEqual({ mode: 'move', target_id: 'c2' }));
      expect((await lastSaved()).text).toBe('Saved · Deleted “Urgent”, tasks moved to “VIP”');
    });

    it('also delete: needs the typed name, then toasts the number of tasks', async () => {
      const { user, dialog } = await openDelete('Urgent');
      await user.click(within(dialog).getByRole('radio', { name: /Also delete the 5 tasks/ }));
      const confirm = within(dialog).getByRole('button', { name: 'Delete category and 5 tasks' });
      expect(confirm).toBeDisabled();
      await user.type(within(dialog).getByLabelText('Type “Urgent” to confirm'), 'Urgent');
      expect(confirm).toBeEnabled();
      await user.click(confirm);
      await waitFor(() => expect(calls.find((x) => x.method === 'delete')?.body).toEqual({ mode: 'delete_tasks', confirm_name: 'Urgent', expected_task_count: 5 }));
      expect((await lastSaved()).text).toBe('Saved · Deleted “Urgent” and 5 tasks');
    });
  });
});

describe('closing a delete dialog with Escape', () => {
  it.each([['Tags', 'VIP'], ['Task categories', 'VIP']])('%s: focus returns to the row\'s "More actions" button', async (title, name) => {
    const { user, card } = await open(title);
    await user.click(within(card).getByRole('button', { name: `More actions for ${name}` }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete…' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(within(card).getByRole('button', { name: `More actions for ${name}` })).toHaveFocus());
  });
});

describe('gating', () => {
  it('a Tags viewer without delete Tag has no "Delete…" and one without create Tag has no create row', async () => {
    const { TagsCard } = await import('@/pages/v2/settings/ListsPage');
    renderWithProviders(<TagsCard />, { ability: buildAbility([{ action: 'update', subject: 'Tag' }, { action: 'read', subject: 'Tag' }]) });
    const card = cardOf('Tags');
    await within(card).findByText('Urgent');
    expect(within(card).queryByRole('button', { name: /^Create tag/ })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Rename Urgent' })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'More actions for Urgent' })).not.toBeInTheDocument();
  });

  it('a read-only viewer sees a static dot and name: no pencil, no More, no create row, no colour button', async () => {
    const { TagsCard } = await import('@/pages/v2/settings/ListsPage');
    renderWithProviders(<TagsCard />, { ability: buildAbility([{ action: 'read', subject: 'Tag' }]) });
    const card = cardOf('Tags');
    await within(card).findByText('Urgent');
    expect(within(card).queryByRole('button', { name: /^Create/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^Rename / })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /^More actions/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Change colour/ })).not.toBeInTheDocument();
    expect(within(card).getAllByText('Red').length).toBeGreaterThan(0);
  });
});

describe('columns', () => {
  it('Tags and Task categories add a Colour column between Name and Used by (132px wide, 40px in a narrow card)', async () => {
    const { card } = await open('Tags');
    const body = card.querySelector('.lc-body') as HTMLElement;
    expect(body.style.getPropertyValue('--cols')).toBe('minmax(0, 1fr) 132px 104px var(--act-w)');
    expect(body.style.getPropertyValue('--cols-s')).toBe('minmax(0, 1fr) 40px 84px var(--act-w-s)');
    expect(within(card).getByText('Colour', { selector: '.lc-head-colour' })).toBeInTheDocument();
    expect(card.querySelector('.lc-head')!.textContent).toBe('NameColourUsed byActions');
    // Job types keep the old four columns.
    const jobs = cardOf('Job types').querySelector('.lc-body') as HTMLElement;
    expect(jobs.style.getPropertyValue('--cols')).toBe('28px minmax(0, 1fr) 104px var(--act-w)');
  });
});
