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
 * SRVW-217 - Activity used to be the builder's second tab, so switching to it
 * replaced the whole canvas. It is now a drawer opened by a button beside
 * Publish, so the canvas stays mounted underneath and closing the drawer
 * leaves it exactly as it was. The tab's lazy mount - the activity query never
 * firing on page load - carries over via the Sheet's own conditional mount.
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
    if (url === `/api/workflows/${WORKFLOW.id}/activity`) return { data: { rows: [] } };
    return { data: {} };
  });
});

describe('the Activity drawer', () => {
  it('has no Activity tab and does not fetch activity on page load', async () => {
    renderAt(`/automations/${WORKFLOW.id}`);
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toHaveValue(WORKFLOW.name));

    expect(screen.queryByRole('tab', { name: 'Activity' })).not.toBeInTheDocument();
    expect(mockApi.get).not.toHaveBeenCalledWith(
      `/api/workflows/${WORKFLOW.id}/activity`,
      expect.anything(),
    );
  });

  it('opens beside Publish and fetches activity only once opened', async () => {
    const user = userEvent.setup();
    renderAt(`/automations/${WORKFLOW.id}`);
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toHaveValue(WORKFLOW.name));

    await user.click(screen.getByRole('button', { name: /activity/i }));

    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeInTheDocument();
    await waitFor(() =>
      expect(mockApi.get).toHaveBeenCalledWith(
        `/api/workflows/${WORKFLOW.id}/activity`,
        expect.anything(),
      ),
    );
  });

  it('closing the drawer leaves the builder canvas exactly as it was', async () => {
    const user = userEvent.setup();
    renderAt(`/automations/${WORKFLOW.id}`);
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toHaveValue(WORKFLOW.name));

    expect(screen.getByText(/guided flow/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /activity/i }));
    expect(await screen.findByRole('heading', { name: 'Activity' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Activity' })).not.toBeInTheDocument());
    expect(screen.getByText(/guided flow/i)).toBeInTheDocument();
  });
});
