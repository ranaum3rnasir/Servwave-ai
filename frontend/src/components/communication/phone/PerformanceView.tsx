// Phone module — Performance view.
//
// Ported from Emanuel's PhonePage monolith (L4524-4815): PerformanceView,
// AgentDetailDrawer, ScriptScore. One-yardstick scorecard — human CSRs and the
// AI receptionist scored on the same metrics (booking rate, sentiment, script
// adherence, attributed revenue) per PRD §4 / R05.
//
// Faithful cut: prop signatures and behavior preserved verbatim. Changes are
// import-shape (data from the `@/lib/api/communication` seam), shared-kernel
// reuse (Stat, DirIcon, customerById, partyNumber), and token-swap only.
import { useMemo, useState } from "react";
import { AlertTriangle, Bot, ChevronDown, User } from "lucide-react";
import type { CallSession, PhoneAgent } from "@/lib/api/communication";
import {
  usePhoneAgents,
  usePhoneCustomers,
  fmtAht,
  fmtPhone,
  DISPOSITION_LABELS,
  SCRIPT_ATTENTION_THRESHOLD,
} from "@/lib/api/communication";
import {
  Stat,
  DirIcon,
  customerById,
  partyNumber,
  dayLabel,
  shortTime,
} from "@/components/communication/phone/shared";
import { CallDetailDrawer } from "@/components/communication/phone/CallsView";
import { agentMatchesId } from "@/components/communication/phone/useCallsPipeline";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useScheduleTimezone } from '@/lib/schedule-tz';

