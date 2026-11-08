/**
 * useLineImageUpload — #2045. Routes an estimate line's "+" upload (ProductThumb's `onAddImage`,
 * wired in through LineItemRow) to the backend and invalidates the right queries.
 *
 * Called UNCONDITIONALLY by LineItemRow (hooks can't be conditional) — inert for a line that
 * isn't a linked estimate line: LineItemRow only ever passes the returned `onAddImage` down to
 * ProductThumb when the line has BOTH an `estimate_id` and a `price_book_item_id`, so a
 * Job/Invoice row's (or an ad-hoc line's) call here is simply never reached by a click, not a
 * runtime guard inside this hook.
 *
 * ONE destination: `fillPriceBookItemImage` — `POST /api/price-book/items/:id/image`, the narrow
 * endpoint that fills the CATALOG item's image (not a per-line photo). Invalidates the estimate,
 * the price-book list and the single item query so every surface (row, Price Book page) reflects
 * the fill.
 *
 * #2029 retired the per-line-item photo route this hook used to fall back to for an ad-hoc line
 * (Ran, directly: a line item's image is an attribute of the stock/price-book item, and that is
 * all). An ad-hoc line has no catalog item to fill, so it is now offered no "+" at all rather
 * than an upload with nowhere to land.
 *
 * The pick is normalised in the browser first — the same `normaliseImageForUpload` every scope
 * photo goes through (#2029). #2029 also puts the catalog image on the PDF, and pdfmake accepts
 * JPEG and PNG only (the backend's allowlist refuses the rest), so converting here is what lets a
 * salesperson's HEIC pick work at all on a phone.
 *
 * Errors surface through `toast` + `extractApiError` — the backend's de-branded refusal copy
 * (e.g. "This item already has an image.") and `ImageNormaliseError`'s own message are both
 * exactly what the user reads.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { fillPriceBookItemImage } from '@/lib/api/estimates';
import { normaliseImageForUpload } from '@/lib/image-normalise';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import type { InvoiceLineItem } from '@/lib/api/jobs';

export interface UseLineImageUploadResult {
  onAddImage: (file: File) => void;
  uploading: boolean;
}

export function useLineImageUpload(line: InvoiceLineItem): UseLineImageUploadResult {
  const queryClient = useQueryClient();
  const estimateId = line.estimate_id ?? null;
  const priceBookItemId = line.price_book_item_id;

  const mutation = useMutation({
    // Result type is `unknown` — the resolved `{ item }` shape is not consumed here; the hook
    // only reacts to success/failure.
    mutationFn: async (file: File): Promise<unknown> => {
      if (!estimateId) throw new Error('This line has no estimate to upload to.');
      if (!priceBookItemId) throw new Error('This line has no catalog item to fill.');
      const normalised = await normaliseImageForUpload(file);
      return fillPriceBookItemImage(priceBookItemId, normalised.file, estimateId);
    },
    onSuccess: () => {
      if (!estimateId) return;
      queryClient.invalidateQueries({ queryKey: ['estimate', estimateId] });
      if (priceBookItemId) {
        queryClient.invalidateQueries({ queryKey: ['price-book-items'] });
        queryClient.invalidateQueries({ queryKey: ['price-book-item', priceBookItemId] });
      }
    },
    onError: (err) => {
      toast({ title: extractApiError(err, 'Failed to upload image'), variant: 'destructive' });
    },
  });

  return {
    // `mutate`, not `mutateAsync` — the returned promise is fire-and-forget from a click handler;
    // `onError` above already routes every rejection to the toast, so nothing here should also
    // need to catch/await it (and mutateAsync's own rejection would otherwise go unhandled).
    onAddImage: (file: File) => mutation.mutate(file),
    uploading: mutation.isPending,
  };
}
