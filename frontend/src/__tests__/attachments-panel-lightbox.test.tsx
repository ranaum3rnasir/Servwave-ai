/**
 * AttachmentsPanel — image lightbox wiring (R7 estimate-parity tail). `AttachmentsPanel` had zero
 * test coverage before this change, so this file stays FOCUSED on the one behavioral change made:
 * clicking an image attachment now opens the shared `AttachmentLightbox` in-app instead of
 * navigating `target="_blank"` to the raw file URL. Non-image attachments and the existing video
 * branch (`VideoPreviewDialog`) are untouched and are not re-tested here.
 *
 * Mirrors `estimate-line-item-photos.test.tsx`'s convention: `@/lib/axios` is globally mocked in
 * `setup.ts`, `renderWithProviders` helper, lightbox assertions via
 * `screen.getByRole('dialog', { name: 'Attachment preview' })`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { AttachmentsPanel } from '@/components/crm/AttachmentsPanel';

const mockApi = vi.mocked(api);

const ENTITY_ID = 'est-1';

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

const PDF_ATTACHMENT = {
  id: 'att-pdf-1',
  file_name: 'permit.pdf',
  file_url: 'https://signed.example/permit.pdf',
  file_type: 'application/pdf',
  file_size: 4096,
  display_name: 'Permit',
  description: '',
  created_at: '2026-07-11T00:00:00.000Z',
  uploader: { id: 'u-1', first_name: 'Test', last_name: 'Admin' },
};

function mockAttachments(attachments: unknown[]) {
  mockApi.get.mockResolvedValue({ data: { attachments } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AttachmentsPanel — image attachment lightbox', () => {
  it('clicking an image attachment opens the lightbox showing its URL (not a new tab)', async () => {
    mockAttachments([IMAGE_ATTACHMENT]);
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel entityType="INVOICE" entityId={ENTITY_ID} />);

    const thumbnail = await screen.findByAltText('Site photo');
    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).not.toBeInTheDocument();

    await user.click(thumbnail);

    const dialog = await screen.findByRole('dialog', { name: 'Attachment preview' });
    expect(within(dialog).getByAltText('Site photo')).toHaveAttribute('src', IMAGE_ATTACHMENT.file_url);
    // Field-mapping: caption <- display_name, uploadedBy <- uploader.first/last_name.
    expect(within(dialog).getByText('Site photo')).toBeInTheDocument();
    expect(within(dialog).getByText(/Test Admin/)).toBeInTheDocument();
  });

  it('clicking a non-image attachment does not open the lightbox and preserves its link behavior', async () => {
    mockAttachments([PDF_ATTACHMENT]);
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel entityType="INVOICE" entityId={ENTITY_ID} />);

    const link = await screen.findByText('Permit');
    expect(link.closest('a')).toHaveAttribute('href', PDF_ATTACHMENT.file_url);
    expect(link.closest('a')).toHaveAttribute('target', '_blank');

    await user.click(link);

    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).not.toBeInTheDocument();
  });

  it('closes on backdrop click, Escape, and the explicit close button', async () => {
    mockAttachments([IMAGE_ATTACHMENT]);
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel entityType="INVOICE" entityId={ENTITY_ID} />);

    const thumbnail = await screen.findByAltText('Site photo');

    // Backdrop click closes.
    await user.click(thumbnail);
    expect(await screen.findByRole('dialog', { name: 'Attachment preview' })).toBeInTheDocument();
    await user.click(screen.getByRole('dialog', { name: 'Attachment preview' }));
    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).not.toBeInTheDocument();

    // Escape closes.
    await user.click(thumbnail);
    expect(await screen.findByRole('dialog', { name: 'Attachment preview' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).not.toBeInTheDocument(),
    );

    // Explicit close button closes.
    await user.click(thumbnail);
    const dialog = await screen.findByRole('dialog', { name: 'Attachment preview' });
    await user.click(within(dialog).getByLabelText('Close preview'));
    expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).not.toBeInTheDocument();
  });
});
