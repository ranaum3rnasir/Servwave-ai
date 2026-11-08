/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';

import api from '@/lib/axios';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';

import AutomationBuilderPage from '../AutomationBuilderPage';

/**
 * The builder had an empty document-outline heading and never touched
 * document.title. This covers the real heading beside the name Input, the
 * document title it now sets, and the "Untitled automation" fallback for a
 * cleared name. The Settings tab (and its "Danger zone" heading) was removed
 * in SRVW-216 - Delete now lives beside Publish in the header and confirms
 * through the shared ConfirmDialog, covered in builderHeaderDelete.test.tsx.
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
      <Route path="/automations/new" element={<AutomationBuilderPage />} />
      <Route path="/automations/:id" element={<AutomationBuilderPage />} />
    </Routes>,
    { initialEntries: [path] },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  document.title = 'ServWave';
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/workflows/catalog') return { data: CATALOG };
    if (url === `/api/workflows/${WORKFLOW.id}`) return { data: WORKFLOW };
    return { data: {} };
  });
});

afterEach(() => {
  document.title = 'ServWave';
});

describe('the automation builder title and headings', () => {
  it('exposes the workflow name as the level 1 heading once it loads', async () => {
    renderAt(`/automations/${WORKFLOW.id}`);

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: WORKFLOW.name })).toBeInTheDocument(),
    );
  });

  it('sets the document title from the workflow name', async () => {
    renderAt(`/automations/${WORKFLOW.id}`);

    await waitFor(() =>
      expect(document.title).toBe(`${WORKFLOW.name} - Automations - ServWave`),
    );
  });

  it('falls back to Untitled automation for an empty name', async () => {
    renderAt('/automations/new');

    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Untitled automation' })).toBeInTheDocument(),
    );
    expect(document.title).toBe('Untitled automation - Automations - ServWave');
  });

});
