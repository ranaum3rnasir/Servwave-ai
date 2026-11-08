/**
 * LODetailSheet — the one Logistic Order detail/editor, which also IS the standalone create
 * screen (spec §7 / §12 rec 1, 5, 7). A right-side slide-over so it overlays any mount context
 * (Inventory list, Job Logistics tab, Invoice tab) without a layout dependency.
 *
 *   • loId set  → view / edit an existing LO (useLogisticOrder).
 *   • loId null → create mode. Anchor comes from props; a standalone create shows ZERO anchor UI.
 *
 * ONE PRIMARY ACTION PER STATE AND PERMISSION (§12 rec 1). A grant holder (holds approve + process)
 * on a DRAFT sees a single sage **Process** button that fast-forwards DRAFT→PROCESSED server-side;
 * in CREATE mode that same button persists then processes in the same click, so the small-shop
 * happy path is exactly three actions: open create → add lines → Process. A non-holder sees
 * **Submit for approval**; an approver on a PENDING order sees **Approve**; a processor on an
 * APPROVED order sees **Process**. Editing a PROCESSED order posts a stock delta, previewed before
 * commit ("Saving returns 2 to Main Warehouse"). Print view is deferred (§12 rec 8).
 *
 * The 409 SHORTAGE (per-line), 422 LO_LINE_INVALID (per-line) and 409 STALE_STATUS responses all
 * render as an in-sheet banner via extractLoError. `cancelled_reason` is OPTIONAL — the correct
 * asymmetry against the required manual-adjustment reason (§12 rec 7).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Loader2, Trash2 } from 'lucide-react';
import {
  extractLoError,
  useApproveLo,
  useCancelLo,
  useCreateLogisticOrder,
  useDeleteLo,
  useLogisticOrder,
  useProcessLo,
  useSubmitLo,
  useUpdateLogisticOrder,
  type CreateLogisticOrderBody,
  type LoAnchors,
  type LoApiError,
  type LoDetailLine,
  type LogisticOrderDetail,
  type LogisticOrderStatus,
  type ProcessLogisticOrderResult,
} from '@/lib/api/logisticOrders';
import { useLocations } from '@/lib/api/inventory';
import { useAppAbility } from '@/contexts/AbilityContext';
import { extractApiError } from '@/lib/utils';
import { toast } from '@/components/ui/use-toast';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { FormField } from '@/components/patterns/FormField';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/data/status-badge';
import { LOLinePicker, toLoLineInput, type LOLineDraft } from './LOLinePicker';
import { formatLoDate } from './loStatus';
import { useConfirm } from '@/hooks/useConfirm';

export interface LODetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create mode. */
  loId: string | null;
  /** Pre-anchor a newly-created LO (Job / Invoice / service-plan tabs). Absent keys = standalone. */
  anchor?: { jobId?: string; invoiceId?: string; servicePlanId?: string };
}

type LifecycleVerb = 'process' | 'submit' | 'approve';

const OPEN_STATUSES: LogisticOrderStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'];

// ─── Pure helpers (module-level so effects don't depend on component identity) ──

function detailLineToDraft(l: LoDetailLine): LOLineDraft {
  return {
    id: l.id,
    item_id: l.itemId ?? '',
    item_sku: l.itemSku ?? null,
    item_name: l.itemName,
    qty: l.qty,
    from_location_id: l.fromLocationId ?? null,
    sequence: l.sequence,
  };
}

/** A stable string of the editable form — the dirty-detection baseline (display fields excluded). */
function buildSnapshot(notes: string, lines: LOLineDraft[]): string {
  return JSON.stringify({
    notes,
    lines: lines.map((l) => ({
      id: l.id ?? null,
      item_id: l.item_id,
      qty: l.qty,
      from_location_id: l.from_location_id,
      sequence: l.sequence ?? null,
    })),
  });
}

function fmtUnits(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2);
}

/**
 * Net stock movement a save on a PROCESSED order will post, per location:
 * (new committed at loc) − (old committed at loc). Positive → consume more; negative → return.
 */
function computeLocationDeltas(
  original: LoDetailLine[],
  current: LOLineDraft[],
): { locationId: string; net: number }[] {
  const net = new Map<string, number>();
  for (const l of original) {
    if (l.fromLocationId) net.set(l.fromLocationId, (net.get(l.fromLocationId) ?? 0) - l.qty);
  }
  for (const l of current) {
    if (l.from_location_id) {
      net.set(l.from_location_id, (net.get(l.from_location_id) ?? 0) + l.qty);
    }
  }
  return [...net.entries()]
    .filter(([, n]) => Math.abs(n) > 1e-9)
    .map(([locationId, n]) => ({ locationId, net: n }));
}

