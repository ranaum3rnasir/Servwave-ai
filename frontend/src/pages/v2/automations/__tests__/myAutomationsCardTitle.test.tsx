/// <reference types="@testing-library/jest-dom/vitest" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import api from '@/lib/axios';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';

import AutomationsHomePage from '../AutomationsHomePage';

/**
 * SRVW-213 - the my-automations card used to lead with the generated
 * "when X happens, do Y" sentence and bury the name the user actually typed
 * as a muted subtitle. That's backwards for telling near-identical
 * automations apart at a glance, so the name is now the bold primary line
 * and the sentence is the secondary muted line beneath it.
 */

const mockApi = vi.mocked(api);

const NAMED_WORKFLOW = {
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

const UNNAMED_WORKFLOW = { ...NAMED_WORKFLOW, id: 'a0000000-0000-0000-0000-000000000002', name: '   ' };

/** Empty but well-formed - no templates, so the gallery below never renders. */
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

function stubWorkflows(workflows: unknown[]) {
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/workflows') return { data: workflows };
    if (url === '/api/workflows/catalog') return { data: CATALOG };
    return { data: {} };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the my-automations card title', () => {
  it('leads with the automation name, not the generated sentence', async () => {
    stubWorkflows([NAMED_WORKFLOW]);
    renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'] });

    const name = await screen.findByText('Post-job review request');
    expect(name.tagName).toBe('P');
    expect(name).toHaveClass('font-semibold');

    // The generated sentence still renders, just demoted to the muted line.
    const sentence = screen.getByText(/job.*complet/i);
    expect(sentence).toHaveClass('text-muted-foreground');
  });

  it('falls back to Untitled automation when the name is blank', async () => {
    stubWorkflows([UNNAMED_WORKFLOW]);
    renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'] });

    const fallback = await screen.findByText('Untitled automation');
    expect(fallback).toHaveClass('font-semibold');
  });
});
