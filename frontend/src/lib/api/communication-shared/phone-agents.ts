// Agent roster — human CSRs + AI agents managed on one yardstick
// (PHONE-SYSTEM-PRD §4 / R05: "manage AI like a named employee").
// Prototype seeds for the Performance / QA view.

export type AgentKind = "human" | "ai";

export type PhoneAgent = {
  id: string;
  kind: AgentKind;
  name: string;
  role: string;
  /** The ServWave user this agent row represents, when it is linked to one.
   *  A real call's `answeredBy.id` is a USER id, so this - not `id` - is what
   *  matches an answered call to its answerer (see `agentMatchesId`). */
  userId?: string;
  linkedUser?: { id: string; name: string; email: string };
  calls: number;
  answerRatePct: number; // % of offered calls answered
  bookingRatePct: number; // booked / eligible
  ahtSec: number; // average handle time
  sentimentPct: number; // % positive/neutral
  revenue: number; // attributed revenue this period
  /** % of monitored calls that followed the approved call script (greeting,
   *  qualifying questions, quote framing, close). Low = coaching needed. */
  scriptAdherencePct: number;
  /** AI-only: % of calls fully handled without human transfer (§4 / R05). */
  containmentPct?: number;
};

/** Script adherence below this needs a manager's attention / coaching. */
export const SCRIPT_ATTENTION_THRESHOLD = 85;

export function fmtAht(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}
