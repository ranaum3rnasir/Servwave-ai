/**
 * Admins manage task categories (visits-and-task-categories slice 09), frontend half.
 *
 * An admin adds, renames and recolors categories from one shared manage panel, opened by the
 * admin-only "Categories" button on the Tasks page and by the Task categories card in
 * Settings > Payments & Lists; and creates one from a task's category picker through its fixed
 * "Create category" row (anything typed pre-fills the name). Non-admins see none of it. A rename or recolor shows on every task
 * already carrying the category, and the chip's text stays readable on every palette color.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from './helpers';
import api from '@/lib/axios';
import { TaskCategoryChip } from '@/components/tasks/TaskCategoryChip';
import { TaskCategoryManager } from '@/components/tasks/TaskCategoryManager';
import { contrastRatio } from '@/design-system/contrast';
import { TAG_COLORS } from '@/lib/tag-colors';
import { taskCategoryKeys, type TaskCategoryRow } from '@/lib/api/taskCategories';
import type { Task, TaskCategoryRef } from '@/lib/tasks/types';
import { useTasksStore } from '@/stores/tasksStore';
import ListView from '@/pages/v2/tasks/views/listView';
import { useTaskDetailStore } from '@/stores/taskDetailStore';
import { TaskDetailDrawer as V2TaskDetailDrawer } from '@/pages/v2/tasks/components/taskDetailDrawer';
import { CreateTaskDialog } from '@/pages/v2/tasks/components/createTaskDialog';
import { TaskDetailDrawer as LegacyTaskDetailDrawer } from '@/components/tasks/TaskDetailDrawer';
import { CreateTaskModal } from '@/components/tasks/CreateTaskModal';
import TasksHubPage from '@/pages/v2/tasks/TasksHubPage';
import PaymentsListsPage from '@/pages/v2/settings/PaymentsListsPage';
import { buildAbility } from '@/lib/ability';

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
/** What every non-admin role holds on categories: read, nothing else (DEFAULT_GRANTS). */
const NON_ADMIN = buildAbility([
  { action: 'read', subject: 'TaskCategory' },
  { action: 'create', subject: 'Task' },
  { action: 'update', subject: 'Task' },
  { action: 'create', subject: 'Tag' },
]);

const ORG = {
  id: 'o1', stripe_account_id: null, accepted_payment_methods: ['CASH'], source_options: ['Google'],
  job_type_options: [], deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 40,
  deposit_default_fixed_amount: 0,
};

const mockApi = vi.mocked(api);

vi.mock('@/lib/api/users', () => ({
  useAssignableUsers: vi.fn(() => ({ data: [], isLoading: false })),
}));
vi.mock('@/components/crm/MultiAssigneeSelect', () => ({
  MultiAssigneeSelect: ({ id, value }: { id?: string; value: string[] }) => (
    <div data-testid={id ?? 'multi-assignee-select'}>{value.join(',')}</div>
  ),
}));
const ME = '00000000-0000-0000-0000-000000000001';

const FOLLOW_UP: TaskCategoryRef = { id: 'cat-follow', name: 'Follow-up', color: '#22C55E' };
const PART_ORDER: TaskCategoryRef = { id: 'cat-parts', name: 'Part order', color: '#F97316' };
const INTERNAL: TaskCategoryRef = { id: 'cat-internal', name: 'Internal', color: '#6B7280' };

/** The server's list, mutated by the mocked POST/PATCH so a refetch reads what was written. */
let serverList: TaskCategoryRow[];

/** The store's real actions, restored before each test; picker tests swap in spies. */
const REAL_TASK_ACTIONS = { ...useTasksStore.getState() };
const mockUpdateTask = vi.fn().mockResolvedValue(undefined);
const mockAddTask = vi.fn();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1', task_number: 'T00001', title: 'Order the hinge kit', description: '',
    status: 'TODO', priority: 'MEDIUM', assignee_ids: [ME], assignees: [{ id: ME, name: 'Test Admin' }],
    watcher_ids: [], due_at: null, linked_entity: null, tags: [], category: PART_ORDER, subtasks: [],
    created_by: ME, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    completed_at: null, activity: [], comments: [],
    ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' },
    ...overrides,
  };
}

