/**
 * Pure, framework-free logic for the "Communication Tracking & QA" report.
 *
 * Ported VERBATIM from the backend service:
 * backend/src/services/communication-tracking-report.ts
 * Keep the two files in LOCKSTEP — edit one, mirror the other.
 *
 * Operates on plain normalized rows (no Prisma, no Express) so it is fully
 * unit-testable and runs on the frontend demo-data path.
 *
 * Spec: md_files/specs/reporting/2026-06-06-communication-tracking-qa-PRD.md
 *
 * The unified "Touch": a connected call (durationSec >= CONNECTED_MIN_SEC) is
 * one touch; a text thread with a two-way exchange within one calendar day is
 * one touch (deduped per day). Non-qualifying calls/texts are "attempts".
 */

export type CommRole = 'csr' | 'sales' | 'dispatch' | 'tech';
export type Channel = 'call' | 'text';
export type CallDir = 'inbound' | 'outbound';
export type TextDir = 'in' | 'out';

export interface CommConfig {
  connectedMinSec: number;
  staleDays: number;
  deltaWindowDays: number;
  reviewThreshold: number;
  bandMin: number;
  bandMax: number;
  /** Per-job-type band overrides; falls back to bandMin/bandMax. */
  bandByJobType: Record<string, { min: number; max: number }>;
}

export const DEFAULT_CONFIG: CommConfig = {
  connectedMinSec: 20,
  staleDays: 7,
  deltaWindowDays: 14,
  reviewThreshold: 70,
  bandMin: 5,
  bandMax: 12,
  bandByJobType: {},
};

export interface RawCall {
  id: string;
  jobId: string | null;
  customerId: string | null;
  repId: string | null;
  role: CommRole;
  direction: CallDir;
  startedAt: string; // ISO
  durationSec: number;
}

export interface RawTextMessage {
  threadId: string;
  jobId: string | null;
  customerId: string | null;
  repId: string | null; // who sent (out); null for inbound
  role: CommRole;
  direction: TextDir;
  ts: string; // ISO
}

export interface Touch {
  jobId: string | null;
  customerId: string | null;
  repId: string | null;
  role: CommRole;
  channel: Channel;
  direction: 'inbound' | 'outbound';
  connected: boolean;
  timestamp: string; // ISO
  durationSec?: number;
  threadId?: string;
}

/** UTC calendar-day key for per-day text dedup (YYYY-MM-DD). */
function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

export function deriveTouches(
  calls: RawCall[],
  texts: RawTextMessage[],
  config: CommConfig,
): Touch[] {
  const out: Touch[] = [];

  for (const c of calls) {
    out.push({
      jobId: c.jobId,
      customerId: c.customerId,
      repId: c.repId,
      role: c.role,
      channel: 'call',
      direction: c.direction,
      connected: c.durationSec >= config.connectedMinSec,
      timestamp: c.startedAt,
      durationSec: c.durationSec,
    });
  }

  // Group texts by thread + calendar day.
  const groups = new Map<string, RawTextMessage[]>();
  for (const m of texts) {
    const key = `${m.threadId}|${dayKey(m.ts)}`;
    const arr = groups.get(key);
    if (arr) arr.push(m);
    else groups.set(key, [m]);
  }
  for (const arr of groups.values()) {
    const hasOut = arr.some((m) => m.direction === 'out');
    const hasIn = arr.some((m) => m.direction === 'in');
    const last = arr.reduce((a, b) => (a.ts >= b.ts ? a : b));
    const outMsg = arr.find((m) => m.direction === 'out');
    out.push({
      jobId: last.jobId,
      customerId: last.customerId,
      repId: outMsg?.repId ?? last.repId,
      role: last.role,
      channel: 'text',
      direction: hasOut ? 'outbound' : 'inbound',
      connected: hasOut && hasIn,
      timestamp: last.ts,
      threadId: last.threadId,
    });
  }

  out.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
  return out;
}

export interface JobRow {
  jobId: string;
  jobNumber: string;
  customerId: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
  jobType: string;
  closed: boolean;
}

export type Band = 'under' | 'healthy' | 'over';

export interface JobCadenceRow {
  jobId: string;
  jobNumber: string;
  customerName: string;
  ownerId: string;
  ownerName: string;
  jobType: string;
  touchCount: number;
  callCount: number;
  textCount: number;
  attempts: number;
  lastTouchAt: string | null;
  daysSinceLastTouch: number | null;
  band: Band;
  stale: boolean;
  min: number;
  max: number;
}

export interface CadenceStats {
  openJobs: number;
  under: number;
  over: number;
  stale: number;
  healthyPct: number;
  avgTouches: number;
}

