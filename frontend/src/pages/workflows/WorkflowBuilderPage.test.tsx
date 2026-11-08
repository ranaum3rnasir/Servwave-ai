import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import WorkflowBuilderPage from './WorkflowBuilderPage';
import {
  useWorkflow,
  useWorkflowCatalog,
  useCreateWorkflow,
  usePatchWorkflow,
  usePublishWorkflow,
  useToggleWorkflow,
  useWorkflowActivity,
  useTestWorkflow,
  useDeleteWorkflow,
  type ApiWorkflow,
  type WorkflowCatalog,
} from '@/lib/api/workflows';

// ── router mock ──────────────────────────────────────────────────────────────
const mockNavigate = vi.fn();
const mockUseParams = vi.fn<() => { id?: string }>(() => ({ id: 'wf-1' }));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate, useParams: () => mockUseParams() };
});

// ── api mock ─────────────────────────────────────────────────────────────────
vi.mock('@/lib/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/workflows')>();
  return {
    ...actual,
    useWorkflow: vi.fn(),
    useWorkflowCatalog: vi.fn(),
    useCreateWorkflow: vi.fn(),
    usePatchWorkflow: vi.fn(),
    usePublishWorkflow: vi.fn(),
    useToggleWorkflow: vi.fn(),
    useWorkflowActivity: vi.fn(),
    useTestWorkflow: vi.fn(),
    useDeleteWorkflow: vi.fn(),
  };
});

const mockUseWorkflow = vi.mocked(useWorkflow);
const mockUseCatalog = vi.mocked(useWorkflowCatalog);
const mockUseCreate = vi.mocked(useCreateWorkflow);
const mockUsePatch = vi.mocked(usePatchWorkflow);
const mockUsePublish = vi.mocked(usePublishWorkflow);
const mockUseToggle = vi.mocked(useToggleWorkflow);
const mockUseActivity = vi.mocked(useWorkflowActivity);
const mockUseTest = vi.mocked(useTestWorkflow);
const mockUseDelete = vi.mocked(useDeleteWorkflow);

const CATALOG = {
  triggers: {
    JOB_COMPLETED: {
      label: 'Job completed',
      description: 'Runs when a job is marked complete.',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    // A second job event — lets the Task B7 trigger-drawer tests below pick
    // something new and observe the bubble/recipe subtitle change.
    JOB_SCHEDULED: {
      label: 'Job is scheduled',
      description: 'Runs when a job gets booked on the calendar.',
      category: 'events',
      entity: 'job',
      timeBased: false,
      mergeFields: [],
    },
    // A legacy timed trigger — for the "opening on an old trigger" test.
    BEFORE_JOB_START: {
      label: 'Before a job starts',
      description: 'A set time before the job’s scheduled start.',
      category: 'timed',
      entity: 'job',
      timeBased: true,
      defaultOffsetMinutes: 1440,
      mergeFields: [],
    },
  },
  actions: {},
  anchors: {
    job: [{ key: 'job.scheduled_start', label: 'the appointment' }],
  },
  merge_field_labels: {},
  sample_context: {},
  templates: [],
  stop_if: { conditions: {}, labels: { invoice_paid: 'the invoice is paid' } },
} as unknown as WorkflowCatalog;

function makeWorkflow(overrides: Partial<ApiWorkflow> = {}): ApiWorkflow {
  return {
    id: 'wf-1',
    name: 'Review request follow-up',
    status: 'DRAFT',
    is_enabled: false,
    trigger_type: 'JOB_COMPLETED',
    trigger_config: null,
    send_window: 'ANYTIME',
    template_key: null,
    legacy_rule_id: null,
    published_at: null,
    last_triggered_at: null,
    trigger_count: 0,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    steps: [
      { id: 's1', position: 0, step_type: 'WAIT', config: { duration_minutes: 1440 } },
      { id: 's2', position: 1, step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'hi' } },
    ],
    issues: [],
    has_unpublished_changes: false,
    published_version: null,
    ...overrides,
  };
}

