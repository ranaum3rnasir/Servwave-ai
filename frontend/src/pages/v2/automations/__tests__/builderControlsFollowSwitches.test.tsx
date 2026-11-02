/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.21 - the automation builder's controls follow the module's switches.
   Renders the ROUTED page (pages/v2/automations/AutomationBuilderPage) at /automations/:id and /automations/new.

   An open automation is edited on Edit automations (name, steps, Publish, the on/off switch, Test); a new one is
   built on Create automations; Delete follows Delete automations. Activity is a read and stays with View automations.
   A person who cannot change what is open sees it read only: the canvas is there to read, with nothing to add,
   reorder, open for editing or save. The signed-in user's role NAME is the opposite of what an old role-name check
   wanted, so a page that still read the name would answer wrongly in both directions.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';
import { impossibleOnPurpose } from '@/__tests__/support/backendSwitchCatalog';
import { useAuthStore } from '@/stores/auth.store';

import AutomationBuilderPage from '../AutomationBuilderPage';

const mockApi = vi.mocked(api);

const VIEW: AbilityRule = { action: 'read', subject: 'Automation' };
const CREATE: AbilityRule = { action: 'create', subject: 'Automation' };
const EDIT: AbilityRule = { action: 'update', subject: 'Automation' };
const DELETE: AbilityRule = { action: 'delete', subject: 'Automation' };
// The catalog no longer lets Create automations be on without Edit automations; the cases below that hold Create
// and not Edit are about exactly that person.
const CREATE_WITHOUT_EDIT =
  'PENDING RAN: this case is about a person with Create automations and without Edit automations, which the catalog no longer allows.';
const abilityOf = (rules: AbilityRule[], impossibleReason?: string) =>
  impossibleReason ? impossibleOnPurpose(buildAbility(rules), impossibleReason) : buildAbility(rules);

const WORKFLOW = {
  id: 'a0000000-0000-0000-0000-000000000001',
  name: 'Post-job thank you',
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
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-01-15T00:00:00.000Z',
  steps: [{ id: 'step-1', position: 0, step_type: 'WAIT', config: {} }],
  issues: [],
  has_unpublished_changes: false,
  published_version: null,
};

const LIVE_WORKFLOW = { ...WORKFLOW, status: 'PUBLISHED', is_enabled: true, published_version: 1 };
type Served = { id: string; name: string } & Record<string, unknown>;

const CATALOG = {
  triggers: {},
  actions: {},
  audiences: {},
  anchors: { job: [], estimate: [], invoice: [], lead: [] },
  merge_field_labels: {},
  sample_context: {},
  templates: [],
  stop_if: { conditions: {}, labels: {} },
  capabilities: { sms_available: true },
} as unknown as WorkflowCatalog;

/** The signed-in user's role NAME. No built-in role name may decide anything on this page. */
function signedInWithRoleName(role: string) {
  vi.mocked(useAuthStore).mockImplementation(((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      user: { id: '00000000-0000-0000-0000-000000000020', email: 'custom@test.com', first_name: 'Cu', last_name: 'Stom', role },
      isAuthenticated: true,
      isLoading: false,
      error: null,
    })
  ) as typeof useAuthStore);
}

async function open(rules: AbilityRule[], role: string, workflow: Served = WORKFLOW, impossibleReason?: string) {
  signedInWithRoleName(role);
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/workflows/catalog') return { data: CATALOG };
    if (url === `/api/workflows/${workflow.id}`) return { data: workflow };
    return { data: {} };
  });
  const user = userEvent.setup();
  renderWithProviders(
    <Routes>
      <Route path="/automations/new" element={<AutomationBuilderPage />} />
      <Route path="/automations/:id" element={<AutomationBuilderPage />} />
    </Routes>,
    { initialEntries: [`/automations/${workflow.id}`], ability: abilityOf(rules, impossibleReason) },
  );
  await waitFor(() => expect(screen.getByLabelText('Automation name')).toHaveValue(workflow.name));
  return user;
}

