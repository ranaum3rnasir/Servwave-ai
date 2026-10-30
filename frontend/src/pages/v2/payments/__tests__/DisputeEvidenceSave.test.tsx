import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';

import {
  DISPUTE_ID, apiError, file, makeEvidence, mockApi, saved, serveDispute,
} from './disputeFixtures';
import { openForm, row } from './disputeHarness';

vi.mock('@/lib/attachments/uploadAttachment', () => ({ uploadAttachment: vi.fn() }));

const URL_EVIDENCE = `/api/payments-page/disputes/${DISPUTE_ID}/evidence`;
const type = (dialog: HTMLElement, label: string, value: string) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.put.mockReset();
  mockApi.post.mockReset();
});

describe('Save draft', () => {
  it('sends every file slot and text field with the version it was loaded at', async () => {
    serveDispute({ evidence: makeEvidence({ form: { version: 3, files: { receipt: file('a1', 'receipt.pdf', { size_bytes: 120_000, page_count: 2 }) } } }) });
    mockApi.put.mockResolvedValue({ data: saved(makeEvidence({ form: { version: 4 } })) });
    const { u, dialog } = await openForm();
    type(dialog, 'Your explanation', 'The work was done and signed off.');
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(1));
    expect(mockApi.put.mock.calls[0]![0]).toBe(URL_EVIDENCE);
    expect(mockApi.put.mock.calls[0]![1]).toEqual({
      version: 3,
      files: {
        receipt: 'a1', customer_communication: null, customer_signature: null, service_documentation: null,
        cancellation_policy: null, refund_policy: null, uncategorized_file: null,
      },
      text: {
        uncategorized_text: 'The work was done and signed off.', product_description: '', service_date: '2026-09-30',
        customer_name: 'Dana Whitfield', customer_email_address: 'dana@example.test',
      },
    });
  });

  it('says Saved and updates the meter with the pages the server counted', async () => {
    serveDispute({ evidence: makeEvidence({ form: { files: { receipt: file('a1', 'receipt.pdf', { size_bytes: 1_000_000, page_count: null }) } } }) });
    mockApi.put.mockResolvedValue({
      data: saved(makeEvidence({
        form: { version: 1, files: { receipt: file('a1', 'receipt.pdf', { size_bytes: 1_000_000, page_count: 4 }) } },
        totals: { bytes: 1_000_000, pages: 4, chars: 0 }, can_submit: true,
      })),
    });
    const { u, dialog } = await openForm();
    expect(within(dialog).queryByText(/pages/)).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    expect(await within(dialog).findByText('1.0 MB of 4.5 MB · 4 of 49 pages')).toBeInTheDocument();
    expect(within(dialog).getByText('Saved')).toBeInTheDocument();
  });

  it('shows a warning when the draft was saved with nothing in it, and keeps Submit off', async () => {
    serveDispute();
    mockApi.put.mockResolvedValue({ data: saved(makeEvidence({ form: { version: 1 } }), { warnings: ['empty'] }) });
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    expect(await within(dialog).findByText('Saved, but there is nothing in it yet. Add a file or write an explanation.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Submit evidence' })).toBeDisabled();
  });
});