function conflict(message: string) {
  return Object.assign(new Error('Request failed with status code 409'), {
    response: { status: 409, data: { error: message, code: 'CATEGORY_EXISTS' } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  serverList = [FOLLOW_UP, PART_ORDER, INTERNAL].map((c, i) => ({ ...c, sort_order: i }));
  useTasksStore.setState({ ...REAL_TASK_ACTIONS, tasks: [], loaded: true, loading: false });
  useTaskDetailStore.setState({ openTaskId: null });
  mockApi.get.mockImplementation((url: string) =>
    url === '/api/task-categories'
      ? Promise.resolve({ data: { categories: serverList.map((c) => ({ ...c })) } })
      : url === '/api/organization'
        ? Promise.resolve({ data: ORG })
        : Promise.resolve({ data: { tasks: [], users: [], departments: [] } }),
  );
  mockApi.post.mockImplementation((url: string, body: { name: string; color: string }) => {
    if (url !== '/api/task-categories') return Promise.resolve({ data: {} });
    if (serverList.some((c) => c.name.toLowerCase() === body.name.toLowerCase())) {
      return Promise.reject(conflict(`A category named "${body.name}" already exists.`));
    }
    const row = { id: `cat-${serverList.length}`, ...body, sort_order: serverList.length };
    serverList.push(row);
    return Promise.resolve({ data: { category: row } });
  });
  mockApi.patch.mockImplementation((url: string, body: Partial<TaskCategoryRow>) => {
    const row = serverList.find((c) => url === `/api/task-categories/${c.id}`);
    if (!row) return Promise.resolve({ data: {} });
    Object.assign(row, body);
    return Promise.resolve({ data: { category: { ...row } } });
  });
});

/** jsdom reports inline colors as rgb(); contrastRatio wants hex. */
function rgbToHex(rgb: string): string {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

describe('the category chip (the approved mockup: a tinted fill, dark text, a dot in the color)', () => {
  it.each(TAG_COLORS)('on %s: the dot carries the color, the fill is a tint of it, the text passes WCAG AA', (color) => {
    render(<TaskCategoryChip category={{ id: 'c', name: 'Follow-up', color }} />);
    const chip = screen.getByTestId('task-category-chip');
    expect(chip).toHaveTextContent('Follow-up');
    expect(within(chip).getByTestId('task-category-dot')).toHaveStyle({ backgroundColor: color });
    const fill = rgbToHex(chip.style.backgroundColor);
    const text = rgbToHex(chip.style.color);
    expect(fill).not.toBe(color);
    // A tint: lighter than the color itself.
    expect(contrastRatio(fill, '#000000')).toBeGreaterThan(contrastRatio(color, '#000000'));
    expect(contrastRatio(text, fill)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the manage panel', () => {
  it('lists the categories with their colors', async () => {
    renderWithProviders(<TaskCategoryManager />);
    const list = await screen.findByRole('list', { name: 'Task categories' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringContaining('Follow-up'), expect.stringContaining('Part order'), expect.stringContaining('Internal'),
    ]);
  });

  it('adds a category with a name and a palette color', async () => {
    const user = userEvent.setup();
    const { queryClient } = renderWithProviders(<TaskCategoryManager />);

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    await user.type(screen.getByRole('textbox', { name: 'Category name' }), 'Warranty');
    await user.click(screen.getByRole('radio', { name: 'Color #14B8A6' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/task-categories', { name: 'Warranty', color: '#14B8A6' }),
    );
    const list = screen.getByRole('list', { name: 'Task categories' });
    expect(await within(list).findByText('Warranty')).toBeInTheDocument();
    // Every picker reads the one shared list, so it holds the new category too.
    await waitFor(() =>
      expect(queryClient.getQueryData<TaskCategoryRow[]>(taskCategoryKeys.all)?.map((c) => c.name)).toContain('Warranty'),
    );
  });

  it('offers exactly the ten Tags palette colors', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskCategoryManager />);

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    const swatches = within(screen.getByRole('radiogroup', { name: 'Color' })).getAllByRole('radio');
    expect(swatches.map((s) => s.getAttribute('aria-label'))).toEqual(TAG_COLORS.map((c) => `Color ${c}`));
  });

  it('shows the server\'s message when the name is already taken, and keeps the form open', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskCategoryManager />);

    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    await user.type(screen.getByRole('textbox', { name: 'Category name' }), 'part ORDER');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('A category named "part ORDER" already exists.');
    expect(screen.getByRole('textbox', { name: 'Category name' })).toHaveValue('part ORDER');
  });

  it('renames and recolors a category inline', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskCategoryManager />);

    await user.click(await screen.findByRole('button', { name: 'Edit Part order' }));
    const field = screen.getByRole('textbox', { name: 'Category name' });
    await user.clear(field);
    await user.type(field, 'Parts to order');
    await user.click(screen.getByRole('radio', { name: 'Color #EAB308' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/task-categories/cat-parts', {
        name: 'Parts to order', color: '#EAB308',
      }),
    );
    expect(await screen.findByText('Parts to order')).toBeInTheDocument();
  });

  it('sends only what changed, and nothing when nothing did', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskCategoryManager />);

    await user.click(await screen.findByRole('button', { name: 'Edit Internal' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockApi.patch).not.toHaveBeenCalled();

    await user.click(await screen.findByRole('button', { name: 'Edit Internal' }));
    await user.click(screen.getByRole('radio', { name: 'Color #3B82F6' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith('/api/task-categories/cat-internal', { color: '#3B82F6' }),
    );
  });

  it('tidies the spacing of a new name, and treats a spacing-only rename as no change', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TaskCategoryManager />);

    await user.click(await screen.findByRole('button', { name: 'Edit Part order' }));
    const field = screen.getByRole('textbox', { name: 'Category name' });
    await user.clear(field);
    await user.type(field, '  Part    order ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockApi.patch).not.toHaveBeenCalled();

    await user.click(await screen.findByRole('button', { name: 'Edit Internal' }));
    const internal = screen.getByRole('textbox', { name: 'Category name' });
    await user.clear(internal);
    await user.type(internal, 'Inter\u200Bnal\uFEFF');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mockApi.patch).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Add category' }));
    await user.type(screen.getByRole('textbox', { name: 'Category name' }), ' Warranty   claim ');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/task-categories', expect.objectContaining({ name: 'Warranty claim' })),
    );
  });

  it('offers Delete on every row (slice 11; the dialog is covered in task-category-delete.test.tsx)', async () => {
    renderWithProviders(<TaskCategoryManager />);
    await screen.findByText('Internal');
    for (const name of ['Follow-up', 'Part order', 'Internal']) {
      expect(screen.getByRole('button', { name: `Delete ${name}` })).toBeInTheDocument();
    }
  });
});

describe('a rename or recolor shows on every task already carrying the category', () => {
  it('the Tasks page list and the task store both follow the new name and color', async () => {
    const user = userEvent.setup();
    useTasksStore.setState({
      tasks: [makeTask(), makeTask({ id: 't2', title: 'Call the lab', category: FOLLOW_UP })],
      loaded: true,
    });
    renderWithProviders(<><TaskCategoryManager /><ListView /></>);
    const row = screen.getByRole('row', { name: /Order the hinge kit/ });
    expect(within(row).getByTestId('task-category-chip')).toHaveTextContent('Part order');

    await user.click(await screen.findByRole('button', { name: 'Edit Part order' }));
    const field = screen.getByRole('textbox', { name: 'Category name' });
    await user.clear(field);
    await user.type(field, 'Parts to order');
    await user.click(screen.getByRole('radio', { name: 'Color #EAB308' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(within(screen.getByRole('row', { name: /Order the hinge kit/ })).getByTestId('task-category-chip'))
        .toHaveTextContent('Parts to order'),
    );
    expect(within(screen.getByRole('row', { name: /Order the hinge kit/ })).getByTestId('task-category-dot'))
      .toHaveStyle({ backgroundColor: '#EAB308' });
    // The store both task UIs read (the Tasks page and the Job/Lead Tasks tab drawers) is patched;
    // a task in another category is untouched.
    const [t1, t2] = useTasksStore.getState().tasks;
    expect(t1.category).toEqual({ id: 'cat-parts', name: 'Parts to order', color: '#EAB308' });
    expect(t2.category).toEqual(FOLLOW_UP);
  });
});

describe('the Tasks page "Categories" button', () => {
  it('sits left of New Task for an admin and opens the manage panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksHubPage />, { ability: ADMIN });

    const categories = screen.getByRole('button', { name: 'Categories' });
    const newTask = screen.getByRole('button', { name: 'New Task' });
    expect(categories.compareDocumentPosition(newTask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(categories);
    const dialog = await screen.findByRole('dialog', { name: 'Task categories' });
    expect(await within(dialog).findByRole('list', { name: 'Task categories' })).toBeInTheDocument();
    // In the header row beside the title, as the mockup draws it.
    const header = dialog.querySelector('[data-slot="dialog-header"]') as HTMLElement;
    expect(within(header).getByRole('button', { name: 'Add category' })).toBeInTheDocument();
  });

  it('Escape while editing a category cancels the edit, not the dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksHubPage />, { ability: ADMIN });
    await user.click(screen.getByRole('button', { name: 'Categories' }));
    const dialog = await screen.findByRole('dialog', { name: 'Task categories' });

    await user.click(await within(dialog).findByRole('button', { name: 'Edit Part order' }));
    await user.type(within(dialog).getByRole('textbox', { name: 'Category name' }), ' typo');
    await user.keyboard('{Escape}');

    expect(screen.getByRole('dialog', { name: 'Task categories' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: 'Category name' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Part order')).toBeInTheDocument();
    expect(mockApi.patch).not.toHaveBeenCalled();

    // With no edit open, Escape closes the dialog as usual.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task categories' })).not.toBeInTheDocument());
  });

  it('Escape while adding a category cancels the add, not the dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<TasksHubPage />, { ability: ADMIN });
    await user.click(screen.getByRole('button', { name: 'Categories' }));
    const dialog = await screen.findByRole('dialog', { name: 'Task categories' });

    await user.click(within(dialog).getByRole('button', { name: 'Add category' }));
    await user.click(within(dialog).getByRole('radio', { name: 'Color #3B82F6' }));
    await user.keyboard('{Escape}');

    expect(screen.getByRole('dialog', { name: 'Task categories' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox', { name: 'Category name' })).not.toBeInTheDocument();
  });

  it('is not there for a non-admin', async () => {
    renderWithProviders(<TasksHubPage />, { ability: NON_ADMIN });
    expect(screen.getByRole('button', { name: 'New Task' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Categories' })).not.toBeInTheDocument();
  });
});

describe('Settings > Payments & Lists - Task categories card', () => {
  it('an admin sees it beside the Tags card, holding the manage panel', async () => {
    renderWithProviders(<PaymentsListsPage />, { ability: ADMIN });
    const heading = await screen.findByRole('heading', { name: 'Task categories' });
    const tags = screen.getByRole('heading', { name: 'Tags' });
    expect(tags.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Task categories' })).toBeInTheDocument();
    // "Add category" sits in the card's header row, beside its title.
    expect(heading.parentElement!.parentElement).toContainElement(screen.getByRole('button', { name: 'Add category' }));
  });

  it('a non-admin does not see it', async () => {
    renderWithProviders(<PaymentsListsPage />, { ability: NON_ADMIN });
    await screen.findByText('Job Types');
    expect(screen.queryByRole('heading', { name: 'Task categories' })).not.toBeInTheDocument();
  });
});

/** The picker's fixed create row - the same row, the same label, typed or not. */
const createRow = () => screen.getByRole('option', { name: 'Create category' });

/** Type a name (or nothing), pick "Create category", finish it in the dialog with a color. */
async function createFromPicker(user: ReturnType<typeof userEvent.setup>, name: string, color: string) {
  await user.click(screen.getByRole('combobox', { name: 'Category' }));
  if (name) await user.type(await screen.findByPlaceholderText(/search/i), name);
  await user.click(createRow());
  const dialog = await screen.findByRole('dialog', { name: 'New task category' });
  expect(within(dialog).getByRole('textbox', { name: 'Category name' })).toHaveValue(name);
  await user.click(within(dialog).getByRole('radio', { name: `Color ${color}` }));
  await user.click(within(dialog).getByRole('button', { name: 'Create category' }));
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledWith('/api/task-categories', { name, color }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New task category' })).not.toBeInTheDocument());
}

describe.each([
  ['Tasks page drawer', V2TaskDetailDrawer],
  ['legacy drawer (Job/Lead Tasks tab)', LegacyTaskDetailDrawer],
])('%s - the category picker', (_name, Drawer) => {
  beforeEach(() => {
    useTasksStore.setState({ tasks: [makeTask()], updateTask: mockUpdateTask, fetchTaskDetail: vi.fn().mockResolvedValue(undefined) });
    useTaskDetailStore.setState({ openTaskId: 't1' });
  });

  it('an admin sees "Create category" pinned below the list the moment it opens, nothing typed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Drawer />, { ability: ADMIN });

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Internal' });
    const options = screen.getAllByRole('option');
    expect(options[options.length - 1]).toBe(createRow());
    expect(screen.getByPlaceholderText(/search/i)).toHaveValue('');
  });

  it('an admin types a new name, creates the category, and the task takes it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Drawer />, { ability: ADMIN });

    await createFromPicker(user, 'Warranty', '#14B8A6');

    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('t1', {
        category: { id: 'cat-3', name: 'Warranty', color: '#14B8A6' },
      }),
    );
  });

  it('with nothing typed, the row opens the dialog with an empty name, and an empty name cannot be saved', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Drawer />, { ability: ADMIN });

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(createRow());
    const dialog = await screen.findByRole('dialog', { name: 'New task category' });
    const name = within(dialog).getByRole('textbox', { name: 'Category name' });
    expect(name).toHaveValue('');

    const save = within(dialog).getByRole('button', { name: 'Create category' });
    expect(save).toBeDisabled();
    await user.type(name, '   ');
    expect(save).toBeDisabled();
    await user.type(name, '{Enter}');
    expect(mockApi.post).not.toHaveBeenCalledWith('/api/task-categories', expect.anything());

    await user.clear(name);
    await user.type(name, 'Warranty');
    await user.click(within(dialog).getByRole('radio', { name: 'Color #14B8A6' }));
    await user.click(save);
    await waitFor(() =>
      expect(mockUpdateTask).toHaveBeenCalledWith('t1', {
        category: { id: 'cat-3', name: 'Warranty', color: '#14B8A6' },
      }),
    );
  });

  it('the row stays the same while searching - an exact existing name still finds it, and the label never changes', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Drawer />, { ability: ADMIN });

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Part order' });
    await user.type(await screen.findByPlaceholderText(/search/i), '  part   ORDER ');
    expect(screen.getByRole('option', { name: 'Part order' })).toBeInTheDocument();
    expect(createRow()).toBeInTheDocument();
    expect(screen.queryByText(/^Create "/)).not.toBeInTheDocument();
  });

  it.each(['Internal ', '  internal', 'Inter\u200Bnal'])(
    'a spacing or invisible-character variant of "Internal" finds it, with the same create row below (%j)',
    async (typed) => {
      const user = userEvent.setup();
      renderWithProviders(<Drawer />, { ability: ADMIN });

      await user.click(screen.getByRole('combobox', { name: 'Category' }));
      await screen.findByRole('option', { name: 'Internal' });
      await user.type(await screen.findByPlaceholderText(/search/i), typed);
      expect(screen.getByRole('option', { name: 'Internal' })).toBeInTheDocument();
      expect(createRow()).toBeInTheDocument();
    },
  );

  it('keyboard: with nothing typed, arrow down to the create row and press Enter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Drawer />, { ability: ADMIN });

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Internal' });
    const search = await screen.findByPlaceholderText(/search/i);
    const create = createRow();
    // The highlighted row: cmdk marks it aria-selected (kit), the app combobox points
    // aria-activedescendant at it.
    const highlighted = () =>
      create.getAttribute('aria-selected') === 'true' || search.getAttribute('aria-activedescendant') === create.id;
    const rows = screen.getAllByRole('option').length;
    for (let i = 0; i < rows && !highlighted(); i += 1) await user.keyboard('{ArrowDown}');
    expect(highlighted()).toBe(true);
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'New task category' });
    expect(within(dialog).getByRole('textbox', { name: 'Category name' })).toHaveValue('');
  });

  it.each(['Part', 'order', 'Cat'])(
    'an admin can create "%s", a name that is only PART of an existing one (or of "No category")',
    async (name) => {
      const user = userEvent.setup();
      renderWithProviders(<Drawer />, { ability: ADMIN });

      await createFromPicker(user, name, '#EF4444');

      await waitFor(() =>
        expect(mockUpdateTask).toHaveBeenCalledWith('t1', { category: { id: 'cat-3', name, color: '#EF4444' } }),
      );
    },
  );

  it('says so when nothing matches, and the create row is still there', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Drawer />, { ability: ADMIN });

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.type(await screen.findByPlaceholderText(/search/i), 'Warranty');
    expect(await screen.findByText('No category matches "Warranty"')).toBeInTheDocument();
    // Last row, after anything still on screen (the app combobox keeps the current selection).
    const options = screen.getAllByRole('option');
    expect(options[options.length - 1]).toBe(createRow());
    expect(options.map((o) => o.textContent)).not.toContain('Warranty');
  });

  it('a non-admin can only pick an existing category - nothing to type, nothing to create', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Drawer />, { ability: NON_ADMIN });

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Internal' });
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Create category' })).not.toBeInTheDocument();
    expect(screen.queryByText('Create category')).not.toBeInTheDocument();
  });
});

describe.each([
  ['Tasks page', CreateTaskDialog],
  ['legacy', CreateTaskModal],
])('%s create dialog - the category picker', (_name, Dialog) => {
  beforeEach(() => {
    mockAddTask.mockResolvedValue(makeTask());
    useTasksStore.setState({ addTask: mockAddTask });
  });

  it('an admin creates a category from the picker and the new task is filed under it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Dialog open onOpenChange={vi.fn()} />, { ability: ADMIN });

    await user.type(screen.getByPlaceholderText('Task title'), 'Replace the closer');
    await createFromPicker(user, 'Warranty', '#8B5CF6');
    // The task dialog is still open, and creating the category did not create the task.
    expect(mockAddTask).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(mockAddTask).toHaveBeenCalled());
    expect(mockAddTask.mock.calls[0][0].category_id).toBe('cat-3');
  });

  it('an admin sees the create row with nothing typed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Dialog open onOpenChange={vi.fn()} />, { ability: ADMIN });

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Internal' });
    expect(createRow()).toBeInTheDocument();
  });

  it('a non-admin is offered no create option', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Dialog open onOpenChange={vi.fn()} />, { ability: NON_ADMIN });

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Internal' });
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Create category' })).not.toBeInTheDocument();
  });
});

