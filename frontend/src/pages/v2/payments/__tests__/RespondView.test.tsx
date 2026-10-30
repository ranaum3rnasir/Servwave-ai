import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { renderWithProviders } from '@/__tests__/helpers';
import { toast } from '@/ui-kit/components/ui/sonner';

import { CAN_UPLOAD, DisputeStage } from './disputeHarness';
import { DISPUTE_ID, DISPUTE_REF, file, makeEvidence, mockApi, serveDispute } from './disputeFixtures';

vi.mock('@/lib/attachments/uploadAttachment', () => ({ uploadAttachment: vi.fn() }));
vi.mock('@/ui-kit/components/ui/sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

function Where() {
  return <div data-testid="where">{new URLSearchParams(useLocation().search).get('d')}</div>;
}
const RESPOND = `/payments?d=dispute:${DISPUTE_ID},respond:${DISPUTE_ID}`;
const where = () => screen.getByTestId('where').textContent;
const render = (url: string) =>
  renderWithProviders(<><DisputeStage /><Where /></>, { ability: CAN_UPLOAD, initialEntries: [url] });
const respondDialog = () => screen.findByRole('dialog', { name: 'Respond to dispute' });
const type = (dialog: HTMLElement, value: string) =>
  fireEvent.change(within(dialog).getByLabelText('Your explanation'), { target: { value } });

const ready = () => makeEvidence({
  can_submit: true,
  form: {
    version: 5,
    files: { receipt: file('a1', 'receipt.pdf') },
    text: { uncategorized_text: 'Done.', product_description: '', service_date: '2026-09-30', customer_name: 'Dana Whitfield', customer_email_address: 'dana@example.test' },
  },
});

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.put.mockReset();
  mockApi.post.mockReset();
  vi.mocked(toast.success).mockReset();
});