export function PerformanceView({
  calls,
  onToast,
}: {
  calls: CallSession[];
  onToast: (m: string) => void;
}) {
  const { data: phoneAgents = [] } = usePhoneAgents();
  const totalRevenue = useMemo(
    () => phoneAgents.reduce((s, a) => s + a.revenue, 0),
    [phoneAgents],
  );
  const [selectedAgent, setSelectedAgent] = useState<PhoneAgent | null>(null);
  const [selectedCall, setSelectedCall] = useState<CallSession | null>(null);

  // Real orgs have no phone_agents rows (agent scorecards are a demo prototype);
  // render an honest empty state rather than agent grids of zeros.
  if (phoneAgents.length === 0) {
    return (
      <div className="p-4">
        <div className="rounded-card border border-border bg-surface-light p-10 text-center">
          <p className="text-sm font-semibold text-text-primary">
            No agent analytics yet
          </p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] text-text-secondary">
            Agent performance appears here once your calls are handled by a phone
            agent.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {phoneAgents.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => setSelectedAgent(a)}
            title={`Open ${a.name}'s performance`}
            className="rounded-lg border border-border bg-surface-light p-3 text-left transition hover:border-primary hover:shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/10"
          >
            <div className="flex items-center gap-2">
              <div
                className={[
                  "flex h-9 w-9 items-center justify-center rounded-full",
                  a.kind === "ai" ? "bg-ai-50 text-ai-600" : "bg-background-light text-text-secondary",
                ].join(" ")}
              >
                {a.kind === "ai" ? <Bot className="h-4 w-4" /> : <User className="h-4 w-4" />}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-text-primary">{a.name}</p>
                <p className="text-[11px] text-text-secondary">{a.role}</p>
              </div>
              {a.kind === "ai" && (
                <span className="ml-auto rounded-full bg-ai-50 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-ai-600">
                  AI agent
                </span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Stat label="Calls" value={String(a.calls)} />
              <Stat label="Answer rate" value={`${a.answerRatePct}%`} />
              <Stat label="Booking rate" value={`${a.bookingRatePct}%`} />
              <Stat label="AHT" value={fmtAht(a.ahtSec)} />
              {a.containmentPct != null && <Stat label="Containment" value={`${a.containmentPct}%`} />}
              <Stat label="Revenue" value={`$${(a.revenue / 1000).toFixed(1)}k`} />
            </div>
          </button>
        ))}
      </div>

      <section className="rounded-card border border-border bg-surface-light">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            Scorecard · this period
          </span>
          <span className="text-[11px] text-text-secondary">
            ${(totalRevenue / 1000).toFixed(1)}k attributed revenue
          </span>
        </div>
        <table className="w-full text-xs">
          <thead className="bg-background-light text-[10px] uppercase tracking-wide text-text-secondary">
            <tr>
              <th className="px-3 py-2 text-left">Agent</th>
              <th className="px-3 py-2 text-left">Type</th>
              <th className="px-3 py-2 text-right">Calls</th>
              <th className="px-3 py-2 text-right">Booking</th>
              <th className="px-3 py-2 text-left">Sentiment</th>
              <th className="px-3 py-2 text-left">Script</th>
              <th className="px-3 py-2 text-right">Revenue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {phoneAgents.map((a) => (
              <tr
                key={a.id}
                onClick={() => setSelectedAgent(a)}
                title={`Open ${a.name}'s performance`}
                className="cursor-pointer hover:bg-primary/5"
              >
                <td className="px-3 py-2 font-semibold text-text-primary">{a.name}</td>
                <td className="px-3 py-2 capitalize text-text-secondary">{a.kind}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{a.calls}</td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">{a.bookingRatePct}%</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-success/10">
                      <div className="h-full rounded-full bg-success" style={{ width: `${a.sentimentPct}%` }} />
                    </div>
                    <span className="font-mono text-[10px] text-text-secondary">{a.sentimentPct}%</span>
                  </div>
                </td>
                <td className="px-3 py-2">
                  <ScriptScore pct={a.scriptAdherencePct} />
                </td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-text-primary">
                  ${(a.revenue / 1000).toFixed(1)}k
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-border bg-background-light px-3 py-2 text-[10px] italic text-text-secondary">
          Human CSRs and the AI receptionist are scored on one yardstick — booking
          rate, sentiment, script adherence, and attributed revenue.
        </div>
      </section>

      {selectedAgent && (
        <AgentDetailDrawer
          agent={selectedAgent}
          calls={calls}
          onClose={() => setSelectedAgent(null)}
          onOpenCall={(c) => {
            setSelectedAgent(null);
            setSelectedCall(c);
          }}
          onToast={onToast}
        />
      )}
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

function AgentDetailDrawer({
  agent,
  calls,
  onClose,
  onOpenCall,
  onToast,
}: {
  agent: PhoneAgent;
  calls: CallSession[];
  onClose: () => void;
  onOpenCall: (c: CallSession) => void;
  onToast: (m: string) => void;
}) {
  const { data: customers = [] } = usePhoneCustomers();
  const tz = useScheduleTimezone();
  // A real call's answeredBy.id is the ServWave USER id, not this row's own
  // primary key - comparing them directly is why this drawer listed zero calls
  // for every agent regardless of what ingest resolved.
  const handled = calls
    .filter((c) => agentMatchesId(agent, c.answeredBy.id))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetDescription className="sr-only">Performance details for {agent.name}</SheetDescription>
        <div className="flex items-start justify-between border-b border-border p-4 pr-12">
          <div className="flex items-center gap-3">
            <div
              className={[
                "flex h-11 w-11 items-center justify-center rounded-full",
                agent.kind === "ai"
                  ? "bg-ai-50 text-ai-600"
                  : "bg-background-light text-text-secondary",
              ].join(" ")}
            >
              {agent.kind === "ai" ? (
                <Bot className="h-5 w-5" />
              ) : (
                <User className="h-5 w-5" />
              )}
            </div>
            <div>
              <SheetTitle className="text-base font-semibold">{agent.name}</SheetTitle>
              <p className="text-[12px] text-text-secondary">
                {agent.role}
                {agent.kind === "ai" ? " · AI agent" : ""}
              </p>
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Calls" value={String(agent.calls)} />
            <Stat label="Answer rate" value={`${agent.answerRatePct}%`} />
            <Stat label="Booking rate" value={`${agent.bookingRatePct}%`} />
            <Stat label="AHT" value={fmtAht(agent.ahtSec)} />
            <Stat label="Sentiment" value={`${agent.sentimentPct}%`} />
            <Stat label="Revenue" value={`$${(agent.revenue / 1000).toFixed(1)}k`} />
            {agent.containmentPct != null && (
              <Stat label="Containment" value={`${agent.containmentPct}%`} />
            )}
          </div>

          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Script adherence
            </p>
            <ScriptScore pct={agent.scriptAdherencePct} />
          </div>

          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Calls handled ({handled.length})
            </p>
            {handled.length === 0 ? (
              <p className="text-[12px] text-text-secondary">No calls in this period.</p>
            ) : (
              <ul className="space-y-1">
                {handled.map((c) => {
                  const cust = customerById(customers, c.customerId);
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => onOpenCall(c)}
                        title="Open call details"
                        className="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-left transition hover:border-primary hover:bg-primary/5"
                      >
                        <DirIcon call={c} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-semibold text-text-primary">
                            {cust?.name ?? fmtPhone(partyNumber(c))}
                          </span>
                          <span className="block truncate text-[11px] text-text-secondary">
                            {dayLabel(c.startedAt, tz)} · {shortTime(c.startedAt, tz)}
                            {c.disposition
                              ? ` · ${DISPOSITION_LABELS[c.disposition]}`
                              : ""}
                          </span>
                        </span>
                        <ChevronDown className="h-3.5 w-3.5 -rotate-90 text-text-secondary" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="border-t border-border p-3">
          <button
            type="button"
            onClick={() => onToast(`📋 Coaching note drafted for ${agent.name}`)}
            className="w-full rounded-md bg-primary px-3 py-2 text-sm font-semibold text-on-fill transition hover:bg-primary/90"
          >
            Send coaching note
          </button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ScriptScore({ pct }: { pct: number }) {
  const needsAttention = pct < SCRIPT_ATTENTION_THRESHOLD;
  const barColor = needsAttention
    ? "bg-danger"
    : pct < 90
      ? "bg-warning"
      : "bg-success";
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-background-light">
        <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono text-[10px] text-text-secondary">{pct}%</span>
      {needsAttention && (
        <span className="inline-flex items-center gap-0.5 rounded bg-danger/10 px-1 py-0.5 text-[9px] font-semibold text-danger">
          <AlertTriangle className="h-2.5 w-2.5" /> Needs attention
        </span>
      )}
    </div>
  );
}
