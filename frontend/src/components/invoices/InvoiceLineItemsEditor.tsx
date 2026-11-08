/**
 * InvoiceLineItemsEditor — the editable line-items grid for the Invoice detail page's Line Items tab.
 *
 * Reuses the shared <LineItemsTable> (same rows / totals footer / add dialog as the Job → Items
 * editor), but wires the cache + mutations to the invoice itself:
 *   - Mutations hit POST/PATCH/DELETE /api/invoices/:id/line-items, invalidating
 *     ['invoice', id] + ['invoices'].
 *   - There is NO ensure-invoice step — the invoice already exists on this page.
 *   - Editing is allowed until the invoice is settled (DRAFT/SENT/PARTIAL); a paid/closed invoice is read-only.
 *
 * Totals/billing (v12 receipt consolidation, plan §3/§4 Invoice): tip/invoice-discount/tax-rate
 * editing has MOVED to the page-level `<InvoiceReceiptCard>` (Card A) — `InvoiceDetailPage.tsx`
 * owns the billing mutation now. This editor always passes `canEditBilling={false}` into
 * `<LineItemsTable>` (mirrors the Job editor's own already-hardcoded `false`) so its embedded
 * `<TotalsFooter>` never offers a second, competing set of money inputs — Card A is the one
 * editable money surface. `onTipChange`/`onDiscountChange`/`onTaxRateChange` are still passed
 * through as required props of `<LineItemsTable>`, but as no-ops (unreachable once
 * `canEditBilling` is false), matching the Job editor's identical pattern.
 *
 * Header actions (v12 §4 Invoice): the bare icon "+" is replaced by the same two-button pattern
 * Job already ships — outlined "Price Book" (browse/bulk-add the shared `<PriceBookPicker>`)
 * beside sage "Add item" (the precise single-line `<AddLineDialog>` flow, unchanged). Bulk
 * additions from the picker go through the SAME `addMutation` the single-add flow uses, awaited
 * sequentially (not `Promise.all`) so multi-select can't race the backend's per-request line-
 * numbering/append order — identical to `LineItemsEditor.tsx`'s (Job) `handlePriceBookAdd`. The
 * picker's own "Add new item" card hands its typed query back via `onCreateAdhoc`, which opens
 * the same `<AddLineDialog>` the "Add item" button opens (create mode) — the "one door" rule.
 * (v12 review fix L5) `initialQuery` pre-fills that dialog's search box from the query — the local
 * `initialQuery` state below is set alongside `addOpen` and cleared whenever the plain "Add item"
 * button opens the dialog fresh, mirroring `EstimateLineItemsEditor.tsx`'s `openCreate()`/
 * `onCreateAdhoc` pair.
 *
 * `editingLine` (Stage 4) is held here and controlled into <LineItemsTable> the SAME way `addOpen`
 * already is — a row's pencil Edit button sets it, the shared AddLineDialog opens into its edit
 * form, and a successful PATCH clears it (mirroring addMutation's onSuccess closing the add dialog).
 *
 * `InvoiceScopeOfWorkCard` (Batch 3, exported alongside `InvoiceLineItemsEditor` from this same
 * file) owns the Invoice side of the shared `<ScopeOfWorkCard>`'s data. Unlike the Job side, an
 * invoice's scopes ride along on the SAME detail fetch as everything else
 * (`invoiceDetailSelect` embeds `scopes: true`) — no separate GET, mutations just invalidate
 * `['invoice', invoiceId]` the same way this file's own line mutations already do. `onReorder`
 * receives the full target `Scope[]` order and persists it via the atomic
 * `PATCH /api/invoices/:id/scopes/reorder` endpoint (one request carrying the complete id order,
 * mirroring the Job side and line-items' own `/reorder` route) — replacing an earlier version
 * that diffed the target order against the current one and PATCHed only the changed indices'
 * content, which for a simple two-block swap (Move up/down) fired TWO concurrent index-addressed
 * PATCHes racing on the same non-atomic whole-column read-modify-write.
 *
 * Scope add/delete are gated `manage_lines` Invoice; inline field edits (title/body/price/
 * taxable/internal_cost) + move-up/down reorder are gated `update` Invoice — mirrors the
 * backend's B6/B7 route split on `/scopes` (POST/DELETE require only `manage_lines`; PATCH
 * `/scopes/:idx` + `/scopes/reorder` require only `update`). `<ScopeOfWorkCard>` exposes the two
 * grants as separate props (`canEdit` for the update-gated surface, `canAddDelete` for the
 * manage_lines-gated Add/Delete), so this card wires them through independently instead of
 * ANDing them into one flag — a caller holding only `manage_lines` (e.g. SALES via
 * OWN_INVOICE_VIA_LEAD, see defaultGrants.ts) still gets working Add/Delete, just no inline
 * editing or reorder (which the backend would 403 on).
 */
