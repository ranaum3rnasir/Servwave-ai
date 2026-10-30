/**
 * Regression coverage for the estimates raw-tag conversion batch (phase 11b/11d):
 *
 *  - Input primitive adoption: PhotoAttachmentStrip.tsx's hidden camera-upload field now renders
 *    through the shared Input primitive rather than a raw <input> - flagged by an earlier review on
 *    a sibling batch as a real gap (the tag swap typechecks either way; only a real render+interact
 *    test catches a wiring regression).
 *
 * The timeclock half of this file (the work-zone picker's FormField wiring) went with the work-zone
 * settings, which the clock-in location removal took out of the product.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhotoAttachmentStrip } from '@/components/estimates/photos/PhotoAttachmentStrip';
import type { EstimatePhoto } from '@/lib/api/estimates';

beforeEach(() => {
  vi.resetModules();
});

// The real normalise pipeline needs a canvas jsdom does not have; the identity stub keeps this
// file testing the Input adoption. The conversion itself is covered in lib/image-normalise.test.ts.
vi.mock('@/lib/image-normalise', async () => {
  const actual = await vi.importActual<typeof import('@/lib/image-normalise')>('@/lib/image-normalise');
  return { ...actual, normaliseImageForUpload: async (file: File) => ({ file, width: 480, height: 360 }) };
});

describe('PhotoAttachmentStrip - hidden file Input adoption', () => {
  const PHOTOS: EstimatePhoto[] = [];

  it('renders the hidden file Input and still triggers onUpload through the camera button', async () => {
    const user = userEvent.setup();
    const onUpload = vi.fn().mockResolvedValue(undefined);

    render(
      <PhotoAttachmentStrip
        photos={PHOTOS}
        canManage
        onUpload={onUpload}
        onDelete={vi.fn()}
        itemLabel="photo"
      />,
    );

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input).toHaveClass('hidden');

    const file = new File(['x'], 'site.jpg', { type: 'image/jpeg' });
    await user.upload(input, file);

    // #2029 — what is uploaded is the NORMALISED photo, not the file the salesperson picked. The
    // subject of this test is still the hidden Input triggering an upload at all.
    await waitFor(() => expect(onUpload).toHaveBeenCalled());
    expect((onUpload.mock.calls[0][0] as File).name).toBe('site.jpg');
  });

  it('read-only strip (canManage=false, with photos) disables the file Input and renders no camera trigger button', () => {
    const photos: EstimatePhoto[] = [
      {
        id: 'ph-1',
        url: 'https://example.com/a.jpg',
        mime_type: 'image/jpeg',
        caption: null,
        uploaded_by: null,
        uploaded_at: '2026-07-30T00:00:00Z',
      },
    ];
    render(
      <PhotoAttachmentStrip
        photos={photos}
        canManage={false}
        onUpload={vi.fn()}
        onDelete={vi.fn()}
        itemLabel="photo"
      />,
    );

    expect(screen.getByTitle('View photo')).toBeInTheDocument();
    expect(screen.queryByLabelText('Add photo')).toBeNull();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeDisabled();
  });
});
