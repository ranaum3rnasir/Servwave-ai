// Pure logic for the Items & Services report: scoring, aggregation, KPIs.
// No React/JSX imports — mirror-able to a future backend service.

export type Kind = 'ITEM' | 'SERVICE';
export type Grade = 'A' | 'B' | 'C' | 'D';

export interface ScoreWeights { speed: number; ftf: number; margin: number; rating: number }
export const DEFAULT_WEIGHTS: ScoreWeights = { speed: 0.35, ftf: 0.30, margin: 0.20, rating: 0.15 };
export const MIN_CONFIDENT = 5;

export const clamp = (n: number, lo = 0, hi = 100): number => Math.max(lo, Math.min(hi, n));
// Faster-than-expected (negative variance) scores higher; on-time = 50.
export const speedScore = (vsExpectedPct: number): number => clamp(50 - vsExpectedPct);
export const ftfScore = (ftfPct: number): number => clamp(ftfPct);
export const marginScore = (gpPct: number): number => clamp(gpPct);
export const ratingScore = (rating: number | null): number | null =>
  rating == null ? null : clamp((rating / 5) * 100);

export function toGrade(score: number): Grade {
  return score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';
}

export interface ScoreInput { vsExpectedPct: number; ftfPct: number; gpPct: number; rating: number | null; timesDone: number }

export function compositeScore(input: ScoreInput, weights: ScoreWeights = DEFAULT_WEIGHTS): { score: number; grade: Grade; lowConfidence: boolean } {
  const parts: { w: number; s: number }[] = [
    { w: weights.speed, s: speedScore(input.vsExpectedPct) },
    { w: weights.ftf, s: ftfScore(input.ftfPct) },
    { w: weights.margin, s: marginScore(input.gpPct) },
  ];
  const rs = ratingScore(input.rating);
  if (rs != null) parts.push({ w: weights.rating, s: rs });
  const totalW = parts.reduce((a, p) => a + p.w, 0) || 1;
  let score = parts.reduce((a, p) => a + p.s * p.w, 0) / totalW;
  const lowConfidence = input.timesDone < MIN_CONFIDENT;
  if (lowConfidence) score = 50 + (score - 50) * (input.timesDone / MIN_CONFIDENT);
  const rounded = Math.round(score);
  return { score: rounded, grade: toGrade(rounded), lowConfidence };
}

export interface RawItemTech {
  itemId: string; itemName: string; kind: Kind; category: string; expectedMin: number;
  techId: string; techName: string; timesDone: number; actualMin: number; weekActualMin: number;
  ftfPct: number; gpPct: number; rating: number | null; revenue: number; gpDollars: number;
}

export interface TechItemStat {
  techId: string; techName: string; timesDone: number;
  expectedMin: number; actualMin: number; vsExpectedPct: number; vsTeamPct: number;
  ftfPct: number; gpPct: number; gpDollars: number; rating: number | null;
  score: number; grade: Grade; lowConfidence: boolean;
}

export interface ItemServiceStat {
  id: string; name: string; kind: Kind; category: string;
  timesDone: number; expectedMin: number; actualMin: number;
  variancePct: number; weekVariancePct: number;
  revenue: number; gpDollars: number; gpPct: number;
  byTech: TechItemStat[]; bestTechId: string | null; slowestTechId: string | null;
}

const wAvg = (recs: { v: number; w: number }[], fallback: number): number => {
  const tw = recs.reduce((a, r) => a + r.w, 0);
  return tw ? recs.reduce((a, r) => a + r.v * r.w, 0) / tw : fallback;
};

