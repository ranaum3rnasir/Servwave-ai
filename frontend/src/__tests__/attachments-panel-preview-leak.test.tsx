/**
 * AttachmentsPanel — the image preview's object URL must always be released (#33).
 *
 * The original code created `previewUrl` as a per-call local and revoked it in a `finally`,
 * so every pick released its own URL no matter how the upload ended. The S5 queue rewrite
 * moved it to a single ref revoked only in `onSettled`, which leaks in two reachable ways:
 *
 *   - a SECOND pick while the first is still in flight overwrites the ref, and the first
 *     URL can never be reached again (the Upload control is not disabled during an upload);
 *   - an UNMOUNT before the transport resolves never runs the settle at all.
 *
 * Each URL pins its Blob in memory for the lifetime of the document, so on a dispatcher's
 * long-lived tab this is an unbounded leak of whole image files.
 *
 * These assert the INVARIANT (every created URL is revoked) rather than a call count, so they
 * stay honest if the implementation changes shape again.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitFor, fireEvent } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { AttachmentsPanel } from '@/components/crm/AttachmentsPanel';

const mockApi = vi.mocked(api);

let created: string[] = [];
let revoked: string[] = [];
let seq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  created = [];
  revoked = [];
  seq = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
    const url = `blob:preview-${++seq}`;
    created.push(url);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
  });
  mockApi.get.mockResolvedValue({ data: { attachments: [] } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Anything created and not revoked is still pinning a Blob. */
function leaked(): string[] {
  return created.filter((u) => !revoked.includes(u));
}

function imageFile(name: string): File {
  return new File(['x'], name, { type: 'image/jpeg' });
}

async function pick(container: HTMLElement, file: File) {
  let input: HTMLInputElement | undefined;
  await waitFor(() => {
    input = container.querySelector<HTMLInputElement>('input[type="file"]') ?? undefined;
    expect(input).toBeDefined();
  });
  fireEvent.change(input!, { target: { files: [file] } });
}

describe('AttachmentsPanel image preview object URLs', () => {
  it('releases the first preview when a second file is picked mid-upload', async () => {
    mockApi.post.mockImplementation(() => new Promise(() => {}));
    const { container } = renderWithProviders(
      <AttachmentsPanel entityType="CUSTOMER" entityId="c-1" />
    );

    await pick(container, imageFile('one.jpg'));
    await waitFor(() => expect(created.length).toBe(1));

    await pick(container, imageFile('two.jpg'));
    await waitFor(() => expect(created.length).toBe(2));

    // The first URL is unreachable from here on; it must already be released.
    expect(leaked()).toEqual(['blob:preview-2']);
  });

  it('releases the preview when the panel unmounts before the upload resolves', async () => {
    mockApi.post.mockImplementation(() => new Promise(() => {}));
    const { container, unmount } = renderWithProviders(
      <AttachmentsPanel entityType="CUSTOMER" entityId="c-1" />
    );

    await pick(container, imageFile('one.jpg'));
    await waitFor(() => expect(created.length).toBe(1));

    unmount();

    expect(leaked()).toEqual([]);
  });

  it('releases the preview on the ordinary success path', async () => {
    mockApi.post.mockResolvedValue({ data: {} });
    const { container } = renderWithProviders(
      <AttachmentsPanel entityType="CUSTOMER" entityId="c-1" />
    );

    await pick(container, imageFile('one.jpg'));
    await waitFor(() => expect(created.length).toBe(1));
    await waitFor(() => expect(leaked()).toEqual([]));
  });

  it('releases the preview when the upload fails', async () => {
    mockApi.post.mockRejectedValue(new Error('nope'));
    const { container } = renderWithProviders(
      <AttachmentsPanel entityType="CUSTOMER" entityId="c-1" />
    );

    await pick(container, imageFile('one.jpg'));
    await waitFor(() => expect(created.length).toBe(1));
    await waitFor(() => expect(leaked()).toEqual([]));
  });
});
