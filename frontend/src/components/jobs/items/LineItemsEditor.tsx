/**
 * LineItemsEditor — the editable billing grid for the Job → Items tab.
 *
 * SERV10X-38 (job-owned items): a job tracks its own billable line items directly
 * (`JobLineItem`) BEFORE any invoice exists. This wrapper fetches/mutates those lines via
 * GET/POST/PATCH/DELETE /api/jobs/:id/line-items — there is no more "lazily create an
 * invoice on first add" step and no more estimate-basis read-only fallback (both retired:
 * the backend endpoint that did the former no longer exists, and a job's own items are the
 * only source of truth here regardless of whether the job has an estimate). Creating an
 * actual invoice FROM these items is a separate step (the "Create Invoice" dialog, draw/itemized).
 *
 * The grid itself (rows + totals footer + add dialog) is the shared <LineItemsTable> — the
 * SAME component the Invoice detail page's line editor uses. `hasInvoice` is passed false
 * here (there is no invoice-level tip/tax/discount at the job stage), so the totals footer
 * shows a running, tax-free JOB SUBTOTAL computed from the lines (billing.total from the
 * server matches this) rather than an "Invoice total"/"Estimate total".
 *
 * RBAC: the job-lines backend gates every mutation (add/update/delete) on a SINGLE ability,
 * `manage_lines Job` (Job does not copy Invoice's asymmetric manage_lines-vs-update scope
 * split) - canManage drives the header buttons, per-row trash, and inline field edits. Mutations
 * invalidate ['job-line-items', jobId] + ['job-financials', jobId] + ['job', jobId].
 *
 * v12 §4 Job (plan `md_files/plans/estimates/2026-07-16-v12-implementation-plan.md`): the header's
 * bare 28px "+" icon is replaced by the real two-button pattern — outlined "Price Book" (opens the
 * shared `<PriceBookPicker>`, browse/bulk-add from the catalog) beside sage "Add item" (opens the
 * shared `<AddLineDialog>` in create mode, the precise-single/one-off path) — same ordering/variant
 * convention `ScopeOfWorkCard`'s own header already established. The picker's own "Add new item"
 * card hands its typed query back via `onCreateAdhoc`, which opens that SAME `<AddLineDialog>`
 * (the "one door" rule) rather than a second creation form, pre-filled via `initialQuery` (SRVW-221
 * - previously discarded here; now threaded through like Estimate's/Invoice's identical handoff).
 * The picker itself closes on hand-off (handleCreateAdhoc calls onOpenChange(false)) and
 * `onBackToPicker` brings it back to the front on Cancel/Back/Escape/an overlay dismissal, browse
 * state intact - a successful create closes both dialogs instead and does NOT reopen the picker
 * (Ran's ruling: the back affordance available while the create form is open already satisfies
 * the round-trip requirement on its own) - see PriceBookPicker.tsx's/AddLineDialog.tsx's own docs
 * for the round trip.
 * Selections from the picker post through the SAME `addMutation` the single-item flow uses,
 * awaited sequentially (not `Promise.all`) since there's no bulk create-line endpoint.
 *
 * `editingLine` (Stage 4) is held here and controlled into <LineItemsTable> the SAME way
 * `addOpen` already is — a row's pencil Edit button sets it, the shared AddLineDialog opens
 * into its edit form, and a successful PATCH clears it (mirroring addMutation's onSuccess
 * closing the add dialog). Both add/update mutationFns forward unit_cost/markup_percent
 * through to updateJobLine/addJobLine alongside the pre-existing quantity/unit_price/is_taxable.
 *
 * `JobScopeOfWorkCard` (Batch 3, exported alongside `LineItemsEditor` from this same file) owns
 * the Job side of the shared `<ScopeOfWorkCard>`'s data — GET/POST/PATCH/DELETE
 * /api/jobs/:id/scopes — mirroring `LineItemsEditor`'s own listJobLines wiring above. It is
 * rendered as its own sibling `SectionCard` on the Job page (immediately before
 * `<LineItemsEditor>`), not nested inside `LineItemsEditor`'s JSX, per the Batch 3 plan's card
 * ordering. `onReorder` receives the full target `Scope[]` order and persists it via the atomic
 * `PATCH /api/jobs/:id/scopes/reorder` endpoint (one request carrying the complete id order) —
 * mirroring line-items' own `/reorder` route. An earlier version diffed the target order against
 * the current one and PATCHed only the changed indices' content, which for a simple two-block
 * swap (Move up/down) fired TWO concurrent index-addressed PATCHes racing on the same non-atomic
 * whole-column read-modify-write — whichever committed last silently clobbered the other's change.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Package, BookOpen, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { LineItemsTable } from './LineItemsTable';
import { ScopeOfWorkCard, type ScopeDraft } from './ScopeOfWorkCard';
import { PriceBookPicker, type PriceBookPickerHandle, type PriceBookSelection } from './PriceBookPicker';
import { CreatePOFromJobDialog } from './CreatePOFromJobDialog';
import type { AddLineItemPayload, UpdateLineItemPayload } from '@/lib/api/invoices';
import {
  listJobLines,
  addJobLine,
  updateJobLine,
  deleteJobLine,
  reorderJobLines,
  listJobScopes,
  addJobScope,
  updateJobScope,
  deleteJobScope,
  reorderJobScopes,
} from '@/lib/api/jobs';
import type { InvoiceLineItem, Scope } from '@/lib/api/jobs';
import { useAppAbility } from '@/contexts/AbilityContext';
import { canSeePricing as canSeePricingAbility } from '@/lib/ability';
import { useModuleAccess } from '@/lib/entitlements';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';

export interface LineItemsEditorProps {
  jobId: string;
  /**
   * Per-instance `manage_lines Job` answer, computed by the parent from the JOB
   * (`canOnJob(ability, 'manage_lines', job, userId)`).
   *
   * REQUIRED, with no ability fallback, deliberately. Since the technician-ownership spec (Part C)
   * the grant is conditioned on `created_by_id`, so the subject-level question this component used
   * to ask - `ability.can('manage_lines','Job')` - is true for EVERY technician and cannot see which
   * job is on screen: it would render the editor on jobs the API refuses. An optional prop with that
   * expression as its default is worse than either, because a new call site that forgets the prop
   * silently gets the wrong, permissive answer with no signal. Required means the compiler asks.
   */
  canManage: boolean;
}