// ─── Component ──────────────────────────────────────────────────────────────

export function LODetailSheet({ open, onOpenChange, loId, anchor }: LODetailSheetProps) {
  const { confirm, confirmDialog } = useConfirm();
  const ability = useAppAbility();
  const canApprove = ability.can('approve', 'LogisticOrder');
  const canProcess = ability.can('process', 'LogisticOrder');
  const canSubmit = ability.can('submit', 'LogisticOrder');
  const canUpdate = ability.can('update', 'LogisticOrder');
  const canCancel = ability.can('cancel', 'LogisticOrder');
  const canDelete = ability.can('delete', 'LogisticOrder');
  const isGrantHolder = canApprove && canProcess;

  const [activeId, setActiveId] = useState<string | null>(loId);
  const isCreate = activeId === null;

  const detailQuery = useLogisticOrder(activeId);
  const detail = detailQuery.data ?? null;
  const status: LogisticOrderStatus = detail?.status ?? 'DRAFT';

  const locationsQuery = useLocations();

  const createLo = useCreateLogisticOrder();
  const updateLo = useUpdateLogisticOrder();
  const submitLo = useSubmitLo();
  const approveLo = useApproveLo();
  const processLo = useProcessLo();
  const cancelLo = useCancelLo();
  const deleteLo = useDeleteLo();

  // -- Form state -----------------------------------------------------------
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LOLineDraft[]>([]);
  const [baseline, setBaseline] = useState(() => buildSnapshot('', []));
  const syncedRef = useRef<string | null>(null);

  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<LoApiError | string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  // Sync the form from the server only when a NEW version arrives (keyed on updated_at) — an idle
  // background refetch returning the same version must never clobber in-progress edits.
  useEffect(() => {
    if (!detail) return;
    if (syncedRef.current === detail.updatedAt) return;
    const nextLines = detail.lines.map(detailLineToDraft);
    setNotes(detail.notes ?? '');
    setLines(nextLines);
    setBaseline(buildSnapshot(detail.notes ?? '', nextLines));
    syncedRef.current = detail.updatedAt;
  }, [detail]);

  const dirty = buildSnapshot(notes, lines) !== baseline;
  const terminal = status === 'CANCELLED' || status === 'RETURNED';
  const readOnly = !isCreate && terminal;
  // Editing the lines/notes of an EXISTING order requires `update`. `readOnly` (terminal) only stops
  // editing on CANCELLED/RETURNED; a SALES actor (create+submit, NO update) opening a non-terminal
  // DRAFT must NOT be able to dirty the form, or Submit would fire a doomed PATCH → 403. Create mode
  // is always editable (the create endpoint is gated on `create`, not `update`).
  const canEditLines = isCreate || (canUpdate && !terminal);
  const noLines = lines.length === 0;

  const totalUnits = useMemo(() => lines.reduce((sum, l) => sum + (l.qty || 0), 0), [lines]);

  const locName = (id: string): string => {
    const fromList = locationsQuery.data?.find((l) => l.id === id)?.name;
    if (fromList) return fromList;
    const fromLine = detail?.lines.find((l) => l.fromLocationId === id)?.fromLocationName;
    return fromLine ?? 'the source location';
  };

  const deltas =
    !isCreate && status === 'PROCESSED' && dirty
      ? computeLocationDeltas(detail?.lines ?? [], lines)
      : [];

  // -- One primary lifecycle action per state + permission ------------------
  function resolveLifecycle(): { label: string; verb: LifecycleVerb } | null {
    const s: LogisticOrderStatus = isCreate ? 'DRAFT' : status;
    if (s === 'DRAFT') {
      if (isGrantHolder) return { label: 'Process', verb: 'process' };
      if (canSubmit) return { label: 'Submit for approval', verb: 'submit' };
      return null;
    }
    if (s === 'PENDING_APPROVAL') return canApprove ? { label: 'Approve', verb: 'approve' } : null;
    if (s === 'APPROVED') return canProcess ? { label: 'Process', verb: 'process' } : null;
    return null; // PROCESSED / CANCELLED / RETURNED — no forward lifecycle action
  }
  const lifecycle = resolveLifecycle();
  const showSave = !readOnly && (isCreate || (canUpdate && dirty));
  const saveLabel = isCreate || status === 'DRAFT' ? 'Save draft' : 'Save changes';

  // -- Actions --------------------------------------------------------------

  /** Persist the current form (create or, when dirty, update) and return the effective id. */
  async function persist(): Promise<string> {
    if (isCreate) {
      const body: CreateLogisticOrderBody = {
        ...(anchor?.jobId ? { job_id: anchor.jobId } : {}),
        ...(anchor?.invoiceId ? { invoice_id: anchor.invoiceId } : {}),
        ...(anchor?.servicePlanId ? { service_plan_id: anchor.servicePlanId } : {}),
        notes: notes.trim() ? notes : null,
        lines: lines.map(toLoLineInput),
      };
      const created = await createLo.mutateAsync(body);
      setActiveId(created.id);
      return created.id;
    }
    // Only PATCH when the form is dirty AND this actor may update. The editability gate above already
    // stops a non-`update` actor from dirtying an existing order; this is defense-in-depth so a lifecycle
    // action (e.g. Submit) never fires a doomed PATCH → 403 that a lifecycle-only actor cannot recover.
    if (dirty && canUpdate) {
      await updateLo.mutateAsync({
        id: activeId!,
        notes: notes.trim() ? notes : null,
        lines: lines.map(toLoLineInput),
      });
    }
    return activeId!;
  }

  async function runAction(verb: LifecycleVerb | 'save') {
    setApiError(null);
    setBusy(true);
    try {
      const id = await persist();
      if (verb === 'process') {
        const result = await processLo.mutateAsync(id);
        toastProcessWarnings(result);
        onOpenChange(false);
      } else if (verb === 'submit') {
        await submitLo.mutateAsync(id);
        onOpenChange(false);
      } else if (verb === 'approve') {
        await approveLo.mutateAsync(id);
        onOpenChange(false);
      }
      // 'save' → persisted; stay open. The refetch re-syncs the form (dirty clears).
    } catch (e) {
      setApiError(extractLoError(e) ?? extractApiError(e, 'Something went wrong'));
    } finally {
      setBusy(false);
    }
  }

  async function confirmCancel() {
    setApiError(null);
    setBusy(true);
    try {
      await cancelLo.mutateAsync({ id: activeId!, cancelled_reason: cancelReason.trim() || null });
      onOpenChange(false);
    } catch (e) {
      setApiError(extractLoError(e) ?? extractApiError(e, 'Failed to cancel the order'));
      setCancelling(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    const description =
      status === 'PROCESSED'
        ? 'Its stock is returned first, then the order is removed. This cannot be undone.'
        : 'This cannot be undone.';
    if (
      !(await confirm({
        title: 'Delete this logistic order?',
        description,
        confirmLabel: 'Delete',
        tone: 'danger',
      }))
    )
      return;
    setApiError(null);
    setBusy(true);
    try {
      await deleteLo.mutateAsync(activeId!);
      onOpenChange(false);
    } catch (e) {
      setApiError(extractLoError(e) ?? extractApiError(e, 'Failed to delete the order'));
    } finally {
      setBusy(false);
    }
  }

  const createAnchorLabel = anchor?.jobId
    ? 'this job'
    : anchor?.invoiceId
      ? 'this invoice'
      : anchor?.servicePlanId
        ? 'this service plan'
        : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        {/* Header */}
        <div className="border-b border-border px-6 pb-4 pt-6 pr-12">
          <div className="flex items-center gap-3">
            <SheetTitle className="text-lg font-semibold">
              {isCreate ? 'New logistic order' : (detail?.number ?? 'Logistic order')}
            </SheetTitle>
            {!isCreate && detail && <StatusBadge domain="logisticOrder" status={detail.status} />}
            {!isCreate && detail && (detail.status === 'PROCESSED' || detail.status === 'RETURNED') && (
              <Link
                to={`/inventory/activity?lo=${detail.id}`}
                className="text-sm font-medium text-primary hover:underline"
              >
                View stock activity
              </Link>
            )}
          </div>

          {/* Anchor links */}
          {!isCreate && detail && <AnchorLinks anchors={detail.anchors} />}
          {isCreate && createAnchorLabel && (
            <p className="mt-1 text-sm text-text-secondary">Linked to {createAnchorLabel}.</p>
          )}
          {isCreate && !createAnchorLabel && (
            <p className="mt-1 text-sm text-text-secondary">Standalone — not linked to any record.</p>
          )}

          {/* Actor trail */}
          {!isCreate && detail && <ActorTrail detail={detail} />}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {!isCreate && detailQuery.isLoading ? (
            <div className="flex items-center gap-2 py-10 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          ) : cancelling ? (
            <div className="space-y-3">
              <p className="text-sm font-medium text-text-primary">Cancel {detail?.number}?</p>
              <p className="text-sm text-text-secondary">
                The order is voided. No stock moves — nothing was processed.
              </p>
              {/*
                The label text stays the literal "Reason (optional)" rather than
                FormField's `optional` flag: the flag renders the suffix as its
                own <Text> span, which splits the label's single text node in
                two. Same painted result (Text tone="secondary" resolves to the
                same text-text-secondary the Label already carries), but it is a
                DOM-text change this structural pass has no reason to make.
              */}
              <FormField label="Reason (optional)" htmlFor="lo-cancel-reason">
                <Textarea
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  rows={3}
                  placeholder="Why is this being cancelled?"
                />
              </FormField>
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={() => setCancelling(false)} disabled={busy}>
                  Back
                </Button>
                <Button variant="solid" tone="danger" size="sm" onClick={confirmCancel} disabled={busy}>
                  {busy ? 'Cancelling…' : 'Cancel order'}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Line editor */}
              <div>
                <div className="mb-2 flex items-baseline justify-between">
                  <Label>Items</Label>
                  <span className="text-xs text-text-secondary">
                    {fmtUnits(totalUnits)} unit{totalUnits === 1 ? '' : 's'} · {lines.length} line
                    {lines.length === 1 ? '' : 's'}
                  </span>
                </div>
                <LOLinePicker lines={lines} onChange={setLines} disabled={!canEditLines} />
              </div>

              {/* Delta preview (PROCESSED edit) */}
              {deltas.length > 0 && (
                <div className="rounded-control border border-info/20 bg-info/10 p-3 text-sm text-info">
                  <p className="font-medium">Saving will move stock:</p>
                  <ul className="mt-1 space-y-0.5">
                    {deltas.map((d) => (
                      <li key={d.locationId}>
                        {d.net < 0
                          ? `Returns ${fmtUnits(-d.net)} to ${locName(d.locationId)}`
                          : `Consumes ${fmtUnits(d.net)} from ${locName(d.locationId)}`}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Notes */}
              <FormField label="Notes" htmlFor="lo-notes">
                <Textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  disabled={!canEditLines}
                  placeholder="Optional — anything the picker should know."
                />
              </FormField>

              {/* Error banner */}
              {apiError && <ErrorBanner error={apiError} />}
            </div>
          )}
        </div>

        {/* Footer actions */}
        {!cancelling && !readOnly && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
            <div className="flex items-center gap-1">
              {!isCreate && canDelete && (
                <Button
                  variant="ghost" tone="danger" revealOnHover
                  size="sm"
                  onClick={() => void handleDelete()}
                  disabled={busy}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </Button>
              )}
              {!isCreate && canCancel && OPEN_STATUSES.includes(status) && (
                <Button
                  variant="ghost" tone="danger" revealOnHover
                  size="sm"
                  onClick={() => setCancelling(true)}
                  disabled={busy}
                >
                  Cancel order
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {showSave && (
                <Button
                  variant={lifecycle ? 'outline' : 'solid'}
                  tone={lifecycle ? undefined : 'business'}
                  size="sm"
                  onClick={() => runAction('save')}
                  disabled={busy || (!isCreate && !dirty)}
                >
                  {saveLabel}
                </Button>
              )}
              {lifecycle && (
                <Button
                  variant="solid" tone="business"
                  size="sm"
                  onClick={() => runAction(lifecycle.verb)}
                  disabled={busy || noLines}
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {lifecycle.label}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Terminal-state footer: read-only, delete-only cleanup */}
        {!cancelling && readOnly && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
            {canDelete && (
              <Button
                variant="ghost" tone="danger" revealOnHover
                size="sm"
                onClick={() => void handleDelete()}
                disabled={busy}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </Button>
            )}
          </div>
        )}
      </SheetContent>
      {confirmDialog}
    </Sheet>
  );
}

function toastProcessWarnings(result: ProcessLogisticOrderResult) {
  const n = result.warnings?.length ?? 0;
  if (n === 0) return;
  toast({
    title: 'Processed with stock warnings',
    description: `${n} line${n === 1 ? '' : 's'} drew a location below zero. Reconcile with a count.`,
  });
}

// ─── Header sub-components ─────────────────────────────────────────────────

function AnchorLinks({ anchors }: { anchors: LoAnchors }) {
  const links: { label: string; to?: string }[] = [];
  if (anchors.jobId) links.push({ label: `Job ${anchors.jobNumber ?? ''}`.trim(), to: `/jobs/${anchors.jobId}` });
  if (anchors.invoiceId)
    links.push({ label: `Invoice ${anchors.invoiceNumber ?? ''}`.trim(), to: `/invoices/${anchors.invoiceId}` });
  if (anchors.estimateId)
    links.push({ label: `Estimate ${anchors.estimateNumber ?? ''}`.trim(), to: `/estimates/${anchors.estimateId}` });
  if (anchors.leadId)
    links.push({ label: `Lead ${anchors.leadNumber ?? ''}`.trim(), to: `/leads/${anchors.leadId}` });
  if (anchors.customerId)
    links.push({ label: `Customer ${anchors.customerNumber ?? ''}`.trim(), to: `/customers/${anchors.customerId}` });
  if (anchors.servicePlanId)
    links.push({ label: `Service plan ${anchors.servicePlanNumber ?? ''}`.trim() });

  if (links.length === 0) {
    return <p className="mt-1 text-sm text-text-secondary">Standalone — not linked to any record.</p>;
  }
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {links.map((l) =>
        l.to ? (
          <Link
            key={l.label}
            to={l.to}
            className="rounded-control bg-background-light px-2 py-0.5 text-xs font-medium text-primary hover:underline"
          >
            {l.label}
          </Link>
        ) : (
          <span
            key={l.label}
            className="rounded-control bg-background-light px-2 py-0.5 text-xs font-medium text-text-secondary"
          >
            {l.label}
          </span>
        ),
      )}
    </div>
  );
}

function ActorTrail({ detail }: { detail: LogisticOrderDetail }) {
  const steps: { label: string; who?: string | null; at: string | null }[] = [
    { label: 'Created', who: detail.createdBy?.name, at: detail.createdAt },
    { label: 'Submitted', who: detail.submittedBy?.name, at: detail.submittedAt },
    { label: 'Approved', who: detail.approvedBy?.name, at: detail.approvedAt },
    { label: 'Processed', who: detail.processedBy?.name, at: detail.processedAt },
    { label: 'Cancelled', who: null, at: detail.cancelledAt },
  ].filter((s) => s.at);

  return (
    <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-secondary">
      {steps.map((s) => (
        <li key={s.label} className="inline-flex items-center gap-1">
          <span className="font-medium text-text-primary">{s.label}</span>
          {s.who ? <span>by {s.who}</span> : null}
          <span>· {formatLoDate(s.at)}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── Error banner ───────────────────────────────────────────────────────────

function ErrorBanner({ error }: { error: LoApiError | string }) {
  const shell =
    'flex gap-2 rounded-control border border-danger/20 bg-danger/10 p-3 text-sm text-danger';

  if (typeof error === 'string') {
    return (
      <div className={shell} role="alert">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{error}</span>
      </div>
    );
  }

  if (error.kind === 'SHORTAGE') {
    return (
      <div className={shell} role="alert">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">Not enough stock to process</p>
          <ul className="mt-1 space-y-0.5">
            {error.details.map((d, i) => (
              <li key={i}>
                {d.item_name || d.item_sku || 'A line'} — needs {d.requested}, {d.available} available
                at {d.location_name ?? 'the source location'}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (error.kind === 'LO_LINE_INVALID') {
    return (
      <div className={shell} role="alert">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="font-medium">Fix these lines</p>
          <ul className="mt-1 space-y-0.5">
            {error.details.map((d, i) => (
              <li key={i}>
                {d.item_name || d.item_sku || 'A line'} — {d.message}
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }

  if (error.kind === 'STALE_STATUS') {
    return (
      <div className={shell} role="alert">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="inline-flex flex-wrap items-center gap-1">
          {error.message}
          <span className="inline-flex items-center gap-1 text-text-secondary">
            <ArrowRight className="h-3 w-3" /> Close and reopen to see the current state.
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className={shell} role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{error.message}</span>
    </div>
  );
}
