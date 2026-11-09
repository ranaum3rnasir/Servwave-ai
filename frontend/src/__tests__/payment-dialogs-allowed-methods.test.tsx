/**
 * Roles & Permissions S02.32 - the two payment dialogs (the invoice record-payment dialog, also opened by the job's
 * Payment Received step, and the estimate deposit dialog) offer exactly the methods that are in the company's
 * effective accepted list AND in the person's Allowed payment methods.
 *
 * The two reads are served as the server answers them (GET /api/permission-switches/accepted-payment-methods and
 * GET /api/permission-switches/me); what each case expects is derived from the case's own two inputs, never from the
 * dialog's code.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { RecordPaymentDialog } from '@/components/invoices/RecordPaymentDialog';
import { RecordEstimatePaymentDialog } from '@/components/estimates/RecordEstimatePaymentDialog';
import { ALL_ACCEPTED } from '@/lib/api/permissionSwitches';
import { type AcceptedPaymentMethods } from '@/lib/api/recordablePaymentMethods';
import { type SwitchValue } from '@/lib/api/shared/switchTypes';

vi.mock('@/lib/axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock('@/lib/api/shared/organization', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/shared/organization')>()),
  useOrganization: () => ({ data: { deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 } }),
}));

const mockApi = vi.mocked(api);

/** Every method a dialog can offer, in the order the dialogs list them, by the label a person reads. */
const EVERY_METHOD: AcceptedPaymentMethods = {
  every_method: true,
  methods: ['CARD', 'EXTERNAL_CARD', 'BANK_TRANSFER', 'CHECK', 'CASH', 'ZELLE', 'VENMO', 'CASH_APP', 'OTHER'],
};
const CHECK_AND_CARD: AcceptedPaymentMethods = { every_method: false, methods: ['CHECK', 'CARD'] };
const CHECK_ONLY: AcceptedPaymentMethods = { every_method: false, methods: ['CHECK'] };
const ALL_LABELS = [
  'Credit Card', 'Card (outside ServWave)', 'Bank transfer', 'Check', 'Cash', 'Zelle', 'Venmo', 'Cash App', 'Other',
];

interface Reads {
  company: AcceptedPaymentMethods | 'fails';
  /** The person's Allowed payment methods value, or the Admin box. */
  person: SwitchValue | 'admin';
}

function serve({ company, person }: Reads) {
  mockApi.get.mockImplementation((url: string) => {
    if (url === '/api/permission-switches/accepted-payment-methods') {
      return company === 'fails' ? Promise.reject(new Error('boom')) : Promise.resolve({ data: company });
    }
    if (url === '/api/permission-switches/me') {
      return Promise.resolve({
        data: { admin_box: person === 'admin', values: { allowed_payment_methods: person === 'admin' ? ALL_ACCEPTED : person }, rules: [] },
      });
    }
    return Promise.resolve({ data: {} });
  });
}

function invoiceDialog() {
  return renderWithProviders(
    <RecordPaymentDialog open onOpenChange={vi.fn()} invoiceId="inv-1" invoiceNumber="I00001" amountDue={900} onSuccess={vi.fn()} />,
  );
}

function depositDialog() {
  return renderWithProviders(
    <RecordEstimatePaymentDialog open onOpenChange={vi.fn()} estimateId="est-1" estimateNumber="J00001-1" totalAmount={1000} />,
  );
}

const dialogs = [
  { name: 'the invoice record-payment dialog', open: invoiceDialog },
  { name: 'the estimate deposit dialog', open: depositDialog },
];

async function offered(): Promise<string[]> {
  const trigger = await screen.findByRole('combobox', { name: /payment method/i });
  await userEvent.click(trigger);
  const options = await screen.findAllByRole('option');
  return options.map((o) => o.textContent ?? '');
}

const recordButton = () => screen.getByRole('button', { name: /record payment/i });

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: {} });
});

