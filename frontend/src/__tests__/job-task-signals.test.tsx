/**
 * P3-2: Job command-center task signals
 * - Stat chips (open / overdue / next-due)
 * - At-risk amber strip
 * - Tasks tab count badge
 * - "New Task" quick-action opens CreateTaskModal
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import * as jobsApi from '@/lib/api/jobs';
import { renderWithProviders } from './helpers';
import JobDetailPage from '@/pages/v2/jobs/JobDetailPage';
import { useTasksStore } from '@/stores/tasksStore';

// ── Stubs ────────────────────────────────────────────────────────────────────

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ id: 'j0000000-0000-0000-0000-000000000001' }),
  };
});

// Stub CreateTaskModal so we can assert it renders without real internals
let createTaskModalOpen = false;
let capturedPreset: { type: string; id: string; label?: string } | undefined;
/** The onOpenChange of whichever modal instance is currently open. */
let openModalOnOpenChange: ((v: boolean) => void) | undefined;
vi.mock('@/components/tasks/CreateTaskModal', () => ({
  CreateTaskModal: (props: { open: boolean; onOpenChange: (v: boolean) => void; presetEntity?: { type: string; id: string; label?: string } }) => {
    createTaskModalOpen = props.open;
    capturedPreset = props.presetEntity;
    if (props.open) openModalOnOpenChange = props.onOpenChange;
    return props.open ? <div data-testid="create-task-modal">CreateTaskModal</div> : null;
  },
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const mockApi = vi.mocked(api);

const BASE_JOB = {
  id: 'j0000000-0000-0000-0000-000000000001',
  job_number: 'J00001',
  status: 'IN_PROGRESS',
  job_type: 'HVAC Installation',
  scope_notes: null,
  estimated_duration: null,
  completion_notes: null,
  scheduled_start: null as string | null,
  scheduled_end: null,
  started_at: null,
  completed_at: null,
  cancelled_at: null,
  cancelled_reason: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
  dispatcher: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Johnson',
    company_name: null,
    email: 'sarah@example.com',
    phone: '5125550198',
  },
  assignees: [] as { user: { id: string; first_name: string; last_name: string } }[],
  service_location: null,
  estimate: null,
  invoices: [] as Array<{
    id: string;
    invoice_number: string;
    status: string;
    total_amount: number | string;
    amount_due: number | string;
    created_at: string;
  }>,
  tags: [] as Array<{ id: string; name: string; color: string }>,
  source_plan_id: null,
  source_plan: null,
};

const FINANCIALS = { final_invoice: null, invoices: [], payments: [] };

const TASK_SUMMARY = {
  open: 3,
  overdue: 1,
  at_risk: 2,
  next_due_at: '2026-06-20T17:00:00Z',
};

function mockAll() {
  // Mock the axios api instance for job + financials
  mockApi.get.mockImplementation(async (url: string) => {
    if (url.includes('/financials')) return { data: FINANCIALS };
    if (url.includes('/api/jobs/')) return { data: { job: BASE_JOB } };
    return { data: {} };
  });

  // Mock getJobTaskSummary at the module level
  vi.spyOn(jobsApi, 'getJobTaskSummary').mockResolvedValue(TASK_SUMMARY);
}

beforeEach(() => {
  vi.clearAllMocks();
  createTaskModalOpen = false;
  capturedPreset = undefined;
  openModalOnOpenChange = undefined;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

/*
 * The three header chips this file used to open with - Open, Overdue and Next
 * due, keyed on `task-chip-open` / `task-chip-overdue` / `task-chip-next-due` -
 * are gone, and their cases with them. Not an oversight: the live page
 * (`pages/v2/jobs/JobDetailPage.tsx`) records the removal and its reason at the
 * point where they used to render, namely that all three were on screen at all
 * times including the overwhelmingly common "0 Open, 0 Overdue, Next due -",
 * spending a header row to report that there was nothing to report.
 *
 * Nothing they carried went unwatched. The open COUNT is asserted below on the
 * Tasks tab label, and the one state that has to interrupt - something overdue -
 * is asserted below on the at-risk strip. Both of those cases pass against the
 * live page unchanged, which is why the chips could go and this file still
 * covers P3-2.
 */
describe('JobDetailPage — task signals (P3-2)', () => {
  it('renders the at-risk amber strip when overdue > 0', async () => {
    mockAll();
    renderWithProviders(<JobDetailPage />);

    await waitFor(() => {
      expect(screen.getByTestId('task-at-risk-strip')).toBeInTheDocument();
    });
  });

  it('shows "(3)" count badge on the Tasks tab', async () => {
    mockAll();
    renderWithProviders(<JobDetailPage />);

    await waitFor(() => {
      // Tasks tab with the count
      const tasksTrigger = screen.getByRole('tab', { name: /Tasks/i });
      expect(tasksTrigger).toBeInTheDocument();
      expect(tasksTrigger.textContent).toContain('3');
    });
  });

  it('renders "New Task" button in the header action cluster', async () => {
    mockAll();
    renderWithProviders(<JobDetailPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New Task/i })).toBeInTheDocument();
    });
  });

  it('opens CreateTaskModal when "New Task" is clicked', async () => {
    mockAll();
    const user = userEvent.setup();
    renderWithProviders(<JobDetailPage />);

    const btn = await screen.findByRole('button', { name: /New Task/i });
    await user.click(btn);

    await waitFor(() => {
      expect(screen.getByTestId('create-task-modal')).toBeInTheDocument();
    });

    // presetEntity must carry the job UUID (not the human-readable number)
    expect(capturedPreset?.id).toBe('j0000000-0000-0000-0000-000000000001');
    expect(capturedPreset?.id).not.toBe('J00001');
    expect(capturedPreset?.type).toBe('JOB');
  });
});

