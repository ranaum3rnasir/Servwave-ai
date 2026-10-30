/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import api from '@/lib/axios';
import type { WorkflowCatalog } from '@/lib/api/workflows';
import { automationsManageAbility, renderWithProviders } from '@/__tests__/helpers';
import { MEDIA } from '@/ui-kit/lib/breakpoints';

import AutomationBuilderPage from '../AutomationBuilderPage';

/**
 * Mobile slice 55: the automation builder's header on the shared detail header.
 *
 * At 320 px Publish used to sit past the right edge: the title column and a `shrink-0` row of
 * Test, Activity, Delete and Publish shared one line. Below sm the header now stacks: Back and
 * the name, the sentence, Publish on its own full-width row and Test, Activity and Delete inside
 * an Actions menu. From sm up it is the old row and the text link above the title.
 */

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

const mockApi = vi.mocked(api);
const originalMatchMedia = window.matchMedia;

function setPhone(isPhone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: isPhone && query === MEDIA.belowSm,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

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

function renderBuilder() {
  return renderWithProviders(
    <Routes>
      <Route path="/automations/:id" element={<AutomationBuilderPage />} />
    </Routes>,
    { initialEntries: [`/automations/${WORKFLOW.id}`], ability: automationsManageAbility() },
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
afterEach(() => {
  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: originalMatchMedia });
  window.history.replaceState(null, '');
});

describe('automation builder header on a phone (mobile slice 55)', () => {
  it('puts Publish on its own full-width row and folds Test, Activity and Delete into Actions', async () => {
    setPhone(true);
    const user = userEvent.setup();
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toHaveValue(WORKFLOW.name));

    // Publish (or its disabled-reason shell) is a direct child of the primary row.
    const publish = screen.getByRole('button', { name: /^Publish$/ });
    const row = (publish.closest('[data-disabled-reason-shell]') ?? publish).parentElement!;
    expect(row.className).toContain('[&>button]:h-11');
    expect(row.className).toContain('flex-col');

    // Nothing else of the old action row is a header button now.
    expect(screen.queryByRole('button', { name: /^Test$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Activity$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByRole('menuitem', { name: /Test/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Activity/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Delete/ })).toBeInTheDocument();
  });

  it('has a Back control that always goes to the list, never back in history', async () => {
    setPhone(true);
    const user = userEvent.setup();
    // An earlier in-app entry exists: a history pop would land on the /new entry, which no longer holds this draft.
    window.history.replaceState({ idx: 4 }, '');
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Back to Automations' }));
    expect(mockNavigate).toHaveBeenCalledWith('/automations');
    expect(mockNavigate).not.toHaveBeenCalledWith(-1);
    // The text link above the title is the wide layout's.
    expect(screen.queryByRole('link', { name: /back to automations/i })).not.toBeInTheDocument();
  });

  it('shows why Test is blocked inside the menu, in text, because a title never shows on touch', async () => {
    setPhone(true);
    const user = userEvent.setup();
    renderBuilder();
    // A never-saved page (no server id) cannot be tested.
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toBeInTheDocument());
    await user.type(screen.getByLabelText('Automation name'), ' v2');
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    expect(await screen.findByText('Save your changes first')).toBeVisible();
  });
});

describe('automation builder header from sm up (unchanged)', () => {
  it('keeps the text link above the title and Test, Activity and Delete as buttons beside Publish', async () => {
    setPhone(false);
    renderBuilder();
    await waitFor(() => expect(screen.getByLabelText('Automation name')).toBeInTheDocument());

    expect(screen.getByRole('link', { name: /back to automations/i })).toHaveAttribute('href', '/automations');
    expect(screen.queryByRole('button', { name: 'Back to Automations' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Test$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Activity$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Delete$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Publish$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actions' })).not.toBeInTheDocument();
  });
});