describe.each(dialogs)('$name', ({ open }) => {
  it('offers exactly the intersection of the company list and the person\'s own list, in the usual order', async () => {
    // The company accepts Check, Cash and Zelle (no card); the person may record Zelle, Check and Venmo.
    serve({ company: { every_method: false, methods: ['CASH', 'CHECK', 'ZELLE'] }, person: ['ZELLE', 'CHECK', 'VENMO'] });
    open();
    expect(await offered()).toEqual(['Check', 'Zelle']);
  });

  it('follows a change of the company list for a person on "All accepted methods", without touching the person', async () => {
    serve({ company: CHECK_ONLY, person: ALL_ACCEPTED });
    const first = open();
    expect(await offered()).toEqual(['Check']);
    first.unmount();

    serve({ company: { every_method: false, methods: ['CHECK', 'ZELLE'] }, person: ALL_ACCEPTED });
    open();
    expect(await offered()).toEqual(['Check', 'Zelle']);
  });

  it('offers every method to an admin and to an "All accepted" person when the company has chosen none', async () => {
    for (const person of ['admin', ALL_ACCEPTED] as const) {
      serve({ company: EVERY_METHOD, person });
      const view = open();
      expect(await offered()).toEqual(ALL_LABELS);
      view.unmount();
    }
  });

  it('offers Check and Credit Card when the company ticks Check with the card processor live', async () => {
    serve({ company: CHECK_AND_CARD, person: ALL_ACCEPTED });
    open();
    expect(await offered()).toEqual(['Credit Card', 'Check']);
  });

  it('offers no Credit Card when the company ticks Check and the processor is not live', async () => {
    serve({ company: CHECK_ONLY, person: ALL_ACCEPTED });
    open();
    expect(await offered()).toEqual(['Check']);
  });

  it('preselects the first allowed method in the usual order', async () => {
    serve({ company: EVERY_METHOD, person: ['CASH', 'CHECK'] });
    open();
    // Check comes before Cash in the usual order, so a person allowed both opens on Check, not on a fixed default.
    await waitFor(() => expect(screen.getByRole('combobox', { name: /payment method/i })).toHaveTextContent('Check'));
  });

  it('greys the record button with its reason when the person may record no method', async () => {
    serve({ company: EVERY_METHOD, person: [] });
    open();
    expect(await screen.findByText('No payment methods are allowed for you. Ask an admin.')).toBeInTheDocument();
    expect(recordButton()).toBeDisabled();
    expect(recordButton()).toHaveAccessibleDescription('No payment methods are allowed for you. Ask an admin.');
  });

  it('greys the record button when the person\'s list and the company\'s list share nothing', async () => {
    serve({ company: CHECK_ONLY, person: ['CASH'] });
    open();
    expect(await screen.findByText('No payment methods are allowed for you. Ask an admin.')).toBeInTheDocument();
    expect(recordButton()).toBeDisabled();
  });

  it('holds the record button until the two lists have been read', async () => {
    mockApi.get.mockImplementation(() => new Promise(() => {}));
    open();
    expect(recordButton()).toBeDisabled();
    expect(screen.queryByText('No payment methods are allowed for you. Ask an admin.')).not.toBeInTheDocument();
  });

  it('offers every method when the company list cannot be read, because the server decides on submit', async () => {
    serve({ company: 'fails', person: ALL_ACCEPTED });
    open();
    expect(await offered()).toEqual(ALL_LABELS);
  });

  it('sends the preselected method, and a method the person picks instead', async () => {
    serve({ company: { every_method: false, methods: ['CHECK', 'CASH', 'ZELLE'] }, person: ALL_ACCEPTED });
    open();
    await waitFor(() => expect(screen.getByRole('combobox', { name: /payment method/i })).toHaveTextContent('Check'));
    await waitFor(() => expect(recordButton()).toBeEnabled());
    await userEvent.click(recordButton());
    await waitFor(() => expect(mockApi.post).toHaveBeenCalledTimes(1));
    const [, body] = mockApi.post.mock.calls[0]!;
    expect(Object.values(body as Record<string, unknown>)).toContain('CHECK');
  });
});