export function LineItemsEditor({ jobId, canManage }: LineItemsEditorProps) {
  const ability = useAppAbility();
  const queryClient = useQueryClient();
  // Cost/margin visibility - shared with the backend's canSeePricing gate (SRVW-140), see
  // lib/ability.ts.
  const canSeePricing = canSeePricingAbility(ability);
  // #590 — writing INTO the catalog is a separate, admin-grantable ability; editing job lines
  // must not imply catalog-write rights.
  const canSaveToPriceBook = ability.can('create', 'PriceBook');
  // Inventory P2 (D16 entry #2) — ordering materials reads job lines, it doesn't mutate them;
  // `create PurchaseOrder` (Admin/Dispatcher per D11) is the gate, NOT canManage.
  // useModuleAccess adds the org axis: purchase orders live behind
  // requireFeature('inventory'), so on a sub-Scale plan this action must not
  // render at all. Job line items themselves are Starter core and stay editable.
  const canCreatePO = useModuleAccess('inventory', 'create', 'PurchaseOrder');

  const { data } = useQuery({
    queryKey: ['job-line-items', jobId],
    queryFn: () => listJobLines(jobId),
    enabled: !!jobId,
  });

  const lines = data?.lines ?? [];
  const billing = data?.billing ?? { total: 0, invoiced: 0, remaining: 0 };

  const [addOpen, setAddOpen] = useState(false);
  const [editingLine, setEditingLine] = useState<InvoiceLineItem | null>(null);
  const [pbOpen, setPbOpen] = useState(false);
  const [createPOOpen, setCreatePOOpen] = useState(false);
  // SRVW-221: lets addMutation's onSuccess clear PriceBookPicker's pendingReturnRef when a
  // create-adhoc hand-off resolves via a successful save (which bypasses onBackToPicker entirely)
  // - see PriceBookPicker.tsx's PriceBookPickerHandle doc for why that ref would otherwise strand.
  const pbPickerRef = useRef<PriceBookPickerHandle>(null);
  // SRVW-221: query handed back by PriceBookPicker's "Add new item" card, threaded into the
  // embedded AddLineDialog's `initialQuery` so it opens pre-filled instead of blank - mirrors
  // Estimate's/Invoice's identical state.
  const [initialQuery, setInitialQuery] = useState<string | undefined>(undefined);

  // Inventory P2 (D16 entry #2) — only MATERIAL lines are orderable on a PO.
  const materialLines = lines.filter((l) => l.item_type === 'MATERIAL');

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['job-line-items', jobId] });
    queryClient.invalidateQueries({ queryKey: ['job-financials', jobId] });
    queryClient.invalidateQueries({ queryKey: ['job', jobId] });
  };
  const onError = (err: unknown, fallback: string) =>
    toast({ title: extractApiError(err, fallback), variant: 'destructive' });

  const addMutation = useMutation({
    mutationFn: (payload: AddLineItemPayload) =>
      addJobLine(jobId, {
        description: payload.description,
        quantity: payload.quantity,
        unit_price: payload.unit_price,
        is_taxable: payload.is_taxable,
        item_type: payload.item_type,
        ...(payload.price_book_item_id ? { price_book_item_id: payload.price_book_item_id } : {}),
        ...(payload.unit_cost !== undefined ? { unit_cost: payload.unit_cost } : {}),
        ...(payload.markup_percent !== undefined ? { markup_percent: payload.markup_percent } : {}),
      }),
    onSuccess: () => {
      invalidate();
      setAddOpen(false);
      // SRVW-221: this success path bypasses AddLineDialog's onBackToPicker wrapper entirely, so
      // PriceBookPicker never gets a normal chance to consume its own pendingReturnRef - clear it
      // explicitly or a later, unrelated picker open would wrongly skip its reset.
      pbPickerRef.current?.clearPendingReturn();
    },
    onError: (err) => onError(err, 'Failed to add line item'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ lineId, patch }: { lineId: string; patch: UpdateLineItemPayload }) =>
      updateJobLine(jobId, lineId, {
        ...(patch.quantity !== undefined ? { quantity: patch.quantity } : {}),
        ...(patch.unit_price !== undefined ? { unit_price: patch.unit_price } : {}),
        ...(patch.is_taxable !== undefined ? { is_taxable: patch.is_taxable } : {}),
        ...(patch.item_type !== undefined ? { item_type: patch.item_type } : {}),
        ...(patch.unit_cost !== undefined ? { unit_cost: patch.unit_cost } : {}),
        ...(patch.markup_percent !== undefined ? { markup_percent: patch.markup_percent } : {}),
      }),
    onSuccess: () => {
      invalidate();
      setEditingLine(null);
    },
    onError: (err) => onError(err, 'Failed to update line item'),
  });

  const deleteMutation = useMutation({
    mutationFn: (lineId: string) => deleteJobLine(jobId, lineId),
    onSuccess: (_result, lineId) => {
      // §4.1 — deleting a SYNCED line auto-returns its stock server-side; surface it.
      // (Capture from the pre-invalidate closure — the line is gone after the refetch.)
      const line = lines.find((l) => l.id === lineId);
      invalidate();
      if (line?.stock_status === 'SYNCED') {
        queryClient.invalidateQueries({ queryKey: ['inventory'] });
        toast({
          title: 'Line removed',
          description: `${Number(line.quantity) || 0} × ${line.description.split('\n')[0]} returned to stock.`,
        });
      }
    },
    onError: (err) => onError(err, 'Failed to remove line item'),
  });

  const reorderMutation = useMutation({
    mutationFn: (order: string[]) => reorderJobLines(jobId, order),
    onSuccess: invalidate,
    onError: (err) => onError(err, 'Failed to reorder line items'),
  });

  const busy =
    addMutation.isPending || updateMutation.isPending || deleteMutation.isPending || reorderMutation.isPending;

  // Bulk-add from the shared PriceBookPicker — no bulk create-line endpoint exists, so each
  // selected item goes through the SAME addMutation the single "+ Add item" flow uses, awaited
  // in sequence (not Promise.all) so the picker's multi-select can't race the backend's own
  // per-request line-numbering/append order.
  //
  // M3 fix: each item is now wrapped in its own try/catch, so ONE failed add no longer aborts the
  // whole batch mid-loop (every other selected item still gets added). `addMutation`'s own
  // `onError` already toasts a generic "Failed to add line item" per failure; if any item failed,
  // this re-throws ONE aggregate error naming which item(s) — `PriceBookPicker.tsx`'s own M3 fix
  // awaits this promise and keeps the dialog open (with that message shown inline) instead of
  // closing over a partially-failed batch.
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

  // v12 §4 Job: the bare 28px "+" icon is replaced by the real two-button pattern — outlined
  // "Price Book" (browse/bulk-add the shared PriceBookPicker) beside sage "Add item" (the
  // precise-single/one-off AddLineDialog flow) — same ordering/variant convention
  // ScopeOfWorkCard's own header already established (outline secondary action, then sage primary).
  const priceBookButton = canManage ? (
    // L1 fix: disabled during an in-flight bulk add (busy) — without this, a second click could
    // race the batch loop's own reads and produce a duplicate `sequence` value.
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPbOpen(true)}>
      <BookOpen className="h-4 w-4" aria-hidden /> Price Book
    </Button>
  ) : undefined;

  const addButton = canManage ? (
    <Button
      type="button"
      variant="solid"
      tone="business"
      size="sm"
      disabled={busy}
      onClick={() => {
        // Fresh open from the plain button - clear any leftover query from a prior ad-hoc-create
        // handoff (onCreateAdhoc below) so this doesn't reopen pre-filled. Mirrors Invoice's
        // identical guard (InvoiceLineItemsEditor.tsx).
        setInitialQuery(undefined);
        setAddOpen(true);
      }}
    >
      <Plus className="h-4 w-4" aria-hidden /> Add item
    </Button>
  ) : undefined;

  // Inventory P2 (D16 entry #2): "Create PO" — leftmost (a side-flow, not the primary add
  // path). Hidden entirely (not disabled) without the ability, matching how priceBookButton/
  // addButton vanish without canManage.
  const createPOButton =
    canCreatePO && materialLines.length > 0 ? (
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setCreatePOOpen(true)}>
        <ShoppingCart className="h-4 w-4" aria-hidden /> Create PO
      </Button>
    ) : undefined;

  const headerAction =
    createPOButton || priceBookButton || addButton ? (
      <>
        {createPOButton}
        {priceBookButton}
        {addButton}
      </>
    ) : undefined;

  return (
    <SectionCard
      title="Line items"
      icon={<Package className="h-4 w-4 text-text-secondary" />}
      titleSuffix={
        <span className="ml-1 inline-flex items-center gap-1.5 font-normal text-text-secondary">
          ({lines.length})
        </span>
      }
      meta={headerAction}
    >
      <LineItemsTable
        lines={lines}
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
        estimateTotal={billing.total}
        // Inert today (showTotal={false} below suppresses this footer's own total), but kept in
        // sync with <ReceiptCard>'s hero so the two can't disagree if it is ever switched back on.
        totalLabel="Total"
        // B3 fix: JobDetailPage.tsx now renders a page-level <ReceiptCard variant="job"> that owns
        // the Items tab's running total — suppress this footer's own bottom total (and its
        // "Item cost" row, which excludes scope flat_price and could otherwise disagree with
        // ReceiptCard's number) so exactly ONE total renders on the tab.
        showTotal={false}
        // SERV10X-38 Task 6c: the job-line API drops PER-LINE discount fields (add/update never
        // send discount_type/discount_value on a JobLineItem), so this column's control would
        // silently no-op and snap back. Hide it here until real per-line job discount support
        // lands. Distinct from the WHOLE-JOB discount job-items-estimate-parity D2 added - that
        // one is read-only, server-derived, and renders on the page-level <ReceiptCard> instead.
        showDiscount={false}
        // v12's table is a dense, flat receipt (no 112px product-photo card rows) on every
        // surface — explicit here even though it's LineItemsTable's own default, so Job's intent
        // (never the pre-v12 'card' density) survives if that default ever changes.
        density="dense"
        addOpen={addOpen}
        onAddOpenChange={setAddOpen}
        addLoading={addMutation.isPending}
        canSaveToPriceBook={canSaveToPriceBook}
        editingLine={editingLine}
        onEditingLineChange={setEditingLine}
        initialQuery={initialQuery}
        // SRVW-221: closes this AddLineDialog and reopens the picker (below) - PriceBookPicker
        // itself is what keeps tab/category/search/qtys intact across the round trip.
        onBackToPicker={() => {
          setAddOpen(false);
          setInitialQuery(undefined);
          setPbOpen(true);
        }}
        onAdd={async (payload) => {
          await addMutation.mutateAsync(payload);
        }}
        onUpdate={(lineId, patch) => updateMutation.mutate({ lineId, patch })}
        onDelete={(lineId) => deleteMutation.mutate(lineId)}
        onReorder={(orderedIds) => reorderMutation.mutate(orderedIds)}
        onTipChange={() => {}}
        onDiscountChange={() => {}}
        onTaxRateChange={() => {}}
      />
      <PriceBookPicker
        ref={pbPickerRef}
        open={pbOpen}
        onOpenChange={setPbOpen}
        onAdd={handlePriceBookAdd}
        targetLabel="job"
        // "One door" rule (v12 DDR §2b): the picker's own "Add new item" card never opens a
        // second creation form - it hands back here (closing itself), and this opens the SAME
        // AddLineDialog the "+ Add item" button opens (create mode, addOpen=true), pre-filled via
        // `initialQuery`. SRVW-221: the query is no longer discarded (this callback used to take
        // no argument at all) - onBackToPicker (above) reopens the picker on Cancel/Back/a
        // successful create, with its browse state intact.
        onCreateAdhoc={(query) => {
          setInitialQuery(query);
          setAddOpen(true);
        }}
      />

      <CreatePOFromJobDialog
        open={createPOOpen}
        onOpenChange={setCreatePOOpen}
        jobId={jobId}
        lines={materialLines}
        canSeePricing={canSeePricing}
      />
    </SectionCard>
  );
}

