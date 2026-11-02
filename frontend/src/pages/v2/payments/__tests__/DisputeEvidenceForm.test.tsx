import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';

import { DISPUTE_URL, DisputeStage } from './disputeHarness';
import {
  INVOICE_ID, file, invoiceFile, makeEvidence, mockApi, serveDispute, type InvoiceFile,
} from './disputeFixtures';

vi.mock('@/lib/attachments/uploadAttachment', () => ({ uploadAttachment: vi.fn() }));
const upload = vi.mocked(uploadAttachment);

// Edit invoices needs View invoices and See prices.
const CAN_UPLOAD = buildAbility([
  { action: 'update', subject: 'Invoice' },
  { action: 'read', subject: 'Invoice' },
  { action: 'read', subject: 'Prices' },
]);
const user = () => userEvent.setup();

async function openForm(ability = CAN_UPLOAD) {
  const u = user();
  renderWithProviders(<DisputeStage />, { ability, initialEntries: [DISPUTE_URL] });
  await u.click(await screen.findByRole('button', { name: 'Respond' }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByRole('group', { name: 'Receipt' });
  return { u, dialog };
}
const row = (dialog: HTMLElement, label: string) => within(dialog).getByRole('group', { name: label });
const pdf = (name = 'receipt.pdf', type = 'application/pdf') => new File(['%PDF-1.4 test'], name, { type });

beforeEach(() => {
  mockApi.get.mockReset();
  mockApi.put.mockReset();
  mockApi.post.mockReset();
  upload.mockReset();
});

describe('step 2: files', () => {
  it('lists one row per kind of document and marks only the recommended ones', async () => {
    serveDispute();
    const { dialog } = await openForm();
    const labels = within(dialog).getAllByRole('group').map((g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent);
    expect(labels).toEqual([
      'Receipt', 'Customer communication', 'Customer signature', 'Service documentation', 'Cancellation policy', 'Refund policy', 'Other documents',
    ]);
    expect(within(row(dialog, 'Receipt')).getByText('Recommended')).toBeInTheDocument();
    expect(within(row(dialog, 'Customer communication')).getByText('Recommended')).toBeInTheDocument();
    expect(within(row(dialog, 'Customer signature')).queryByText('Recommended')).not.toBeInTheDocument();
    expect(within(row(dialog, 'Refund policy')).queryByText('Recommended')).not.toBeInTheDocument();
  });

  it('gives an empty row Upload and Choose from invoice files, and a filled row its file with Replace and Remove', async () => {
    serveDispute({ evidence: makeEvidence({ form: { files: { receipt: file('a1', 'receipt.pdf', { size_bytes: 120_000, page_count: 2 }), customer_signature: null } } }) });
    const { dialog } = await openForm();
    const empty = row(dialog, 'Customer signature');
    expect(within(empty).getByRole('button', { name: 'Upload' })).toBeInTheDocument();
    expect(within(empty).getByRole('button', { name: 'Choose from invoice files' })).toBeInTheDocument();
    const filled = row(dialog, 'Receipt');
    expect(within(filled).getByText('receipt.pdf')).toBeInTheDocument();
    expect(within(filled).getByText('0.1 MB · PDF')).toBeInTheDocument();
    expect(within(filled).getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(within(filled).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(filled).queryByRole('button', { name: 'Upload' })).not.toBeInTheDocument();
  });

  it('shows one "?" at the top of the files with the must-know sentence', async () => {
    serveDispute();
    const { u, dialog } = await openForm();
    await u.click(within(dialog).getByRole('button', { name: /More about/ }));
    expect(await screen.findByText(/Combine documents of one kind into one file/)).toHaveTextContent(
      'Combine documents of one kind into one file (for example all emails in one PDF). One file per row. PDF, JPG or PNG, 4.5 MB for everything together.',
    );
  });

  it('uploads a file onto the dispute invoice and fills the row with it', async () => {
    let files: InvoiceFile[] = [];
    serveDispute({ files: () => files });
    upload.mockImplementation(async () => { files = [invoiceFile('att-9', 'receipt.pdf', { file_size: 90_000 })]; });
    const { dialog } = await openForm();
    const input = within(row(dialog, 'Receipt')).getByLabelText('Choose a file for Receipt', { selector: 'input' });
    const picked = pdf();
    fireEvent.change(input, { target: { files: [picked] } });
    await waitFor(() => expect(within(row(dialog, 'Receipt')).getByText('receipt.pdf')).toBeInTheDocument());
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toMatchObject({ entityType: 'invoice', entityId: INVOICE_ID, file: picked });
    expect(within(row(dialog, 'Receipt')).getByRole('button', { name: 'Replace' })).toBeInTheDocument();
  });

  it('hides Upload from a person without the attachment switch, leaving Choose', async () => {
    serveDispute();
    const { dialog } = await openForm(buildAbility([]));
    const empty = row(dialog, 'Receipt');
    expect(within(empty).queryByRole('button', { name: 'Upload' })).not.toBeInTheDocument();
    expect(within(empty).getByRole('button', { name: 'Choose from invoice files' })).toBeInTheDocument();
  });

  it('refuses a wrong type beside the row without uploading it', async () => {
    serveDispute();
    const { dialog } = await openForm();
    const input = within(row(dialog, 'Receipt')).getByLabelText('Choose a file for Receipt', { selector: 'input' });
    fireEvent.change(input, { target: { files: [new File(['x'], 'photo.heic', { type: 'image/heic' })] } });
    expect(await within(row(dialog, 'Receipt')).findByText('Evidence must be a PDF, JPG or PNG. Save it as a PDF and attach that.')).toBeInTheDocument();
    expect(upload).not.toHaveBeenCalled();
  });

  it('replaces a file and removes one', async () => {
    serveDispute({
      evidence: makeEvidence({ form: { files: { receipt: file('a1', 'receipt.pdf') } } }),
      files: [invoiceFile('a1', 'receipt.pdf'), invoiceFile('a2', 'new-receipt.pdf')],
    });
    const { u, dialog } = await openForm(buildAbility([]));
    await u.click(within(row(dialog, 'Receipt')).getByRole('button', { name: 'Replace' }));
    const picker = await screen.findByRole('dialog', { name: 'Choose from invoice files' });
    await u.click(await within(picker).findByRole('button', { name: /new-receipt/ }));
    await waitFor(() => expect(within(row(dialog, 'Receipt')).getByText('new-receipt.pdf')).toBeInTheDocument());
    await u.click(within(row(dialog, 'Receipt')).getByRole('button', { name: 'Remove' }));
    expect(within(row(dialog, 'Receipt')).queryByText('new-receipt.pdf')).not.toBeInTheDocument();
    expect(within(row(dialog, 'Receipt')).getByRole('button', { name: 'Choose from invoice files' })).toBeInTheDocument();
  });
});

describe('step 2: the invoice file picker', () => {
  const pick = async (dialog: HTMLElement, u: ReturnType<typeof user>, label = 'Receipt') => {
    await u.click(within(row(dialog, label)).getByRole('button', { name: 'Choose from invoice files' }));
    return screen.findByRole('dialog', { name: 'Choose from invoice files' });
  };

  it('lists only PDF, JPG and PNG files, with size, date and who uploaded each', async () => {
    serveDispute({
      files: [
        invoiceFile('f1', 'scope.pdf'),
        invoiceFile('f2', 'site.jpg', { file_type: 'image/jpeg', file_size: 2_000_000 }),
        invoiceFile('f3', 'site.png', { file_type: 'image/png' }),
        invoiceFile('f4', 'phone.heic', { file_type: 'image/heic' }),
        invoiceFile('f5', 'quote.docx', { file_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
        invoiceFile('f6', 'walkthrough.mp4', { file_type: 'video/mp4' }),
      ],
    });
    const { u, dialog } = await openForm();
    const picker = await pick(dialog, u);
    const items = await within(picker).findAllByRole('button', { name: /\.(pdf|jpg|png)/ });
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining('scope.pdf'), expect.stringContaining('site.jpg'), expect.stringContaining('site.png'),
    ]);
    expect(items[1]).toHaveTextContent('2.0 MB');
    expect(items[0]).toHaveTextContent('Oct 1, 2026');
    expect(items[0]).toHaveTextContent('Maya Ortiz');
    expect(within(picker).queryByText(/heic|docx|mp4/)).not.toBeInTheDocument();
    expect(within(picker).queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('adds a search box past 10 files and filters by it', async () => {
    serveDispute({ files: Array.from({ length: 14 }, (_, i) => invoiceFile(`f${i}`, i === 7 ? 'gate-photo.jpg' : `doc-${i}.pdf`, i === 7 ? { file_type: 'image/jpeg' } : {})) });
    const { u, dialog } = await openForm();
    const picker = await pick(dialog, u);
    const search = await within(picker).findByRole('searchbox', { name: 'Search files' });
    await u.type(search, 'gate');
    expect(within(picker).getAllByRole('button', { name: /\.(pdf|jpg)/ })).toHaveLength(1);
    expect(within(picker).getByRole('button', { name: /gate-photo/ })).toBeInTheDocument();
  });

  it('disables a file already used in another row and says where', async () => {
    serveDispute({
      evidence: makeEvidence({ form: { files: { receipt: file('f1', 'scope.pdf') } } }),
      files: [invoiceFile('f1', 'scope.pdf'), invoiceFile('f2', 'other.pdf')],
    });
    const { u, dialog } = await openForm();
    const picker = await pick(dialog, u, 'Customer signature');
    const used = await within(picker).findByRole('button', { name: /scope\.pdf/ });
    expect(used).toBeDisabled();
    expect(used).toHaveTextContent('Used in Receipt');
    expect(within(picker).getByRole('button', { name: /other\.pdf/ })).toBeEnabled();
  });

  it('says so when the invoice has no usable files', async () => {
    serveDispute({ files: [invoiceFile('f4', 'phone.heic', { file_type: 'image/heic' })] });
    const { u, dialog } = await openForm();
    const picker = await pick(dialog, u);
    expect(await within(picker).findByText('No PDF, JPG or PNG files on this invoice yet.')).toBeInTheDocument();
  });
});

describe('step 2: the explanation, details and meter', () => {
  it('prefills the customer name, email and service date from the defaults, with visible labels', async () => {
    serveDispute();
    const { dialog } = await openForm();
    expect(within(dialog).getByLabelText('Customer name')).toHaveValue('Dana Whitfield');
    expect(within(dialog).getByLabelText('Customer email')).toHaveValue('dana@example.test');
    expect(within(dialog).getByLabelText('Your explanation')).toHaveValue('');
    expect(within(dialog).getByLabelText('Product or service')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Service date')).toBeInTheDocument();
  });

  it('shows a character counter only past 90% of the limit', async () => {
    serveDispute({ evidence: makeEvidence({ limits: { max_bytes: 4_500_000, max_pages: 49, max_chars: 1000, types: [] } }) });
    const { dialog } = await openForm();
    const box = within(dialog).getByLabelText('Your explanation');
    // The prefilled name, email and date already count for 41 characters.
    fireEvent.change(box, { target: { value: 'a'.repeat(800) } });
    expect(within(dialog).queryByText(/characters/)).not.toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'a'.repeat(901) } });
    expect(await within(dialog).findByText('942 of 1,000 characters')).toBeInTheDocument();
  });

  it('shows the size of the chosen files against the limit, without pages before the first save', async () => {
    serveDispute({
      evidence: makeEvidence({}),
      files: [invoiceFile('f1', 'big.pdf', { file_size: 3_000_000 })],
    });
    const { u, dialog } = await openForm();
    expect(within(dialog).getByText('0.0 MB of 4.5 MB')).toBeInTheDocument();
    await u.click(within(row(dialog, 'Receipt')).getByRole('button', { name: 'Choose from invoice files' }));
    await u.click(await screen.findByRole('button', { name: /big\.pdf/ }));
    expect(await within(dialog).findByText('3.0 MB of 4.5 MB')).toBeInTheDocument();
    expect(within(dialog).queryByText(/pages/)).not.toBeInTheDocument();
  });

  it('shows pages from the server and turns danger over a limit, naming the fix', async () => {
    serveDispute({
      evidence: makeEvidence({
        form: { files: { receipt: file('a1', 'receipt.pdf', { size_bytes: 4_700_000, page_count: 3 }) } },
        totals: { bytes: 4_700_000, pages: 3, chars: 0 },
      }),
    });
    const { dialog } = await openForm();
    const meter = within(dialog).getByText(/4\.7 MB of 4\.5 MB/);
    expect(meter).toHaveTextContent('3 of 49 pages');
    expect(meter.closest('[data-tone]')).toHaveAttribute('data-tone', 'danger');
    expect(within(dialog).getByText('Over the 4.5 MB limit. Remove a file or save a smaller one.')).toBeInTheDocument();
  });
});