describe('the Respond view', () => {
  it('hosts the form with one Back, the header\'s "Back to Dispute", and none of its own', async () => {
    serveDispute();
    render(RESPOND);
    const dialog = await respondDialog();
    await within(dialog).findByLabelText('Your explanation');
    const backs = within(dialog).getAllByRole('button', { name: /^Back/ });
    expect(backs.map((b) => b.getAttribute('aria-label'))).toEqual(['Back to Dispute']);
    expect(within(dialog).getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Submit evidence' })).toBeInTheDocument();
  });

  it('asks the submit question with the amount and invoice, and on success lands on the Dispute view with one toast', async () => {
    const sent = () => makeEvidence({
      dispute: { status: 'UNDER_REVIEW' }, can_edit: false, can_submit: false,
      form: { version: 6, files: { receipt: file('a1', 'receipt.pdf') }, text: { uncategorized_text: 'Done.' } },
      submitted: { at: '2026-10-14T15:00:00.000Z', by_name: 'Maya Ortiz', count: 1, files: [{ field: 'receipt', file_name: 'receipt.pdf', attachment_id: 'a1' }] },
    });
    let done = false;
    // The submit answers without a customer block (only the read carries one); the read after it has the block.
    serveDispute({ evidence: () => (done ? sent() : ready()) });
    mockApi.post.mockImplementation((() => { done = true; const { customer_block: _drop, ...answer } = sent(); return Promise.resolve({ data: answer }); }) as never);
    const u = userEvent.setup();
    render(RESPOND);
    const dialog = await respondDialog();
    await u.click(await within(dialog).findByRole('button', { name: 'Submit evidence' }));
    const ask = await screen.findByRole('dialog', { name: 'Submit evidence' });
    expect(ask).toHaveTextContent('Send your evidence for $250.00 on invoice INV-1042 now? You cannot add more after you submit.');
    await u.click(within(ask).getByRole('button', { name: 'Submit evidence' }));
    expect(await screen.findByRole('dialog', { name: `Dispute ${DISPUTE_REF}` })).toBeInTheDocument();
    expect(await screen.findByText('Evidence submitted Oct 14, 2026 by Maya Ortiz')).toBeInTheDocument();
    expect(where()).toBe(`dispute:${DISPUTE_ID}`);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Evidence submitted. The dispute is under review');
    // The customer block the read brought is still there after the answer came back without one.
    expect(screen.getByText('Dana Whitfield')).toBeInTheDocument();
  });

  it.each([
    ['a caller who may only look', makeEvidence({ can_edit: false })],
    ['a dispute whose deadline passed', makeEvidence({ can_edit: false, dispute: { respond_by: '2026-10-01T12:00:00.000Z' } })],
    ['evidence that was already sent', makeEvidence({ can_edit: false, dispute: { status: 'UNDER_REVIEW' } })],
  ])('a link to respond for %s lands on the Dispute view and says nothing else', async (_name, evidence) => {
    serveDispute({ evidence });
    render(RESPOND);
    expect(await screen.findByRole('dialog', { name: `Dispute ${DISPUTE_REF}` })).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe(`dispute:${DISPUTE_ID}`));
    expect(screen.queryByLabelText('Your explanation')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(vi.mocked(toast.error)).not.toHaveBeenCalled();
  });

  it('a link to Respond alone, refused, puts the Dispute where it stood', async () => {
    serveDispute({ evidence: makeEvidence({ can_edit: false }) });
    render(`/payments?d=respond:${DISPUTE_ID}`);
    expect(await screen.findByRole('dialog', { name: `Dispute ${DISPUTE_REF}` })).toBeInTheDocument();
    await waitFor(() => expect(where()).toBe(`dispute:${DISPUTE_ID}`));
  });

  it('Back asks before it throws typed words away; Keep editing stays, Discard shows the Dispute', async () => {
    serveDispute();
    const u = userEvent.setup();
    render(RESPOND);
    const dialog = await respondDialog();
    type(await within(dialog).findByLabelText('Your explanation').then(() => dialog), 'Typed, not saved');
    await u.click(within(dialog).getByRole('button', { name: 'Back to Dispute' }));
    const ask = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    await u.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(where()).toBe(`dispute:${DISPUTE_ID},respond:${DISPUTE_ID}`);
    expect(within(dialog).getByLabelText('Your explanation')).toHaveValue('Typed, not saved');
    await u.click(within(dialog).getByRole('button', { name: 'Back to Dispute' }));
    await u.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('dialog', { name: `Dispute ${DISPUTE_REF}` })).toBeInTheDocument();
    expect(where()).toBe(`dispute:${DISPUTE_ID}`);
  });

  it('Close (the X) asks the same question while the form holds unsaved words', async () => {
    serveDispute();
    const u = userEvent.setup();
    render(RESPOND);
    const dialog = await respondDialog();
    await within(dialog).findByLabelText('Your explanation');
    type(dialog, 'Typed, not saved');
    await u.click(within(dialog).getByRole('button', { name: 'Close drawer' }));
    expect(await screen.findByRole('dialog', { name: 'Discard your changes?' })).toBeInTheDocument();
    expect(where()).toBe(`dispute:${DISPUTE_ID},respond:${DISPUTE_ID}`);
  });

  it('the browser Back button asks the same question, and Discard steps back one view', async () => {
    serveDispute();
    const u = userEvent.setup();
    render(RESPOND);
    const dialog = await respondDialog();
    await within(dialog).findByLabelText('Your explanation');
    type(dialog, 'Typed, not saved');
    // The guard's marker entry is on top of the history; the browser's Back pops it.
    await waitFor(() => expect(window.history.state).toMatchObject({ __dirtyGuardMarker: true }));
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    const ask = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    expect(where()).toBe(`dispute:${DISPUTE_ID},respond:${DISPUTE_ID}`);
    await u.click(within(ask).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByRole('dialog', { name: `Dispute ${DISPUTE_REF}` })).toBeInTheDocument();
    expect(where()).toBe(`dispute:${DISPUTE_ID}`);
  });

  it('Keep editing after the browser Back does not leave a stale answer for the next Close', async () => {
    serveDispute();
    const u = userEvent.setup();
    render(RESPOND);
    const dialog = await respondDialog();
    await within(dialog).findByLabelText('Your explanation');
    type(dialog, 'Typed, not saved');
    await waitFor(() => expect(window.history.state).toMatchObject({ __dirtyGuardMarker: true }));
    await u.click(within(dialog).getByRole('button', { name: 'Close drawer' }));
    await u.click(within(await screen.findByRole('dialog', { name: 'Discard your changes?' })).getByRole('button', { name: 'Keep editing' }));
    act(() => { window.dispatchEvent(new PopStateEvent('popstate')); });
    await u.click(within(await screen.findByRole('dialog', { name: 'Discard your changes?' })).getByRole('button', { name: 'Discard' }));
    // Back one view, not a close of the whole drawer.
    expect(await screen.findByRole('dialog', { name: `Dispute ${DISPUTE_REF}` })).toBeInTheDocument();
  });

  it('opens fresh each time: what was typed and discarded is gone when Respond is pressed again', async () => {
    serveDispute();
    const u = userEvent.setup();
    render(`/payments?d=dispute:${DISPUTE_ID}`);
    await u.click(await screen.findByRole('button', { name: 'Respond' }));
    let dialog = await respondDialog();
    await within(dialog).findByLabelText('Your explanation');
    type(dialog, 'Typed, not saved');
    await u.click(within(dialog).getByRole('button', { name: 'Back to Dispute' }));
    await u.click(await screen.findByRole('button', { name: 'Discard' }));
    await u.click(await screen.findByRole('button', { name: 'Respond' }));
    dialog = await respondDialog();
    expect(await within(dialog).findByLabelText('Your explanation')).toHaveValue('');
  });
});
