/**
 * The catalog item dialog's picture goes to STORAGE, not into the record.
 *
 * It used to ride inline: `prepareImageUpload` produced a data URI, the dialog put it on the
 * payload, and `toPriceBookBody` posted it into the legacy `photo_url` column. The canonical
 * column — the one the public estimate page and the document renderer read — stayed empty, so the
 * picture the operator chose was invisible everywhere it mattered.
 *
 * `useUpsertItem` now saves the row first and then PUTs the picked file at the item-image
 * endpoint, whose response carries the public storage URL the canonical column now holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useUpsertCategory, useUpsertItem } from '@/lib/api/inventory';

const mockApi = vi.mocked(api);

const ITEM_ID = 'c1000000-0000-0000-0000-000000002184';
const STORAGE_URL =
  'https://test.supabase.co/storage/v1/object/public/org-assets/org/price-book-items/i/1-new.jpg';

function wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const pickedFile = () => new File([new Uint8Array([0xff, 0xd8, 0xff])], 'new.jpg', { type: 'image/jpeg' });

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.patch.mockResolvedValue({ data: { data: { id: ITEM_ID } } });
  mockApi.post.mockResolvedValue({ data: { data: { id: ITEM_ID } } });
  mockApi.put.mockResolvedValue({ data: { item: { id: ITEM_ID, image_url: STORAGE_URL } } });
});

describe('useUpsertItem — a picked item image is uploaded, never inlined', () => {
  it('PUTs the file at the item-image endpoint and answers with the canonical storage URL', async () => {
    const { result } = renderHook(() => useUpsertItem(), { wrapper });
    const file = pickedFile();

    const saved = await result.current.mutateAsync({ id: ITEM_ID, name: 'Widget', photoFile: file });

    expect(mockApi.put).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockApi.put.mock.calls[0] as [string, FormData, { headers: Record<string, string> }];
    expect(url).toBe(`/api/price-book/items/${ITEM_ID}/image`);
    expect(body).toBeInstanceOf(FormData);
    expect(body.get('file')).toBe(file);
    expect(config.headers['Content-Type']).toBe('multipart/form-data');
    expect((saved as { image_url?: string }).image_url).toBe(STORAGE_URL);
  });

  it('never sends the picture inline in the row body', async () => {
    const { result } = renderHook(() => useUpsertItem(), { wrapper });

    await result.current.mutateAsync({ id: ITEM_ID, name: 'Widget', photoFile: pickedFile() });

    const body = mockApi.patch.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.photo_url).toBeUndefined();
    expect(body.photoFile).toBeUndefined();
  });

  it('uploads against the id the CREATE just minted, so a brand-new item gets its picture too', async () => {
    const { result } = renderHook(() => useUpsertItem(), { wrapper });

    await result.current.mutateAsync({ name: 'Brand New', photoFile: pickedFile() });

    expect(mockApi.post).toHaveBeenCalledTimes(1);
    expect(mockApi.put.mock.calls[0]![0]).toBe(`/api/price-book/items/${ITEM_ID}/image`);
  });

  it('fails loudly when the upload fails — silence must never read as a saved picture', async () => {
    mockApi.put.mockRejectedValue(new Error('storage exploded'));
    const { result } = renderHook(() => useUpsertItem(), { wrapper });

    await expect(
      result.current.mutateAsync({ id: ITEM_ID, name: 'Widget', photoFile: pickedFile() }),
    ).rejects.toThrow();
  });

  it('does not touch the upload endpoint when no file was picked', async () => {
    const { result } = renderHook(() => useUpsertItem(), { wrapper });

    await result.current.mutateAsync({ id: ITEM_ID, name: 'Widget' });

    await waitFor(() => expect(mockApi.patch).toHaveBeenCalled());
    expect(mockApi.put).not.toHaveBeenCalled();
  });
});

/**
 * Only ITEM pictures moved. The brand, category and group dialogs share `prepareImageUpload` and
 * store their picture inline, and this slice deliberately did not migrate four entity types under
 * cover of one change.
 */
describe('the other catalog dialogs are untouched', () => {
  it('a category picture still rides inline in the row body, and never reaches an upload endpoint', async () => {
    mockApi.post.mockResolvedValue({ data: { data: { id: 'cat_1' } } });
    const { result } = renderHook(() => useUpsertCategory(), { wrapper });

    await result.current.mutateAsync({ name: 'Locks', photoUrl: 'data:image/webp;base64,AAAA' });

    const body = mockApi.post.mock.calls[0]![1] as Record<string, unknown>;
    expect(body.photo_url).toBe('data:image/webp;base64,AAAA');
    expect(mockApi.put).not.toHaveBeenCalled();
  });
});
