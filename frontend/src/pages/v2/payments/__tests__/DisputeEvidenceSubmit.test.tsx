import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';

import { toast } from '@/ui-kit/components/ui/sonner';
import { paymentsPageKeys } from '@/lib/api/paymentsPage';

import {
  DISPUTE_ID, apiError, file, makeEvidence, mockApi, saved, serveDispute,
} from './disputeFixtures';
import { openForm } from './disputeHarness';

vi.mock('@/lib/attachments/uploadAttachment', () => ({ uploadAttachment: vi.fn() }));
vi.mock('@/ui-kit/components/ui/sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() }, Toaster: () => null }));

const URL_EVIDENCE = `/api/payments-page/disputes/${DISPUTE_ID}/evidence`;
const URL_SUBMIT = `${URL_EVIDENCE}/submit`;

/** A draft that was saved with a file and an explanation: ready to send. */
const ready = () => makeEvidence({
  can_submit: true,
  form: {
    version: 5,
    files: { receipt: file('a1', 'receipt.pdf') },
    text: {
      uncategorized_text: 'Done.', product_description: '', service_date: '2026-09-30',
      customer_name: 'Dana Whitfield', customer_email_address: 'dana@example.test',
    },
  },
});
const sent = () => makeEvidence({
  dispute: { status: 'UNDER_REVIEW' }, can_edit: false, can_submit: false,
  form: { version: 6, files: { receipt: file('a1', 'receipt.pdf') }, text: { uncategorized_text: 'Done.' } },
  submitted: { at: '2026-10-14T15:00:00.000Z', by_name: 'Maya Ortiz', count: 1, files: [{ field: 'receipt', file_name: 'receipt.pdf' }] },
});

const submitButton = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Submit evidence' });
const confirm = async (u: Awaited<ReturnType<typeof openForm>>['u'], dialog: HTMLElement) => {
  await u.click(submitButton(dialog));
  return screen.findByRole('dialog', { name: 'Submit evidence' });
};

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.put.mockReset();
  mockApi.post.mockReset();
  vi.mocked(toast.success).mockReset();
});

