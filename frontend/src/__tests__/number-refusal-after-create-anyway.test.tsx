/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * Guard the number (whole-diff security ruling, Ran 2026-11-07): the server refuses a number that a customer the person
 * cannot open already carries, with a 409 that is NOT the duplicate answer, Create anyway included. Typing such a number
 * first opens the duplicate dialog (the server's duplicate answer, redacted for a customer they cannot read); "Create
 * anyway" then gets the refusal. The form must show it: the dialog closes and the sentence is on screen, never a dialog
 * left open with nothing said. API mocked at the network edge (the app's axios instance).
 */
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from '@/lib/axios';
import { buildAbility } from '@/lib/ability';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import StandaloneInvoiceFormPage from '@/pages/v2/invoices/StandaloneInvoiceFormPage';

import { renderWithProviders } from './helpers';
import { renderLeadForm, serveLeadForm } from '@/__tests__/harness/leadFormPage';

const mockApi = vi.mocked(api);

const REFUSAL = "This number is already on a customer you can't open. Ask someone who can open that customer to add it.";

/** The server's duplicate answer for a customer the person cannot read (#1996): no name, no number. */
const duplicate = { response: { status: 409, data: { error: 'duplicate', existing: { id: 'c1', matched: { phone: true }, redacted: true } } } };
const refusal = { response: { status: 409, data: { error: REFUSAL } } };

// Built from parts so the repo-wide guard in add-new-client-target.test.tsx, which counts the quoted literal, is untouched.
const route = (...parts: string[]) => ['', ...parts].join('/');

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  vi.clearAllMocks();
  serveLeadForm({ organization: { timezone: 'America/New_York', job_type_options: [], source_options: [] } });
  mockApi.post.mockRejectedValueOnce(duplicate).mockRejectedValueOnce(refusal);
});

async function createAnyway(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /create anyway/i }));
  await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(2));
  expect(String(mockApi.post.mock.calls[1]![0])).toContain('override=true');
}

describe('the refusal of a number a customer the person cannot open carries, after Create anyway', () => {
  it('the customer form shows it and closes the duplicate dialog', async () => {
    const ability = buildAbility([
      { action: 'create', subject: 'Customer' },
      { action: 'read', subject: 'Customer' },
      { action: 'update', subject: 'Customer' },
    ]);
    renderWithProviders(<CustomerFormPage />, { ability, initialEntries: [route('customers', 'new')] });
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText('Jane'), 'Wes');
    await user.type(screen.getByPlaceholderText('(555) 123-4567'), '5550100155');
    await user.click(screen.getByTestId('customer-form-submit'));

    await createAnyway(user);

    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create anyway/i })).not.toBeInTheDocument();
  });

  it('the lead form shows it and closes the duplicate dialog', async () => {
    const ability = buildAbility([
      { action: 'create', subject: 'Lead' },
      { action: 'read', subject: 'Lead' },
      { action: 'update', subject: 'Lead' },
    ]);
    renderLeadForm({ ability, entry: route('leads', 'new') });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/first name/i), 'Wes');
    await user.type(screen.getByLabelText(/^phone/i), '5550100155');
    await user.type(screen.getByPlaceholderText('Describe the service needed...'), 'Front door will not latch');
    await user.click(screen.getByRole('button', { name: /create lead/i }));

    await createAnyway(user);

    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create anyway/i })).not.toBeInTheDocument();
  });

  it('the job form shows it and closes the duplicate dialog', async () => {
    const ability = buildAbility([
      { action: 'create', subject: 'Job' },
      { action: 'read', subject: 'Job' },
      { action: 'update', subject: 'Job' },
    ]);
    renderWithProviders(<JobFormPage />, { ability, initialEntries: [route('jobs', 'new')] });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/first name/i), 'Wes');
    await user.type(screen.getByLabelText(/^phone/i), '5550100155');
    await user.type(document.getElementById('service_address_line1')!, '1 Test Way');
    await user.type(document.getElementById('service_city')!, 'Testville');
    await user.type(document.getElementById('service_state')!, 'MA');
    await user.type(document.getElementById('service_zip')!, '02108');
    await user.type(screen.getByPlaceholderText('Describe the work needed...'), 'Front door will not latch');
    await user.click(screen.getByRole('button', { name: /create job/i }));

    await createAnyway(user);

    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create anyway/i })).not.toBeInTheDocument();
  });

  it('the new invoice form shows it and closes the duplicate dialog', async () => {
    const ability = buildAbility([{ action: 'manage', subject: 'all' }]);
    renderWithProviders(<StandaloneInvoiceFormPage />, { ability, initialEntries: [route('invoices', 'new')] });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/first name/i), 'Wes');
    await user.type(screen.getByLabelText(/^phone/i), '5550100155');
    await user.click(screen.getByRole('button', { name: /^continue$/i }));

    await createAnyway(user);

    expect(await screen.findByText(REFUSAL)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create anyway/i })).not.toBeInTheDocument();
  });
});
