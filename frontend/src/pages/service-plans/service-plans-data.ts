// ───────────────────────────────────────────────────────────────────────────
// Service Plans — pure data layer. Deterministic seeded mock generators plus
// pure derive/filter/aggregate/lifecycle functions. Shapes mirror an eventual
// GET /api/service-plans so backend wiring is a drop-in. No React here.
// ───────────────────────────────────────────────────────────────────────────
import { hashStr, mulberry32 } from '@/lib/reports/random';

export type PlanStatus =
  | 'Pending approval' | 'Active' | 'Expires soon'
  | 'Expired' | 'Pending billing' | 'Cancelled';

export type BillingFrequency = 'Monthly' | 'Quarterly' | 'Annual';
// Visit cadence is independent of billing frequency: a plan can run visits
// weekly/monthly/yearly, or 'None' for a plan with no maintenance visits.
export type VisitCadence = 'Weekly' | 'Monthly' | 'Annual' | 'None';
export type VisitStatus = 'Scheduled' | 'In progress' | 'Completed' | 'Missed';

export interface PlanLineItem { id: string; name: string; qty: number; unitPrice: number; }

export interface ServicePlan {
  id: number;
  planNumber: string;
  name: string;
  customerId: number;
  clientName: string;
  clientPhone: string;
  propertyAddress: string;
  price: number;
  billingFrequency: BillingFrequency;
  termYears: number;
  startDate: Date;
  endDate: Date;
  status: PlanStatus;
  renewalsCount: number;
  soldBy: string;
  lineItems: PlanLineItem[];
  visitCadence: VisitCadence;
  lastBillingCycle: Date | null;
  nextBillingCycle: Date | null;
}

export interface PlanVisit {
  id: number;
  planId: number;
  planNumber: string;
  planName: string;
  clientName: string;
  address: string;
  visitNumber: number;
  scheduledDate: Date;
  status: VisitStatus;
  assignedTech: string;
  jobId: number | null;
  completedAt: Date | null;
}

// ── Domain vocab (reuse Alpha names from JobStatisticsReport) ────────────────
const TECHS = ['Adam Elkarrat', 'Emanuel Dahan', 'Nadia', 'Ohad', 'Rami', 'Robert Bresnick', 'Sagiv Peker', 'Oved Adani'];
const SELLERS = ['Shani Adani', 'Nadia', 'Emanuel Dahan', 'Ohad'];
const PLAN_NAMES = ['MONITORING — Annual', 'MONITORING — Quarterly', 'Akuvox Maintenance', 'Camera Health Check', 'Access Control Care', 'Fire Panel Inspection', 'Intercom Service', 'Alarm Test & Cert'];
const STREETS = ['Jefferson St', 'Autumn Ln', 'Arsenal St', 'Market St', 'Foley St', 'Beacon St', 'Atlantic Ave', 'Hudson St', 'Grand Ave', 'Park Pl'];
const CITIES = ['Hoboken, NJ', 'Boston, MA', 'Watertown, MA', 'Lynnfield, MA', 'Somerville, MA', 'Brooklyn, NY', 'Queens, NY', 'Newark, NJ'];
const FIRST = ['Leon', 'Kevin', 'Aiden', 'Jenny', 'Marcus', 'Sofia', 'Devon', 'Priya', 'Tyler', 'Aisha', 'Omar', 'Dana'];
const LAST = ['Mills', 'Park', 'Silva', 'Owens', 'Bell', 'Reyes', 'Clark', 'Nair', 'Brooks', 'Khan', 'Cole', 'Shah'];

const FREQS: BillingFrequency[] = ['Monthly', 'Quarterly', 'Annual'];
// Visit-cadence pool for seed data — weighted so most plans have maintenance,
// some run weekly, and a meaningful share are 'None' (no maintenance).
const VISIT_CADENCES: VisitCadence[] = ['Weekly', 'Monthly', 'Monthly', 'Annual', 'Annual', 'None', 'None'];
const STATUS_MIX: PlanStatus[] = [
  ...Array(9).fill('Pending approval'),
  ...Array(47).fill('Active'),
  ...Array(7).fill('Expired'),
  ...Array(10).fill('Pending billing'),
];

const pick = <T,>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;
const cadenceMonths = (f: BillingFrequency) => (f === 'Monthly' ? 1 : f === 'Quarterly' ? 3 : 12);
const addMonths = (d: Date, m: number) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
// Advance a visit date by the cadence interval (day-aware for Weekly).
const advanceVisit = (d: Date, cadence: VisitCadence): Date => {
  const x = new Date(d);
  if (cadence === 'Weekly') x.setDate(x.getDate() + 7);
  else if (cadence === 'Annual') x.setFullYear(x.getFullYear() + 1);
  else x.setMonth(x.getMonth() + 1); // Monthly
  return x;
};
// Safety cap so a weekly plan over a multi-year term doesn't generate thousands
// of rows; bounds the in-memory visit list and keeps the visits table snappy.
const MAX_VISITS_PER_PLAN = 52;
export const pad5 = (n: number) => `SP${String(n).padStart(5, '0')}`;

