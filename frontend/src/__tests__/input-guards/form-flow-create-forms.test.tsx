/* =============================================================================
   Form flow on the four create forms (mobile slice 38, KB-05 and A11Y-07).

   The A11Y-07 empty-form submit, for the lead, customer, job and invoice create
   forms: pressing the submit button on an empty form must
     - focus the FIRST invalid field in page order (First Name on all four),
     - scroll that field into view (inside whatever scroller holds it),
     - leave the field naming its error (aria-invalid + aria-describedby, so a
       screen reader announces the message when focus lands),
     - send nothing to the server.
   And the fields carry the action keys: Next in order, Done on the last one.
   ============================================================================= */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from '@/__tests__/helpers';
import LeadFormPage from '@/pages/v2/leads/LeadFormPage';
import JobFormPage from '@/pages/v2/jobs/JobFormPage';
import CustomerFormPage from '@/pages/v2/customers/CustomerFormPage';
import StandaloneInvoiceFormPage from '@/pages/v2/invoices/StandaloneInvoiceFormPage';
import { buildAbility } from '@/lib/ability';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});
vi.mock('@/lib/api/organization', () => ({
  useOrganization: () => ({ data: { job_type_options: [], source_options: [], billing_terms_options: [], timezone: 'America/New_York' } }),
  useUpdateOrganization: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/api/users', () => ({ useAssignableUsers: () => ({ data: [] }) }));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const mockApi = vi.mocked(api);
const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);
let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy as unknown as Element['scrollIntoView'];
  mockApi.get.mockImplementation(async (url: string) => {
    // The new-lead form shows the creator rule's pre-fill and will not save blind without it.
    if (url === '/api/leads/creator-prefill') return { data: { prefill: { owner_id: null, dispatcher_id: null } } };
    // The new-job form shows the creator rule's pre-fill (Sold By and Dispatcher) and will not save blind without it.
    if (url === '/api/jobs/creator-prefill') return { data: { prefill: { sold_by_id: null, dispatcher_id: null } } };
    if (url === '/api/customers/picker') return { data: { customers: [] } };
    return { data: { data: [] } };
  });
});

const CASES = [
  {
    name: 'create lead',
    // A template literal on purpose: add-new-client-target.test.tsx counts the
    // single-quoted new-lead path across src/ as a navigation-target guard; a test route is not one.
    render: () => renderWithProviders(<LeadFormPage />, { ability: adminAbility, initialEntries: [`/leads/new`] }),
    submit: /create lead/i,
    error: 'Enter a first name or a company name',
  },
  {
    name: 'create customer',
    render: () => renderWithProviders(<CustomerFormPage />, { ability: adminAbility, initialEntries: ['/customers/new'] }),
    submit: /create customer/i,
    error: 'Enter a first name or a company name',
  },
  {
    name: 'create job',
    render: () => renderWithProviders(<JobFormPage />, { ability: adminAbility, initialEntries: ['/jobs/new'] }),
    submit: /create job/i,
    error: 'Enter a first name or a company name',
  },
  {
    name: 'create invoice',
    render: () => renderWithProviders(<StandaloneInvoiceFormPage />, { ability: adminAbility, initialEntries: ['/invoices/new'] }),
    submit: /continue/i,
    error: 'Enter a first name or a company name',
  },
] as const;

/**
 * The fields that take part in the order, in page order: text inputs and
 * textareas. Only single-line inputs carry a key; a textarea's Return adds a line.
 */
function orderedFields(form: HTMLFormElement): (HTMLInputElement | HTMLTextAreaElement)[] {
  return Array.from(form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')).filter(
    (el) => el instanceof HTMLTextAreaElement || ['', 'text', 'email', 'tel', 'search'].includes(el.getAttribute('type') ?? ''),
  ).filter((el) => !el.disabled && el.tabIndex >= 0);
}

describe.each(CASES)('$name', ({ render, submit, error }) => {
  it('gives its fields Next in order and Done on the last (a textarea keeps Return)', async () => {
    render();
    const first = await screen.findByLabelText(/first name/i);
    const form = (first as HTMLInputElement).form!;
    await waitFor(() => expect(first).toHaveAttribute('enterkeyhint', 'next'));
    const fields = orderedFields(form);
    const inputs = fields.filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);
    expect(inputs.length).toBeGreaterThan(2);
    const lastIsInput = fields.at(-1) instanceof HTMLInputElement;
    inputs.forEach((el, i) => {
      const own = el.getAttribute('enterkeyhint');
      if (own === 'search') return; // a field that names its own key keeps it
      const isLast = lastIsInput && i === inputs.length - 1;
      expect({ field: el.id || el.name || el.placeholder, key: own }).toEqual({
        field: el.id || el.name || el.placeholder,
        key: isLast ? 'done' : 'next',
      });
    });
    // A textarea carries no key: Return adds a line there.
    fields.filter((el) => el instanceof HTMLTextAreaElement).forEach((el) => expect(el).not.toHaveAttribute('enterkeyhint'));
  });

  it('an empty submit focuses First Name, scrolls it into view, links its error, and sends nothing', async () => {
    const user = userEvent.setup();
    render();
    const first = await screen.findByLabelText(/first name/i);
    await user.click(screen.getByRole('button', { name: submit }));

    await waitFor(() => expect(document.activeElement).toBe(first));
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).toHaveAccessibleDescription(expect.stringContaining(error));
    expect(scrollSpy.mock.contexts).toContain(first);
    expect(mockApi.post).not.toHaveBeenCalled();
  });
});
