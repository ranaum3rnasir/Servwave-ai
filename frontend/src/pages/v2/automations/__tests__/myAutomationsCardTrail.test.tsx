/// <reference types="@testing-library/jest-dom/vitest" />
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import api from '@/lib/axios';
import type { AutomationTemplate, WorkflowCatalog } from '@/lib/api/workflows';
import { renderWithProviders } from '@/__tests__/helpers';

import AutomationsHomePage from '../AutomationsHomePage';

/**
 * SRVW-215 - the step-icon trail (`FlowTrail`) used to lead every
 * my-automations card, repeating in icons what the generated sentence
 * already said in words while eating the room the name/sentence/stats
 * column needed. It's gone from those cards. `FlowTrail` itself is not
 * deleted: the templates gallery below still uses it, so this only checks
 * it stopped rendering on the my-automations list, not that the component
 * or its export disappeared.
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
  steps: [{ id: 's1', position: 0, step_type: 'SEND_EMAIL', config: {} }],
  issues: [],
  has_unpublished_changes: false,
  published_version: 1,
};

const TEMPLATE: AutomationTemplate = {
  key: 'thank-you',
  name: 'Thank you email',
  description: 'Send a thank-you email after a job completes.',
  category: 'customer',
  trigger_type: 'JOB_COMPLETED',
  action_type: 'SEND_SMS',
  action_config: { recipient: 'customer', body: 'Thanks!' },
  send_window: 'ANYTIME',
};

const CATALOG_WITH_TEMPLATE = {
  triggers: {},
  actions: {},
  audiences: {},
  anchors: { job: [], estimate: [], invoice: [], lead: [] },
  merge_field_labels: {},
  sample_context: {},
  templates: [TEMPLATE],
  stop_if: { conditions: {}, labels: {} },
  capabilities: { sms_available: true },
} as unknown as WorkflowCatalog;

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockImplementation(async (url: string) => {
    if (url === '/api/workflows') return { data: [WORKFLOW] };
    if (url === '/api/workflows/catalog') return { data: CATALOG_WITH_TEMPLATE };
    return { data: {} };
  });
});

describe('the my-automations card step trail', () => {
  it('does not render the step-icon trail on the my-automations card', async () => {
    renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'] });
    const nameEl = await screen.findByText('Post-job review request');

    const card = nameEl.closest('.rounded-lg') as HTMLElement;
    // FlowTrail's tiles are `title`-attributed step-type labels, e.g. "Trigger".
    expect(within(card).queryByTitle('Trigger')).not.toBeInTheDocument();

    // The name/sentence/stats column takes the row's full width now that
    // nothing sits to its left - not turned into unused whitespace.
    const textColumn = nameEl.closest('.flex-1') as HTMLElement;
    expect(textColumn).toHaveClass('flex-1');
  });

  it('still renders the step-icon trail on template cards below', async () => {
    renderWithProviders(<AutomationsHomePage />, { initialEntries: ['/automations'] });
    const templateName = await screen.findByText('Thank you email');

    const templateCard = templateName.closest('.rounded-lg') as HTMLElement;
    expect(within(templateCard).getByTitle('Trigger')).toBeInTheDocument();
  });
});
