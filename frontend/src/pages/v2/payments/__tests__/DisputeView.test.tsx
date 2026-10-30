import { beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';

import { DISPUTE_URL, DisputeStage } from './disputeHarness';
import { makeDetail, manyRows } from './paymentsFixtures';
import {
  DISPUTE_ID, DISPUTE_REF, PAYMENT_ID, apiError, file, inDays, inHours, makeEvidence, mockApi, serveDispute,
} from './disputeFixtures';

function Where() {
  return <div data-testid="where">{new URLSearchParams(useLocation().search).get('d')}</div>;
}
const open = (url = DISPUTE_URL) => renderWithProviders(<><DisputeStage /><Where /></>, { initialEntries: [url] });
const drawer = () => screen.findByRole('dialog');
const term = (dialog: HTMLElement, name: string) => within(dialog).getByText(name, { selector: 'dt' }).nextElementSibling as HTMLElement;
const respondButton = (dialog: HTMLElement) => within(dialog).queryByRole('button', { name: 'Respond' });
const timelineText = (dialog: HTMLElement) => dialog.querySelector('[data-slot="timeline"]')?.textContent ?? '';

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.put.mockReset();
  mockApi.post.mockReset();
});

describe('the Dispute view', () => {
  it('is titled with the DSP- code and reads the status, reason, amount, opened date and payment code', async () => {
    serveDispute();
    open();
    const dialog = await screen.findByRole('dialog', { name: `Dispute ${DISPUTE_REF}` });
    expect(await within(dialog).findByText('5 days left')).toBeInTheDocument();
    expect(term(dialog, 'Status')).toHaveTextContent('Needs response');
    expect(term(dialog, 'Reason')).toHaveTextContent('The customer does not recognize the charge');
    expect(term(dialog, 'Amount')).toHaveTextContent('$250.00');
    expect(term(dialog, 'Opened')).toHaveTextContent('Oct 1, 2026');
    expect(term(dialog, 'Payment')).toHaveTextContent('PMT-000041');
    // The customer block and the payment link replace the old Customer and Invoice rows.
    expect(within(dialog).queryByText('Customer', { selector: 'dt' })).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Invoice', { selector: 'dt' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('Dana Whitfield')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Evidence files' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Timeline' })).toBeInTheDocument();
  });

  it('shows the Respond button only when the API says the caller may answer, and no Add evidence step', async () => {
    serveDispute();
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByRole('button', { name: 'Respond' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add evidence' })).not.toBeInTheDocument();
  });

  it('shows a view-only caller the view and Close, with no Respond', async () => {
    serveDispute({ evidence: makeEvidence({ can_edit: false }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('5 days left')).toBeInTheDocument();
    expect(respondButton(dialog)).not.toBeInTheDocument();
    const footer = dialog.querySelector('[data-slot="sheet-footer"]') as HTMLElement;
    expect(within(footer).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
  });

  it('says "No evidence files yet." when there are none', async () => {
    serveDispute();
    open();
    expect(await within(await drawer()).findByText('No evidence files yet.')).toBeInTheDocument();
  });

  it('lists the saved files in field order, with size, one button each', async () => {
    serveDispute({
      evidence: makeEvidence({
        form: { files: { uncategorized_file: file('a3', 'other.png', { mime: 'image/png', size_bytes: 90_000 }), receipt: file('a1', 'receipt.pdf', { size_bytes: 90_000 }) } },
      }),
    });
    open();
    const dialog = await drawer();
    const rows = await within(dialog).findAllByRole('button', { name: /receipt\.pdf|other\.png/ });
    expect(rows.map((r) => r.textContent)).toEqual(['receipt.pdf90 KB', 'other.png90 KB']);
  });

  it('the Payment code pushes the Payment view on top (Back goes to the Dispute)', async () => {
    serveDispute();
    const base = mockApi.get.getMockImplementation()! as (u: string, c?: unknown) => unknown;
    mockApi.get.mockImplementation(((url: string, config?: unknown) =>
      url === `/api/payments-page/payments/${PAYMENT_ID}` ? Promise.resolve({ data: makeDetail(manyRows(1)[0]!) }) : base(url, config)) as never);
    const u = userEvent.setup();
    open();
    const dialog = await drawer();
    await u.click(await within(dialog).findByRole('button', { name: 'PMT-000041' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`dispute:${DISPUTE_ID},payment:${PAYMENT_ID}`));
  });

  it('Respond pushes the Respond view', async () => {
    serveDispute();
    const u = userEvent.setup();
    open();
    await u.click(await within(await drawer()).findByRole('button', { name: 'Respond' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`dispute:${DISPUTE_ID},respond:${DISPUTE_ID}`));
  });

  it('reads a restricted customer block as one line, with no person fields', async () => {
    serveDispute({ evidence: makeEvidence({ customer_block: { restricted: true, customer: null } }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('Customer details are restricted for your role.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Dana Whitfield')).not.toBeInTheDocument();
  });

  it('does not open a dispute the caller may not see (404)', async () => {
    mockApi.get.mockImplementation((() => Promise.reject(apiError(404, { error: 'Dispute not found' }))) as never);
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('This dispute can’t be opened.')).toBeInTheDocument();
    expect(respondButton(dialog)).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });
});

describe('the deadline, from respond_by (never days_left)', () => {
  it('reads hours under 48 and turns urgent, whatever days_left says', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { respond_by: inHours(40), days_left: 2 } }) });
    open();
    const dialog = await drawer();
    const banner = await within(dialog).findByRole('status');
    expect(banner).toHaveTextContent('40 hours left');
    expect(banner).toHaveAttribute('data-tone', 'danger');
    expect(banner).toHaveTextContent(/Respond by [A-Z][a-z]{2} \d{1,2}, 20\d\d, \d{1,2}:\d{2}\s?[AP]M/);
  });

  it('reads whole days (rounded down) from 48 hours, in the warning tone', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { respond_by: inHours(3 * 24 + 20), days_left: 4 } }) });
    open();
    const banner = await within(await drawer()).findByRole('status');
    expect(banner).toHaveTextContent('3 days left');
    expect(banner).toHaveAttribute('data-tone', 'warning');
  });

  it('says Past due once the time has passed, and offers no Respond', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { respond_by: '2026-10-01T12:00:00.000Z', days_left: 0 }, can_edit: false }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByRole('status')).toHaveTextContent('Past due');
    expect(timelineText(dialog)).toContain('Evidence dueOct 1, 2026 · Past due');
    expect(respondButton(dialog)).not.toBeInTheDocument();
  });

  it('has no banner and no Evidence due entry once the evidence is sent', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { status: 'UNDER_REVIEW' }, can_edit: false }) });
    open();
    const dialog = await drawer();
    await within(dialog).findByText('Under review');
    expect(within(dialog).queryByText(/^Respond by/)).not.toBeInTheDocument();
    expect(timelineText(dialog)).not.toContain('Evidence due');
  });
});