import { useRef, useState } from 'react';
import { Plus, BookOpen } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/heading';
import { LineItemsTable } from '@/components/jobs/items/LineItemsTable';
import { ScopeOfWorkCard, type ScopeDraft } from '@/components/jobs/items/ScopeOfWorkCard';
import {
  PriceBookPicker,
  type PriceBookPickerHandle,
  type PriceBookSelection,
} from '@/components/jobs/items/PriceBookPicker';
import {
  addInvoiceLine,
  updateInvoiceLine,
  deleteInvoiceLine,
  reorderInvoiceLines,
  addInvoiceScope,
  updateInvoiceScope,
  deleteInvoiceScope,
  reorderInvoiceScopes,
  type AddLineItemPayload,
  type UpdateLineItemPayload,
  type Scope,
} from '@/lib/api/invoices';
import type { InvoiceLineItem } from '@/lib/api/jobs';
import { useAppAbility } from '@/contexts/AbilityContext';
import { canSeePricing as canSeePricingAbility } from '@/lib/ability';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import { isInvoiceEditable } from '@/lib/invoiceEditable';

/** The slice of an invoice the editor needs — InvoiceDetail is structurally assignable to this. */
export interface InvoiceEditorInvoice {
  id: string;
  status: string;
  subtotal: string | number;
  tax_amount: string | number;
  tax_rate: string | number;
  discount_amount: string | number;
  tip?: string | number | null;
  total_amount: string | number;
  line_items?: InvoiceLineItem[];
}

export interface InvoiceLineItemsEditorProps {
  invoice: InvoiceEditorInvoice;
  /** Estimate line items — a read-only basis shown when the invoice owns none (display parity). */
  estimateLines?: InvoiceLineItem[];
}

