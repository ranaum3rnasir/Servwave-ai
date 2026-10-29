/// <reference types="@testing-library/jest-dom/vitest" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';

import api from '@/lib/axios';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';

import AutomationBuilderPage from '../AutomationBuilderPage';

/**
 * The builder's way back to the list.
 *
 * This page is the one v2 detail/form surface that cannot take the kit
 * `PageHeader` - its title is a live, editable `Input`, not an `<h1>` - so it
 * did not inherit `PageHeader`'s `back` slot the way the lead, job and customer
 * form pages and the two reports shells did, and both of its routes shipped
 * with no way back at all.
 *
 * The layout's crumb trail does not cover it: that trail is a record of VISITS,
 * so it renders nothing when this page is the first of a session - which a
 * bookmark, a deep link and a hard reload all are.
 *
 * Both assertions ask for an ANCHOR with an href, not just an accessible name,
 * and that is the point rather than pedantry: the create route rewrites its own
 * URL to `/automations/:id` on first autosave, so a `navigate(-1)` here pops to
 * a `/new` entry that no longer holds the draft. The destination has to be
 * named.
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

/**
 * Empty but well-formed. The catalog is a static vocabulary the back control
 * never reads; it is stubbed only because a `useQuery` may not resolve to
 * `undefined`, and every consumer here already takes an empty one.
 */
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

/** Both routes mount the SAME component, so the tree carries both patterns. */
function renderAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/automations/new" element={<AutomationBuilderPage />} />
      <Route path="/automations/:id" element={<AutomationBuilderPage />} />
    </Routes>,
    { initialEntries: [path] },
  );
}

const backLink = () => screen.getByRole('link', { name: /back to automations/i });

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/workflows/catalog') return { data: CATALOG };
    if (url === `/api/workflows/${WORKFLOW.id}`) return { data: WORKFLOW };
    return { data: {} };
  });
});

describe('the automation builder back control', () => {
  it('sends /automations/new to the list', async () => {
    renderAt('/automations/new');

    await waitFor(() => expect(screen.getByLabelText('Automation name')).toBeInTheDocument());

    expect(backLink()).toHaveAttribute('href', '/automations');
  });

  it('sends a deep-linked /automations/:id to the list, before and after it loads', async () => {
    renderAt(`/automations/${WORKFLOW.id}`);

    // While the workflow is still in flight. A deep link can be the first
    // render of a session, so the skeleton state needs the real control and not
    // a placeholder for one.
    expect(backLink()).toHaveAttribute('href', '/automations');

    await waitFor(() =>
      expect(screen.getByLabelText('Automation name')).toHaveValue(WORKFLOW.name),
    );

    expect(backLink()).toHaveAttribute('href', '/automations');
  });
});
