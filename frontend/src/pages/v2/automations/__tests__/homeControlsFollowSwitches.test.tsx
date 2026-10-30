/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.21 - the Automations landing page's controls follow the module's switches.
   Renders the ROUTED page (pages/v2/automations/AutomationsHomePage).

   New automation, Start from scratch, a recipe's Use this and Duplicate follow Create automations; the on/off switch
   follows Edit automations; Delete follows Delete automations. Each person below is described by the rules those
   switches compile into (create, update, delete on Automation - the pairs the backend catalog emits and the workflow
   routes check). The signed-in user's role NAME is the opposite of what an old role-name check wanted.
   ========================================================================== */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import { buildAbility, type AbilityRule } from '@/lib/ability';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';
import { useAuthStore } from '@/stores/auth.store';

import AutomationsHomePage from '../AutomationsHomePage';

const mockApi = vi.mocked(api);

const VIEW: AbilityRule = { action: 'read', subject: 'Automation' };
const CREATE: AbilityRule = { action: 'create', subject: 'Automation' };
const EDIT: AbilityRule = { action: 'update', subject: 'Automation' };
const DELETE: AbilityRule = { action: 'delete', subject: 'Automation' };

const WORKFLOW = {
  id: 'a0000000-0000-0000-0000-000000000001',
  name: 'Post-job review request',
  status: 'PUBLISHED',
  is_enabled: true,
  trigger_type: 'JOB_COMPLETED',
  trigger_config: null,
  send_window: 'ANYTIME',
  template_key: null,
  legacy_rule_id: null,
  published_at: '2026-01-10T00:00:00.000Z',
  last_triggered_at: null,
  trigger_count: 3,
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-01-15T00:00:00.000Z',
  steps: [],
  issues: [],
  has_unpublished_changes: false,
  published_version: 1,
};

const CATALOG = {
  triggers: {},
  actions: {},
  audiences: {},
  anchors: { job: [], estimate: [], invoice: [], lead: [] },
  merge_field_labels: {},
  sample_context: {},
  templates: [
    {
      key: 'review-request',
      name: 'Ask for a review',
      description: 'Text the customer a review link after the job.',
      category: 'customer',
      trigger_type: 'JOB_COMPLETED',
      action_type: 'SEND_EMAIL',
      action_config: {},
    },
  ],
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

async function openPage(rules: AbilityRule[], role: string, workflows: unknown[] = [WORKFLOW]) {
  signedInWithRoleName(role);
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/workflows') return { data: workflows };
    if (url === '/api/workflows/catalog') return { data: CATALOG };
    return { data: {} };
  });
  renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'], ability: buildAbility(rules) });
  await screen.findByRole('heading', { name: 'Automations' });
  if (workflows.length > 0) await screen.findByText('Post-job review request');
  else await screen.findByText(/no automations yet|start from a recipe/i);
}

const NAME = 'Post-job review request';
const button = (name: string | RegExp) => screen.queryByRole('button', { name });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Create automations', () => {
  it.each(['TECHNICIAN', 'ADMIN'])('offers New automation, Duplicate and the recipes to a %s who holds it', async (role) => {
    await openPage([VIEW, CREATE], role);

    expect(button('New automation')).toBeInTheDocument();
    expect(button(`Duplicate ${NAME}`)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Use this' })).toBeInTheDocument();
  });

  it('offers Start from scratch when there are no automations yet', async () => {
    await openPage([VIEW, CREATE], 'SALES', []);
    expect(button('Start from scratch')).toBeInTheDocument();
  });

  it.each(['ADMIN', 'DISPATCHER'])('offers none of them to a %s who holds every switch except it', async (role) => {
    await openPage([VIEW, EDIT, DELETE], role);

    expect(button('New automation')).toBeNull();
    expect(button(`Duplicate ${NAME}`)).toBeNull();
    expect(button('Use this')).toBeNull();
    expect(screen.queryByText('Ask for a review')).toBeNull();
  });
});

describe('Edit automations', () => {
  it('offers the on/off switch with it', async () => {
    await openPage([VIEW, EDIT], 'TECHNICIAN');
    expect(screen.getByRole('switch', { name: `Pause ${NAME}` })).toBeInTheDocument();
  });

  it('offers no switch without it, and the status chip still says whether the automation is on', async () => {
    await openPage([VIEW, CREATE, DELETE], 'ADMIN');
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getAllByText('Live').length).toBeGreaterThan(0);
  });
});

describe('Delete automations', () => {
  it('offers Delete with it, and only Delete', async () => {
    await openPage([VIEW, DELETE], 'SALES');
    expect(button(`Delete ${NAME}`)).toBeInTheDocument();
    expect(button('New automation')).toBeNull();
    expect(button(`Duplicate ${NAME}`)).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('hides Delete without it', async () => {
    await openPage([VIEW, CREATE, EDIT], 'ADMIN');
    expect(button(`Delete ${NAME}`)).toBeNull();
  });
});

describe('View automations alone', () => {
  it('shows the list and no control at all', async () => {
    await openPage([VIEW], 'ADMIN');
    expect(screen.getByText(NAME)).toBeInTheDocument();
    expect(button('New automation')).toBeNull();
    expect(button(`Duplicate ${NAME}`)).toBeNull();
    expect(button(`Delete ${NAME}`)).toBeNull();
    expect(button('Use this')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('says there is nothing yet, with no way to start one, when the company has none', async () => {
    await openPage([VIEW], 'ADMIN', []);
    expect(screen.getByText('No automations yet.')).toBeInTheDocument();
    expect(button('New automation')).toBeNull();
    expect(button('Start from scratch')).toBeNull();
  });
});
