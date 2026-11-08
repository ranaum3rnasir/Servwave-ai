// Phone module — Dispatch & Calls view.
//
// Faithful cut from Emanuel's PhonePage monolith (L4346-4491). Behavior is
// verbatim; only two classes of change were made:
//   1. Tailwind tokens swapped indigo/slate -> ALPHA design tokens
//      (primary / text-primary / text-secondary / border / background-light).
//      emerald, amber, rose, sky, violet are kept verbatim (status colors).
//   2. Data comes from the `@/lib/api/communication` seam: the customer array
//      feeds the kernel `customerById(customers, id)` lookup; `fmtPhone` and
//      `DISPOSITION_LABELS` come from the seam too. The `calls`/`setCalls`
//      controlled props are owned by the shell and kept verbatim.
//
// View-specific note: the callback queue is ordered by expected lost revenue
// (highest first) so the calls worth the most recovery surface at the top.
import { useState } from "react";
import { AlertTriangle, PhoneMissed, Voicemail } from "lucide-react";
import {
  DISPOSITION_LABELS,
  fmtPhone,
  type CallSession,
} from "@/lib/api/communication";
import { usePhoneCustomers } from "@/lib/api/communication";
import {
  AnsweredBy,
  customerById,
  DirIcon,
  shortTime,
} from "@/components/communication/phone/shared";
import { CallDetailDrawer } from "@/components/communication/phone/CallsView";
import { useScheduleTimezone } from '@/lib/schedule-tz';

/* ─────────────────── Dispatch & Calls ─────────────────── */

export function DispatchView({
  calls,
  setCalls,
  onToast,
}: {
  calls: CallSession[];
  setCalls: React.Dispatch<React.SetStateAction<CallSession[]>>;
  onToast: (m: string) => void;
}) {
  const { data: customers = [] } = usePhoneCustomers();
  const tz = useScheduleTimezone();
  // Callback queue: missed + voicemail, ordered by expected lost revenue.
  const queue = calls
    .filter((c) => c.status === "missed" || c.status === "voicemail")
    .sort((a, b) => (b.revenue ?? 0) - (a.revenue ?? 0));
  const [selectedCall, setSelectedCall] = useState<CallSession | null>(null);

  function clearFromQueue(id: string) {
    setCalls((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status: "completed", disposition: c.disposition ?? "follow_up" } : c)),
    );
    onToast("✓ Removed from callback queue");
  }

  return (
    <div className="space-y-4 p-4">
      {/* Callback queue + recent calls (the standalone softphone dock was
          removed — calling now lives in the Dialer popup). */}
      <div className="space-y-4">
        <section className="rounded-card border border-border bg-surface-light">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              <PhoneMissed className="h-3.5 w-3.5 text-warning" /> Callback queue
            </span>
            <span className="text-[11px] text-text-secondary">{queue.length} to recover</span>
          </div>
          {queue.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-text-secondary">Queue clear — nice.</p>
          ) : (
            <ul className="divide-y divide-border">
              {queue.map((c) => {
                const cust = customerById(customers, c.customerId);
                return (
                  <li
                    key={c.id}
                    onClick={() => setSelectedCall(c)}
                    title="Open call details"
                    className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-primary/10"
                  >
                    <div className="mt-0.5">
                      {c.status === "voicemail" ? (
                        <Voicemail className="h-4 w-4 text-info" />
                      ) : (
                        <PhoneMissed className="h-4 w-4 text-warning" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-text-primary">
                        {cust?.name ?? fmtPhone(c.fromNumber)}
                        <span className="ml-2 text-[10px] font-normal uppercase tracking-wide text-text-secondary">
                          {c.status} · {shortTime(c.startedAt, tz)}
                        </span>
                      </p>
                      {c.summary && <p className="truncate text-[12px] text-text-secondary">{c.summary}</p>}
                      {c.reviewFlag && (
                        <span className="mt-1 inline-flex items-center gap-1 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">
                          <AlertTriangle className="h-3 w-3" /> {c.reviewFlag}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        clearFromQueue(c.id);
                      }}
                      className="flex-shrink-0 rounded-md border border-border px-2 py-1 text-[11px] font-semibold text-text-secondary hover:bg-background-light"
                    >
                      Resolve
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="rounded-card border border-border bg-surface-light">
          <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            Recent calls
          </div>
          <table className="w-full text-xs">
            <thead className="bg-background-light text-[10px] uppercase tracking-wide text-text-secondary">
              <tr>
                <th className="px-3 py-2 text-left">Dir</th>
                <th className="px-3 py-2 text-left">Caller</th>
                <th className="px-3 py-2 text-left">Answered by</th>
                <th className="px-3 py-2 text-left">Disposition</th>
                <th className="px-3 py-2 text-left">Source</th>
                <th className="px-3 py-2 text-right">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {calls.map((c) => {
                const cust = customerById(customers, c.customerId);
                return (
                  <tr
                    key={c.id}
                    onClick={() => setSelectedCall(c)}
                    title="Open call details"
                    className="cursor-pointer hover:bg-primary/10"
                  >
                    <td className="px-3 py-2">
                      <DirIcon call={c} />
                    </td>
                    <td className="px-3 py-2">
                      <p className="font-semibold text-text-primary">{cust?.name ?? fmtPhone(c.fromNumber)}</p>
                      {c.summary && <p className="max-w-[260px] truncate text-[11px] text-text-secondary">{c.summary}</p>}
                    </td>
                    <td className="px-3 py-2">
                      <AnsweredBy call={c} />
                    </td>
                    <td className="px-3 py-2">
                      {c.disposition ? (
                        <span className="rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                          {DISPOSITION_LABELS[c.disposition]}
                        </span>
                      ) : (
                        <span className="text-text-secondary">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-text-secondary">{c.trackingSource ?? "—"}</td>
                    <td className="px-3 py-2 text-right font-mono text-text-secondary">{shortTime(c.startedAt, tz)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      {selectedCall && (
        <CallDetailDrawer
          call={selectedCall}
          onClose={() => setSelectedCall(null)}
          onToast={onToast}
        />
      )}
    </div>
  );
}