export interface JobScopeOfWorkCardProps {
  jobId: string;
  /** Per-instance `manage_lines Job` answer from the parent - see LineItemsEditorProps.canManage. */
  canManage: boolean;
}

/**
 * Job side of the shared `<ScopeOfWorkCard>` - same gating (`manage_lines Job` for
 * add/edit/delete/reorder, `read Pricing` for internal_cost AND for the sell price) as
 * `LineItemsEditor` above, since the backend gates every job-scope mutation on the identical
 * single `manage_lines Job` ability.
 */
export function JobScopeOfWorkCard({ jobId, canManage }: JobScopeOfWorkCardProps) {
  const ability = useAppAbility();
  const queryClient = useQueryClient();
  const canSeePricing = canSeePricingAbility(ability);

  const { data } = useQuery({
    queryKey: ['job-scopes', jobId],
    queryFn: () => listJobScopes(jobId),
    enabled: !!jobId,
  });

  const scopes = data?.scopes ?? [];

  // A scope mutation changes billing (flat_price folds into the job total) exactly like a line
  // mutation does — invalidate the SAME keys LineItemsEditor's own mutations do, so
  // JobBillingSummary/InternalCostsCard refresh alongside this card.
  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['job-scopes', jobId] });
    queryClient.invalidateQueries({ queryKey: ['job-line-items', jobId] });
    queryClient.invalidateQueries({ queryKey: ['job-financials', jobId] });
    queryClient.invalidateQueries({ queryKey: ['job', jobId] });
  };
  const onError = (err: unknown, fallback: string) =>
    toast({ title: extractApiError(err, fallback), variant: 'destructive' });

  const addMutation = useMutation({
    mutationFn: (payload: ScopeDraft) => addJobScope(jobId, payload),
    onSuccess: invalidate,
    onError: (err) => onError(err, 'Failed to add scope of work'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ idx, patch }: { idx: number; patch: Partial<ScopeDraft> }) =>
      updateJobScope(jobId, idx, patch),
    onSuccess: invalidate,
    onError: (err) => onError(err, 'Failed to update scope of work'),
  });

  const deleteMutation = useMutation({
    mutationFn: (idx: number) => deleteJobScope(jobId, idx),
    onSuccess: invalidate,
    onError: (err) => onError(err, 'Failed to remove scope of work'),
  });

  // A single atomic request carrying the FULL target id order — see reorderJobScopes for why
  // this replaced the earlier diff-and-PATCH-the-changed-indices approach (lost-update race).
  const reorderMutation = useMutation({
    mutationFn: (newOrder: Scope[]) => reorderJobScopes(jobId, newOrder.map((s) => s.id)),
    onSuccess: invalidate,
    onError: (err) => onError(err, 'Failed to reorder scope of work'),
  });

  const busy =
    addMutation.isPending ||
    updateMutation.isPending ||
    deleteMutation.isPending ||
    reorderMutation.isPending;

  return (
    <ScopeOfWorkCard
      scopes={scopes}
      canEdit={canManage}
      canSeePricing={canSeePricing}
      // Job is the ONE surface whose backend removes the sell price outright for a requester
      // without `read Pricing`: job-lines.controller.ts strips flat_price from every scopes
      // response (stripScopeMoney) and drops it from the write body (`delete body.flat_price`).
      // Estimate and Invoice keep it for everyone, so they leave this at its `true` default.
      canSeeSellPrice={canSeePricing}
      busy={busy}
      onAdd={(payload) => addMutation.mutate(payload)}
      onUpdate={(idx, patch) => updateMutation.mutate({ idx, patch })}
      onDelete={(idx) => deleteMutation.mutate(idx)}
      onReorder={(newOrder) => reorderMutation.mutate(newOrder)}
    />
  );
}
