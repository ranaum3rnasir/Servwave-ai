import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import { renderSchedule, serveSchedule } from '@/__tests__/harness/schedulePage';
import { useAuthStore } from '@/stores/auth.store';

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

// Issue #369 — the Schedule tab's department filter dropdown gains a
// "+ Add department" option (ADMIN-gated, mirrors POST /api/departments) that
// opens a create modal and, on success, selects the new department as the
// active filter. The '__add__' option is a reserved sentinel: picking it must
// NOT change the active filter, only open the dialog.
//
// Task 10 repointed this dropdown to SelectField (Radix Select) — an in-DOM
// portal that only renders when open and exposes no native `.value`/`<option>`
// DOM APIs. These tests drive it via real clicks (open trigger → click item)
// instead of `fireEvent.change`, and read the current filter off the
// trigger's rendered label instead of `select.value`.
const mockApi = vi.mocked(api);

const DEPT_A = { id: 'dept-a', name: 'HVAC', head_id: null, created_at: '' };
const NEW_DEPT = { id: 'dept-new', name: 'Night Crew', head_id: null, created_at: '' };

/** Departments returned by GET /api/departments — mutable so the post-create
 *  invalidation refetch can observe the newly created department. */
let departmentRows: Array<typeof DEPT_A>;

beforeEach(() => {
  vi.clearAllMocks();
  departmentRows = [DEPT_A];
  serveSchedule({ jobs: [], bucketJobs: [], departments: () => departmentRows });
  mockApi.post.mockImplementation((url: string) => {
    if (url === '/api/departments') {
      departmentRows = [...departmentRows, NEW_DEPT];
      return Promise.resolve({ data: { department: NEW_DEPT } });
    }
    return Promise.resolve({ data: {} });
  });
});

const ADMIN = buildAbility([{ action: 'manage', subject: 'all' }]);
// Dispatcher-like: full schedule read, but NO create Department grant.
const NO_CREATE_DEPT = buildAbility([
  { action: 'read', subject: 'Job' },
  { action: 'read', subject: 'Lead' },
  { action: 'read', subject: 'Department' },
]);

/** The department filter's Radix Select trigger (button[role="combobox"]). */
const getDeptTrigger = async () =>
  screen.findByRole('combobox', { name: 'Filter schedule by department' });

describe('SchedulePage — "+ Add department" in the department filter (issue #369)', () => {
  it('renders the "+ Add department" option for a user who can create departments', async () => {
    const user = userEvent.setup();
    renderSchedule({ ability: ADMIN, tooltip: false });
    const trigger = await getDeptTrigger();
    expect(trigger).toHaveTextContent('All departments');
    await user.click(trigger);
    await screen.findByRole('option', { name: 'HVAC' });
    expect(screen.getByRole('option', { name: '+ Add department' })).toBeInTheDocument();
  });

  it('hides the option from a user without the create-Department ability', async () => {
    const user = userEvent.setup();
    renderSchedule({ ability: NO_CREATE_DEPT, tooltip: false });
    const trigger = await getDeptTrigger();
    await user.click(trigger);
    await screen.findByRole('option', { name: 'HVAC' });
    expect(screen.queryByRole('option', { name: '+ Add department' })).toBeNull();
  });

  it('selecting the sentinel opens the dialog WITHOUT changing the active filter', async () => {
    const user = userEvent.setup();
    renderSchedule({ ability: ADMIN, tooltip: false });
    const trigger = await getDeptTrigger();
    await user.click(trigger);
    await screen.findByRole('option', { name: 'HVAC' });
    await user.click(screen.getByRole('option', { name: '+ Add department' }));

    await screen.findByText('Create a new department');
    expect(trigger).toHaveTextContent('All departments'); // sentinel never becomes the filter
    // No department was created just by opening the modal.
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('creating a department POSTs, closes the dialog, and selects the new department', async () => {
    const user = userEvent.setup();
    renderSchedule({ ability: ADMIN, tooltip: false });
    const trigger = await getDeptTrigger();
    await user.click(trigger);
    await screen.findByRole('option', { name: 'HVAC' });
    await user.click(screen.getByRole('option', { name: '+ Add department' }));
    await screen.findByText('Create a new department');

    const createBtn = screen.getByRole('button', { name: 'Create' });
    expect(createBtn).toBeDisabled(); // empty name → disabled

    fireEvent.change(screen.getByPlaceholderText('Department name'), {
      target: { value: '  Night Crew  ' },
    });
    expect(createBtn).toBeEnabled();
    fireEvent.click(createBtn);

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith('/api/departments', { name: 'Night Crew' })
    );
    // Dialog closes and the new department becomes the active filter (invalidation
    // refetch landing is reflected once the SelectField's options include it).
    await waitFor(() => expect(screen.queryByText('Create a new department')).toBeNull());
    await waitFor(() => expect(trigger).toHaveTextContent('Night Crew'));
  });

  it('selecting an existing department still just filters (no dialog)', async () => {
    const user = userEvent.setup();
    renderSchedule({ ability: ADMIN, tooltip: false });
    const trigger = await getDeptTrigger();
    await user.click(trigger);
    await screen.findByRole('option', { name: 'HVAC' });

    await user.click(screen.getByRole('option', { name: 'HVAC' }));
    expect(trigger).toHaveTextContent('HVAC');
    expect(screen.queryByText('Create a new department')).toBeNull();
  });
});