const button = (name: string | RegExp) => screen.queryByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('an open automation, with Edit automations', () => {
  it.each(['TECHNICIAN', 'ADMIN'])('lets a %s change it: name, steps, Publish and Test', async (role) => {
    await open([VIEW, EDIT], role);

    expect(screen.getByLabelText('Automation name')).not.toHaveAttribute('readonly');
    expect(button('Publish')).toBeInTheDocument();
    expect(button('Test')).toBeInTheDocument();
    expect(button('Reorder step 1: Wait')).toBeInTheDocument();
    expect(button('Step 1 actions')).toBeInTheDocument();
    expect(button('Add a step')).toBeInTheDocument();
  });

  it('offers the on/off switch on a live one', async () => {
    await open([VIEW, EDIT], 'SALES', LIVE_WORKFLOW);
    expect(screen.getByRole('switch', { name: 'Pause this automation' })).toBeInTheDocument();
  });

  it('offers no Delete without Delete automations', async () => {
    await open([VIEW, EDIT], 'ADMIN');
    expect(button('Delete')).toBeNull();
  });

  it('opens a step for editing', async () => {
    const user = await open([VIEW, EDIT], 'DISPATCHER');
    await user.click(await screen.findByText(/set up this step/i));
    expect(await screen.findByRole('button', { name: 'Remove step' })).toBeInTheDocument();
  });
});

describe('an open automation, without Edit automations', () => {
  it.each(['ADMIN', 'DISPATCHER'])('shows a %s who holds Create and Delete the automation to read, with nothing to change', async (role) => {
    await open([VIEW, CREATE, DELETE], role, WORKFLOW, CREATE_WITHOUT_EDIT);

    expect(screen.getByLabelText('Automation name')).toHaveAttribute('readonly');
    for (const name of ['Publish', 'Test', 'Reorder step 1: Wait', 'Step 1 actions', 'Add a step']) {
      expect(button(name), name).toBeNull();
    }
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(button('Activity')).toBeInTheDocument();
  });

  it('shows a live one without its on/off switch', async () => {
    await open([VIEW], 'ADMIN', LIVE_WORKFLOW);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Live')).toBeInTheDocument();
  });

  it('does not open a step for editing', async () => {
    const user = await open([VIEW], 'ADMIN');
    await user.click(screen.getByText(/wait/i, { selector: 'span' }));
    expect(screen.queryByRole('button', { name: 'Remove step' })).toBeNull();
  });

  it('never saves, whatever happens to the page', async () => {
    await open([VIEW], 'ADMIN');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockApi.patch).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});

describe('Delete automations', () => {
  it('offers Delete with it, enabled for a saved automation', async () => {
    await open([VIEW, DELETE], 'TECHNICIAN');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it('offers no Delete to a person who can edit and create but not delete', async () => {
    await open([VIEW, CREATE, EDIT], 'ADMIN');
    expect(button('Delete')).toBeNull();
  });
});

describe('a new automation', () => {
  async function openNew(rules: AbilityRule[], role: string, impossibleReason?: string) {
    signedInWithRoleName(role);
    mockApi.get.mockImplementation(async (url: string) => (url === '/api/workflows/catalog' ? { data: CATALOG } : { data: {} }));
    renderWithProviders(
      <Routes>
        <Route path="/automations/new" element={<AutomationBuilderPage />} />
      </Routes>,
      { initialEntries: ['/automations/new'], ability: abilityOf(rules, impossibleReason) },
    );
    await screen.findByLabelText('Automation name');
  }

  it('is built on Create automations: the name takes text and the first step can be added', async () => {
    await openNew([VIEW, CREATE], 'TECHNICIAN', CREATE_WITHOUT_EDIT);
    expect(screen.getByLabelText('Automation name')).not.toHaveAttribute('readonly');
    expect(await screen.findByRole('button', { name: /add your first step|add a step/i })).toBeInTheDocument();
    // Publishing is a change to an existing automation: it needs Edit automations.
    expect(button('Publish')).toBeNull();
  });

  it('offers Publish when the person can also edit', async () => {
    await openNew([VIEW, CREATE, EDIT], 'SALES');
    expect(button('Publish')).toBeInTheDocument();
  });

  it('is read only without Create automations', async () => {
    await openNew([VIEW, EDIT], 'ADMIN');
    expect(screen.getByLabelText('Automation name')).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: /add your first step|add a step/i })).toBeNull();
  });
});
