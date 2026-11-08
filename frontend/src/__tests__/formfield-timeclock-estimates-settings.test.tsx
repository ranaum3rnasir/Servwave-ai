/**
 * Regression coverage for the timeclock/estimates/settings raw-tag conversion batch
 * (phase 11b/11d), two shapes:
 *
 *  - FormField adoption: StoreLocationPicker.tsx's "Service address" label sat above a
 *    single sibling control (StoreAddressSearch, which forwards its own `id` prop to an
 *    internal raw <input>) with htmlFor/id already hand-wired - the exact shape FormField
 *    exists to collapse into one generated/pinned id instead of two literals that can
 *    drift. This file pins the id-wiring contract per CLAUDE.md's TDD rule: a "renders
 *    without crashing" test would not catch a regression where the label and control
 *    drift apart, or where the FormField wrap silently breaks the field's own
 *    value/onChange.
 *
 *  - Input primitive adoption: StoreAddressSearch.tsx's combobox search field and
 *    PhotoAttachmentStrip.tsx's hidden camera-upload field now render through the shared
 *    Input primitive rather than a raw <input> - flagged by an earlier review on a sibling
 *    batch as a real gap (the tag swap typechecks either way; only a real render+interact
 *    test catches a wiring regression).
 *
 * Env stubbed empty (like StoreAddressSearch.test.tsx) so typing into the address field
 * never depends on whatever VITE_GOOGLE_MAPS_API_KEY happens to be set locally, and never
 * risks a real network call regardless.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhotoAttachmentStrip } from '@/components/estimates/photos/PhotoAttachmentStrip';
import type { EstimatePhoto } from '@/lib/api/estimates';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function renderPicker() {
  const { StoreLocationPicker } = await import('@/components/timeclock/StoreLocationPicker');
  const onChange = vi.fn();
  const value = { label: '', address: '', lat: 40.7128, lng: -74.006 };
  render(<StoreLocationPicker value={value} onChange={onChange} />);
  return { onChange };
}

describe('StoreLocationPicker - "Service address" FormField adoption', () => {
  it('wires one id from the "Service address" label to the StoreAddressSearch combobox, reachable by label', async () => {
    await renderPicker();

    const label = screen.getByText('Service address');
    const control = screen.getByLabelText('Service address');

    expect(label.tagName).toBe('LABEL');
    expect(control.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(control.id);
    expect(control).toHaveAttribute('role', 'combobox');
  });

  it('Service address still drives its own value/onChange after the wrap', async () => {
    const user = userEvent.setup();
    const { onChange } = await renderPicker();

    const control = screen.getByLabelText('Service address');
    await user.type(control, '4');

    // The harness re-renders from a fixed prop `value` (no state loop), so each
    // keystroke's onChange fires from the same base value - asserting the single
    // typed character round-trips is enough to prove the wrap didn't swallow it.
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ address: '4' }));
  });

  it('Store name (a wrapping-label site, left raw) still drives its own value/onChange alongside the FormField site', async () => {
    const user = userEvent.setup();
    const { onChange } = await renderPicker();

    const storeName = screen.getByPlaceholderText('e.g. Downtown HQ');
    await user.type(storeName, 'H');

    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ label: 'H' }));
  });
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
