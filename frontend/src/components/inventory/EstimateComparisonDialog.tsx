import { useMemo } from "react";
import {
  AlertOctagon,
  CheckCircle2,
  ClipboardList,
  Crown,
  DollarSign,
  Flame,
  Package,
  Star,
  Timer,
  TrendingDown,
  Zap,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { useInventoryItems, useVendors } from "@/lib/api/inventory";
import { formatCurrency } from "@/lib/utils";
import {
  generateQuotes,
  quoteSuperlatives,
  type RFQLine,
  type VendorQuote,
} from "@/lib/inventory/rfq-mock";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  lines: RFQLine[];
  zIndex?: number;
  lockEscape?: boolean;
  /**
   * Called when the user picks a winning quote. Parent should write the
   * winning vendor back onto every line and close the dialog.
   */
  onPickWinner: (quote: VendorQuote) => void;
};

// Canonical formatter - reads the org's configured currency rather than
// hardcoding USD.
const fmtMoney = formatCurrency;

function Stars({ value }: { value: number }) {
  const full = Math.floor(value);
  const half = value - full >= 0.5;
  return (
    <span className="inline-flex items-center gap-0.5" title={`${value} / 5`}>
      {Array.from({ length: 5 }).map((_, i) => {
        const filled = i < full || (i === full && half);
        return (
          <Star
            key={i}
            className={`h-3 w-3 ${filled ? "fill-warning text-warning" : "text-border"}`}
          />
        );
      })}
    </span>
  );
}

