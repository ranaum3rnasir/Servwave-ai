/**
 * line-image-upload.test.tsx — #2045 × #2029. `useLineImageUpload` is the piece that decides what
 * a line's "+" click does and what it invalidates afterward:
 *
 *  - a linked line (`price_book_item_id` set) -> the narrow `POST /api/price-book/items/:id/image`
 *    (fills the CATALOG item's image), carrying the NORMALISED JPEG rather than the raw pick, then
 *    invalidates the estimate, the price-book list and the single item query;
 *  - an ad-hoc line (`price_book_item_id` null) -> nothing at all. #2029 retired the per-line-item
 *    photo route this hook used to fall back to, and an ad-hoc line has no catalog item to fill;
 *  - a refusal — from the server (e.g. the catalog item already has an image) or from the
 *    normaliser itself — surfaces through `toast` with that message (`extractApiError`), not a
 *    generic fallback.
 *
 * `@/lib/axios` is globally mocked (setup.ts) — spy on it directly, same convention as
 * job-items-editor.test.tsx / use-upsert-vendor-placeholder-id.test.tsx. The normaliser is stubbed
 * here (jsdom has no canvas); the conversion itself is covered in lib/image-normalise.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import api from '@/lib/axios';
import { useLineImageUpload } from '@/components/jobs/items/useLineImageUpload';
import type { InvoiceLineItem } from '@/lib/api/jobs';

const mockApi = vi.mocked(api);

const hoisted = vi.hoisted(() => ({ toast: vi.fn(), normalise: vi.fn() }));
vi.mock('@/components/ui/use-toast', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/use-toast')>();
  return { ...actual, toast: hoisted.toast };
});
vi.mock('@/lib/image-normalise', async () => {
  const actual = await vi.importActual<typeof import('@/lib/image-normalise')>('@/lib/image-normalise');
  return { ...actual, normaliseImageForUpload: hoisted.normalise };
});

const BASE_LINE_FIELDS = {
  sequence: 1,
  quantity: 1,
  unit_price: 100,
  unit_cost: null,
  markup_percent: null,
  is_taxable: true,
  line_total: 100,
  discount_type: null,
  discount_value: null,
  discount_amount: 0,
  item_type: 'MATERIAL' as const,
};

const LINKED_LINE: InvoiceLineItem = {
  ...BASE_LINE_FIELDS,
  id: 'line-2045-linked',
  description: 'Linked line',
  price_book_item_id: 'item-2045-linked',
  price_book_item: { image_url: null, photo_url: null },
  estimate_id: 'estimate-2045',
};

const ADHOC_LINE: InvoiceLineItem = {
  ...BASE_LINE_FIELDS,
  id: 'line-2045-adhoc',
  description: 'Ad hoc line',
  price_book_item_id: null,
  estimate_id: 'estimate-2045',
};

/** What the phone handed over. */
function makeFile() {
  return new File(['x'], 'IMG_0421.HEIC', { type: 'image/heic' });
}

/** What `normaliseImageForUpload` turns it into — the only thing that should ever be posted. */
function normalisedFile() {
  return new File(['jpeg'], 'IMG_0421.jpg', { type: 'image/jpeg' });
}

function renderUploadHook(line: InvoiceLineItem) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
  function wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  const { result } = renderHook(() => useLineImageUpload(line), { wrapper });
  return { result, invalidateSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.normalise.mockImplementation(async () => ({ file: normalisedFile(), width: 480, height: 320 }));
});

describe('useLineImageUpload — routing (#2045)', () => {
  it('a linked line posts the NORMALISED jpeg to the narrow price-book image endpoint with the item id + estimate_id, and invalidates the estimate/price-book queries', async () => {
    mockApi.post.mockResolvedValue({ data: { item: { id: 'item-2045-linked', image_url: 'https://cdn.example.com/x.png' } } });
    const { result, invalidateSpy } = renderUploadHook(LINKED_LINE);

    result.current.onAddImage(makeFile());

    await waitFor(() => expect(mockApi.post).toHaveBeenCalled());
    expect(mockApi.post.mock.calls[0][0]).toBe('/api/price-book/items/item-2045-linked/image');
    const form = mockApi.post.mock.calls[0][1] as FormData;
    expect(form.get('estimate_id')).toBe('estimate-2045');
    // The HEIC never leaves the device: what reaches the endpoint is the converted JPEG, which is
    // the only thing the backend allowlist accepts and the only thing pdfmake can draw (#2029).
    const posted = form.get('file') as File;
    expect(posted).toBeInstanceOf(File);
    expect(posted.type).toBe('image/jpeg');
    expect(posted.name).toBe('IMG_0421.jpg');

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['estimate', 'estimate-2045'] }));
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['price-book-items'] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['price-book-item', 'item-2045-linked'] });
  });

  it('an ad-hoc line has no catalog item to fill, so nothing is posted and nothing is invalidated (#2029 retired the per-line photo route)', async () => {
    const { result, invalidateSpy } = renderUploadHook(ADHOC_LINE);

    result.current.onAddImage(makeFile());

    await waitFor(() => expect(hoisted.toast).toHaveBeenCalled());
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(hoisted.normalise).not.toHaveBeenCalled();
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(hoisted.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'This line has no catalog item to fill.', variant: 'destructive' }),
    );
  });

  it("surfaces a refusal's server message through the toast (extractApiError), not a generic fallback", async () => {
    mockApi.post.mockRejectedValue({ response: { data: { error: 'This item already has an image.' } } });
    const { result } = renderUploadHook(LINKED_LINE);

    result.current.onAddImage(makeFile());

    await waitFor(() => expect(hoisted.toast).toHaveBeenCalled());
    expect(hoisted.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'This item already has an image.', variant: 'destructive' }),
    );
  });

  it("surfaces the normaliser's own refusal and never posts (#2029)", async () => {
    hoisted.normalise.mockRejectedValue(new Error('That photo is larger than 8MB. Pick a smaller one.'));
    const { result } = renderUploadHook(LINKED_LINE);

    result.current.onAddImage(makeFile());

    await waitFor(() => expect(hoisted.toast).toHaveBeenCalled());
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(hoisted.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'That photo is larger than 8MB. Pick a smaller one.', variant: 'destructive' }),
    );
  });
});
