/**
 * #2047, OQ5 — Download inside `AttachmentLightbox`, and its wiring through `AttachmentsPanel`.
 *
 * A NEW file rather than an edit to `attachment-lightbox-delete.test.tsx` (one of this run's six
 * shipped suites, which must stay green and UNEDITED per the IMPLEMENT task instructions — R17's
 * suggestion to fold this into that file is not followed here for that reason). Mirrors that
 * file's own two-halves shape: the component half pins the additive guarantee (omitted `onDownload`
 * changes nothing), the panel half pins the caller wiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { AttachmentLightbox } from '@/components/ui/AttachmentLightbox';
import { AttachmentsPanel } from '@/components/crm/AttachmentsPanel';

const mockApi = vi.mocked(api);

const hoisted = vi.hoisted(() => ({ downloadAttachment: vi.fn() }));
vi.mock('@/lib/attachments/downloadAttachment', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attachments/downloadAttachment')>();
  return { ...actual, downloadAttachment: hoisted.downloadAttachment };
});

const ENTITY_ID = 'inv-1';

const IMAGE_ATTACHMENT = {
  id: 'att-image-1',
  file_name: 'site-photo.jpg',
  file_url: 'https://signed.example/site-photo.jpg',
  file_type: 'image/jpeg',
  file_size: 2048,
  display_name: 'Site photo',
  description: '',
  created_at: '2026-07-10T00:00:00.000Z',
  uploader: { id: 'u-1', first_name: 'Test', last_name: 'Admin' },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AttachmentLightbox — Download control', () => {
  it('renders no Download control when onDownload is omitted (additive guarantee)', () => {
    render(
      <AttachmentLightbox url="https://x.test/a.png" caption="A" onDelete={vi.fn()} onClose={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Attachment preview' });
    expect(within(dialog).queryByLabelText('Download attachment')).toBeNull();
    expect(within(dialog).getByLabelText('Delete attachment')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Close preview')).toBeInTheDocument();
  });

  it('adds Download to the corner cluster, left of Delete, left of Close, when supplied', () => {
    render(
      <AttachmentLightbox
        url="https://x.test/a.png"
        caption="A"
        onDownload={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Attachment preview' });
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Download attachment',
      'Delete attachment',
      'Close preview',
    ]);
  });

  it('clicking Download invokes onDownload and does not close the overlay', async () => {
    const onDownload = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachmentLightbox
        url="https://x.test/a.png"
        caption="A"
        onDownload={onDownload}
        onDelete={vi.fn()}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByLabelText('Download attachment'));

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Attachment preview' })).toBeInTheDocument();
  });

  it('renders Download alone when onDelete is omitted but onDownload is supplied', () => {
    render(
      <AttachmentLightbox url="https://x.test/a.png" caption="A" onDownload={vi.fn()} onClose={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Attachment preview' });
    expect(within(dialog).getByLabelText('Download attachment')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Delete attachment')).toBeNull();
  });
});

describe('AttachmentsPanel — wiring Download into the lightbox', () => {
  it('opens the lightbox on an image click and its Download calls the shared helper with the attachment', async () => {
    mockApi.get.mockResolvedValue({ data: { attachments: [IMAGE_ATTACHMENT] } });
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel entityType="INVOICE" entityId={ENTITY_ID} />);

    await user.click(await screen.findByAltText('Site photo'));
    const dialog = await screen.findByRole('dialog', { name: 'Attachment preview' });

    await user.click(within(dialog).getByLabelText('Download attachment'));

    expect(hoisted.downloadAttachment).toHaveBeenCalledTimes(1);
    expect(hoisted.downloadAttachment).toHaveBeenCalledWith(
      expect.objectContaining({ id: IMAGE_ATTACHMENT.id, file_url: IMAGE_ATTACHMENT.file_url }),
    );
    // Same overlay, still open.
    expect(screen.getByRole('dialog', { name: 'Attachment preview' })).toBeInTheDocument();
  });
});
