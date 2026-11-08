/**
 * EmployeePayrollCard — the per-employee drill-down for the Timesheets report.
 *
 * Tag header (name · period) + mini KPI strip + a per-ISO-week Time Cards
 * section. Overtime is WEEKLY-OVER-40: each week carries a single OT review pill +
 * Approve/Reject buttons keyed to that week's `reviewKey` (`${userId}:${isoWeek}`).
 * Daily hour rows are kept for display only.
 */
import { Fragment, useState } from 'react';
import {
  ArrowLeft, Check, X, ChevronRight,
  Clock, Timer, AlarmClock, CheckCircle2, Hourglass, Briefcase, Sigma,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { KpiTile } from '@/components/data/KpiStrip';
import { Heading } from '@/components/ui/heading';
import { STATUS_INTENT_CLASSES, STATUS_REGISTRY } from '@/design-system/status-registry';
import type { DayRow, PayrollRow, WeekRow } from '@/lib/timeclock/payroll';
import { buildWeeks } from '@/lib/timeclock/payroll';
import type { ReviewState } from '@/lib/timeclock/types';

const fmtHM = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;
const fmtClock = (ts: number | null) =>
  ts == null ? '—' : new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit' });

function OtPill({ state }: { state: ReviewState }) {
  // `timeclockReview` covers all four ReviewState values, so the fallback is
  // unreachable - it exists only because the registry maps are keyed by string.
  const intent = STATUS_REGISTRY.timeclockReview[state]?.intent ?? 'warning';
  const tone = STATUS_INTENT_CLASSES[intent];
  const label = state === 'none' ? 'pending' : state;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${tone}`}>{label}</span>;
}

export function EmployeePayrollCard({
  payroll,
  days,
  otReviews,
  onApproveOt,
  onRejectOt,
  onBack,
  periodLabel,
  timeZone,
}: {
  payroll: PayrollRow;
  days: DayRow[];
  /** Per-ISO-week OT review map keyed by `${userId}:${isoWeek}`. */
  otReviews: Record<string, ReviewState>;
  /** Approve/Reject the weekly OT for a given week. */
  onApproveOt: (week: WeekRow) => void;
  onRejectOt: (week: WeekRow) => void;
  onBack: () => void;
  periodLabel: string;
  /** Org IANA timezone — weeks must bucket in the org zone, matching the backend. */
  timeZone: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const weeks = buildWeeks(days, timeZone);

  const subTotal = days.reduce(
    (a, d) => ({
      worked: a.worked + d.workedMin,
      reg: a.reg + d.regMin,
      ot1: a.ot1 + d.ot1Min,
      ot2: a.ot2 + d.ot2Min,
    }),
    { worked: 0, reg: 0, ot1: 0, ot2: 0 },
  );

  return (
    <div className="space-y-4">
      <Button
        type="button"
        variant="ghost"
        tone="subtle"
        size="sm"
        className="-ml-3"
        onClick={onBack}
      >
        <ArrowLeft className="h-4 w-4" />
        All team members
      </Button>

      {/* Employee tag header */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface-light p-5 shadow-card">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary text-base font-semibold text-on-fill">
          {payroll.userName.split(' ').map((p) => p[0]).join('').slice(0, 2)}
        </div>
        <div>
          <Heading level={2} scale="lg">{payroll.userName}</Heading>
          <p className="text-sm text-text-secondary">
            Employee · {periodLabel}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-background-light px-2.5 py-1 font-medium text-text-secondary">
            {payroll.days} days
          </span>
          {payroll.lateCount > 0 && (
            <span className="rounded-full bg-danger-surface px-2.5 py-1 font-medium text-danger-text">
              {payroll.lateCount} late
            </span>
          )}
        </div>
      </div>

      {/* Mini KPI strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <KpiTile icon={Clock} label="Regular" value={fmtHM(payroll.regMin)} tone="neutral" />
        <KpiTile icon={Timer} label="OT1" value={fmtHM(payroll.ot1Min)} tone="warning" />
        <KpiTile icon={AlarmClock} label="OT2" value={fmtHM(payroll.ot2Min)} tone="warning" />
        <KpiTile icon={CheckCircle2} label="Approved OT" value={fmtHM(payroll.otApprovedMin)} tone="success" />
        <KpiTile icon={Hourglass} label="Pending OT" value={fmtHM(payroll.otPendingMin)} tone="warning" />
        <KpiTile icon={Briefcase} label="Job OT" value={fmtHM(payroll.jobOtMin)} tone="primary" />
        <KpiTile icon={Sigma} label="Total" value={fmtHM(payroll.totalMin)} tone="success" emphasize />
      </div>

      {/* Per-week Time Cards: each week has a single weekly-40 OT approval. */}
      <div className="space-y-4">
        {weeks.length === 0 && (
          <div className="rounded-xl border border-border bg-surface-light p-8 text-center text-sm text-text-secondary shadow-card">
            No days in this period.
          </div>
        )}
        {weeks.map((w) => {
          const review = otReviews[w.reviewKey] ?? 'pending';
          return (
            <div key={w.reviewKey} className="overflow-hidden rounded-xl border border-border bg-surface-light shadow-card">
              {/* Week header with the single weekly OT review */}
              <div className="flex flex-wrap items-center gap-3 border-b border-border bg-background-light px-4 py-3">
                <span className="text-sm font-semibold text-text-primary">Week {w.periodKey}</span>
                <span className="text-xs text-text-secondary">{fmtHM(w.workedMin)} worked</span>
                {w.otMin > 0 ? (
                  <div className="ml-auto flex items-center gap-2">
                    <span className="text-xs font-medium text-warning-text">OT {fmtHM(w.otMin)}</span>
                    <OtPill state={review} />
                    {w.isJobOt && (
                      <span className="rounded-full bg-primary-subtle px-2 py-0.5 text-xs font-medium text-primary">
                        job
                      </span>
                    )}
                    {(review === 'pending' || review === 'none') && (
                      <span className="flex gap-1">
                        {/* Approve/Reject pair: no ghost/success cell exists on Button, and
                            converting only the Reject half would misalign the pair's geometry
                            - same reasoning already applied to TimesheetsReport.tsx's identical
                            Approve/Reject pair. Deferred. */}
                        <button
                          type="button"
                          aria-label="Approve overtime"
                          onClick={() => onApproveOt(w)}
                          className="rounded-md p-1 text-success-text hover:bg-success-surface"
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          aria-label="Reject overtime"
                          onClick={() => onRejectOt(w)}
                          className="rounded-md p-1 text-danger-text hover:bg-danger-surface"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </span>
                    )}
                  </div>
                ) : (
                  <span className="ml-auto text-xs text-text-secondary">No overtime</span>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                  <thead>
                    <tr className="border-b border-border bg-surface-light text-xs font-semibold uppercase tracking-wide text-text-secondary">
                      <th className="w-8 px-2 py-2.5" />
                      <th className="px-3 py-2.5 text-left">Day</th>
                      <th className="px-3 py-2.5 text-left">Date</th>
                      <th className="px-3 py-2.5 text-right">Total</th>
                      <th className="px-3 py-2.5 text-right">Regular</th>
                      <th className="px-3 py-2.5 text-right">OT1</th>
                      <th className="px-3 py-2.5 text-right">OT2</th>
                      <th className="px-3 py-2.5 text-left">IN</th>
                      <th className="px-3 py-2.5 text-left">OUT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.days.map((d) => {
                      const open = expanded === d.dayKey;
                      return (
                        <Fragment key={d.dayKey}>
                          <tr
                            onClick={() => setExpanded(open ? null : d.dayKey)}
                            className="group cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-background-light/60"
                          >
                            <td className="px-2 py-3 text-text-secondary">
                              <ChevronRight className={`h-4 w-4 transition-transform ${open ? 'rotate-90' : ''}`} />
                            </td>
                            <td className="px-3 py-3 font-medium text-text-primary">{d.dayName}</td>
                            <td className="px-3 py-3 tabular-nums text-text-secondary">{fmtDate(d.dateTs)}</td>
                            <td className="px-3 py-3 text-right tabular-nums font-medium">{fmtHM(d.workedMin)}</td>
                            <td className="px-3 py-3 text-right tabular-nums">{fmtHM(d.regMin)}</td>
                            <td className="px-3 py-3 text-right tabular-nums">{d.ot1Min ? fmtHM(d.ot1Min) : '—'}</td>
                            <td className="px-3 py-3 text-right tabular-nums">{d.ot2Min ? fmtHM(d.ot2Min) : '—'}</td>
                            <td className="px-3 py-3 tabular-nums text-success-text">{fmtClock(d.inTs)}</td>
                            <td className="px-3 py-3 tabular-nums text-danger-text">{fmtClock(d.outTs)}</td>
                          </tr>
                          {open && (
                            <tr className="bg-background-light/40">
                              <td />
                              <td colSpan={8} className="px-3 py-3">
                                <div className="space-y-1.5">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                                    Punches
                                  </p>
                                  {d.sessions.map((s, i) => (
                                    <div
                                      key={i}
                                      className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border bg-surface-light px-3 py-2 text-sm"
                                    >
                                      <span className="tabular-nums text-success-text">IN {fmtClock(s.inTs)}</span>
                                      <span className="tabular-nums text-danger-text">OUT {fmtClock(s.outTs)}</span>
                                      <span className="text-text-primary">{s.matchedZoneLabel ?? 'No zone'}</span>
                                      {s.inStatus === 'in_zone' ? (
                                        <span className="rounded-full bg-success-surface px-2 py-0.5 text-xs font-medium text-success-text">
                                          In zone
                                        </span>
                                      ) : (
                                        <span className="rounded-full bg-warning-surface px-2 py-0.5 text-xs font-medium text-warning-text">
                                          Override · {s.inReview}
                                        </span>
                                      )}
                                      <span className="ml-auto tabular-nums text-text-secondary">{fmtHM(s.minutes)}</span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>

      {/* Period sub-total */}
      {days.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface-light shadow-card">
          <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
            <tfoot>
              <tr className="bg-background-light font-semibold text-text-primary">
                <td className="px-3 py-3" colSpan={3}>
                  Hours Sub Total
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{fmtHM(subTotal.worked)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmtHM(subTotal.reg)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmtHM(subTotal.ot1)}</td>
                <td className="px-3 py-3 text-right tabular-nums">{fmtHM(subTotal.ot2)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