export function buildPlans(seed = 'alpha-service-plans'): ServicePlan[] {
  const rng = mulberry32(hashStr(seed));
  const now = new Date();
  const plans: ServicePlan[] = [];
  for (let i = 0; i < STATUS_MIX.length; i++) {
    const id = 100 - i;
    const status = STATUS_MIX[i]!;
    const freq = pick(rng, FREQS);
    const cadence = pick(rng, VISIT_CADENCES);
    const termYears = pick(rng, [1, 2, 3, 4]);
    const startOffset = status === 'Expired' ? -termYears * 12 - 2 : Math.floor(rng() * 18) - 6;
    const startDate = addMonths(now, startOffset);
    const endDate = addMonths(startDate, termYears * 12);
    const itemCount = 1 + Math.floor(rng() * 3);
    const lineItems: PlanLineItem[] = Array.from({ length: itemCount }, (_, k) => ({
      id: `${id}-${k}`,
      name: pick(rng, ['Monitoring service', 'Annual inspection', 'Battery replacement', 'Firmware update', 'On-site visit']),
      qty: 1 + Math.floor(rng() * 2),
      unitPrice: Math.round((40 + rng() * 360) / 5) * 5,
    }));
    const price = lineItems.reduce((s, li) => s + li.qty * li.unitPrice, 0);
    const billed = status === 'Active' || status === 'Expired';
    plans.push({
      id,
      planNumber: pad5(id),
      name: pick(rng, PLAN_NAMES),
      customerId: 1 + Math.floor(rng() * 60),
      clientName: `${pick(rng, FIRST)} ${pick(rng, LAST)}`,
      clientPhone: `(917) ${String(100 + Math.floor(rng() * 900))}-${String(1000 + Math.floor(rng() * 9000))}`,
      propertyAddress: `${100 + Math.floor(rng() * 1400)} ${pick(rng, STREETS)}, ${pick(rng, CITIES)}`,
      price,
      billingFrequency: freq,
      termYears,
      startDate,
      endDate,
      status,
      renewalsCount: status === 'Expired' ? Math.floor(rng() * 2) : 0,
      soldBy: pick(rng, SELLERS),
      lineItems,
      visitCadence: cadence,
      lastBillingCycle: billed ? addMonths(startDate, cadenceMonths(freq)) : null,
      nextBillingCycle: status === 'Cancelled' ? null : addMonths(now, cadenceMonths(freq)),
    });
  }
  return plans;
}

export function buildVisitsForPlan(p: ServicePlan, startId: number, seed = 'alpha-spv'): PlanVisit[] {
  const rng = mulberry32(hashStr(`${seed}-${p.id}`));
  const now = new Date();
  const out: PlanVisit[] = [];
  // No visits for cancelled, not-yet-approved, or 'None' (no-maintenance) plans.
  if (p.status === 'Cancelled' || p.status === 'Pending approval' || p.visitCadence === 'None') return out;
  let cursor = new Date(p.startDate);
  let n = 1; let vid = startId;
  while (cursor < p.endDate && n <= MAX_VISITS_PER_PLAN) {
    const past = cursor < now;
    const status: VisitStatus = past
      ? (rng() > 0.12 ? 'Completed' : 'Missed')
      : (Math.abs(cursor.getTime() - now.getTime()) < 3 * 86400000 ? 'In progress' : 'Scheduled');
    out.push({
      id: vid++, planId: p.id, planNumber: p.planNumber, planName: p.name,
      clientName: p.clientName, address: p.propertyAddress, visitNumber: n++,
      scheduledDate: new Date(cursor), status, assignedTech: pick(rng, TECHS),
      jobId: status === 'Completed' ? 698000 + vid : null,
      completedAt: status === 'Completed' ? new Date(cursor) : null,
    });
    cursor = advanceVisit(cursor, p.visitCadence);
  }
  return out;
}

export function buildVisits(plans: ServicePlan[]): PlanVisit[] {
  let id = 1;
  const all: PlanVisit[] = [];
  for (const p of plans) {
    const vs = buildVisitsForPlan(p, id);
    id += vs.length;
    all.push(...vs);
  }
  return all;
}

// ── Derived status: an Active plan whose end is within 60 days → "Expires soon"
export function effectiveStatus(p: ServicePlan, now = new Date()): PlanStatus {
  if (p.status === 'Active' && p.endDate.getTime() - now.getTime() < 60 * 86400000 && p.endDate > now) {
    return 'Expires soon';
  }
  return p.status;
}