function queryResult<T>(data: T | undefined, overrides: Record<string, unknown> = {}) {
  return { data, isLoading: false, isError: false, refetch: vi.fn(), ...overrides } as any;
}
function mutationResult(overrides: Record<string, unknown> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(makeWorkflow()),
    reset: vi.fn(),
    isPending: false,
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseParams.mockReturnValue({ id: 'wf-1' });
  mockUseWorkflow.mockReturnValue(queryResult(makeWorkflow()));
  mockUseCatalog.mockReturnValue(queryResult(CATALOG));
  mockUseCreate.mockReturnValue(mutationResult());
  mockUsePatch.mockReturnValue(mutationResult());
  mockUsePublish.mockReturnValue(mutationResult());
  mockUseToggle.mockReturnValue(mutationResult());
  mockUseActivity.mockReturnValue(queryResult({ rows: [] }));
  mockUseTest.mockReturnValue(mutationResult({ data: undefined }));
  mockUseDelete.mockReturnValue(mutationResult());
});

// ── 1. render trigger + steps ─────────────────────────────────────────────────
describe('WorkflowBuilderPage — renders a loaded workflow', () => {
  it('renders the trigger sentence and each step sentence with its config token', async () => {
    renderWithProviders(<WorkflowBuilderPage />);
    // trigger bubble
    expect(await screen.findByText('When a job is completed')).toBeInTheDocument();
    // step sentences (config tokens bolded within their own spans)
    expect(await screen.findByText('1 day')).toBeInTheDocument();
    expect(screen.getByText('the customer')).toBeInTheDocument();
    // recipe subtitle
    expect(
      screen.getByText('When a job is completed → wait 1 day → text the customer'),
    ).toBeInTheDocument();
  });
});

// ── 2. AddStepButton inserts at index + opens drawer ─────────────────────────
describe('WorkflowBuilderPage — inserting a step', () => {
  it('inserts at the chosen gap and opens the drawer on the new node', async () => {
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    // Insert AFTER step 1 (between WAIT and SEND_TEXT).
    await userEvent.click(screen.getByRole('button', { name: 'Insert a step after step 1' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Send email/i }));

    // New SEND_EMAIL lands at index 1 → recipe reflects the order. It reads "email the
    // recipient", not "email the customer": a new email step no longer seeds an audience, so
    // the recipe describes an unmade choice until the admin makes it. Same wording a new text
    // step has given since Spec C slice 8, and the reason a task-trigger email step can be
    // published at all.
    await waitFor(() =>
      expect(
        screen.getByText('When a job is completed → wait 1 day → email the recipient → text the customer'),
      ).toBeInTheDocument(),
    );
    // Drawer opened on the newly selected node — the email step form is live.
    expect(await screen.findByText('Set up this email step')).toBeInTheDocument();
  });
});

