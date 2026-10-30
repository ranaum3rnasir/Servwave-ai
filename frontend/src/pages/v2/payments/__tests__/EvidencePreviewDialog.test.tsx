import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/__tests__/helpers';
import { downloadAttachment } from '@/lib/attachments/downloadAttachment';

import { DISPUTE_URL, DisputeStage } from './disputeHarness';
import { DISPUTE_ID, FILE_URL, apiError, file, makeEvidence, mockApi, serveDispute } from './disputeFixtures';

vi.mock('@/lib/attachments/downloadAttachment', () => ({ downloadAttachment: vi.fn(() => Promise.resolve()) }));

const download = vi.mocked(downloadAttachment);

const withFiles = () => makeEvidence({
  form: {
    files: {
      receipt: file('a1', 'receipt.pdf', { size_bytes: 90_000 }),
      customer_communication: file('a2', 'texts.png', { mime: 'image/png', size_bytes: 90_000 }),
      uncategorized_file: file('a3', 'agreement.pdf', { size_bytes: 90_000 }),
    },
  },
});

const fileCalls = () => mockApi.get.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/evidence/files/'));
const previewDialog = () => screen.findByRole('dialog', { name: /receipt\.pdf|texts\.png|agreement\.pdf/ });

async function openDrawer() {
  const u = userEvent.setup();
  renderWithProviders(<DisputeStage />, { initialEntries: [DISPUTE_URL] });
  const drawer = await screen.findByRole('dialog');
  await within(drawer).findByRole('button', { name: /texts\.png/ });
  return { u, drawer };
}

beforeEach(() => {
  mockApi.get.mockReset();
  download.mockClear();
});

