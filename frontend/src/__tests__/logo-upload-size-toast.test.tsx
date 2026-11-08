/**
 * LogoUpload's 2 MB client-side size guard, after the browser-dialog sweep.
 *
 * This path used to call `alert('File must be under 2 MB')`. It asks the user
 * nothing - there is no decision to make, only a fact to report - so it became a
 * `toast`, not a `ConfirmDialog`. See no-browser-dialogs.guard.test.ts.
 *
 * The behaviour worth protecting is the REJECTION, not the message: an oversized
 * file must never reach the upload mutation. A regression that dropped the toast
 * but kept the early return would be cosmetic; one that dropped the early return
 * would ship a doomed multipart request on every oversized pick.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mutate = vi.fn();
const toastSpy = vi.fn();

vi.mock('@/lib/api/organization', () => ({
  useUploadLogo: () => ({ mutate, isPending: false }),
}));

vi.mock('@/components/ui/use-toast', async () => {
  const actual = await vi.importActual<typeof import('@/components/ui/use-toast')>(
    '@/components/ui/use-toast',
  );
  return { ...actual, toast: (...args: unknown[]) => toastSpy(...args) };
});

import { LogoUpload } from '@/components/settings/LogoUpload';

function pick(sizeInBytes: number) {
  render(<LogoUpload />);
  const input = document.getElementById('logo-upload-input') as HTMLInputElement;
  const file = new File(['x'], 'logo.png', { type: 'image/png' });
  // File size is read-only, so define it rather than allocating a real 3 MB buffer.
  Object.defineProperty(file, 'size', { value: sizeInBytes });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('LogoUpload size guard', () => {
  beforeEach(() => {
    mutate.mockClear();
    toastSpy.mockClear();
  });

  it('rejects a file over 2 MB with a danger toast and never calls the mutation', () => {
    pick(3 * 1024 * 1024);

    expect(mutate).not.toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][0]).toMatchObject({
      title: 'That logo is too large',
      tone: 'danger',
    });
  });

  it('uploads a file under 2 MB without any toast', () => {
    pick(1024);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('accepts a file exactly at the 2 MB boundary', () => {
    // The guard is `> 2 MB`, so the boundary itself must pass - an off-by-one
    // flip to `>=` would silently reject a legitimate 2,097,152-byte logo.
    pick(2 * 1024 * 1024);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('does not reach for the browser alert', () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    pick(3 * 1024 * 1024);
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('renders the upload trigger', () => {
    render(<LogoUpload />);
    expect(screen.getByText('Upload Logo')).toBeInTheDocument();
  });
});