// ── Per-plan derived metrics ─────────────────────────────────────────────────
export function planVisits(planId: number, visits: PlanVisit[]): PlanVisit[] {
  return visits.filter((v) => v.planId === planId);
}
export function nextVisitDate(planId: number, visits: PlanVisit[], now = new Date()): Date | null {
  const up = planVisits(planId, visits)
    .filter((v) => v.scheduledDate >= now && (v.status === 'Scheduled' || v.status === 'In progress'))
    .sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime());
  return up[0]?.scheduledDate ?? null;
}
export function visitsCount(planId: number, visits: PlanVisit[]): number {
  return planVisits(planId, visits).length;
}
export function itemsCount(p: ServicePlan): number {
  return p.lineItems.reduce((s, li) => s + li.qty, 0);
}
export function billingTotal(p: ServicePlan): number {
  return p.price;
}

// ── KPI aggregates for the Clients-plans tiles ──────────────────────────────
export interface PlanKpis {
  collectedRevenue: number;
  pendingApproval: number;
  active: number;
  expiresSoon: number;
  expired: number;
}
export function computePlanKpis(plans: ServicePlan[], now = new Date()): PlanKpis {
  let collectedRevenue = 0, pendingApproval = 0, active = 0, expiresSoon = 0, expired = 0;
  for (const p of plans) {
    const s = effectiveStatus(p, now);
    if (p.lastBillingCycle) collectedRevenue += p.price;
    if (s === 'Pending approval') pendingApproval++;
    else if (s === 'Active') active++;
    else if (s === 'Expires soon') expiresSoon++;
    else if (s === 'Expired') expired++;
  }
  return { collectedRevenue, pendingApproval, active, expiresSoon, expired };
}

// ── Filtering (Clients-plans tab) ────────────────────────────────────────────
export interface PlanFilter { query: string; status: PlanStatus | 'all'; soldBy: string | 'all'; }
export function filterPlans(plans: ServicePlan[], f: PlanFilter, now = new Date()): ServicePlan[] {
  const q = f.query.trim().toLowerCase();
  return plans.filter((p) => {
    if (f.status !== 'all' && effectiveStatus(p, now) !== f.status) return false;
    if (f.soldBy !== 'all' && p.soldBy !== f.soldBy) return false;
    if (q) {
      const hay = `${p.planNumber} ${p.name} ${p.clientName} ${p.propertyAddress}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ── Visit filtering (My visits tab) ──────────────────────────────────────────
export type VisitView = 'upcoming' | 'completed' | 'missed' | 'all';
export function filterVisits(visits: PlanVisit[], view: VisitView, tech: string | 'all', now = new Date()): PlanVisit[] {
  return visits
    .filter((v) => {
      if (tech !== 'all' && v.assignedTech !== tech) return false;
      if (view === 'upcoming') return v.scheduledDate >= now && (v.status === 'Scheduled' || v.status === 'In progress');
      if (view === 'completed') return v.status === 'Completed';
      if (view === 'missed') return v.status === 'Missed';
      return true;
    })
    .sort((a, b) => a.scheduledDate.getTime() - b.scheduledDate.getTime());
}

// ── Overview analytics ───────────────────────────────────────────────────────
export function weeklyVisitTrend(visits: PlanVisit[], now = new Date()): { week: string; visits: number }[] {
  const out: { week: string; visits: number }[] = [];
  for (let i = 7; i >= 0; i--) {
    const end = new Date(now); end.setDate(now.getDate() - i * 7);
    const start = new Date(end); start.setDate(end.getDate() - 7);
    const count = visits.filter((v) => v.scheduledDate > start && v.scheduledDate <= end).length;
    out.push({ week: `W${8 - i}`, visits: count });
  }
  return out;
}
export function completedByTech(visits: PlanVisit[]): { tech: string; completed: number }[] {
  const map = new Map<string, number>();
  for (const v of visits) if (v.status === 'Completed') map.set(v.assignedTech, (map.get(v.assignedTech) ?? 0) + 1);
  return [...map.entries()].map(([tech, completed]) => ({ tech, completed })).sort((a, b) => b.completed - a.completed);
}

// ── Pure lifecycle transitions (store delegates to these) ────────────────────
export function applyApprove(p: ServicePlan): ServicePlan {
  return { ...p, status: 'Active' };
}
export function applyMarkBilled(p: ServicePlan, now = new Date()): ServicePlan {
  const step = cadenceMonths(p.billingFrequency);
  return { ...p, lastBillingCycle: now, nextBillingCycle: addMonths(now, step) };
}
export function applyRenew(p: ServicePlan): ServicePlan {
  return { ...p, status: 'Active', endDate: addMonths(p.endDate, p.termYears * 12), renewalsCount: p.renewalsCount + 1 };
}
export function applyCancel(p: ServicePlan): ServicePlan {
  return { ...p, status: 'Cancelled', nextBillingCycle: null };
}