export function InvoiceLineItemsEditor({ invoice, estimateLines = [] }: InvoiceLineItemsEditorProps) {
  const ability = useAppAbility();
  const queryClient = useQueryClient();
  const invoiceId = invoice.id;

  const isEditable = isInvoiceEditable(invoice.status);
  const canUpdate = ability.can('update', 'Invoice');
  const canManageLines = ability.can('manage_lines', 'Invoice');
  // Cost/margin visibility - shared with the backend's canSeePricing gate (SRVW-140), see
  // lib/ability.ts.
  const canSeePricing = canSeePricingAbility(ability);
  // #590 — catalog writes are a separate, admin-grantable ability (create PriceBook).
  const canSaveToPriceBook = ability.can('create', 'PriceBook');

  // The invoice owns its lines; fall back to the estimate items (read-only) when it owns none.
  const ownLines = invoice.line_items ?? [];
  const usingOwnLines = ownLines.length > 0;
  const lines: InvoiceLineItem[] = usingOwnLines ? ownLines : estimateLines;

  // Editing is allowed until the invoice is settled (P2: DRAFT/SENT/PARTIAL editable; locked once
  // PAID/VOIDED/closed). Row edits also require the rows to be the invoice's OWN lines (not the
  // read-only estimate basis).
  const canEditRows = isEditable && canUpdate && usingOwnLines;
  // v12 receipt consolidation: tip/invoice-discount/tax-rate editing now lives EXCLUSIVELY on the
  // page-level <InvoiceReceiptCard> (Card A) — always false here so <LineItemsTable>'s embedded
  // <TotalsFooter> never offers a second, competing set of money inputs. Mirrors the Job editor's
  // own already-hardcoded `canEditBilling={false}` (LineItemsEditor.tsx).
  const canEditBilling = false;
  const canManageRows = isEditable && canManageLines && usingOwnLines;
  const canAdd = isEditable && canManageLines;

  const [addOpen, setAddOpen] = useState(false);
  const [editingLine, setEditingLine] = useState<InvoiceLineItem | null>(null);
  const [pbOpen, setPbOpen] = useState(false);
  const [initialQuery, setInitialQuery] = useState<string | undefined>(undefined);
  // SRVW-221: lets addMutation's onSuccess clear PriceBookPicker's pendingReturnRef when a
  // create-adhoc hand-off resolves via a successful save (which bypasses onBackToPicker entirely)
  // - see PriceBookPicker.tsx's PriceBookPickerHandle doc for why that ref would otherwise strand.
  const pbPickerRef = useRef<PriceBookPickerHandle>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };
  const onError = (err: unknown, fallback: string) =>
    toast({ title: extractApiError(err, fallback), variant: 'destructive' });

  const addMutation = useMutation({
    mutationFn: (payload: AddLineItemPayload) => addInvoiceLine(invoiceId, payload),
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
      updateInvoiceLine(invoiceId, lineId, patch),
    onSuccess: () => {
      invalidate();
      setEditingLine(null);
    },
    onError: (err) => onError(err, 'Failed to update line item'),
  });

  const deleteMutation = useMutation({
    mutationFn: (lineId: string) => deleteInvoiceLine(invoiceId, lineId),
    onSuccess: (_result, lineId) => {
      // §4.1 — deleting a SYNCED invoice-born line auto-returns its stock server-side.
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
    mutationFn: (order: string[]) => reorderInvoiceLines(invoiceId, order),
    onSuccess: invalidate,
    onError: (err) => onError(err, 'Failed to reorder line items'),
  });

  const busy =
    addMutation.isPending || updateMutation.isPending || deleteMutation.isPending || reorderMutation.isPending;

  // Bulk-add from the shared PriceBookPicker — no bulk create-line endpoint exists, so each
  // selected item goes through the SAME addMutation the single "Add item" flow uses, awaited in
  // sequence (not Promise.all) so the picker's multi-select can't race the backend's own
  // per-request line-numbering/append order. Mirrors LineItemsEditor.tsx's (Job) identical helper,
  // including its M3 partial-failure fix: one bad item no longer aborts the rest of the batch, and
  // any failures are re-thrown as one aggregate error naming the item(s) — PriceBookPicker.tsx's
  // own M3 fix awaits this promise and keeps the dialog open (message shown inline) rather than
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

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <Heading level={3} weight="bold">
          Line items <span className="font-normal text-text-secondary">({lines.length})</span>
        </Heading>
        {canAdd && (
          <div className="flex items-center gap-2">
            {/* L1 fix: disabled during an in-flight bulk add (busy) — without this, a second
                click could race the batch loop's own reads and produce a duplicate `sequence`
                value. */}
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setPbOpen(true)}>
              <BookOpen className="h-4 w-4" aria-hidden /> Price Book
            </Button>
            <Button
              type="button"
              variant="solid" tone="business"
              size="sm"
              disabled={busy}
              onClick={() => {
                // Fresh open from the plain button — clear any leftover query from a prior
                // ad-hoc-create handoff (onCreateAdhoc below) so this doesn't reopen pre-filled.
                setInitialQuery(undefined);
                setAddOpen(true);
              }}
            >
              <Plus className="h-4 w-4" aria-hidden /> Add item
            </Button>
          </div>
        )}
      </div>

      <LineItemsTable
        lines={lines}
        canAdd={canAdd}
        canManageRows={canManageRows}
        canEditRows={canEditRows}
        canEditBilling={canEditBilling}
        canSeePricing={canSeePricing}
        busy={busy}
        hasInvoice
        subtotal={invoice.subtotal}
        tax_amount={invoice.tax_amount}
        tax_rate={invoice.tax_rate}
        discount_amount={invoice.discount_amount}
        tip={invoice.tip ?? null}
        total_amount={invoice.total_amount}
        showEstimateBasisHint={!usingOwnLines && lines.length > 0}
        // B4 fix: v12 has no per-line Discount column anywhere (plan §3) — mirrors Job
        // (LineItemsEditor.tsx, already false). Without this the table falls through to
        // <LineItemsTable>'s default `true`, rendering a live editable per-row Discount
        // Select+Input that duplicates the header-level discount control on <InvoiceReceiptCard>.
        showDiscount={false}
        // v12's table is a dense, flat receipt (no 112px product-photo card rows) — explicit here
        // even though it's LineItemsTable's own default, mirroring Job's identical intent-pin.
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
        // Money editing moved to Card A (<InvoiceReceiptCard> on InvoiceDetailPage.tsx) —
        // unreachable no-ops here since canEditBilling is always false (see above).
        onTipChange={() => {}}
        onDiscountChange={() => {}}
        onTaxRateChange={() => {}}
      />

      <PriceBookPicker
        ref={pbPickerRef}
        open={pbOpen}
        onOpenChange={setPbOpen}
        onAdd={handlePriceBookAdd}
        targetLabel="invoice"
        // "One door" rule (v12 DDR §2b): hands the query back here (the picker closes itself),
        // which opens the SAME AddLineDialog the "Add item" button opens (create mode,
        // addOpen=true), pre-filled via `initialQuery` (v12 review fix L5) - matches Estimate's
        // identical handoff. SRVW-221: onBackToPicker (above) reopens the picker on Cancel/Back/a
        // successful create, with its browse state intact.
        onCreateAdhoc={(query) => {
          setInitialQuery(query);
          setAddOpen(true);
        }}
      />
    </div>
  );
}