describe('by status', () => {
  it('shows what was submitted, read-only, with the files as rows and the saved words', async () => {
    serveDispute({
      evidence: makeEvidence({
        dispute: { status: 'UNDER_REVIEW' },
        can_edit: false,
        form: {
          files: { receipt: file('a1', 'receipt.pdf', { size_bytes: 90_000 }), customer_signature: null },
          text: { uncategorized_text: 'The job was finished and signed off on site.' },
        },
        submitted: { at: '2026-10-12T15:00:00.000Z', by_name: 'Maya Ortiz', count: 1, files: [{ field: 'receipt', file_name: 'receipt.pdf', attachment_id: 'a1' }] },
      }),
    });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('Evidence submitted Oct 12, 2026 by Maya Ortiz')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /receipt\.pdf/ })).toBeInTheDocument();
    expect(within(dialog).getByText('Your explanation')).toBeInTheDocument();
    expect(within(dialog).getByText('The job was finished and signed off on site.')).toBeInTheDocument();
    expect(term(dialog, 'Status')).toHaveTextContent('Under review');
    expect(timelineText(dialog)).toContain('Evidence submittedOct 12, 2026 · Under review by the card network');
    expect(within(dialog).queryByRole('button', { name: /respond|save draft|submit evidence|remove|replace/i })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('shows a won dispute on the timeline with the day it closed', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { status: 'WON', outcome: 'won', closed_at: '2026-10-10T12:00:00.000Z' }, can_edit: false }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('Dispute won')).toBeInTheDocument();
    expect(timelineText(dialog)).toContain('Oct 10, 2026 · Funds returned to you');
    expect(term(dialog, 'Status')).toHaveTextContent('Won');
    expect(respondButton(dialog)).not.toBeInTheDocument();
  });

  it.each([
    ['lost', 'LOST', 'Lost'],
    ['closed', 'CLOSED', 'Closed'],
  ] as const)('shows the outcome when the dispute was %s, with the day it closed, and no Won entry', async (outcome, status, word) => {
    serveDispute({ evidence: makeEvidence({ dispute: { status, outcome, closed_at: '2026-10-10T12:00:00.000Z' }, can_edit: false }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText(`${word} on Oct 10, 2026`)).toBeInTheDocument();
    expect(timelineText(dialog)).not.toContain('Dispute won');
    expect(respondButton(dialog)).not.toBeInTheDocument();
  });

  it('explains a bank return in one sentence and offers no Respond', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { is_bank_return: true }, can_edit: false }) });
    open();
    const dialog = await drawer();
    expect(await within(dialog).findByText('The bank returned this payment, so there is no evidence to send.')).toBeInTheDocument();
    expect(respondButton(dialog)).not.toBeInTheDocument();
  });

  it('puts the dispute opening first on the timeline, with the reason and the opened date', async () => {
    serveDispute();
    open();
    const dialog = await drawer();
    await within(dialog).findByText('Dispute opened');
    expect(timelineText(dialog)).toContain('Dispute openedOct 1, 2026 · The customer does not recognize the charge');
    expect(timelineText(dialog)).toContain('Evidence due');
  });
});

describe('the opened-from-elsewhere deep links', () => {
  it('a link to the Dispute alone opens it', async () => {
    serveDispute({ evidence: makeEvidence({ dispute: { respond_by: inDays(3) } }) });
    open(`/payments?d=dispute:${DISPUTE_ID}`);
    expect(await screen.findByRole('dialog', { name: `Dispute ${DISPUTE_REF}` })).toBeInTheDocument();
  });
});

describe('long file names', () => {
  it('wrap inside the row instead of running under the size and the chevron', async () => {
    const name = `${'a'.repeat(120)}.pdf`;
    serveDispute({ evidence: makeEvidence({ form: { files: { receipt: file('a1', name, { size_bytes: 90_000 }) } } }) });
    open();
    const row = await within(await drawer()).findByRole('button', { name: new RegExp('a{20}') });
    expect(row.classList.contains('whitespace-normal')).toBe(true);
    expect(within(row).getByText(name).classList.contains('whitespace-normal')).toBe(true);
  });
});
