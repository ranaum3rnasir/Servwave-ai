import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/__tests__/helpers';

import { DisputeDrawer } from '../components/DisputeDrawer';
import {
  DISPUTE_ID, INVOICE_ID, apiError, file, inDays, makeEvidence, mockApi, serveDispute,
} from './disputeFixtures';

const open = (props: Partial<React.ComponentProps<typeof DisputeDrawer>> = {}) =>
  renderWithProviders(<DisputeDrawer disputeId={DISPUTE_ID} onClose={vi.fn()} {...props} />);
const drawer = () => screen.findByRole('dialog');
const term = (dialog: HTMLElement, name: string) => within(dialog).getByText(name, { selector: 'dt' }).nextElementSibling as HTMLElement;

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.put.mockReset();
  mockApi.post.mockReset();
});

describe('step 1: the dispute', () => {
  it('reads the deadline, amount, reason, customer, invoice and status, with Add evidence to start', async () => {
    serveDispute();
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('5 days left')).toBeInTheDocument();
    expect(within(dialog).getByText('5 days left')).not.toHaveAttribute('data-tone', 'danger');
    expect(term(dialog, 'Amount')).toHaveTextContent('$250.00');
    expect(term(dialog, 'Reason')).toHaveTextContent('The customer does not recognize the charge');
    expect(term(dialog, 'Customer')).toHaveTextContent('Dana Whitfield');
    expect(within(dialog).getByRole('link', { name: 'INV-1042' })).toHaveAttribute('href', `/invoices/${INVOICE_ID}`);
    expect(term(dialog, 'Status')).toHaveTextContent('Needs response');
    expect(within(dialog).getByRole('button', { name: 'Add evidence' })).toBeInTheDocument();
  });

  it('turns the days left to the danger tone at 3 days or fewer', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { respond_by: inDays(2), days_left: 2 } }) });
    open();
    expect(await screen.findByText('2 days left')).toHaveAttribute('data-tone', 'danger');
  });

  it('says so when the deadline passed, and offers no way to add evidence', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { respond_by: '2026-10-01T12:00:00.000Z', days_left: 0 }, can_edit: false }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('The deadline passed on Oct 1, 2026')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add evidence' })).not.toBeInTheDocument();
  });

  it('shows what was submitted, read-only, with no edit controls', async () => {
    serveDispute({
      evidence: makeEvidence({
        dispute: { status: 'UNDER_REVIEW' },
        can_edit: false,
        form: {
          files: { receipt: file('a1', 'receipt.pdf', { size_bytes: 120_000 }), customer_signature: null },
          text: { uncategorized_text: 'The job was finished and signed off on site.' },
        },
        submitted: { at: '2026-10-12T15:00:00.000Z', by_name: 'Maya Ortiz', count: 1, files: [{ field: 'receipt', file_name: 'receipt.pdf' }] },
      }),
    });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('Evidence submitted Oct 12, 2026 by Maya Ortiz')).toBeInTheDocument();
    expect(within(dialog).getByText('receipt.pdf')).toBeInTheDocument();
    expect(within(dialog).getByText('Receipt')).toBeInTheDocument();
    expect(within(dialog).getByText('Your explanation')).toBeInTheDocument();
    expect(within(dialog).getByText('The job was finished and signed off on site.')).toBeInTheDocument();
    // Nothing is left to respond to, so no deadline.
    expect(within(dialog).queryByText('Respond by')).not.toBeInTheDocument();
    expect(term(dialog, 'Status')).toHaveTextContent('Under review');
    expect(within(dialog).queryByRole('button', { name: /add evidence|save draft|submit evidence|remove|replace/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it.each([
    ['won', 'WON', 'Won'],
    ['lost', 'LOST', 'Lost'],
  ] as const)('shows the outcome when the dispute was %s, with the day it closed', async (outcome, status, word) => {
    serveDispute({ evidence: makeEvidence({ dispute: { status, outcome, closed_at: '2026-10-10T12:00:00.000Z' }, can_edit: false }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText(`${word} on Oct 10, 2026`)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add evidence' })).not.toBeInTheDocument();
  });

  it('explains a bank return in one sentence and shows no form', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { is_bank_return: true }, can_edit: false }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('The bank returned this payment, so there is no evidence to send.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add evidence' })).not.toBeInTheDocument();
  });

  it('shows a view-only caller steps 1 and no button', async () => {
    serveDispute({ evidence: makeEvidence({ can_edit: false }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('5 days left')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add evidence' })).not.toBeInTheDocument();
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
  });

  it('does not open a dispute the caller may not see (404)', async () => {
    mockApi.get.mockImplementation((() => Promise.reject(apiError(404, { error: 'Dispute not found' }))) as never);
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('This dispute can’t be opened.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add evidence' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});
