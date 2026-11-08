/**
 * loErrorViews — shared render surfaces for the typed LO API errors (task LO-3 §1).
 *
 * The LODetailSheet / editor catches an axios error, runs `extractLoError(err)` (lib/api/
 * logisticOrders.ts) and hands the discriminated result to <LoErrorView>. This module owns the
 * visual language so the list + detail agents don't each reinvent it:
 *
 *   • SHORTAGE (409, block-mode)  → per-line rows (item · location · requested vs on-hand), amber.
 *   • LO_LINE_INVALID (422)       → per-line reasons (the server's human message), amber.
 *   • STALE_STATUS (409)          → "changed since you opened it — reload" notice, blue, + Reload.
 *   • hard blocks (item-swap / anchor-gone / job-cancelled) → generic red banner from `.message`.
 *
 * Warn-mode (process succeeds but a line went negative) is NOT an error — it returns
 * ProcessLogisticOrderResult.warnings; `toastLoWarnings` surfaces it as a toast.
 *
 * On reuse of the relocated helpers (lib/stockToasts.ts): `extractShortage`/`toastStockWarning`
 * only parse the SINGLE-line job/invoice shapes — they cannot read the LO aggregate (foundation
 * decision 4), so the LO path uses `extractLoError` + these views instead. `toastLoWarnings` is the
 * LO-native analog of `toastStockWarning`. Tokens only — no raw hex, no palette classes.
 */
import { Link } from 'react-router-dom';
import { AlertTriangle, Ban, RefreshCw } from 'lucide-react';
import { toast } from '@/components/ui/use-toast';
import { Button } from '@/components/ui/button';
import type {
  LoApiError,
  LoShortageDetail,
  LoLineInvalidDetail,
  ProcessLogisticOrderResult,
} from '@/lib/api/logisticOrders';

type Tone = 'warning' | 'danger' | 'info';

const TONE_SHELL: Record<Tone, string> = {
  warning: 'border-warning/20 bg-warning/10 text-warning',
  danger: 'border-danger/20 bg-danger/10 text-danger',
  info: 'border-info/20 bg-info/10 text-info',
};

/** Shared tinted banner shell — the SyncStockDialog shortage-panel template, tokenised per tone. */
function LoErrorBanner({
  tone,
  icon: Icon,
  title,
  children,
}: {
  tone: Tone;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className={['space-y-2 rounded-card border p-3 text-sm', TONE_SHELL[tone]].join(' ')}>
      <div className="flex gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="font-medium">{title}</span>
      </div>
      {children}
    </div>
  );
}

/** 409 aggregate SHORTAGE — one row per short line, nothing was deducted. */
export function LoShortagePanel({ details }: { details: LoShortageDetail[] }) {
  return (
    <LoErrorBanner tone="warning" icon={AlertTriangle} title="Not enough stock to process — nothing was deducted.">
      <ul className="space-y-1 pl-6 text-xs">
        {details.map((d, i) => (
          <li key={`${d.item_id}-${d.location_id}-${i}`} className="flex flex-wrap gap-x-1.5">
            <span className="font-medium">{d.item_name || d.item_sku || 'Item'}</span>
            <span>at {d.location_name ?? 'this location'}:</span>
            <span>
              {d.available} on hand, {d.requested} needed.
            </span>
          </li>
        ))}
      </ul>
      <p className="pl-6 text-xs">
        Restock or transfer from the{' '}
        <Link to="/inventory" className="underline">
          Inventory page
        </Link>
        , or lower the quantity and try again.
      </p>
    </LoErrorBanner>
  );
}

/** 422 LO_LINE_INVALID — one row per bad line; the server's `message` is already human. */
export function LoLineInvalidPanel({ details }: { details: LoLineInvalidDetail[] }) {
  return (
    <LoErrorBanner tone="warning" icon={AlertTriangle} title="These lines need fixing before you can save.">
      <ul className="space-y-1 pl-6 text-xs">
        {details.map((d, i) => {
          const label = d.item_name || d.item_sku;
          return (
            <li key={`${d.line_id ?? 'order'}-${i}`} className="flex flex-wrap gap-x-1.5">
              {label && <span className="font-medium">{label}:</span>}
              <span>{d.message}</span>
            </li>
          );
        })}
      </ul>
    </LoErrorBanner>
  );
}

/** 409 STALE_STATUS — the order moved on since it was opened; the view must reload. */
export function LoStaleStatusNotice({ onReload }: { onReload?: () => void }) {
  return (
    <LoErrorBanner tone="info" icon={RefreshCw} title="This order changed since you opened it — reload to see the latest.">
      {onReload && (
        <div className="pl-6">
          <Button type="button" variant="outline" size="sm" onClick={onReload}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Reload
          </Button>
        </div>
      )}
    </LoErrorBanner>
  );
}

/** Terminal / non-recoverable LO errors (item swap, anchor gone, job cancelled). */
function LoHardErrorBanner({ message }: { message: string }) {
  return <LoErrorBanner tone="danger" icon={Ban} title={message} />;
}

/**
 * The one entry point the editor calls: `<LoErrorView error={extractLoError(err)} onReload={…} />`.
 * Renders nothing for a null error (not an LO error — the caller shows its own generic toast).
 */
export function LoErrorView({
  error,
  onReload,
}: {
  error: LoApiError | null;
  onReload?: () => void;
}) {
  if (!error) return null;
  switch (error.kind) {
    case 'SHORTAGE':
      return <LoShortagePanel details={error.details} />;
    case 'LO_LINE_INVALID':
      return <LoLineInvalidPanel details={error.details} />;
    case 'STALE_STATUS':
      return <LoStaleStatusNotice onReload={onReload} />;
    case 'ITEM_SWAP_FORBIDDEN':
    case 'ANCHOR_NOT_FOUND':
    case 'JOB_CANCELLED':
      return <LoHardErrorBanner message={error.message} />;
    default:
      return null;
  }
}

/**
 * Warn-mode surfacing after a successful process (org allows negative stock): the response carries
 * `warnings[]` — lines that went (or stayed) below zero. Toast once. LO-native analog of
 * `toastStockWarning`; uses only payload fields (itemName / onHandAfter — locationId has no name here).
 */
export function toastLoWarnings(result: Pick<ProcessLogisticOrderResult, 'warnings'>): void {
  const warnings = result?.warnings ?? [];
  const first = warnings[0];
  if (!first) return;
  const name = first.itemName || first.itemSku || 'A line';
  const more = warnings.length - 1;
  const description =
    more > 0
      ? `${name} and ${more} more went below zero after processing.`
      : `${name} is now ${first.onHandAfter ?? 'below zero'} on hand after processing.`;
  toast({ title: 'Processed — stock went negative', description });
}
