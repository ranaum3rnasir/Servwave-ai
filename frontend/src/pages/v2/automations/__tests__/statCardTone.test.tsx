import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import api from '@/lib/axios';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';

import AutomationsHomePage from '../AutomationsHomePage';

/**
 * SRVW-264 - the "Paused" stat card is the one tone the page had dropped:
 * "Active" carries green and "Runs all-time" carries brand, but "Paused"
 * rendered with no tone at all, so it had no colour rail. workflowVisuals.tsx
 * already paints PAUSED amber elsewhere on this same page, so the card should
 * carry that same tone.
 */

const mockApi = vi.mocked(api);

const PAUSED_WORKFLOW = {
  id: 'a0000000-0000-0000-0000-000000000001',
  name: 'Post-job thank you',
  status: 'PUBLISHED',
  is_enabled: false,
  trigger_type: 'JOB_COMPLETED',
  trigger_config: null,
  send_window: 'ANYTIME',
  template_key: null,
  legacy_rule_id: null,
  published_at: '2026-01-10T00:00:00.000Z',
  last_triggered_at: null,
  trigger_count: 0,
  created_at: '2026-01-15T00:00:00.000Z',
  updated_at: '2026-01-15T00:00:00.000Z',
  steps: [],
  issues: [],
  has_unpublished_changes: false,
  published_version: 1,
};

/** Empty but well-formed - the templates gallery below the stat band reads it. */
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
    if (url === '/api/workflows') return { data: [PAUSED_WORKFLOW] };
    if (url === '/api/workflows/catalog') return { data: CATALOG };
    return { data: {} };
  });
});

describe('the automations stat band', () => {
  it('gives the Paused card the amber rail', async () => {
    renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'] });

    const [activeLabel] = await screen.findAllByText('Active');
    const statBand = activeLabel!.closest('[data-slot="stat-card-group"]') as HTMLElement;
    const pausedLabel = within(statBand).getByText('Paused');
    const card = pausedLabel.closest('[data-slot="stat-card"]');

    expect(card).toHaveClass('before:bg-status-amber');
  });
});