export function EstimateComparisonDialog({
  open,
  onClose,
  lines,
  zIndex: _zIndex,
  lockEscape,
  onPickWinner,
}: Props) {
  // Seam data — generateQuotes was re-signatured to (lines, allItems, allVendors)
  // so the mock catalog + vendor lists flow in from the query layer, not a
  // module-scope import.
  const { data: items = [] } = useInventoryItems();
  const { data: vendors = [] } = useVendors();

  const quotes = useMemo(
    () => generateQuotes(lines, items, vendors),
    [lines, items, vendors],
  );
  const superlatives = useMemo(() => quoteSuperlatives(quotes), [quotes]);
  const winner = quotes.find((q) => q.recommended);
  const cheapestTotal =
    quotes.length > 0 ? Math.min(...quotes.map((q) => q.total)) : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Estimate Comparison · ${quotes.length} vendor${quotes.length === 1 ? "" : "s"}`}
      subtitle={`RFQ on ${lines.length} item${lines.length === 1 ? "" : "s"} · ranked by composite score (60% price · 25% lead · 15% reliability)`}
      size="xl"
      lockEscape={lockEscape}
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          {/* Raw by design: no `success` tone is minted on Button (see
              button.tsx header note - deferred, zero measured call sites);
              danger/neutral would misrepresent this as a warning/plain
              action instead of the positive recommended choice. */}
          <button
            type="button"
            disabled={!winner}
            onClick={() => winner && onPickWinner(winner)}
            className="inline-flex items-center gap-1.5 rounded-md bg-success px-3 py-1.5 text-sm font-semibold text-on-fill shadow-sm hover:bg-success disabled:cursor-not-allowed disabled:bg-border"
            title={winner ? `Use ${winner.vendor.name} for this PO` : ""}
          >
            <Crown className="h-3.5 w-3.5" />
            Use Recommended · {winner?.vendor.name ?? ""}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Empty state */}
        {quotes.length === 0 && (
          <div className="rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-xs text-warning">
            Add at least one line item to request quotes.
          </div>
        )}

        {/* Recommendation banner */}
        {winner && (
          <div className="rounded-card border-2 border-success/20 bg-gradient-to-r from-success/10 via-success/10 to-surface-light p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <div className="rounded-full bg-success p-1.5 text-on-fill shadow-sm">
                  <Crown className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-success">
                    Recommended
                  </div>
                  <div className="text-base font-bold text-text-primary">
                    {winner.vendor.name}
                  </div>
                  <div className="mt-0.5 text-[11px] text-text-secondary">
                    Best composite score across price · lead time · reliability
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                <span className="inline-flex items-center gap-1 font-mono text-base font-bold text-success">
                  <DollarSign className="h-3.5 w-3.5" />
                  {fmtMoney(winner.total)}
                </span>
                <span className="inline-flex items-center gap-1 text-text-secondary">
                  <Timer className="h-3 w-3 text-primary" />
                  {winner.avgLeadDays}-day lead
                </span>
                <Stars value={winner.reliabilityScore} />
                <span className="text-text-secondary">
                  ({winner.pastJobsWithUs} past jobs)
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Quote cards grid */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          {quotes.map((q) => {
            const isWinner = q.recommended;
            const isCheapest = q.vendor.id === superlatives.cheapestVendorId;
            const isFastest = q.vendor.id === superlatives.fastestVendorId;
            const isMostReliable =
              q.vendor.id === superlatives.mostReliableVendorId;
            const deltaPct =
              cheapestTotal > 0
                ? ((q.total - cheapestTotal) / cheapestTotal) * 100
                : 0;
            return (
              <div
                key={q.vendor.id}
                className={[
                  "flex flex-col rounded-card border bg-surface-light shadow-sm transition",
                  isWinner
                    ? "border-success/20 ring-2 ring-success/20"
                    : "border-border",
                ].join(" ")}
              >
                {/* Card header */}
                <div
                  className={[
                    "rounded-t-lg border-b px-3 py-2",
                    isWinner
                      ? "border-success/20 bg-success/10"
                      : "border-border bg-background-light/60",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {isWinner && (
                        <Crown className="h-3.5 w-3.5 text-success" />
                      )}
                      <span className="truncate text-sm font-bold text-text-primary">
                        {q.vendor.name}
                      </span>
                    </div>
                    <span className="rounded-full bg-surface-light px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-secondary ring-1 ring-border">
                      #{q.rank}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-text-secondary">
                    {q.vendor.category} · {q.vendor.paymentTerms}
                  </div>
                </div>

                {/* Body */}
                <div className="flex flex-col gap-2 p-3">
                  {/* Totals + KPIs */}
                  <div className="flex items-baseline justify-between">
                    <span className="font-mono text-xl font-bold text-text-primary">
                      {fmtMoney(q.total)}
                    </span>
                    {isCheapest ? (
                      <span className="inline-flex items-center gap-0.5 rounded bg-success/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-success">
                        <TrendingDown className="h-2.5 w-2.5" />
                        Cheapest
                      </span>
                    ) : (
                      <span className="text-[10px] font-medium text-danger">
                        +{deltaPct.toFixed(1)}% vs cheapest
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                    <span className="inline-flex items-center gap-1 text-text-secondary">
                      <Timer className="h-3 w-3 text-primary" />
                      {q.avgLeadDays}-day lead
                      {isFastest && (
                        <span className="ml-0.5 inline-flex items-center gap-0.5 rounded bg-primary-subtle px-1 py-px text-[8px] font-semibold uppercase text-primary">
                          <Zap className="h-2 w-2" />
                          Fastest
                        </span>
                      )}
                    </span>
                    <span className="inline-flex items-center gap-1 text-text-secondary">
                      <Stars value={q.reliabilityScore} />
                      {q.reliabilityScore.toFixed(1)}
                      {isMostReliable && (
                        <span className="ml-0.5 inline-flex items-center gap-0.5 rounded bg-warning/10 px-1 py-px text-[8px] font-semibold uppercase text-warning">
                          <Flame className="h-2 w-2" />
                          Top-rated
                        </span>
                      )}
                    </span>
                  </div>

                  <div className="text-[10px] text-text-secondary">
                    {q.pastJobsWithUs} past jobs · {q.vendor.transmitMethod}
                  </div>

                  {q.notes && (
                    <div className="mt-1 flex items-start gap-1 rounded border border-warning/20 bg-warning/10 px-1.5 py-1 text-[10px] text-warning">
                      <AlertOctagon className="mt-px h-2.5 w-2.5 flex-shrink-0" />
                      <span>{q.notes}</span>
                    </div>
                  )}

                  {/* Line breakdown */}
                  <div className="mt-1 overflow-hidden rounded border border-border">
                    <table className="w-full text-[10px]">
                      <thead className="bg-background-light text-[9px] uppercase tracking-wide text-text-secondary">
                        <tr>
                          <th className="px-2 py-1 text-left font-semibold">Item</th>
                          <th className="px-1 py-1 text-right font-semibold">Qty</th>
                          <th className="px-1 py-1 text-right font-semibold">Unit</th>
                          <th className="px-1 py-1 text-right font-semibold">Ext</th>
                        </tr>
                      </thead>
                      <tbody>
                        {q.lines.map((ql) => (
                          <tr
                            key={ql.itemSku}
                            className="border-t border-border"
                          >
                            <td className="px-2 py-1">
                              <code className="font-mono text-[9px] text-text-secondary">
                                {ql.itemSku}
                              </code>
                              {!ql.inStock && (
                                <span className="ml-1 inline-flex items-center rounded bg-warning/10 px-1 text-[8px] font-semibold uppercase text-warning">
                                  BO
                                </span>
                              )}
                            </td>
                            <td className="px-1 py-1 text-right font-mono">
                              {ql.qty} {ql.uom}
                            </td>
                            <td className="px-1 py-1 text-right font-mono text-text-secondary">
                              {fmtMoney(ql.unitCost)}
                            </td>
                            <td className="px-1 py-1 text-right font-mono font-semibold text-text-primary">
                              {fmtMoney(ql.ext)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Use this vendor CTA. Raw by design: the isWinner branch
                      needs the unminted `success` tone (see the footer CTA
                      above); kept as one raw control rather than splitting
                      this single semantic action into two diverging
                      implementations by state. */}
                  <button
                    type="button"
                    onClick={() => onPickWinner(q)}
                    className={[
                      "mt-1 inline-flex w-full items-center justify-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-semibold transition",
                      isWinner
                        ? "bg-success text-on-fill shadow-sm hover:bg-success"
                        : "border border-border bg-surface-light text-text-secondary hover:bg-background-light",
                    ].join(" ")}
                  >
                    {isWinner ? (
                      <>
                        <CheckCircle2 className="h-3 w-3" />
                        Use This Vendor (Recommended)
                      </>
                    ) : (
                      <>
                        <ClipboardList className="h-3 w-3" />
                        Use {q.vendor.name.split(/[\s/]/)[0]} Anyway
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Scoring formula explainer */}
        <div className="rounded-md border border-border bg-background-light/60 px-3 py-2 text-[10px] text-text-secondary">
          <div className="font-semibold uppercase tracking-wide text-text-secondary">
            How we ranked these
          </div>
          <p className="mt-0.5">
            <span className="font-mono">composite = price_score × 0.6 + lead_score × 0.25 + reliability_score × 0.15</span>
          </p>
          <p className="mt-0.5">
            Each metric is normalized to the best quote in this RFQ (lowest
            price / shortest lead / highest reliability = 1.0). The vendor with
            the highest composite is flagged Recommended; ties break on lowest
            total.
          </p>
        </div>

        {/* Lines preview / what was RFQ'd */}
        <div className="rounded-md border border-border bg-surface-light px-3 py-2">
          <div className="mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
            <span>RFQ Sent To {quotes.length} Vendors</span>
            <span className="inline-flex items-center gap-1 text-success">
              <Package className="h-3 w-3" />
              {lines.length} item{lines.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="space-y-0.5 text-[11px] text-text-secondary">
            {lines.slice(0, 4).map((l) => (
              <div key={l.itemSku} className="font-mono">
                <span className="text-text-secondary">•</span>{" "}
                <span className="text-text-secondary">{l.itemSku}</span>
                {l.itemName && (
                  <span className="text-text-secondary"> — {l.itemName}</span>
                )}
                <span className="text-text-secondary">
                  {" · "}
                  {l.qty} {l.uom}
                </span>
              </div>
            ))}
            {lines.length > 4 && (
              <div className="text-[10px] italic text-text-secondary">
                +{lines.length - 4} more…
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
