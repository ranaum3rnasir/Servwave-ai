/// <reference types="@testing-library/jest-dom/vitest" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import api from '@/lib/axios';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';

import AutomationBuilderPage from '../AutomationBuilderPage';

/**
 * SRVW-216 - the Settings tab held only a redundant second name field and the
 * danger-zone Delete. The tab is gone; Delete now sits beside Publish in the
 * header and still confirms through the same dialog before it fires.
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
  steps: [],
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
      <Route path="/automations" element={<div>Automations list</div>} />
      <Route path="/automations/new" element={<AutomationBuilderPage />} />
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
  mockApi.delete.mockResolvedValue({ data: undefined });
});

describe('the builder header Delete control', () => {
  it('has no Settings tab', async () => {
    renderAt(`/automations/${WORKFLOW.id}`);
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toHaveValue(WORKFLOW.name));

    expect(screen.queryByRole('tab', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('sits beside Publish and stays disabled on an unsaved draft', async () => {
    renderAt('/automations/new');
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('confirms once through the shared dialog before deleting, naming the automation', async () => {
    const user = userEvent.setup();
    renderAt(`/automations/${WORKFLOW.id}`);
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toHaveValue(WORKFLOW.name));

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(await screen.findByRole('heading', { name: `Delete "${WORKFLOW.name}"?` })).toBeInTheDocument();
    expect(mockApi.delete).not.toHaveBeenCalled();

    // Cancelling leaves it untouched.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockApi.delete).not.toHaveBeenCalled();
  });

  it('deleting navigates back to the automations list', async () => {
    const user = userEvent.setup();
    renderAt(`/automations/${WORKFLOW.id}`);
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toHaveValue(WORKFLOW.name));

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/workflows/${WORKFLOW.id}`));
    expect(await screen.findByText('Automations list')).toBeInTheDocument();
  });
});