export interface CadenceResult {
  rows: JobCadenceRow[];
  stats: CadenceStats;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function bandFor(count: number, min: number, max: number): Band {
  if (count < min) return 'under';
  if (count > max) return 'over';
  return 'healthy';
}

export function computeJobCadence(
  jobs: JobRow[],
  touches: Touch[],
  config: CommConfig,
  now: Date,
): CadenceResult {
  const byJob = new Map<string, Touch[]>();
  for (const t of touches) {
    if (!t.jobId) continue;
    const arr = byJob.get(t.jobId);
    if (arr) arr.push(t);
    else byJob.set(t.jobId, [t]);
  }

  const rows: JobCadenceRow[] = [];
  for (const j of jobs) {
    if (j.closed) continue;
    const all = byJob.get(j.jobId) ?? [];
    const connected = all.filter((t) => t.connected);
    const band = config.bandByJobType[j.jobType] ?? {
      min: config.bandMin,
      max: config.bandMax,
    };
    const lastTouch = connected.reduce<string | null>(
      (acc, t) => (acc && acc >= t.timestamp ? acc : t.timestamp),
      null,
    );
    const days =
      lastTouch === null
        ? null
        : Math.round((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
            Date.UTC(new Date(lastTouch).getUTCFullYear(), new Date(lastTouch).getUTCMonth(), new Date(lastTouch).getUTCDate())) / DAY_MS);
    rows.push({
      jobId: j.jobId,
      jobNumber: j.jobNumber,
      customerName: j.customerName,
      ownerId: j.ownerId,
      ownerName: j.ownerName,
      jobType: j.jobType,
      touchCount: connected.length,
      callCount: connected.filter((t) => t.channel === 'call').length,
      textCount: connected.filter((t) => t.channel === 'text').length,
      attempts: all.length - connected.length,
      lastTouchAt: lastTouch,
      daysSinceLastTouch: days,
      band: bandFor(connected.length, band.min, band.max),
      stale: days !== null && days > config.staleDays,
      min: band.min,
      max: band.max,
    });
  }

  const openJobs = rows.length;
  const under = rows.filter((r) => r.band === 'under').length;
  const over = rows.filter((r) => r.band === 'over').length;
  const stale = rows.filter((r) => r.stale).length;
  const healthy = rows.filter((r) => r.band === 'healthy').length;
  const totalTouches = rows.reduce((s, r) => s + r.touchCount, 0);

  // Worklist sort: under-touched + stale first, then by fewest touches.
  rows.sort((a, b) => {
    const aw = (a.band === 'under' ? 0 : 2) + (a.stale ? 0 : 1);
    const bw = (b.band === 'under' ? 0 : 2) + (b.stale ? 0 : 1);
    if (aw !== bw) return aw - bw;
    return a.touchCount - b.touchCount;
  });

  return {
    rows,
    stats: {
      openJobs,
      under,
      over,
      stale,
      healthyPct: openJobs === 0 ? 0 : Math.round((healthy / openJobs) * 100),
      avgTouches: openJobs === 0 ? 0 : Math.round((totalTouches / openJobs) * 10) / 10,
    },
  };
}

export interface RubricItem {
  key: string;
  label: string;
  hit: boolean;
}

export interface QaInteraction {
  id: string;
  kind: Channel;
  role: CommRole;
  repId: string;
  repName: string;
  jobId: string | null;
  customerName: string;
  timestamp: string;
  aiScore: number;
  managerScore?: number | null;
  disputed?: boolean;
  rubricItems: RubricItem[];
  flags: string[];
  sentiment?: 'positive' | 'neutral' | 'negative';
}

export function effectiveScore(q: QaInteraction): number {
  return q.managerScore ?? q.aiScore;
}

export interface QaRepRow {
  repId: string;
  repName: string;
  role: CommRole;
  count: number;
  callCount: number;
  textCount: number;
  avgScore: number;
}

export interface QaRoleRow {
  role: CommRole;
  count: number;
  avgScore: number;
}

export interface QaResult {
  byRep: QaRepRow[];
  byRole: QaRoleRow[];
  reviewQueue: QaInteraction[];
  avgScore: number;
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return Math.round((nums.reduce((s, n) => s + n, 0) / nums.length) * 10) / 10;
}

export function computeQa(interactions: QaInteraction[], config: CommConfig): QaResult {
  const repMap = new Map<string, QaInteraction[]>();
  const roleMap = new Map<CommRole, QaInteraction[]>();
  for (const q of interactions) {
    (repMap.get(q.repId) ?? repMap.set(q.repId, []).get(q.repId)!).push(q);
    (roleMap.get(q.role) ?? roleMap.set(q.role, []).get(q.role)!).push(q);
  }

  const byRep: QaRepRow[] = [...repMap.values()].map((list) => ({
    repId: list[0]!.repId,
    repName: list[0]!.repName,
    role: list[0]!.role,
    count: list.length,
    callCount: list.filter((q) => q.kind === 'call').length,
    textCount: list.filter((q) => q.kind === 'text').length,
    avgScore: avg(list.map(effectiveScore)),
  }));
  byRep.sort((a, b) => b.avgScore - a.avgScore);

  const byRole: QaRoleRow[] = [...roleMap.values()].map((list) => ({
    role: list[0]!.role,
    count: list.length,
    avgScore: avg(list.map(effectiveScore)),
  }));
  byRole.sort((a, b) => b.avgScore - a.avgScore);

  const reviewQueue = interactions
    .filter((q) => effectiveScore(q) < config.reviewThreshold || q.disputed)
    .sort((a, b) => effectiveScore(a) - effectiveScore(b));

  return {
    byRep,
    byRole,
    reviewQueue,
    avgScore: avg(interactions.map(effectiveScore)),
  };
}

export interface TrainingCompletionRec {
  repId: string;
  repName: string;
  role: CommRole;
  scenarioId: string;
  scenarioTitle: string;
  completedAt: string;
}

export interface TrainingImpactRow {
  repId: string;
  repName: string;
  role: CommRole;
  scenarioTitle: string;
  completedAt: string;
  before: number;
  after: number;
  delta: number;
  beforeN: number;
  afterN: number;
  improved: boolean;
}

export interface NeedsTrainingRow {
  repId: string;
  repName: string;
  role: CommRole;
  avgScore: number;
  count: number;
}

export interface TrainingImpactResult {
  rows: TrainingImpactRow[];
  needsTraining: NeedsTrainingRow[];
  avgDelta: number;
}

export function computeTrainingImpact(
  completions: TrainingCompletionRec[],
  interactions: QaInteraction[],
  config: CommConfig,
): TrainingImpactResult {
  const windowMs = config.deltaWindowDays * DAY_MS;

  const rows: TrainingImpactRow[] = completions.map((c) => {
    const done = new Date(c.completedAt).getTime();
    const sameRepRole = interactions.filter(
      (q) => q.repId === c.repId && q.role === c.role,
    );
    const beforeList = sameRepRole.filter((q) => {
      const t = new Date(q.timestamp).getTime();
      return t < done && t >= done - windowMs;
    });
    const afterList = sameRepRole.filter((q) => {
      const t = new Date(q.timestamp).getTime();
      return t > done && t <= done + windowMs;
    });
    const before = avg(beforeList.map(effectiveScore));
    const after = avg(afterList.map(effectiveScore));
    return {
      repId: c.repId,
      repName: c.repName,
      role: c.role,
      scenarioTitle: c.scenarioTitle,
      completedAt: c.completedAt,
      before,
      after,
      delta: Math.round((after - before) * 10) / 10,
      beforeN: beforeList.length,
      afterN: afterList.length,
      improved: beforeList.length > 0 && afterList.length > 0 && after > before,
    };
  });

  // Reps below threshold whose role has no completion.
  const trainedRoles = new Set(completions.map((c) => `${c.repId}|${c.role}`));
  const repRoleMap = new Map<string, QaInteraction[]>();
  for (const q of interactions) {
    const key = `${q.repId}|${q.role}`;
    (repRoleMap.get(key) ?? repRoleMap.set(key, []).get(key)!).push(q);
  }
  const needsTraining: NeedsTrainingRow[] = [];
  for (const [key, list] of repRoleMap.entries()) {
    const avgScore = avg(list.map(effectiveScore));
    if (avgScore < config.reviewThreshold && !trainedRoles.has(key)) {
      needsTraining.push({
        repId: list[0]!.repId,
        repName: list[0]!.repName,
        role: list[0]!.role,
        avgScore,
        count: list.length,
      });
    }
  }
  needsTraining.sort((a, b) => a.avgScore - b.avgScore);

  return {
    rows,
    needsTraining,
    avgDelta: avg(rows.filter((r) => r.beforeN > 0 && r.afterN > 0).map((r) => r.delta)),
  };
}

export interface ReportInput {
  jobs: JobRow[];
  calls: RawCall[];
  texts: RawTextMessage[];
  qa: QaInteraction[];
  completions: TrainingCompletionRec[];
  config: CommConfig;
}

export interface CommReportPayload {
  cadence: CadenceResult;
  qa: QaResult;
  training: TrainingImpactResult;
}

export function buildReport(input: ReportInput, now: Date): CommReportPayload {
  const touches = deriveTouches(input.calls, input.texts, input.config);
  return {
    cadence: computeJobCadence(input.jobs, touches, input.config, now),
    qa: computeQa(input.qa, input.config),
    training: computeTrainingImpact(input.completions, input.qa, input.config),
  };
}
