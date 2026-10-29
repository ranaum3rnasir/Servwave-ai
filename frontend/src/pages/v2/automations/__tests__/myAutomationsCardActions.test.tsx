/// <reference types="@testing-library/jest-dom/vitest" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import api from '@/lib/axios';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';

import AutomationsHomePage from '../AutomationsHomePage';

/**
 * SRVW-214 - the 3-dot "Actions" menu held exactly three items (Open,
 * Duplicate, Delete). Open was redundant with the card's own click target,
 * so it cost two clicks to reach either real action. The menu is gone;
 * duplicate and delete now render as direct icon buttons on the card.
 */

const mockApi = vi.mocked(api);

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
  templates: [],
  stop_if: { conditions: {}, labels: {} },
  capabilities: { sms_available: true },
} as unknown as WorkflowCatalog;

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/workflows') return { data: [WORKFLOW] };
    if (url === '/api/workflows/catalog') return { data: CATALOG };
    return { data: {} };
  });
  mockApi.post.mockResolvedValue({ data: { ...WORKFLOW, id: 'new-id' } });
  mockApi.delete.mockResolvedValue({ data: undefined });
});

describe('the my-automations card actions', () => {
  it('has no Actions menu trigger', async () => {
    renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'] });
    await screen.findByText('Post-job review request');

    expect(screen.queryByRole('button', { name: /^actions for/i })).not.toBeInTheDocument();
  });

  it('renders direct duplicate and delete icon buttons naming the automation', async () => {
    renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'] });
    await screen.findByText('Post-job review request');

    expect(screen.getByRole('button', { name: 'Duplicate Post-job review request' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete Post-job review request' })).toBeInTheDocument();
  });

  it('duplicating calls create with a copy name, without opening a menu', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'] });
    await screen.findByText('Post-job review request');

    await user.click(screen.getByRole('button', { name: 'Duplicate Post-job review request' }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith(
        '/api/workflows',
        expect.objectContaining({ name: 'Post-job review request (copy)' }),
      ),
    );
  });

  it('delete opens the existing confirmation dialog, not a bare click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'] });
    await screen.findByText('Post-job review request');

    await user.click(screen.getByRole('button', { name: 'Delete Post-job review request' }));

    expect(await screen.findByRole('heading', { name: /delete "post-job review request"\?/i })).toBeInTheDocument();
    // A click alone must not have deleted anything yet.
    expect(mockApi.delete).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledWith(`/api/workflows/${WORKFLOW.id}`));
  });
});