// ── 3. kebab reorder + delete-confirm ────────────────────────────────────────
describe('WorkflowBuilderPage — kebab reorder and delete', () => {
  it('"Move down" reorders the steps', async () => {
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('button', { name: 'Step 1 actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Move down/i }));

    await waitFor(() =>
      expect(screen.getByText('When a job is completed → text the customer → wait 1 day')).toBeInTheDocument(),
    );
  });

  it('"Delete step" requires the inline confirm before removing', async () => {
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('button', { name: 'Step 1 actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete step' }));

    // Still two steps — the first click only armed the confirm.
    expect(screen.getByText('When a job is completed → wait 1 day → text the customer')).toBeInTheDocument();
    const confirm = await screen.findByRole('menuitem', { name: 'Really delete?' });
    await userEvent.click(confirm);

    await waitFor(() =>
      expect(screen.getByText('When a job is completed → text the customer')).toBeInTheDocument(),
    );
  });
});

// ── 4. autosave PATCH + issue badges ─────────────────────────────────────────
describe('WorkflowBuilderPage — autosave', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces a PATCH with array-ordered steps and shows badges from the response', async () => {
    const saved = makeWorkflow({ issues: [{ step_index: 1, path: 'body', message: 'Add a message' }] });
    const patch = mutationResult({ mutateAsync: vi.fn().mockResolvedValue(saved) });
    mockUsePatch.mockReturnValue(patch);

    renderWithProviders(<WorkflowBuilderPage />);

    fireEvent.change(screen.getByLabelText('Automation name'), { target: { value: 'Renamed flow' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(patch.mutateAsync).toHaveBeenCalledTimes(1);
    const arg = patch.mutateAsync.mock.calls[0][0];
    expect(arg.id).toBe('wf-1');
    expect(arg.data.name).toBe('Renamed flow');
    expect(arg.data.trigger_type).toBe('JOB_COMPLETED'); // contract: always present
    expect(arg.data.steps.map((s: { step_type: string }) => s.step_type)).toEqual(['WAIT', 'SEND_TEXT']);

    // response issues populate the SEND_TEXT "needs setup" badge (2nd step, index 1)
    expect(screen.getByText('Needs setup')).toBeInTheDocument();
  });

  // A bare "Needs setup" is a dead end: the server already says exactly what is
  // wrong (e.g. an unrecognised merge token), so the step must show that text
  // rather than making the user guess which field it means. See #901.
  it('shows the server issue message on the step, not just the badge', async () => {
    const saved = makeWorkflow({
      issues: [
        { step_index: 1, path: 'config.body', message: "The field {{job.date}} isn't available for this trigger" },
      ],
    });
    mockUsePatch.mockReturnValue(mutationResult({ mutateAsync: vi.fn().mockResolvedValue(saved) }));

    renderWithProviders(<WorkflowBuilderPage />);
    fireEvent.change(screen.getByLabelText('Automation name'), { target: { value: 'Renamed flow' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByText("The field {{job.date}} isn't available for this trigger")).toBeInTheDocument();
  });

  it('lists every issue on a step when the server reports more than one', async () => {
    const saved = makeWorkflow({
      issues: [
        { step_index: 1, path: 'config.body', message: "The field {{job.date}} isn't available for this trigger" },
        { step_index: 1, path: 'config.subject', message: 'Add a subject' },
      ],
    });
    mockUsePatch.mockReturnValue(mutationResult({ mutateAsync: vi.fn().mockResolvedValue(saved) }));

    renderWithProviders(<WorkflowBuilderPage />);
    fireEvent.change(screen.getByLabelText('Automation name'), { target: { value: 'Renamed flow' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(screen.getByText("The field {{job.date}} isn't available for this trigger")).toBeInTheDocument();
    expect(screen.getByText('Add a subject')).toBeInTheDocument();
  });
});

// ── 6. create-on-first-save for /automations/new ─────────────────────────────
describe('WorkflowBuilderPage — /automations/new', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('first autosave POSTs createWorkflow then swaps the URL via navigate replace', async () => {
    mockUseParams.mockReturnValue({}); // /automations/new — no id
    mockUseWorkflow.mockReturnValue(queryResult(undefined)); // query disabled
    const created = makeWorkflow({ id: 'new-id', name: 'Untitled automation' });
    const create = mutationResult({ mutateAsync: vi.fn().mockResolvedValue(created) });
    mockUseCreate.mockReturnValue(create);

    renderWithProviders(<WorkflowBuilderPage />);

    // empty flow → the first-step bubble
    fireEvent.change(screen.getByLabelText('Automation name'), { target: { value: 'My new flow' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(create.mutateAsync).toHaveBeenCalledTimes(1);
    expect(create.mutateAsync.mock.calls[0][0].name).toBe('My new flow');
    expect(mockNavigate).toHaveBeenCalledWith('/automations/new-id', { replace: true });
  });

  // 2026-07-20 QA-pass regression: blankState()'s trigger_type ('JOB_COMPLETED')
  // is a required-but-unseen placeholder, not a real pick — a genuinely new
  // automation must never present it as one, on the bubble OR the header.
  it('a genuinely new automation shows a neutral "choose a trigger" prompt, never a description of the unseen placeholder trigger', async () => {
    mockUseParams.mockReturnValue({});
    mockUseWorkflow.mockReturnValue(queryResult(undefined));

    renderWithProviders(<WorkflowBuilderPage />);

    expect(screen.getByRole('button', { name: /Edit trigger: Choose what starts this automation/ })).toBeInTheDocument();
    expect(screen.getByText('Choose what starts this automation to get going.')).toBeInTheDocument();
    expect(screen.queryByText(/job is completed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/job completed/i)).not.toBeInTheDocument();
  });
});

// ── Publish/toggle fold the mutation response into the header (no-reload) ────
describe('WorkflowBuilderPage — publish + toggle ingest the server response', () => {
  it('publishing flips the header to "Live · up to date" without a reload', async () => {
    const published = makeWorkflow({ status: 'PUBLISHED', is_enabled: true, published_version: { version: 1, published_at: '2026-07-10T00:00:00.000Z' } });
    const publish = mutationResult({ mutateAsync: vi.fn().mockResolvedValue(published) });
    mockUsePublish.mockReturnValue(publish);
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }));

    expect(publish.mutateAsync).toHaveBeenCalledWith({ id: 'wf-1', enable: true });
    // The 4-state control derives from the ingested snapshot — no rehydrate/reload.
    expect(await screen.findByText('Live · up to date')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Pause this automation' })).toBeInTheDocument();
  });

  it('pausing via the switch ingests the toggle response into the control', async () => {
    mockUseWorkflow.mockReturnValue(
      queryResult(makeWorkflow({ status: 'PUBLISHED', is_enabled: true, published_version: { version: 1, published_at: '2026-07-10T00:00:00.000Z' } })),
    );
    const paused = makeWorkflow({ status: 'PUBLISHED', is_enabled: false, published_version: { version: 1, published_at: '2026-07-10T00:00:00.000Z' } });
    const toggle = mutationResult({ mutateAsync: vi.fn().mockResolvedValue(paused) });
    mockUseToggle.mockReturnValue(toggle);
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('switch', { name: 'Pause this automation' }));

    expect(toggle.mutateAsync).toHaveBeenCalledWith({ id: 'wf-1', is_enabled: false });
    expect(await screen.findByRole('switch', { name: 'Turn this automation on' })).toBeInTheDocument();
  });
});

// ── Test dialog wiring ────────────────────────────────────────────────────────
describe('WorkflowBuilderPage — Test dialog', () => {
  it('the Test button opens the dry-run dialog, which runs a dry-run for the loaded workflow', async () => {
    const test = mutationResult({ data: undefined });
    mockUseTest.mockReturnValue(test);
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('button', { name: /^test$/i }));

    expect(await screen.findByText('Test this automation')).toBeInTheDocument();
    expect(test.mutate).toHaveBeenCalledWith({ id: 'wf-1', send_to_me: false });
  });

  it('needs_setup "Fix it" closes the dialog and opens that step in the drawer', async () => {
    mockUseTest.mockReturnValue(
      mutationResult({
        data: {
          steps: [{ step_index: 1, step_type: 'SEND_TEXT', outcome: 'needs_setup', detail: 'Add a message' }],
          delivered: [],
        },
      }),
    );
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('button', { name: /^test$/i }));
    await userEvent.click(await screen.findByRole('button', { name: 'Fix it' }));

    // Dialog closed, and step index 1 (the SEND_TEXT step) is now selected in the drawer.
    await waitFor(() => expect(screen.queryByText('Test this automation')).not.toBeInTheDocument());
    expect(await screen.findByText('the customer')).toBeInTheDocument();
  });
});

// ── Activity + Settings tabs ─────────────────────────────────────────────────
describe('WorkflowBuilderPage — Activity + Settings tabs', () => {
  it('the Activity tab shows the empty state when there is no history yet', async () => {
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText(/Nothing has run yet/)).toBeInTheDocument();
  });

  it('the Settings tab pre-fills the name and deleting navigates to /automations', async () => {
    const remove = mutationResult({
      mutate: vi.fn((_id: string, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
    });
    mockUseDelete.mockReturnValue(remove);
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(await screen.findByLabelText('Automation name (Settings)')).toHaveValue('Review request follow-up');

    await userEvent.click(screen.getByRole('button', { name: /delete this automation/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    expect(remove.mutate).toHaveBeenCalledWith('wf-1', expect.objectContaining({ onSuccess: expect.any(Function) }));
    expect(mockNavigate).toHaveBeenCalledWith('/automations');
  });
});

// ── Trigger drawer: the composed two-mode builder (Task B7) ─────────────────
// Unlike the exhaustive unit coverage in TriggerForm.test.tsx (which mounts
// TriggerForm directly with controlled props), these exercise the REAL
// StepConfigDrawer -> TriggerForm prop-forwarding chain through the actual
// trigger bubble click, proving the wiring (not just the composed
// component's own internals) is correct end-to-end.
describe('WorkflowBuilderPage — trigger drawer (two-mode builder)', () => {
  it('opens on the current event trigger pre-populated (checked radio + readback), no legacy banner', async () => {
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('button', { name: /Edit trigger/ }));

    expect(await screen.findByRole('button', { name: /Jobs — change subject/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Job completed/ })).toHaveAttribute('aria-checked', 'true');
    // Two `role="status"` regions exist on the page (TriggerReadback's own +
    // the toast viewport) — match by full text instead of the bare role.
    // Fixture's catalog label is "Job completed" (no "is") — articleizeEventLabel
    // lowercases it verbatim, it doesn't insert a copula.
    expect(screen.getByText((_, node) => node?.textContent === 'The moment a job completed.')).toBeInTheDocument();
    expect(screen.queryByText(/older timing setup/)).not.toBeInTheDocument();
  });

  it('picking a new event trigger commits immediately (readback updates before Done), and the bubble + recipe subtitle reflect it after closing', async () => {
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('button', { name: /Edit trigger/ }));
    await userEvent.click(screen.getByText('Job is scheduled').closest('button')!);

    // Committed inside the drawer without needing "Done" — TriggerForm calls
    // onSetTrigger the moment the pick is complete.
    await waitFor(() =>
      expect(
        screen.getByText((_, node) => node?.textContent === 'The moment a job is scheduled.'),
      ).toBeInTheDocument(),
    );

    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    // Background trigger bubble + header recipe subtitle both reflect the new trigger, live.
    expect(screen.getByRole('button', { name: /Edit trigger: When a job is scheduled/ })).toBeInTheDocument();
    expect(screen.getByText('When a job is scheduled → wait 1 day → text the customer')).toBeInTheDocument();
  });

  it('opening the drawer on a saved legacy timed trigger (BEFORE_JOB_START) shows the honest fallback banner instead of crashing or silently blanking', async () => {
    mockUseWorkflow.mockReturnValue(
      queryResult(makeWorkflow({ trigger_type: 'BEFORE_JOB_START', trigger_config: { offset_minutes: 1440 } })),
    );
    renderWithProviders(<WorkflowBuilderPage />);
    await screen.findByText('1 day');

    await userEvent.click(screen.getByRole('button', { name: /Edit trigger/ }));

    expect(await screen.findByText(/This automation currently uses an older timing setup/)).toBeInTheDocument();
    expect(screen.getByText('Before a job starts')).toBeInTheDocument();
    expect(screen.getByText('What is this automation about?')).toBeInTheDocument();
  });
});