export interface InvoiceScopeOfWorkCardInvoice {
  id: string;
  status: string;
  scopes?: Scope[];
}

export interface InvoiceScopeOfWorkCardProps {
  invoice: InvoiceScopeOfWorkCardInvoice;
}

/**
 * Invoice side of the shared `<ScopeOfWorkCard>` — see the file header for the manage_lines/update
 * split gating rationale and the atomic-reorder-endpoint strategy (identical to the Job side's
 * `JobScopeOfWorkCard`).
 */
export function InvoiceScopeOfWorkCard({ invoice }: InvoiceScopeOfWorkCardProps) {
  const ability = useAppAbility();
  const queryClient = useQueryClient();
  const invoiceId = invoice.id;

  const isEditable = isInvoiceEditable(invoice.status);
  const canManageLines = ability.can('manage_lines', 'Invoice');
  const canUpdate = ability.can('update', 'Invoice');
  const canSeePricing = canSeePricingAbility(ability);
  // Backend split: POST/DELETE /scopes need only manage_lines; PATCH /scopes/:idx +
  // /scopes/reorder need only update — wired through as two separate props (not ANDed) so a
  // manage_lines-only caller (SALES) still gets working Add/Delete.
  const canEdit = isEditable && canUpdate;
  const canAddDelete = isEditable && canManageLines;

  const scopes = invoice.scopes ?? [];

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    queryClient.invalidateQueries({ queryKey: ['invoices'] });
  };
  const onError = (err: unknown, fallback: string) =>
    toast({ title: extractApiError(err, fallback), variant: 'destructive' });

  const addMutation = useMutation({
    mutationFn: (payload: ScopeDraft) => addInvoiceScope(invoiceId, payload),
    onSuccess: invalidate,
    onError: (err) => onError(err, 'Failed to add scope of work'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ idx, patch }: { idx: number; patch: Partial<ScopeDraft> }) =>
      updateInvoiceScope(invoiceId, idx, patch),
    onSuccess: invalidate,
    onError: (err) => onError(err, 'Failed to update scope of work'),
  });

  const deleteMutation = useMutation({
    mutationFn: (idx: number) => deleteInvoiceScope(invoiceId, idx),
    onSuccess: invalidate,
    onError: (err) => onError(err, 'Failed to remove scope of work'),
  });

  // A single atomic request carrying the FULL target id order — see reorderInvoiceScopes for why
  // this replaced the earlier diff-and-PATCH-the-changed-indices approach (lost-update race).
  const reorderMutation = useMutation({
    mutationFn: (newOrder: Scope[]) => reorderInvoiceScopes(invoiceId, newOrder.map((s) => s.id)),
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
      canEdit={canEdit}
      canAddDelete={canAddDelete}
      canSeePricing={canSeePricing}
      busy={busy}
      onAdd={(payload) => addMutation.mutate(payload)}
      onUpdate={(idx, patch) => updateMutation.mutate({ idx, patch })}
      onDelete={(idx) => deleteMutation.mutate(idx)}
      onReorder={(newOrder) => reorderMutation.mutate(newOrder)}
    />
  );
}
