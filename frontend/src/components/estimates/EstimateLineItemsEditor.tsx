/**
 * EstimateLineItemsEditor + EstimateScopeOfWorkCard — the Estimate workspace's wrappers around the
 * shared `<LineItemsTable>`/`<ScopeOfWorkCard>` (v12 unified line-items, plan §4 Estimate — "the
 * big migration"). Mirrors `InvoiceLineItemsEditor.tsx`'s/`LineItemsEditor.tsx`'s (Job) own wrapper
 * pattern: this file owns no presentation, only the granular-endpoint data/mutation wiring the
 * shared components are driven by.
 *
 * Every mutation (add/update/delete/reorder — lines AND scopes) returns the WHOLE updated estimate
 * as `{ estimate }` (`lib/api/estimates.ts`'s own header comment) — Invoice's envelope convention,
 * not Job's. So there is no separate `['estimate-lines', id]`/`['estimate-scopes', id]` query the
 * way Job needs one: both wrappers read `line_items`/`scopes` straight off the SAME
 * `['estimate', id]` query the page already owns (passed down as the `estimate` prop), and every
 * mutation's `onSuccess` writes that one cache entry, refreshing line items, scopes, AND totals
 * (`EstimateReceiptCard`/`InternalCostsCard`) at once.
 *
 * SRVW-103 - that write MERGES the response onto the cached entry rather than replacing it. Both
 * payloads resolve from the same `estimateDetailSelect` top-level key set, so the merge is
 * byte-identical to a replace for every key the mutation returns; what it additionally preserves
 * is a read-only field hydrated by GET /api/estimates/:id but absent from the granular responses
 * (today: `tags`). A replace silently erased the tag chips on the first line/scope/discount/cost
 * edit. If a future handler ever returns a deliberately NARROWER estimate payload on this key, the
 * merge would keep stale keys where a replace would have dropped them - narrow the write then.
 *
 * RBAC: the backend gates every granular line/scope mutation on a SINGLE ability, `update Estimate`
 * (no manage_lines split — Estimate mirrors Job's precedent here, not Invoice's; see Wave 1's
 * `estimate-lines.controller.ts`). `canManage` (the page's lock/terminal policy ANDed with that
 * grant) drives every add/edit/delete/reorder affordance on both cards alike.
 *
 * The existing, real AI image panel (`AiImagePanel`/`getAiImageSuggestions`) drops into
 * `<AddLineDialog>`'s `extraCreateContent` slot, CREATE mode only (no home in the edit form — the
 * shared modal's own contract). `EstimateLineItem` has no persisted `image_url` column at all (checked
 * schema.prisma — a line's only image comes from a linked `price_book_item`), so an AI-picked
 * image for a brand-new line was ALREADY client-only/session-only pre-migration (the old page's
 * own `runSave()` never sent `image_url` in its PATCH body) — this wrapper preserves that exact
 * pre-existing limitation (a local id→url overlay, never submitted to the backend) rather than
 * inventing a new one.
 *
 * v12's table has no per-line Discount column anywhere (plan §3) — `showDiscount={false}` here,
 * ahead of Job (already false) and Invoice (not yet migrated off it), since this is the reference
 * slice. `EstimateLineItem`'s granular endpoints still accept `discount_type`/`discount_value`
 * server-side; only the per-row UI column is dropped.
 *
 * "One door" rule (DDR §2b): the header's two buttons (outlined "Price Book", sage "Add item")
 * and the picker's own "Add new item" card all open the exact SAME `<AddLineDialog>` instance —
 * this file renders its OWN copy (not the one `<LineItemsTable>` embeds internally) so that copy
 * can carry `extraCreateContent`/`initialQuery`, which `<LineItemsTable>`'s
 * built-in instance has no props for. `<LineItemsTable>` is still handed `addOpen`/`editingLine`
 * (always literally closed) plus `onAddOpenChange`/`onEditingLineChange` — its own empty-state "add
 * the first line" CTA and each row's pencil-edit button still work, they just redirect into THIS
 * file's own open state instead of `<LineItemsTable>`'s internal one, so every entry point lands on
 * the one dialog with the full estimate-only feature set.
 */
import { useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, BookOpen, Sparkles, Image as ImageIcon, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { LineItemsTable } from '@/components/jobs/items/LineItemsTable';
import { AddLineDialog } from '@/components/jobs/items/AddLineDialog';
import { ScopeOfWorkCard, type ScopeDraft } from '@/components/jobs/items/ScopeOfWorkCard';
import {
  PriceBookPicker,
  type PriceBookPickerHandle,
  type PriceBookSelection,
  type PriceBookGroup,
} from '@/components/jobs/items/PriceBookPicker';
import type { AddLineItemPayload, UpdateLineItemPayload } from '@/lib/api/invoices';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';
import {
  addEstimateLine,
  updateEstimateLine,
  deleteEstimateLine,
  reorderEstimateLines,
  addEstimateScope,
  updateEstimateScope,
  deleteEstimateScope,
  reorderEstimateScopes,
  createScopePreset,
  type EstimateLineItem,
  type EstimateScopePhoto,
} from '@/lib/api/estimates';
import { ScopePhotoStrip } from '@/components/estimates/photos/ScopePhotoStrip';
import { AiImagePanel } from '@/features/estimate-workspace/components/AiImagePanel';
import { ScopePresetPicker, type ScopePreset } from '@/features/estimate-workspace/components/ScopePresetPicker';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { areSelectionsLocked } from '@/lib/estimates/selectionLock';

/**
 * Runtime-only widening — mirrors `AddLineDialog.tsx`'s own local `LineUpdatePatch`.
 * #2053 slice 1 — is_optional/is_selected added so this file's own `onAdd`/`onUpdate` handlers
 * (which reconstruct the wire body field-by-field for `addEstimateLine`/`updateEstimateLine`) can
 * read them.
 */
type EstimateAddDraft = AddLineItemPayload & { is_optional?: boolean; is_selected?: boolean };
type EstimateUpdateDraft = UpdateLineItemPayload & { description?: string; is_optional?: boolean; is_selected?: boolean };

/**
 * Normalizes `EstimateLineItem[]` into the `InvoiceLineItem[]` shape `<LineItemsTable>`/
 * `<InternalCostsCard>` expect. The only real difference: `price_book_item` here carries no
 * `photo_url` (estimateDetailSelect's nested select omits it) — falls back to `image_url` for
 * both, matching `LineItemRow`'s own `image_url ?? photo_url` fallback chain. This is what feeds
 * the 40px thumb at the head of each row's Item cell. `clientImageOverrides` layers in a
 * session-only AI-picked image for a freshly-created line (file header) without mutating the
 * server-shaped object. Cast (not a literal-typed return) deliberately — the object legitimately
 * carries extra Estimate-only keys (`estimate_id`, …) at runtime that `InvoiceLineItem` doesn't
 * declare.
 *
 * #2045 round 2 — `estimate_id` is declared on the `EstimateLineItem` type but is NOT actually
 * selected per-line by `estimateDetailSelect` (`backend/src/controllers/estimate.controller.ts`'s
 * `line_items.select`), so `...line` alone never carries it at runtime; `LineItemRow`'s "+"
 * upload affordance keys off `!!line.estimate_id` (spec R10) to tell an Estimate line apart from
 * a Job/Invoice one, so without a stamp here it silently never rendered on a real page (verified
 * live: every line in `GET /api/estimates/:id` has 16 keys, none is `estimate_id`). Widening the
 * backend select would land inside #2041/#2053's own `line_items.select` hunk (adding
 * `is_optional`/`is_selected` at that exact spot on `staging`), so this stamps it here instead —
 * additive only (`line.estimate_id ?? estimateId`), never overriding a caller that already has it
 * (e.g. the frozen test's own fixtures, and `estimateLinesToInvoiceShape`'s callers below, whose
 * signature stays unchanged).
 */
function toInvoiceLineShape(
  line: EstimateLineItem,
  clientImageOverrides: Record<string, string>,
  estimateId?: string,
): InvoiceLineItem {
  const overrideUrl = clientImageOverrides[line.id];
  const imageUrl = overrideUrl ?? line.price_book_item?.image_url ?? null;
  return {
    ...line,
    estimate_id: line.estimate_id ?? estimateId ?? null,
    price_book_item: line.price_book_item || overrideUrl ? { image_url: imageUrl, photo_url: imageUrl } : null,
  } as unknown as InvoiceLineItem;
}

/**
 * Same normalization as `toInvoiceLineShape`, without a client-image-override map — for callers
 * that only need the `InvoiceLineItem[]` shape (e.g. the page's `<InternalCostsCard>`, which never
 * renders an image), not the session-only AI-picked-image overlay this file's own table uses.
 * Signature unchanged (#2045 round 2) — a caller that doesn't have an estimate id handy still
 * gets whatever `line.estimate_id` itself carries (nothing, from the real API today; whatever a
 * test fixture set, in a test).
 */
export function estimateLinesToInvoiceShape(lines: EstimateLineItem[]): InvoiceLineItem[] {
  return lines.map((l) => toInvoiceLineShape(l, {}));
}

/** The create-form-only AI image slot (`extraCreateContent`) — see file header for the "never persisted" note. */
function AiImageCreateSlot({ imageUrl, onPick }: { imageUrl: string | null; onPick: (url: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-dashed border-border bg-background-light px-2.5 py-2">
      {imageUrl ? (
        <UploadedImage src={imageUrl} radius="sm" className="h-8 w-8 shrink-0" />
      ) : (
        <ImageIcon className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden />
      )}
      <span className="flex-1 text-xs text-text-secondary">
        {imageUrl ? 'Image selected — shows on this line for this session.' : 'Optional: suggest a product image.'}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Sparkles className="mr-1 h-3.5 w-3.5" aria-hidden />
        {imageUrl ? 'Change' : 'Suggest image'}
      </Button>
      <AiImagePanel
        open={open}
        itemName=""
        itemDetail=""
        onApply={(url) => {
          onPick(url);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </div>
  );
}

export interface EstimateLineItemsEditorEstimate {
  id: string;
  line_items?: EstimateLineItem[];
  /** B2 fix: fed straight into `<LineItemsTable estimateTotal totalLabel>` below so the embedded
   *  `<TotalsFooter>` shows the REAL total instead of falling back to its `0` default (the
   *  "$0.00 Estimate total" phantom-footer bug). */
  total_amount?: number | string | null;
  /** #2088 — see `areSelectionsLocked`'s own doc. */
  status?: string | null;
  invoices?: { kind?: string | null; status?: string | null }[] | null;
}

export interface EstimateLineItemsEditorProps {
  estimate: EstimateLineItemsEditorEstimate;
  /** §A1/A3 lock policy ANDed with `update Estimate` — the single ability gating every line mutation. */
  canManage: boolean;
  canSeePricing: boolean;
  canSaveToPriceBook: boolean;
}

export function EstimateLineItemsEditor({
  estimate,
  canManage,
  canSeePricing,
  canSaveToPriceBook,
}: EstimateLineItemsEditorProps) {
  const queryClient = useQueryClient();
  const estimateId = estimate.id;
  const lines = estimate.line_items ?? [];

  // #2088 - computed once per render (F5). It names the optional tag, and since #2090 slice A3
  // it is the ONE condition that makes the rep's own checkbox inert. The estimate's send state
  // is deliberately NOT an input: the rep goes on recommending until the customer signs.
  const selectionsLocked = areSelectionsLocked(estimate);

  // This file's OWN dialog state — see file header re: why a second <AddLineDialog> instance
  // exists alongside <LineItemsTable>'s built-in one.
  const [addOpen, setAddOpen] = useState(false);
  const [editingLine, setEditingLine] = useState<InvoiceLineItem | null>(null);
  const [pbOpen, setPbOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState<string | undefined>(undefined);
  // SRVW-221: lets addMutation's onSuccess clear PriceBookPicker's pendingReturnRef when a
  // create-adhoc hand-off resolves via a successful save (which bypasses onBackToPicker entirely)
  // - see PriceBookPicker.tsx's PriceBookPickerHandle doc for why that ref would otherwise strand.
  const pbPickerRef = useRef<PriceBookPickerHandle>(null);
  const [pendingImageUrl, setPendingImageUrl] = useState<string | null>(null);
  const [clientImageOverrides, setClientImageOverrides] = useState<Record<string, string>>({});

  const setEstimateCache = (res: { estimate?: unknown }) => {
    if (res?.estimate) {
      queryClient.setQueryData<Record<string, unknown>>(['estimate', estimateId], (old) => ({
        ...(old ?? {}),
        ...(res.estimate as Record<string, unknown>),
      }));
    }
  };
  const onError = (err: unknown, fallback: string) =>
    toast({ title: extractApiError(err, fallback), variant: 'destructive' });

  const openCreate = () => {
    setInitialQuery(undefined);
    setPendingImageUrl(null);
    setAddOpen(true);
  };

  const addMutation = useMutation({
    mutationFn: (payload: EstimateAddDraft) =>
      addEstimateLine(estimateId, {
        description: payload.description,
        quantity: payload.quantity,
        unit_price: payload.unit_price,
        is_taxable: payload.is_taxable,
        item_type: payload.item_type,
        ...(payload.price_book_item_id ? { price_book_item_id: payload.price_book_item_id } : {}),
        ...(payload.unit_cost !== undefined ? { unit_cost: payload.unit_cost } : {}),
        ...(payload.markup_percent !== undefined ? { markup_percent: payload.markup_percent } : {}),
        ...(payload.is_optional !== undefined ? { is_optional: payload.is_optional } : {}),
        ...(payload.is_selected !== undefined ? { is_selected: payload.is_selected } : {}),
      }),
    onSuccess: (res) => {
      setEstimateCache(res);
      setAddOpen(false);
      // SRVW-221: this success path bypasses AddLineDialog's onBackToPicker wrapper entirely, so
      // PriceBookPicker never gets a normal chance to consume its own pendingReturnRef - clear it
      // explicitly or a later, unrelated picker open would wrongly skip its reset.
      pbPickerRef.current?.clearPendingReturn();
      // Carry the session-only AI-picked image (file header) over to the freshly-appended line —
      // never sent to the backend, EstimateLineItem has no image_url column.
      if (pendingImageUrl) {
        const createdLines = res.estimate?.line_items ?? [];
        const created = createdLines[createdLines.length - 1];
        if (created) setClientImageOverrides((prev) => ({ ...prev, [created.id]: pendingImageUrl! }));
      }
      setPendingImageUrl(null);
    },
    onError: (err) => onError(err, 'Failed to add line item'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ lineId, patch }: { lineId: string; patch: EstimateUpdateDraft }) =>
      updateEstimateLine(estimateId, lineId, {
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
        ...(patch.unit_price !== undefined ? { unit_price: patch.unit_price } : {}),
        ...(patch.is_taxable !== undefined ? { is_taxable: patch.is_taxable } : {}),
        ...(patch.item_type !== undefined ? { item_type: patch.item_type } : {}),
        ...(patch.unit_cost !== undefined ? { unit_cost: patch.unit_cost } : {}),
        ...(patch.markup_percent !== undefined ? { markup_percent: patch.markup_percent } : {}),
        ...(patch.discount_type !== undefined ? { discount_type: patch.discount_type } : {}),
        ...(patch.discount_value !== undefined ? { discount_value: patch.discount_value } : {}),
        ...(patch.is_optional !== undefined ? { is_optional: patch.is_optional } : {}),
        ...(patch.is_selected !== undefined ? { is_selected: patch.is_selected } : {}),
      }),
    onSuccess: (res) => {
      setEstimateCache(res);
      setEditingLine(null);
    },
    onError: (err) => onError(err, 'Failed to update line item'),
  });

  const deleteMutation = useMutation({
    mutationFn: (lineId: string) => deleteEstimateLine(estimateId, lineId),
    onSuccess: (res) => {
      setEstimateCache(res);
      setEditingLine(null);
    },
    onError: (err) => onError(err, 'Failed to remove line item'),
  });

  const reorderMutation = useMutation({
    mutationFn: (order: string[]) => reorderEstimateLines(estimateId, order),
    onSuccess: setEstimateCache,
    onError: (err) => onError(err, 'Failed to reorder line items'),
  });

  const busy =
    addMutation.isPending || updateMutation.isPending || deleteMutation.isPending || reorderMutation.isPending;

  // Bulk-add from the shared PriceBookPicker — no bulk create-line endpoint exists, so each
  // selected item goes through the SAME addMutation the "Add item" flow uses, awaited in sequence
  // (not Promise.all) — mirrors Job's/Invoice's identical `handlePriceBookAdd`, including its M3
  // partial-failure fix: one bad item no longer aborts the rest of the batch, and any failures are
  // re-thrown as one aggregate error naming the item(s) — PriceBookPicker.tsx's own M3 fix awaits
  // this promise and keeps the dialog open (message shown inline) rather than closing over a
  // partially-failed batch.
  const handlePriceBookAdd = async (selections: PriceBookSelection[]) => {
    const failed: string[] = [];
    for (const { item, quantity } of selections) {
      try {
        await addMutation.mutateAsync({
          description: item.description ? `${item.name}\n${item.description}` : item.name,
          item_type: item.type,
          quantity,
          unit_price: Number(item.unit_price),
          is_taxable: item.taxable,
          price_book_item_id: item.id,
          ...(item.unit_cost != null ? { unit_cost: Number(item.unit_cost) } : {}),
        });
      } catch {
        failed.push(item.name);
      }
    }
    if (failed.length > 0) {
      throw new Error(
        failed.length === 1
          ? `Could not add "${failed[0]}" — the rest of the batch was added.`
          : `Could not add ${failed.length} item(s) (${failed.join(', ')}) — the rest of the batch was added.`,
      );
    }
  };

  // Groups/bundles — one click adds every line in the bundle (v12 SECTION 03: "Bundles folds in
  // here — a bundle is just a group"). Preserves the old estimate-local PriceBookPicker's
  // "add whole item group" capability that the shared picker's Groups tab replaces.
  //
  // R5a (2026-07-21) — the M3 partial-failure fix `handlePriceBookAdd` above already has, applied
  // here: sequential (not Promise.all), one bad line no longer aborts the rest of the bundle, and
  // any failures are re-thrown as one aggregate error naming the line(s) — PriceBookPicker.tsx's
  // own R5a fix awaits this promise and keeps the card's busy state/dialog open on rejection
  // rather than silently closing over a partially-added bundle.
  const handleAddGroup = async (group: PriceBookGroup) => {
    const failed: string[] = [];
    for (const li of group.line_items) {
      try {
        await addMutation.mutateAsync({
          description: li.description ? `${li.name}\n${li.description}` : li.name,
          item_type: li.item_type,
          quantity: li.quantity,
          unit_price: li.unit_price,
          is_taxable: li.is_taxable,
          unit_cost: li.unit_cost,
        });
      } catch {
        failed.push(li.name);
      }
    }
    if (failed.length > 0) {
      throw new Error(
        failed.length === 1
          ? `Could not add "${failed[0]}" from ${group.name} — the rest of the bundle was added.`
          : `Could not add ${failed.length} line(s) (${failed.join(', ')}) from ${group.name} — the rest of the bundle was added.`,
      );
    }
    toast({ title: 'Group added', description: `${group.name} — ${group.line_items.length} line(s) added.` });
  };

  const headerAction = canManage ? (
    <>
      {/* L1 fix: disabled during an in-flight bulk add (busy) — without this, a second click
          could race the batch loop's own reads and produce a duplicate `sequence` value. */}
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPbOpen(true)}>
        <BookOpen className="h-4 w-4" aria-hidden /> Price Book
      </Button>
      <Button type="button" variant="solid" tone="business" size="sm" disabled={busy} onClick={openCreate}>
        <Plus className="h-4 w-4" aria-hidden /> Add item
      </Button>
    </>
  ) : undefined;

  return (
    <SectionCard
      title="Line items"
      icon={<Package className="h-4 w-4 text-text-secondary" />}
      titleSuffix={<span className="ml-1 font-normal text-text-secondary">({lines.length})</span>}
      meta={headerAction}
    >
      <LineItemsTable
        lines={lines.map((l) => toInvoiceLineShape(l, clientImageOverrides, estimateId))}
        canAdd={canManage}
        canManageRows={canManage}
        canEditRows={canManage}
        canEditBilling={false}
        canSeePricing={canSeePricing}
        busy={busy}
        hasInvoice={false}
        subtotal={null}
        tax_amount={null}
        tax_rate={null}
        discount_amount={null}
        tip={null}
        total_amount={null}
        // B2 fix: without these, TotalsFooter falls back to its defaults (0 / "Estimate total"),
        // rendering a hard-coded "$0.00 Estimate total" row that contradicts the correct total in
        // the adjacent <EstimateReceiptCard> — mirrors Job's own wrapper (LineItemsEditor.tsx).
        estimateTotal={Number(estimate.total_amount ?? 0)}
        totalLabel="Estimate total"
        // v12's table has no per-line Discount column on any surface (plan §3) — Estimate leads
        // on this since it's the reference slice; Job already matches, Invoice not yet migrated.
        showDiscount={false}
        // §2.6 fix: <EstimateReceiptCard> is the page-level card that owns the running total for
        // Estimate — without this, TotalsFooter's own "Item cost"/"Estimate total" rows also
        // render (showTotal defaults true) and DISAGREE with the receipt card, because "Item
        // cost" is lines.reduce(...) here (excludes scope flat_price) while the receipt reads
        // the server-authoritative total_amount. Mirrors Job's identical fix, LineItemsEditor.tsx:361.
        showTotal={false}
        density="dense"
        // #2053 slice 1 — the only caller of the three shared components that passes true.
        showOptionalToggle
        selectionsLocked={selectionsLocked}
        addOpen={false}
        onAddOpenChange={(open) => open && openCreate()}
        addLoading={addMutation.isPending}
        canSaveToPriceBook={canSaveToPriceBook}
        editingLine={null}
        onEditingLineChange={(line) => {
          if (line) setEditingLine(line);
        }}
        onAdd={async (payload) => {
          await addMutation.mutateAsync(payload as EstimateAddDraft);
        }}
        onUpdate={(lineId, patch) => updateMutation.mutate({ lineId, patch: patch as EstimateUpdateDraft })}
        onDelete={(lineId) => deleteMutation.mutate(lineId)}
        onReorder={(orderedIds) => reorderMutation.mutate(orderedIds)}
        onTipChange={() => {}}
        onDiscountChange={() => {}}
        onTaxRateChange={() => {}}
      />

      {/* This file's own <AddLineDialog> — carries the estimate-only props <LineItemsTable>'s
          built-in instance has no room for (extraCreateContent/initialQuery). */}
      <AddLineDialog
        open={addOpen || editingLine != null}
        onOpenChange={(next) => {
          if (!next) {
            setAddOpen(false);
            setEditingLine(null);
          }
        }}
        loading={addMutation.isPending || updateMutation.isPending}
        canSaveToPriceBook={canSaveToPriceBook}
        canSeePricing={canSeePricing}
        editingLine={editingLine}
        initialQuery={initialQuery}
        // SRVW-221: closes this dialog and reopens the picker (below) - PriceBookPicker itself is
        // what keeps tab/category/search/qtys intact across the round trip.
        onBackToPicker={() => {
          setAddOpen(false);
          setInitialQuery(undefined);
          setPendingImageUrl(null);
          setPbOpen(true);
        }}
        extraCreateContent={<AiImageCreateSlot imageUrl={pendingImageUrl} onPick={setPendingImageUrl} />}
        showOptionalToggle
        onAdd={async (payload) => {
          await addMutation.mutateAsync(payload as EstimateAddDraft);
        }}
        onUpdate={(lineId, patch) => updateMutation.mutate({ lineId, patch: patch as EstimateUpdateDraft })}
        onDelete={(lineId) => deleteMutation.mutate(lineId)}
      />

      <PriceBookPicker
        ref={pbPickerRef}
        open={pbOpen}
        onOpenChange={setPbOpen}
        onAdd={handlePriceBookAdd}
        targetLabel="estimate"
        // "One door" rule (DDR §2b): hands the query back here (the picker closes itself), which
        // opens the SAME AddLineDialog the "Add item" button opens (create mode), pre-filled via
        // `initialQuery`. SRVW-221: onBackToPicker (above) reopens the picker on Cancel/Back/a
        // successful create, with its browse state intact.
        onCreateAdhoc={(query) => {
          setPendingImageUrl(null);
          setInitialQuery(query);
          setAddOpen(true);
        }}
        onAddGroup={handleAddGroup}
      />
    </SectionCard>
  );
}

export interface EstimateScopeOfWorkCardEstimate {
  id: string;
  scopes?: Scope[];
  /** Legacy single-block fields — read ONLY for the lazy-backfill seed; never written back to. */
  scope_name?: string | null;
  scope_notes?: string | null;
  /** R5f — flat array of every scope photo on the estimate; grouped by `scope_id` below. */
  scope_photos?: EstimateScopePhoto[];
  /** #2088 — see `areSelectionsLocked`'s own doc. */
  status?: string | null;
  invoices?: { kind?: string | null; status?: string | null }[] | null;
}

export interface EstimateScopeOfWorkCardProps {
  estimate: EstimateScopeOfWorkCardEstimate;
  canManage: boolean;
  canSeePricing: boolean;
}

/** Sentinel id for the client-only, not-yet-persisted backfilled block (never sent to the API). */
const LEGACY_SCOPE_ID = '__legacy__';

/**
 * B7 fix: carries a scope's full pricing/taxability into the save-as-preset payload. Previously
 * only `name`/`scope_text` were sent (`savePresetMutation.mutate({ name, scope_text })`),
 * silently dropping `flat_price`/`is_taxable`/`internal_cost` — a priced/taxed scope saved as a
 * preset came back unpriced/untaxed on reapply with no error surfaced. `createScopePreset`'s
 * exported param type (`lib/api/estimates.ts`) doesn't yet declare `is_taxable`/`internal_cost`,
 * but the backend controller now accepts them (2026-07-16 v12 review fix B7, scope-preset.
 * controller.ts) — passed through this typed helper's return value (not a fresh object literal at
 * the `createScopePreset(...)` call site) so TS's structural typing lets the extra keys through
 * without widening that shared API type from this file.
 */
function scopeToPresetPayload(scope: Scope) {
  return {
    name: scope.title || 'Scope',
    scope_text: scope.body,
    priced: scope.flat_price != null,
    price: scope.flat_price,
    is_taxable: scope.is_taxable,
    internal_cost: scope.internal_cost ?? null,
  };
}

/**
 * M2 fix: `backfillDismissed` (below) was plain in-memory `useState(false)` — reset to `false` on
 * every remount (e.g. navigate away to the estimates list and back), silently resurrecting a
 * legacy scope's stale pre-edit text the user had already dismissed (deleted the never-promoted
 * `LEGACY_SCOPE_ID` draft without ever editing it, so nothing was persisted server-side to clear
 * `scope_name`/`scope_notes` — see `handleDelete` below). Persisted to localStorage, keyed per
 * estimate, so the dismissal survives both a full remount AND a sibling-estimate tab switch
 * (`<EstimateTabs>` re-renders this SAME component instance with a new `estimate` prop rather
 * than remounting it — plain `useState(false)` would carry the FIRST estimate's dismissal into
 * the second). Best-effort: an unavailable localStorage (private browsing, tests) just falls back
 * to the pre-fix in-memory-only behavior instead of throwing.
 *
 * A *promoted* legacy scope (edited at least once, or later deleted after being promoted) doesn't
 * need this at all — the backend now nulls `scope_name`/`scope_notes` server-side on promotion
 * and on the promoted row's later deletion (2026-07-16 v12 review fix M2, estimate-lines.
 * controller.ts's `addScope`/`deleteScope`), so `hasLegacyText` below already goes false on its
 * own refetch. This localStorage flag only covers the OTHER path: dismissing the seeded draft
 * before it was ever promoted, which never touches the server at all.
 */
function backfillDismissedKey(estimateId: string): string {
  return `estimate-scope-backfill-dismissed:${estimateId}`;
}
function readBackfillDismissed(estimateId: string): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(backfillDismissedKey(estimateId)) === '1';
  } catch {
    return false;
  }
}
function persistBackfillDismissed(estimateId: string): void {
  try {
    window.localStorage.setItem(backfillDismissedKey(estimateId), '1');
  } catch {
    /* best-effort — localStorage may be unavailable (private mode, SSR, tests) */
  }
}

/**
 * Estimate side of the shared `<ScopeOfWorkCard>`. LAZY BACKFILL (v12 §4 Estimate plan, "the
 * agreed default"): an estimate written before `scopes[]` existed has its one block sitting in the
 * legacy `scope_name`/`scope_notes` strings. When `scopes[]` is empty and legacy text exists, this
 * shows a single DRAFT block seeded from it — never bulk-written, never destroying `scope_notes` —
 * that becomes a real `scopes[0]` row on its FIRST edit (`handleUpdate` below promotes it via
 * `addEstimateScope` instead of `updateEstimateScope`, since no real row exists yet). `busy`
 * disables every input while that create is in flight, so a second field's blur can't race the
 * first and create two rows.
 */
export function EstimateScopeOfWorkCard({ estimate, canManage, canSeePricing }: EstimateScopeOfWorkCardProps) {
  const queryClient = useQueryClient();
  const estimateId = estimate.id;
  const serverScopes = estimate.scopes ?? [];

  // #2088 — same computation as `EstimateLineItemsEditor` (F5); this is the sibling component
  // that mounts `<ScopeOfWorkCard>`, so it needs its own copy.
  const selectionsLocked = areSelectionsLocked(estimate);

  const [backfillDismissed, setBackfillDismissed] = useState(() => readBackfillDismissed(estimateId));
  // Re-sync from storage whenever the estimate identity itself changes — the "adjust state during
  // render" pattern (no useEffect needed), so a sibling-estimate tab switch that re-renders this
  // SAME instance with a new `estimate` prop reads THAT estimate's own dismissal flag instead of
  // carrying over the previous one, with no one-frame flash the way a useEffect reset would have.
  const [trackedEstimateId, setTrackedEstimateId] = useState(estimateId);
  if (estimateId !== trackedEstimateId) {
    setTrackedEstimateId(estimateId);
    setBackfillDismissed(readBackfillDismissed(estimateId));
  }

  // R5f — the backend has no server-side attach point on the scopes JSONB column, so scope
  // photos come back as one flat top-level array (`estimate.scope_photos`) rather than nested
  // inside each block; group by `scope_id` client-side so each block only ever sees its own.
  const scopePhotosByScopeId = useMemo(() => {
    const map: Record<string, EstimateScopePhoto[]> = {};
    for (const photo of estimate.scope_photos ?? []) {
      (map[photo.scope_id] ??= []).push(photo);
    }
    return map;
  }, [estimate.scope_photos]);

  const hasLegacyText = Boolean(estimate.scope_name?.trim() || estimate.scope_notes?.trim());
  const showBackfill = serverScopes.length === 0 && hasLegacyText && !backfillDismissed;
  const scopes: Scope[] = showBackfill
    ? [
        {
          id: LEGACY_SCOPE_ID,
          title: estimate.scope_name?.trim() || 'Scope of work',
          body: estimate.scope_notes ?? '',
          flat_price: null,
          is_taxable: true,
          internal_cost: null,
        },
      ]
    : serverScopes;

  const setEstimateCache = (res: { estimate?: unknown }) => {
    if (res?.estimate) {
      queryClient.setQueryData<Record<string, unknown>>(['estimate', estimateId], (old) => ({
        ...(old ?? {}),
        ...(res.estimate as Record<string, unknown>),
      }));
    }
  };
  const onError = (err: unknown, fallback: string) =>
    toast({ title: extractApiError(err, fallback), variant: 'destructive' });

  const addMutation = useMutation({
    mutationFn: (payload: ScopeDraft) => addEstimateScope(estimateId, payload),
    onSuccess: setEstimateCache,
    onError: (err) => onError(err, 'Failed to add scope of work'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ idx, patch }: { idx: number; patch: Partial<ScopeDraft> }) =>
      updateEstimateScope(estimateId, idx, patch),
    onSuccess: setEstimateCache,
    onError: (err) => onError(err, 'Failed to update scope of work'),
  });

  const deleteMutation = useMutation({
    mutationFn: (idx: number) => deleteEstimateScope(estimateId, idx),
    onSuccess: setEstimateCache,
    onError: (err) => onError(err, 'Failed to remove scope of work'),
  });

  const reorderMutation = useMutation({
    mutationFn: (newOrder: Scope[]) => reorderEstimateScopes(estimateId, newOrder.map((s) => s.id)),
    onSuccess: setEstimateCache,
    onError: (err) => onError(err, 'Failed to reorder scope of work'),
  });

  const savePresetMutation = useMutation({
    // R5a — widened to accept the optional `category` tag typed into ScopePresetPicker's footer,
    // which isn't part of a Scope's own shape so scopeToPresetPayload doesn't produce it.
    mutationFn: (input: ReturnType<typeof scopeToPresetPayload> & { category?: string | null }) => createScopePreset(input),
    onSuccess: () =>
      toast({ title: 'Saved as scope preset', description: 'Reuse it any time from "Use preset".' }),
    onError: (err) => onError(err, 'Could not save the scope preset.'),
  });

  const busy =
    addMutation.isPending || updateMutation.isPending || deleteMutation.isPending || reorderMutation.isPending;

  const handleUpdate = (idx: number, patch: Partial<ScopeDraft>) => {
    const target = scopes[idx];
    if (target?.id === LEGACY_SCOPE_ID) {
      // First write on the backfilled block — create it for real, merging the patch over the
      // legacy seed. Never a bulk write; only this one block, only now.
      addMutation.mutate({
        title: patch.title ?? target.title,
        body: patch.body ?? target.body,
        flat_price: patch.flat_price,
        is_taxable: patch.is_taxable ?? target.is_taxable,
        internal_cost: patch.internal_cost,
        // #2053 slice 1 — carry the flags through the legacy-block promotion too.
        is_optional: patch.is_optional ?? target.is_optional,
        is_selected: patch.is_selected ?? target.is_selected,
      });
    } else {
      updateMutation.mutate({ idx, patch });
    }
  };

  const handleDelete = (idx: number) => {
    if (scopes[idx]?.id === LEGACY_SCOPE_ID) {
      // Never persisted — nothing to delete server-side, just stop showing the seeded draft.
      // M2 fix: persist the dismissal (not just in-memory state) so it survives a remount.
      setBackfillDismissed(true);
      persistBackfillDismissed(estimateId);
      return;
    }
    deleteMutation.mutate(idx);
  };

  const handleReorder = (newOrder: Scope[]) => {
    if (newOrder.some((s) => s.id === LEGACY_SCOPE_ID)) return; // single un-persisted block — nothing to reorder yet
    reorderMutation.mutate(newOrder);
  };

  // "Use preset" — opens the existing ScopePresetPicker; picking one ADDS a new scope block
  // (never replaces the array) via the same addMutation the header "+ Add" button uses.
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const applyPreset = (preset: ScopePreset) => {
    setPresetPickerOpen(false);
    addMutation.mutate({
      title: preset.name,
      body: preset.scope_text,
      flat_price: preset.priced ? preset.price : null,
    });
  };

  return (
    <>
      <ScopeOfWorkCard
        scopes={scopes}
        canEdit={canManage}
        canSeePricing={canSeePricing}
        busy={busy}
        showOptionalToggle
        selectionsLocked={selectionsLocked}
        onAdd={(payload) => addMutation.mutate(payload)}
        onUpdate={handleUpdate}
        onDelete={handleDelete}
        onReorder={handleReorder}
        onUsePreset={canManage ? () => setPresetPickerOpen(true) : undefined}
        onSaveAsPreset={
          canManage ? (scope) => savePresetMutation.mutate(scopeToPresetPayload(scope)) : undefined
        }
        renderPhotos={(scope) =>
          // The backfilled legacy draft (see file header) isn't a real persisted scope row yet —
          // it has no server-side id to attach photos to until its first edit promotes it.
          scope.id === LEGACY_SCOPE_ID ? null : (
            <ScopePhotoStrip
              estimateId={estimateId}
              scopeId={scope.id}
              photos={scopePhotosByScopeId[scope.id] ?? []}
              canManage={canManage}
              estimatePhotoCount={estimate.scope_photos?.length ?? 0}
            />
          )
        }
      />
      <ScopePresetPicker
        open={presetPickerOpen}
        currentScope={scopes[0]?.body ?? ''}
        onSelect={applyPreset}
        onSaveCurrent={(category) => {
          // Falls back to an unpriced/untaxed-default draft when there's no scope[0] yet — same
          // "Scope" / '' defaults the old inline object literal used.
          const current = scopes[0] ?? {
            id: LEGACY_SCOPE_ID,
            title: 'Scope',
            body: '',
            flat_price: null,
            is_taxable: true,
            internal_cost: null,
          };
          savePresetMutation.mutate({ ...scopeToPresetPayload(current), category: category ?? null });
        }}
        onClose={() => setPresetPickerOpen(false)}
      />
    </>
  );
}
