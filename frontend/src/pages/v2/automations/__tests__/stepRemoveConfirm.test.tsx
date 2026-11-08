/// <reference types="@testing-library/jest-dom/vitest" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import api from '@/lib/axios';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';

import AutomationBuilderPage from '../AutomationBuilderPage';

/**
 * SRVW-218 - the drawer's "Remove step" and the spine node's kebab "Delete
 * step" used to be two different two-click, self-relabelling confirms
 * ("Really remove?" / "Really delete?") for the identical action. Both now
 * route through the app's own `useConfirm()`/`ConfirmDialog`, naming the step
 * type and stating the consequence, same as every other destructive action.
 */

const mockApi = vi.mocked(api);

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

function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/automations/:id" element={<AutomationBuilderPage />} />
    </Routes>,
    { initialEntries: [path] },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/workflows/catalog') return { data: CATALOG };
    if (url === `/api/workflows/${WORKFLOW.id}`) return { data: WORKFLOW };
    return { data: {} };
  });
});

describe('removing a step from the spine node kebab', () => {
  it('confirms once, naming the step type, before removing it', async () => {
    const user = userEvent.setup();
    renderAt(`/automations/${WORKFLOW.id}`);

    await user.click(await screen.findByRole('button', { name: 'Step 1 actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /delete step/i }));

    expect(await screen.findByRole('heading', { name: /remove this wait step\?/i })).toBeInTheDocument();

    // Cancelling leaves the step in place.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Step 1 actions' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Step 1 actions' }));
    await user.click(await screen.findByRole('menuitem', { name: /delete step/i }));
    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Step 1 actions' })).not.toBeInTheDocument(),
    );
  });
});

describe('removing a step from the config drawer', () => {
  it('confirms once through the same dialog, then removes the step and closes the drawer', async () => {
    const user = userEvent.setup();
    renderAt(`/automations/${WORKFLOW.id}`);

    await user.click(await screen.findByText(/set up this step/i));
    const removeButton = await screen.findByRole('button', { name: 'Remove step' });
    await user.click(removeButton);

    expect(await screen.findByRole('heading', { name: /remove this wait step\?/i })).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove step' })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Step 1 actions' })).not.toBeInTheDocument();
  });
});
