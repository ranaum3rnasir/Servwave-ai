/**
 * #2029 slice 2 — the upload path: normalise in the browser, warn before the cap.
 *
 * Every pick is converted and downscaled before it leaves the phone, so what reaches storage is
 * always a document-sized JPEG. The strip is where that happens, because it is the one place a
 * photo enters the system.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PhotoAttachmentStrip } from '@/components/estimates/photos/PhotoAttachmentStrip';

const { normalise } = vi.hoisted(() => ({ normalise: vi.fn() }));

vi.mock('@/lib/image-normalise', async () => {
  const actual = await vi.importActual<typeof import('@/lib/image-normalise')>('@/lib/image-normalise');
  return { ...actual, normaliseImageForUpload: normalise };
});

function pick(name: string, type: string, bytes = 1024): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

async function pickFile(file: File) {
  const user = userEvent.setup();
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, file);
}

beforeEach(() => {
  vi.clearAllMocks();
  normalise.mockImplementation(async (file: File) => ({
    file: new File([new Uint8Array(2048)], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' }),
    width: 480,
    height: 360,
  }));
});

function renderStrip(over: Record<string, unknown> = {}) {
  const onUpload = vi.fn().mockResolvedValue({});
  render(
    <PhotoAttachmentStrip
      photos={[]}
      canManage
      itemLabel="scope photo"
      onUpload={onUpload}
      onDelete={vi.fn()}
      {...over}
    />,
  );
  return { onUpload };
}

describe('picking a scope photo', () => {
  it('uploads the normalised JPEG, never the file the salesperson picked', async () => {
    const { onUpload } = renderStrip();

    await pickFile(pick('IMG_0421.HEIC', 'image/heic'));

    await waitFor(() => expect(onUpload).toHaveBeenCalled());
    const uploaded = onUpload.mock.calls[0][0] as File;
    expect(uploaded.type).toBe('image/jpeg');
    expect(uploaded.name).toBe('IMG_0421.jpg');
  });

  it('surfaces a clear message and uploads nothing when the file cannot be read', async () => {
    normalise.mockRejectedValue(new Error('That photo could not be read. Try a different file.'));
    const { onUpload } = renderStrip();

    await pickFile(pick('broken.jpg', 'image/jpeg'));

    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument();
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('offers HEIC in the picker — the phone has nothing else to give', () => {
    renderStrip();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.accept).toContain('image/heic');
  });
});

describe('approaching the photo cap', () => {
  it('warns without blocking once the count reaches the warning point', () => {
    renderStrip({ photoCount: 16, photoCap: 24 });

    expect(screen.getByRole('status')).toHaveTextContent(/16 of 24/);
    expect(document.querySelector('input[type="file"]')).not.toBeDisabled();
  });

  it('says nothing while the count is comfortably below it', () => {
    renderStrip({ photoCount: 3, photoCap: 24 });

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stops offering an upload once the cap is reached', () => {
    renderStrip({ photoCount: 24, photoCap: 24 });

    expect(screen.getByRole('status')).toHaveTextContent(/24 of 24/);
    expect(screen.queryByRole('button', { name: /scope photo/i })).not.toBeInTheDocument();
  });
});