describe('Submit evidence', () => {
  it('stays disabled until the draft is saved with something in it and has no unsaved edits', async () => {
    serveDispute();
    mockApi.put.mockResolvedValue({ data: saved(makeEvidence({ can_submit: true, form: { version: 1, text: ready().form.text } })) });
    const { u, dialog } = await openForm();
    expect(submitButton(dialog)).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Your explanation'), { target: { value: 'Done.' } });
    expect(submitButton(dialog)).toBeDisabled();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(submitButton(dialog)).toBeEnabled());
    fireEvent.change(within(dialog).getByLabelText('Your explanation'), { target: { value: 'Done. And more.' } });
    expect(submitButton(dialog)).toBeDisabled();
  });

  it('asks first, naming the amount and the invoice', async () => {
    serveDispute({ evidence: ready() });
    const { u, dialog } = await openForm();
    const ask = await confirm(u, dialog);
    expect(within(ask).getByText('Send your evidence for $250.00 on invoice INV-1042 now? You cannot add more after you submit.')).toBeInTheDocument();
    expect(within(ask).getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(mockApi.post).not.toHaveBeenCalled();
  });

  it('sends one request on a double click, with the version', async () => {
    serveDispute({ evidence: ready() });
    mockApi.post.mockReturnValue(new Promise(() => {}));
    const { u, dialog } = await openForm();
    const ask = await confirm(u, dialog);
    const go = within(ask).getByRole('button', { name: 'Submit evidence' });
    fireEvent.click(go);
    fireEvent.click(go);
    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.post.mock.calls[0]![0]).toBe(URL_SUBMIT);
    expect(mockApi.post.mock.calls[0]![1]).toEqual({ version: 5 });
  });

  it('on success: toasts, shows the Submitted state and refreshes the payment views', async () => {
    let done = false;
    serveDispute({ evidence: () => (done ? sent() : ready()) });
    mockApi.post.mockImplementation((() => { done = true; return Promise.resolve({ data: sent() }); }) as never);
    const { u, dialog, queryClient } = await openForm();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const ask = await confirm(u, dialog);
    await u.click(within(ask).getByRole('button', { name: 'Submit evidence' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Evidence submitted. The dispute is under review'));
    expect(await screen.findByText('Evidence submitted Oct 14, 2026 by Maya Ortiz')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Submit evidence' })).not.toBeInTheDocument();
    expect(spy.mock.calls.some(([arg]) => JSON.stringify((arg as { queryKey?: unknown })?.queryKey) === JSON.stringify(paymentsPageKeys.all))).toBe(true);
    expect(screen.queryByRole('button', { name: /save draft|submit evidence/i })).not.toBeInTheDocument();
  });

  it('shows a failure inside the confirm and lets the person try again', async () => {
    serveDispute({ evidence: ready() });
    mockApi.post.mockRejectedValue(apiError(502, { error: 'We couldn\'t send this to the card network. Try again in a moment, or contact ServWave support.' }));
    const { u, dialog } = await openForm();
    const ask = await confirm(u, dialog);
    await u.click(within(ask).getByRole('button', { name: 'Submit evidence' }));
    expect(await within(ask).findByText(/We couldn't send this to the card network/)).toBeInTheDocument();
    expect(within(ask).getByRole('button', { name: 'Submit evidence' })).toBeEnabled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows "being checked" as a status, not a failure, and reads the dispute again', async () => {
    serveDispute({ evidence: ready() });
    mockApi.post.mockRejectedValue(apiError(502, { error: 'Whether the evidence reached the card network is being checked. Reload in a minute to see its state.' }));
    const { u, dialog } = await openForm();
    const reads = () => mockApi.get.mock.calls.filter(([url]) => url === URL_EVIDENCE).length;
    const before = reads();
    const ask = await confirm(u, dialog);
    await u.click(within(ask).getByRole('button', { name: 'Submit evidence' }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('Whether the evidence reached the card network is being checked.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    expect(screen.queryByRole('dialog', { name: 'Submit evidence' })).not.toBeInTheDocument();
  });

  it('puts focus back on the Submit button when the confirm is cancelled', async () => {
    serveDispute({ evidence: ready() });
    const { u, dialog } = await openForm();
    const ask = await confirm(u, dialog);
    await u.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Submit evidence' })).not.toBeInTheDocument());
    await waitFor(() => expect(submitButton(dialog)).toHaveFocus());
  });

  it('closes the confirm on Escape before it closes the drawer', async () => {
    serveDispute({ evidence: ready() });
    const { u, dialog, onClose } = await openForm();
    await confirm(u, dialog);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Submit evidence' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Add evidence' })).toBeInTheDocument();
  });
});

describe('leaving with unsaved edits', () => {
  it('asks first, and Keep editing leaves the form as it was', async () => {
    serveDispute();
    const { u, dialog, onClose } = await openForm();
    fireEvent.change(within(dialog).getByLabelText('Your explanation'), { target: { value: 'Half a thought' } });
    await u.keyboard('{Escape}');
    const ask = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    await u.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText('Your explanation')).toHaveValue('Half a thought');
  });

  it('Discard closes the drawer', async () => {
    serveDispute();
    const { u, dialog, onClose } = await openForm();
    fireEvent.change(within(dialog).getByLabelText('Your explanation'), { target: { value: 'Half a thought' } });
    await u.keyboard('{Escape}');
    const ask = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    await u.click(within(ask).getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes without asking when nothing was changed', async () => {
    serveDispute();
    const { u, onClose } = await openForm();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'Discard your changes?' })).not.toBeInTheDocument();
  });
});

describe('what the page never shows', () => {
  it('has no vendor word and no processor or file id in the text, and logs none to the console', async () => {
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    serveDispute({ evidence: ready() });
    const { u, dialog } = await openForm();
    await confirm(u, dialog);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/stripe|supabase|\bctm\b|calltracking|render\.com/i);
    expect(text).not.toMatch(/\b(du|dp|file|acct|pi|ch|re|po)_[A-Za-z0-9]+/);
    const logged = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(' '))).join('\n');
    expect(logged).not.toMatch(/stripe|supabase|\bctm\b|\b(du|dp|acct|pi|ch)_[A-Za-z0-9]+/i);
    spies.forEach((s) => s.mockRestore());
  });
});