describe('the evidence file preview', () => {
  it('opens on the clicked row, over the drawer, and asks only for that file\'s link', async () => {
    serveDispute({ evidence: withFiles() });
    const { u, drawer } = await openDrawer();
    expect(fileCalls()).toEqual([]);
    await u.click(within(drawer).getByRole('button', { name: /texts\.png/ }));
    const dialog = await previewDialog();
    expect(dialog).toHaveAccessibleName('texts.png');
    await within(dialog).findByRole('img', { name: 'texts.png' });
    expect(fileCalls()).toEqual([`/api/payments-page/disputes/${DISPUTE_ID}/evidence/files/a2`]);
    // The drawer is still there underneath.
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  });

  it('reads the type, size and place in the list, and Previous / Next step through the files', async () => {
    serveDispute({ evidence: withFiles() });
    const { u, drawer } = await openDrawer();
    await u.click(within(drawer).getByRole('button', { name: /receipt\.pdf/ }));
    const dialog = await previewDialog();
    expect(within(dialog).getByText('PDF, 90 KB · 1 of 3')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Previous' })).toBeDisabled();
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByText('Image, 90 KB · 2 of 3')).toBeInTheDocument();
    expect(dialog).toHaveAccessibleName('texts.png');
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByText('PDF, 90 KB · 3 of 3')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Previous' })).toBeEnabled();
  });

  it('draws an image as a picture and a PDF as an embedded document with a plain fallback line', async () => {
    serveDispute({ evidence: withFiles() });
    const { u, drawer } = await openDrawer();
    await u.click(within(drawer).getByRole('button', { name: /texts\.png/ }));
    const dialog = await previewDialog();
    expect(await within(dialog).findByRole('img', { name: 'texts.png' })).toHaveAttribute('src', `${FILE_URL}/a2`);
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(dialog.querySelector('object[type="application/pdf"]')).not.toBeNull());
    expect(dialog.querySelector('object')).toHaveAttribute('data', `${FILE_URL}/a3`);
    expect(within(dialog).getByText('This file can’t be shown here. Use Download to open it.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('img')).not.toBeInTheDocument();
  });

  it('Download hands the link to the one save helper, with a way to ask for a fresh link', async () => {
    serveDispute({ evidence: withFiles() });
    const { u, drawer } = await openDrawer();
    await u.click(within(drawer).getByRole('button', { name: /receipt\.pdf/ }));
    const dialog = await previewDialog();
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Download' })).toBeEnabled());
    await u.click(within(dialog).getByRole('button', { name: 'Download' }));
    expect(download).toHaveBeenCalledTimes(1);
    const [input, options] = download.mock.calls[0]!;
    expect(input).toMatchObject({ id: 'a1', file_url: `${FILE_URL}/a1`, file_name: 'receipt.pdf', display_name: 'receipt.pdf' });
    await expect(options!.refresh!()).resolves.toBe(`${FILE_URL}/a1`);
  });

  it('shows the load error, with its own try-again, when the link cannot be had', async () => {
    serveDispute({ evidence: withFiles(), link: () => Promise.reject(apiError(404, { error: 'File not found' })) });
    const { u, drawer } = await openDrawer();
    await u.click(within(drawer).getByRole('button', { name: /receipt\.pdf/ }));
    const dialog = await previewDialog();
    expect(await within(dialog).findByText('Couldn’t open this file.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Download' })).toBeDisabled();
  });

  it('Escape closes only the preview, and focus returns to the row that opened it', async () => {
    serveDispute({ evidence: withFiles() });
    const { u, drawer } = await openDrawer();
    const row = within(drawer).getByRole('button', { name: /texts\.png/ });
    await u.click(row);
    await previewDialog();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1));
    expect(screen.getByRole('dialog')).toBe(drawer);
    await waitFor(() => expect(row).toHaveFocus());
  });

  it('Close closes it and the next open starts on the file clicked, not where Next left it', async () => {
    serveDispute({ evidence: withFiles() });
    const { u, drawer } = await openDrawer();
    await u.click(within(drawer).getByRole('button', { name: /receipt\.pdf/ }));
    let dialog = await previewDialog();
    await u.click(within(dialog).getByRole('button', { name: 'Next' }));
    await u.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1));
    await u.click(within(drawer).getByRole('button', { name: /receipt\.pdf/ }));
    dialog = await previewDialog();
    expect(within(dialog).getByText('PDF, 90 KB · 1 of 3')).toBeInTheDocument();
  });

  it('keeps Tab inside the preview while it is open, in the order Previous, Next, Download, Close', async () => {
    serveDispute({ evidence: withFiles() });
    const { u, drawer } = await openDrawer();
    await u.click(within(drawer).getByRole('button', { name: /texts\.png/ }));
    const dialog = await previewDialog();
    await within(dialog).findByRole('img');
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      await u.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
      seen.push(document.activeElement!.textContent ?? '');
    }
    const names = ['Previous', 'Next', 'Download', 'Close'];
    expect(seen.filter((t) => names.includes(t)).slice(0, 4)).toEqual(expect.arrayContaining(names));
    const order = seen.filter((t) => names.includes(t));
    expect(order.indexOf('Next')).toBeLessThan(order.indexOf('Download'));
    expect(order.indexOf('Download')).toBeLessThan(order.indexOf('Close'));
  });

  it('opens a submitted file by its attachment id', async () => {
    serveDispute({
      evidence: makeEvidence({
        dispute: { status: 'UNDER_REVIEW' }, can_edit: false,
        form: { files: { receipt: file('a1', 'receipt.pdf', { size_bytes: 90_000 }) } },
        submitted: { at: '2026-10-12T15:00:00.000Z', by_name: 'Maya Ortiz', count: 1, files: [{ field: 'receipt', file_name: 'receipt.pdf', attachment_id: 'a1' }] },
      }),
    });
    const u = userEvent.setup();
    renderWithProviders(<DisputeStage />, { initialEntries: [DISPUTE_URL] });
    await u.click(await screen.findByRole('button', { name: /receipt\.pdf/ }));
    await previewDialog();
    await waitFor(() => expect(fileCalls()).toEqual([`/api/payments-page/disputes/${DISPUTE_ID}/evidence/files/a1`]));
  });

  it('takes the embedded PDF out of the Tab order, so Tab wraps through the buttons', async () => {
    serveDispute({ evidence: withFiles() });
    const { u, drawer } = await openDrawer();
    await u.click(within(drawer).getByRole('button', { name: /receipt\.pdf/ }));
    const dialog = await previewDialog();
    await waitFor(() => expect(dialog.querySelector('object')).not.toBeNull());
    expect(dialog.querySelector('object')).toHaveAttribute('tabindex', '-1');
  });
});
