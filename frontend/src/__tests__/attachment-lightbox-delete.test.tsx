/**
 * AttachmentLightbox delete control, and its wiring through `AttachmentsPanel`.
 *
 * The two halves test different contracts on purpose. The component half pins the ADDITIVE
 * guarantee: without `onDelete` the overlay renders exactly what it always rendered, which is what
 * keeps the non-attachment caller (`ProductThumb`, a price-book image) safe. The panel half pins
 * the CALLER contract the component deliberately does not own - confirm, and close only after the
 * request actually succeeds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { AttachmentLightbox } from '@/components/ui/AttachmentLightbox';
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** Answer the app's ConfirmDialog, which now stands where `window.confirm` used to. */
async function answerConfirm(user: ReturnType<typeof userEvent.setup>, answer: 'Delete' | 'Cancel') {
  await user.click(await screen.findByRole('button', { name: answer }));
}

describe('AttachmentLightbox - delete control', () => {
  it('renders no delete control when onDelete is omitted', () => {
    render(<AttachmentLightbox url="https://x.test/a.png" caption="A" onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Attachment preview' });
    expect(within(dialog).queryByLabelText('Delete attachment')).toBeNull();
    // The close affordance is untouched by the new cluster.
    expect(within(dialog).getByLabelText('Close preview')).toBeInTheDocument();
  });

  it('renders a delete control when onDelete is supplied, and invokes it on click', async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachmentLightbox url="https://x.test/a.png" caption="A" onDelete={onDelete} onClose={vi.fn()} />
    );

    await user.click(screen.getByLabelText('Delete attachment'));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('does not close itself on delete - the caller owns that', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <AttachmentLightbox url="https://x.test/a.png" caption="A" onDelete={vi.fn()} onClose={onClose} />
    );

    await user.click(screen.getByLabelText('Delete attachment'));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Attachment preview' })).toBeInTheDocument();
  });

  it('disables the delete control while a delete is in flight', () => {
    render(
      <AttachmentLightbox url="https://x.test/a.png" onDelete={vi.fn()} deleting onClose={vi.fn()} />
    );

    expect(screen.getByLabelText('Delete attachment')).toBeDisabled();
  });
});

describe('AttachmentsPanel - deleting from the lightbox', () => {
  /**
   * The queries below are scoped with `within(dialog)` deliberately: the attachment ROW has its
   * own trash button carrying the same `Delete attachment` title, so an unscoped query matches
   * two elements and would not prove the lightbox control is the one being exercised.
   */
  async function openLightbox() {
    mockApi.get.mockResolvedValue({ data: { attachments: [IMAGE_ATTACHMENT] } });
    const user = userEvent.setup();
    renderWithProviders(<AttachmentsPanel entityType="INVOICE" entityId={ENTITY_ID} />);
    await user.click(await screen.findByAltText('Site photo'));
    const dialog = await screen.findByRole('dialog', { name: 'Attachment preview' });
    return { user, dialog };
  }

  it('deletes the open attachment and closes the overlay', async () => {
    mockApi.delete.mockResolvedValue({ data: {} });
    const { user, dialog } = await openLightbox();

    await user.click(within(dialog).getByLabelText('Delete attachment'));
    await answerConfirm(user, 'Delete');

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledTimes(1));
    expect(mockApi.delete.mock.calls[0][0]).toBe(`/api/attachments/invoice/${ENTITY_ID}/att-image-1`);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Attachment preview' })).not.toBeInTheDocument()
    );
  });

  it('does nothing and stays open when the confirm is dismissed', async () => {
    const { user, dialog } = await openLightbox();

    await user.click(within(dialog).getByLabelText('Delete attachment'));
    await answerConfirm(user, 'Cancel');

    expect(mockApi.delete).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Attachment preview' })).toBeInTheDocument();
  });

  it('leaves the overlay open when the delete request fails', async () => {
    mockApi.delete.mockRejectedValue(new Error('boom'));
    const { user, dialog } = await openLightbox();

    await user.click(within(dialog).getByLabelText('Delete attachment'));
    await answerConfirm(user, 'Delete');

    await waitFor(() => expect(mockApi.delete).toHaveBeenCalledTimes(1));
    // A lightbox that closed optimistically would hide the failure behind a dismissed overlay.
    expect(screen.getByRole('dialog', { name: 'Attachment preview' })).toBeInTheDocument();
  });
});