describe('errors from a save', () => {
  it('focuses and marks the file row the server names, with its message beside it', async () => {
    serveDispute({ evidence: makeEvidence({ form: { files: { receipt: file('a1', 'receipt.pdf') } } }) });
    mockApi.put.mockRejectedValue(apiError(400, { error: 'The files total 4.7 MB. The limit is 4.5 MB for all files together.', field: 'receipt' }));
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    const message = await within(row(dialog, 'Receipt')).findByText('The files total 4.7 MB. The limit is 4.5 MB for all files together.');
    expect(message).toBeInTheDocument();
    const control = within(row(dialog, 'Receipt')).getByRole('button', { name: 'Replace' });
    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control).toHaveFocus();
  });

  it('focuses and marks a text field the server names', async () => {
    serveDispute();
    mockApi.put.mockRejectedValue(apiError(400, { error: 'Your explanation is too long.', field: 'uncategorized_text' }));
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    const box = within(dialog).getByLabelText('Your explanation');
    await waitFor(() => expect(box).toHaveFocus());
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText('Your explanation is too long.')).toBeInTheDocument();
  });

  it('adds a summary at the top for several errors, each line jumping to its field', async () => {
    serveDispute({ evidence: makeEvidence({ form: { files: { receipt: file('a1', 'receipt.pdf') } } }) });
    mockApi.put.mockRejectedValue(apiError(400, {
      error: 'There are 2 problems.',
      errors: [
        { error: 'This PDF can\'t be read. Save it again as a PDF and attach that.', field: 'receipt' },
        { error: 'Enter a valid email address.', field: 'customer_email_address' },
      ],
    }));
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    const summary = await within(dialog).findByRole('alert');
    expect(within(summary).getByText('2 things to fix')).toBeInTheDocument();
    await u.click(within(summary).getByRole('button', { name: /Enter a valid email address/ }));
    expect(within(dialog).getByLabelText('Customer email')).toHaveFocus();
    await u.click(within(summary).getByRole('button', { name: /This PDF can't be read/ }));
    expect(within(row(dialog, 'Receipt')).getByRole('button', { name: 'Replace' })).toHaveFocus();
  });

  it('answers a 409 with the reload message, and Reload reads the dispute again', async () => {
    let version = 2;
    serveDispute({ evidence: () => makeEvidence({ form: { version } }) });
    mockApi.put.mockRejectedValue(apiError(409, { error: 'Someone changed this evidence. Reload and try again.' }));
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    expect(await within(dialog).findByText('Someone changed this evidence. Reload to see it.')).toBeInTheDocument();
    const reads = () => mockApi.get.mock.calls.filter(([url]) => url === URL_EVIDENCE).length;
    const before = reads();
    version = 3;
    await u.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    await waitFor(() => expect(within(dialog).queryByText('Someone changed this evidence. Reload to see it.')).not.toBeInTheDocument());
  });
});

describe('a save the processor refused after the draft was stored (B1)', () => {
  const refusal = (status: number, version: number, over: Record<string, unknown> = {}, form: Parameters<typeof makeEvidence>[0] = {}) =>
    apiError(status, {
      ...makeEvidence({ ...form, form: { version, ...form.form } }), staged: false, sent: false, draft_saved: true,
      error: 'The card network could not accept the evidence. Try again in a moment.', ...over,
    });

  it('takes the new version from a 502 body, so the retry does not meet the own-save 409', async () => {
    serveDispute({ evidence: makeEvidence({ form: { version: 3 } }) });
    mockApi.put
      .mockRejectedValueOnce(refusal(502, 4))
      .mockResolvedValueOnce({ data: saved(makeEvidence({ form: { version: 5 } })) });
    const { u, dialog } = await openForm();
    type(dialog, 'Your explanation', 'The work was done.');
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    expect(await within(dialog).findByText('The card network could not accept the evidence. Try again in a moment.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(2));
    expect(mockApi.put.mock.calls[0]![1]).toMatchObject({ version: 3 });
    expect(mockApi.put.mock.calls[1]![1]).toMatchObject({ version: 4, text: { uncategorized_text: 'The work was done.' } });
  });

  it('treats a 409 that stored the draft the same way: no reload prompt, the body\'s version for the retry', async () => {
    serveDispute({ evidence: makeEvidence({ form: { version: 3 } }) });
    mockApi.put
      .mockRejectedValueOnce(refusal(409, 4, { error: 'Someone changed this evidence. Reload and try again.' }))
      .mockResolvedValueOnce({ data: saved(makeEvidence({ form: { version: 5 } })) });
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    expect(await within(dialog).findByText(/Someone changed this evidence/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(mockApi.put).toHaveBeenCalledTimes(2));
    expect(mockApi.put.mock.calls[1]![1]).toMatchObject({ version: 4 });
  });

  it('marks the file row the processor refused, beside that row, and moves focus there', async () => {
    serveDispute({ evidence: makeEvidence({ form: { files: { receipt: file('a1', 'receipt.pdf') } } }) });
    mockApi.put.mockRejectedValue(refusal(502, 4, { error: 'The card network could not read one of the files.' }, {
      form: { files: { receipt: file('a1', 'receipt.pdf', { refused: true }) } },
    }));
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    const group = row(dialog, 'Receipt');
    expect(await within(group).findByText('The card network could not read one of the files.')).toBeInTheDocument();
    const control = within(group).getByRole('button', { name: 'Replace' });
    expect(control).toHaveAttribute('aria-invalid', 'true');
    await waitFor(() => expect(control).toHaveFocus());
  });

  it('shows the message beside the field the body names, and as the form error when it names none', async () => {
    serveDispute();
    mockApi.put.mockRejectedValueOnce(refusal(502, 4, { error: 'Your explanation could not be accepted.', field: 'uncategorized_text' }));
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    const box = within(dialog).getByLabelText('Your explanation');
    await waitFor(() => expect(box).toHaveFocus());
    expect(within(dialog).getByText('Your explanation could not be accepted.')).toBeInTheDocument();
    mockApi.put.mockRejectedValueOnce(refusal(502, 5, { error: 'Try again in a moment.' }));
    await u.click(within(dialog).getByRole('button', { name: 'Save draft' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Try again in a moment.');
    expect(mockApi.put.mock.calls[1]![1]).toMatchObject({ version: 4 });
  });
});