describe('the picker\'s create dialog', () => {
  beforeEach(() => {
    useTasksStore.setState({ tasks: [makeTask()], updateTask: mockUpdateTask, fetchTaskDetail: vi.fn().mockResolvedValue(undefined) });
    useTaskDetailStore.setState({ openTaskId: 't1' });
  });

  it('shows the duplicate refusal in the dialog, keeps it open, and leaves the task unchanged', async () => {
    const user = userEvent.setup();
    renderWithProviders(<V2TaskDetailDrawer />, { ability: ADMIN });
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await screen.findByRole('option', { name: 'Internal' });
    // Another admin adds "Warranty" after this picker loaded its list.
    serverList.push({ id: 'cat-late', name: 'Warranty', color: '#EF4444', sort_order: 3 });

    await user.type(await screen.findByPlaceholderText(/search/i), 'WARRANTY');
    await user.click(createRow());
    const dialog = await screen.findByRole('dialog', { name: 'New task category' });
    await user.click(within(dialog).getByRole('button', { name: 'Create category' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A category named "WARRANTY" already exists.');
    expect(screen.getByRole('dialog', { name: 'New task category' })).toBeInTheDocument();
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });

  it('refuses a name already in the list the same way, after the row pre-fills it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<V2TaskDetailDrawer />, { ability: ADMIN });
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.type(await screen.findByPlaceholderText(/search/i), 'internal');
    await user.click(createRow());
    const dialog = await screen.findByRole('dialog', { name: 'New task category' });
    expect(within(dialog).getByRole('textbox', { name: 'Category name' })).toHaveValue('internal');
    await user.click(within(dialog).getByRole('button', { name: 'Create category' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A category named "internal" already exists.');
    expect(mockUpdateTask).not.toHaveBeenCalled();
  });
});