// ── Bug fix: job-task-summary invalidated after store task mutations ──────────

const JOB_ID = 'j0000000-0000-0000-0000-000000000001';

// A minimal task object linked to the job under test
const LINKED_TASK = {
  id: 't0000000-0000-0000-0000-000000000001',
  task_number: 'T00001',
  title: 'Fit sensor',
  description: '',
  status: 'TODO' as const,
  priority: 'MEDIUM' as const,
  assignee_ids: ['admin'],
  assignees: [{ id: 'admin', name: 'Admin User' }],
  watcher_ids: [],
  due_at: null,
  linked_entity: { type: 'JOB' as const, id: JOB_ID, label: 'J00001' },
  tags: [],
  subtasks: [],
  created_by: 'admin',
  created_at: '2026-06-17T00:00:00.000Z',
  updated_at: '2026-06-17T00:00:00.000Z',
  completed_at: null,
  activity: [],
  comments: [],
  ai: { risk_score: 0, risk_reason: null, suggested_by: null, source: 'manual' as const },
};

describe('JobDetailPage — job-task-summary invalidated after task store mutations (bug fix)', () => {
  beforeEach(() => {
    // Reset the Zustand store to a clean slate before each test
    useTasksStore.setState({ tasks: [], loaded: false, loading: false });
    vi.clearAllMocks();
    createTaskModalOpen = false;
    capturedPreset = undefined;
  });

  it('invalidates ["job-task-summary", id] when a job-linked task is added to the store', async () => {
    // Set up API mocks
    vi.mocked(api).get.mockImplementation(async (url: string) => {
      if (url.includes('/financials')) return { data: FINANCIALS };
      if (url.includes('/api/jobs/')) return { data: { job: BASE_JOB } };
      return { data: {} };
    });
    vi.spyOn(jobsApi, 'getJobTaskSummary').mockResolvedValue(TASK_SUMMARY);

    const { queryClient } = renderWithProviders(<JobDetailPage />);

    // Wait for the page to hydrate (J00001 appears in heading + breadcrumb)
    await waitFor(() => {
      expect(screen.getAllByText(/J00001/).length).toBeGreaterThan(0);
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    // Simulate addTask: push a linked task into the store (same as tasksStore.addTask does)
    await act(async () => {
      useTasksStore.setState((s) => ({ tasks: [LINKED_TASK, ...s.tasks] }));
    });

    await waitFor(() => {
      const calls = invalidateSpy.mock.calls.map((c) => c[0]);
      expect(
        calls.some(
          (arg) =>
            arg &&
            typeof arg === 'object' &&
            'queryKey' in arg &&
            Array.isArray(arg.queryKey) &&
            arg.queryKey[0] === 'job-task-summary' &&
            arg.queryKey[1] === JOB_ID,
        ),
      ).toBe(true);
    });
  });

  it('does NOT invalidate ["job-task-summary", id] on initial mount (no spurious refetch)', async () => {
    vi.mocked(api).get.mockImplementation(async (url: string) => {
      if (url.includes('/financials')) return { data: FINANCIALS };
      if (url.includes('/api/jobs/')) return { data: { job: BASE_JOB } };
      return { data: {} };
    });
    vi.spyOn(jobsApi, 'getJobTaskSummary').mockResolvedValue(TASK_SUMMARY);

    const { queryClient } = renderWithProviders(<JobDetailPage />);

    // Wait for page to settle (J00001 appears in heading + breadcrumb)
    await waitFor(() => {
      expect(screen.getAllByText(/J00001/).length).toBeGreaterThan(0);
    });

    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    // No store mutation — spy should NOT have been called for job-task-summary
    await new Promise((r) => setTimeout(r, 50));

    const taskSummaryInvalidations = invalidateSpy.mock.calls.filter((c) => {
      const arg = c[0];
      return (
        arg &&
        typeof arg === 'object' &&
        'queryKey' in arg &&
        Array.isArray(arg.queryKey) &&
        arg.queryKey[0] === 'job-task-summary'
      );
    });
    expect(taskSummaryInvalidations).toHaveLength(0);
  });
});

// ── Slice 13: the header's New Task refreshes the Tasks tab list ──────────────

describe('JobDetailPage — header New Task refreshes the open Tasks tab', () => {
  it('re-reads the job\'s task list when the header create dialog closes', async () => {
    mockAll();
    const base = mockApi.get.getMockImplementation()!;
    mockApi.get.mockImplementation(async (url: string, config?: unknown) =>
      url === '/api/tasks' ? { data: { tasks: [] } } : base(url, config));
    const user = userEvent.setup();
    renderWithProviders(<JobDetailPage />);

    await user.click(await screen.findByRole('tab', { name: /Tasks/i }));
    const listReads = () => mockApi.get.mock.calls.filter(([url]) => url === '/api/tasks').length;
    await waitFor(() => expect(listReads()).toBe(1));

    // The header's button, not the tab's own (which already refreshes on close): first in order.
    await user.click(screen.getAllByRole('button', { name: /New Task/i })[0]);
    await waitFor(() => expect(openModalOnOpenChange).toBeDefined());
    act(() => openModalOnOpenChange!(false));

    await waitFor(() => expect(listReads()).toBe(2));
    expect(mockApi.get).toHaveBeenLastCalledWith('/api/tasks', {
      params: { linked_entity_type: 'JOB', linked_entity_id: JOB_ID },
    });
  });
});
