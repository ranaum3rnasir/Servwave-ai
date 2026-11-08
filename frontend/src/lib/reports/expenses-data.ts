/**
 * Deterministic mock data for the Expenses report (frontend-only, no backend).
 * Same shapes the future GET /api/reports/expenses should return.
 */
import { hashStr, mulberry32 } from './random';
import {
  EXPENSE_CATEGORIES,
  BUSINESS_UNITS,
  CARDHOLDERS,
  USERS,
  monthKeyOf,
  type ExpenseRow,
  type ExpenseCategory,
} from './expenses-logic';

const MERCHANTS: Record<ExpenseCategory, string[]> = {
  Hardware: ['The Home Depot', 'Lowe\'s', 'Bronx True Value'],
  Materials: ['Grainger', 'Ferguson', 'SupplyHouse'],
  Gas: ['ExxonMobil', 'Shell', 'BP'],
  Parking: ['NYC DOT', 'SpotHero', 'Icon Parking'],
  Software: ['Render', 'Vercel', 'Adobe', 'Google Workspace'],
  Tools: ['Milwaukee Tool', 'DeWalt', 'Klein Tools'],
  Meals: ['Chipotle', 'Dunkin', 'Pizza Hut'],
  General: ['Amazon', 'Staples', 'CTLP*CSC'],
};

const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

/** ~120 expenses spread across the last 13 months. Deterministic by seed. */
export function buildExpenses(seed = 'expenses'): ExpenseRow[] {
  const rng = mulberry32(hashStr(seed));
  const rows: ExpenseRow[] = [];
  const now = new Date(2026, 5, 6, 12, 0, 0); // fixed reference so mock is stable
  for (let i = 0; i < 120; i++) {
    const monthsAgo = Math.floor(rng() * 13);
    const base = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
    const day = 1 + Math.floor(rng() * 27);
    const date = new Date(base.getFullYear(), base.getMonth(), day, Math.floor(rng() * 12) + 8, Math.floor(rng() * 60));
    const category = pick(rng, EXPENSE_CATEGORIES);
    const hasJob = rng() > 0.45;
    const merchant = pick(rng, MERCHANTS[category]);
    const jobNumber = hasJob ? `JOB-${1000 + Math.floor(rng() * 600)}` : null;
    // Seed a note on ~45% of rows so the With/Without-Description facet is meaningful.
    const description = rng() > 0.55 ? `${category} — ${merchant}${jobNumber ? ` (${jobNumber})` : ''}` : '';
    rows.push({
      id: `exp-${i}`,
      date,
      merchant,
      category,
      amount: Math.round((3 + rng() * 340) * 100) / 100,
      cardholder: pick(rng, CARDHOLDERS),
      loggedBy: pick(rng, USERS),
      businessUnit: pick(rng, BUSINESS_UNITS),
      jobNumber,
      description,
      hasReceipt: rng() > 0.7,
      status: rng() > 0.5 ? 'Settled' : 'Pending',
    });
  }
  return rows.sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Monthly revenue for the profit strip, keyed YYYY-MM, last 13 months. */
export function buildMonthlyRevenue(now: Date, seed = 'expenses-revenue'): Record<string, number> {
  const rng = mulberry32(hashStr(seed));
  const out: Record<string, number> = {};
  for (let i = 0; i < 13; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out[monthKeyOf(d)] = Math.round(20000 + rng() * 60000);
  }
  return out;
}