export function aggregateItems(raw: RawItemTech[]): ItemServiceStat[] {
  const byItem = new Map<string, RawItemTech[]>();
  for (const r of raw) { const a = byItem.get(r.itemId) ?? []; a.push(r); byItem.set(r.itemId, a); }

  const stats: ItemServiceStat[] = [];
  for (const [id, recs] of byItem) {
    const first = recs[0]!;
    const expectedMin = first.expectedMin;
    const timesDone = recs.reduce((a, r) => a + r.timesDone, 0);
    const actualMin = wAvg(recs.map((r) => ({ v: r.actualMin, w: r.timesDone })), expectedMin);
    // Phase-1 approximation: weighted by all-time timesDone (the mock has no
    // separate weekly job count). Phase 2 weights by this-week volume.
    const weekActualMin = wAvg(recs.map((r) => ({ v: r.weekActualMin, w: r.timesDone })), expectedMin);
    const revenue = recs.reduce((a, r) => a + r.revenue, 0);
    const gpDollars = recs.reduce((a, r) => a + r.gpDollars, 0);

    const byTech: TechItemStat[] = recs.map((r) => {
      const vsExpectedPct = expectedMin ? ((r.actualMin - expectedMin) / expectedMin) * 100 : 0;
      const vsTeamPct = actualMin ? ((r.actualMin - actualMin) / actualMin) * 100 : 0;
      const { score, grade, lowConfidence } = compositeScore({ vsExpectedPct, ftfPct: r.ftfPct, gpPct: r.gpPct, rating: r.rating, timesDone: r.timesDone });
      return {
        techId: r.techId, techName: r.techName, timesDone: r.timesDone,
        expectedMin, actualMin: r.actualMin, vsExpectedPct, vsTeamPct,
        ftfPct: r.ftfPct, gpPct: r.gpPct, gpDollars: r.gpDollars, rating: r.rating,
        score, grade, lowConfidence,
      };
    }).sort((a, b) => b.score - a.score);

    const best = byTech.find((t) => !t.lowConfidence) ?? byTech[0] ?? null;
    const slowest = [...byTech].sort((a, b) => b.vsExpectedPct - a.vsExpectedPct)[0] ?? null;

    stats.push({
      id, name: first.itemName, kind: first.kind, category: first.category,
      timesDone, expectedMin, actualMin,
      variancePct: expectedMin ? ((actualMin - expectedMin) / expectedMin) * 100 : 0,
      weekVariancePct: expectedMin ? ((weekActualMin - expectedMin) / expectedMin) * 100 : 0,
      revenue, gpDollars, gpPct: revenue ? (gpDollars / revenue) * 100 : 0,
      byTech, bestTechId: best?.techId ?? null, slowestTechId: slowest?.techId ?? null,
    });
  }
  return stats.sort((a, b) => b.timesDone - a.timesDone);
}

export interface CompanyKpis {
  revenue: number; gpDollars: number; marginPct: number;
  timeVsExpectedPct: number; itemCount: number;
  biggestSlip: { name: string; weekVariancePct: number } | null;
}

export function companyKpis(stats: ItemServiceStat[]): CompanyKpis {
  const revenue = stats.reduce((a, s) => a + s.revenue, 0);
  const gpDollars = stats.reduce((a, s) => a + s.gpDollars, 0);
  const totalDone = stats.reduce((a, s) => a + s.timesDone, 0);
  const timeVsExpectedPct = totalDone ? stats.reduce((a, s) => a + s.variancePct * s.timesDone, 0) / totalDone : 0;
  let biggest: ItemServiceStat | null = null;
  for (const s of stats) if (!biggest || s.weekVariancePct > biggest.weekVariancePct) biggest = s;
  return {
    revenue, gpDollars, marginPct: revenue ? (gpDollars / revenue) * 100 : 0,
    timeVsExpectedPct, itemCount: stats.length,
    biggestSlip: biggest ? { name: biggest.name, weekVariancePct: biggest.weekVariancePct } : null,
  };
}

export interface TechRow extends TechItemStat { itemId: string; itemName: string; category: string; teamActualMin: number }

export function technicianRows(stats: ItemServiceStat[], techId: string): TechRow[] {
  const out: TechRow[] = [];
  for (const s of stats) {
    const t = s.byTech.find((x) => x.techId === techId);
    if (t) out.push({ ...t, itemId: s.id, itemName: s.name, category: s.category, teamActualMin: s.actualMin });
  }
  return out.sort((a, b) => b.timesDone - a.timesDone);
}

export function technicianIds(stats: ItemServiceStat[]): { id: string; name: string }[] {
  const m = new Map<string, string>();
  for (const s of stats) for (const t of s.byTech) m.set(t.techId, t.techName);
  return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export interface TechSummary {
  jobs: number; vsExpectedPct: number; ftfPct: number; gpPerJob: number;
  grade: Grade; bestAt: TechRow | null; needsWork: TechRow | null;
}

export interface WeekPoint { week: string; variancePct: number }

export function technicianSummary(rows: TechRow[]): TechSummary {
  const jobs = rows.reduce((a, r) => a + r.timesDone, 0);
  const vsExpectedPct = jobs ? rows.reduce((a, r) => a + r.vsExpectedPct * r.timesDone, 0) / jobs : 0;
  const ftfPct = jobs ? rows.reduce((a, r) => a + r.ftfPct * r.timesDone, 0) / jobs : 0;
  const gpPerJob = jobs ? rows.reduce((a, r) => a + r.gpDollars, 0) / jobs : 0;
  const avgScore = jobs ? rows.reduce((a, r) => a + r.score * r.timesDone, 0) / jobs : 0;
  let bestAt: TechRow | null = null;
  let needsWork: TechRow | null = null;
  for (const r of rows) {
    if (!bestAt || r.score > bestAt.score) bestAt = r;
    if (!needsWork || r.vsExpectedPct > needsWork.vsExpectedPct) needsWork = r;
  }
  return { jobs, vsExpectedPct, ftfPct, gpPerJob, grade: toGrade(Math.round(avgScore)), bestAt, needsWork };
}
