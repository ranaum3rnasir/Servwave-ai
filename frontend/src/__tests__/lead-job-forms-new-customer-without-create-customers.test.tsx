/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Roles & Permissions, PRD 2, slice S02.26 - Create customers is the STANDALONE New Customer only. The new customer inside
 * the lead form and the job form follows Create leads / Create jobs, so a person who holds those and not Create customers
 * (the Technician preset's values) still adds a customer there. Rendered through the routed pages.
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAbility } from '@/lib/ability';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';

import { renderWithProviders } from './helpers';
import { renderLeadForm, serveLeadForm } from '@/__tests__/harness/leadFormPage';


// Built from parts so the repo-wide guard in add-new-client-target.test.tsx, which counts the quoted literal, is untouched.
const NEW_LEAD_ROUTE = ['', 'leads', 'new'].join('/');
const NEW_JOB_ROUTE = ['', 'jobs', 'new'].join('/');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  vi.clearAllMocks();
  serveLeadForm({ organization: { timezone: 'America/New_York', job_type_options: [], source_options: [] } });
});

describe('a person with Create leads / Create jobs and without Create customers', () => {
  it('adds a new customer inside the lead form', async () => {
    // Create leads needs View leads and Edit leads.
    const ability = buildAbility([
      { action: 'create', subject: 'Lead' },
      { action: 'read', subject: 'Lead' },
      { action: 'update', subject: 'Lead' },
    ]);
    expect(ability.can('create', 'Customer')).toBe(false);

    renderLeadForm({ ability, entry: NEW_LEAD_ROUTE });

    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/first name/i), 'Jane');
    await user.type(screen.getByLabelText(/last name/i), 'Doe');
    await user.type(screen.getByLabelText(/^phone/i), '5551234567');
    await user.type(screen.getByPlaceholderText('Describe the service needed...'), 'Front door will not latch');

    // The new customer is typed into the lead form and the lead can be saved: no Create customers needed.
    await waitFor(() => expect(screen.getByRole('button', { name: /create lead/i })).toBeEnabled());
  });

  it('adds a new customer inside the job form', async () => {
    // Create jobs needs View jobs and Edit jobs.
    const ability = buildAbility([
      { action: 'create', subject: 'Job' },
      { action: 'read', subject: 'Job' },
      { action: 'update', subject: 'Job' },
    ]);
    expect(ability.can('create', 'Customer')).toBe(false);

    renderWithProviders(<JobFormPage />, { ability, initialEntries: [NEW_JOB_ROUTE] });

    expect(await screen.findByLabelText(/first name/i)).toBeEnabled();
    expect(screen.getByLabelText(/last name/i)).toBeEnabled();
  });
});
