import { describe, it, expect } from 'vitest';
import {
  bucketStatus,
  statusCounts,
  filterEstimates,
  computeKpis,
  repBreakdown,
  type EstimateRow,
} from './estimates-report-logic';

const rows: EstimateRow[] = [
  { id: '1', number: 'E1', customer: 'A', rep: 'Jordan', createdAt: '2026-06-01', amount: 1000, depositDue: 100, status: 'DRAFT', hasJob: false },
  { id: '2', number: 'E2', customer: 'B', rep: 'Jordan', createdAt: '2026-06-02', amount: 2000, depositDue: 0, status: 'SENT', hasJob: false },
  { id: '3', number: 'E3', customer: 'C', rep: 'Casey', createdAt: '2026-06-03', amount: 3000, depositDue: 0, status: 'PENDING', hasJob: false },
  { id: '4', number: 'E4', customer: 'D', rep: 'Casey', createdAt: '2026-06-04', amount: 4000, depositDue: 0, status: 'WON', hasJob: false },
  { id: '5', number: 'E5', customer: 'E', rep: 'Jordan', createdAt: '2026-06-05', amount: 5000, depositDue: 0, status: 'WON', hasJob: true },
  { id: '6', number: 'E6', customer: 'F', rep: 'Casey', createdAt: '2026-06-06', amount: 6000, depositDue: 0, status: 'DECLINED', hasJob: false },
  { id: '7', number: 'E7', customer: 'G', rep: 'Jordan', createdAt: '2026-06-07', amount: 7000, depositDue: 0, status: 'EXPIRED', hasJob: false },
  { id: '8', number: 'E8', customer: 'H', rep: 'Casey', createdAt: '2026-06-08', amount: 8000, depositDue: 0, status: 'ARCHIVED', hasJob: false },
];

describe('bucketStatus', () => {
  it('maps raw statuses to Workiz buckets', () => {
    expect(bucketStatus(rows[0]!)).toBe('unsent');   // DRAFT
    expect(bucketStatus(rows[1]!)).toBe('pending');  // SENT — the only status still awaiting an answer
    expect(bucketStatus(rows[2]!)).toBe('approved'); // PENDING = customer approved + signed (D6)
    expect(bucketStatus(rows[3]!)).toBe('approved'); // WON no job
    expect(bucketStatus(rows[4]!)).toBe('won');      // WON + job
    expect(bucketStatus(rows[5]!)).toBe('declined'); // DECLINED
    expect(bucketStatus(rows[6]!)).toBe('archived'); // EXPIRED
    expect(bucketStatus(rows[7]!)).toBe('archived'); // ARCHIVED
  });
});

describe('statusCounts', () => {
  it('counts + worth per bucket and sums to all', () => {
    const c = statusCounts(rows);
    expect(c.all.count).toBe(8);
    expect(c.unsent.count).toBe(1);
    expect(c.pending.count).toBe(1);   // E2 SENT
    expect(c.approved.count).toBe(2);  // E3 PENDING + E4 WON-no-job
    expect(c.won.count).toBe(1);
    expect(c.declined.count).toBe(1);
    expect(c.archived.count).toBe(2);
    const sum = c.unsent.count + c.pending.count + c.approved.count + c.won.count + c.declined.count + c.archived.count;
    expect(sum).toBe(c.all.count);
    expect(c.all.worth).toBe(36000);
  });
});

describe('filterEstimates', () => {
  it('filters by status bucket', () => {
    expect(filterEstimates(rows, { status: 'pending', rep: null, search: '' }).map((r) => r.id)).toEqual(['2']);
    expect(filterEstimates(rows, { status: 'approved', rep: null, search: '' }).map((r) => r.id)).toEqual(['3', '4']);
  });
  it('filters by rep', () => {
    expect(filterEstimates(rows, { status: 'all', rep: 'Casey', search: '' }).every((r) => r.rep === 'Casey')).toBe(true);
  });
  it('filters by search over number + customer (case-insensitive)', () => {
    expect(filterEstimates(rows, { status: 'all', rep: null, search: 'e3' }).map((r) => r.id)).toEqual(['3']);
  });
});

describe('computeKpis', () => {
  it('revenue=won $, winRate=won/(won+declined), avgDeal, topRep', () => {
    const k = computeKpis(rows);
    // Revenue counts EVERY status==='WON' row — E4 (no job, 4000) and E5 (job, 5000). Bucketing
    // on 'won' here would drop E4 purely because it has not been scheduled yet.
    expect(k.revenue).toBe(9000);
    expect(k.winRate).toBe(67);              // 2 won / (2 won + 1 declined)
    expect(k.avgDeal).toBe(4500);            // 9000 / 2
    expect(k.topRep).toBe('Jordan');         // Jordan 5000 (E5) > Casey 4000 (E4)
  });

  it('counts a won estimate that has no linked job yet', () => {
    const wonNoJob: EstimateRow[] = [
      { id: 'x', number: 'EX', customer: 'X', rep: 'Rae', createdAt: '2026-06-01', amount: 1200, depositDue: 0, status: 'WON', hasJob: false },
    ];
    expect(computeKpis(wonNoJob).revenue).toBe(1200);
    expect(computeKpis(wonNoJob).winRate).toBe(100);
  });
});

describe('repBreakdown', () => {
  it('one row per rep with revenue, open $, win rate', () => {
    const b = repBreakdown(rows);
    const jordan = b.find((r) => r.rep === 'Jordan')!;
    expect(jordan.revenue).toBe(5000);       // won
    expect(jordan.openDollars).toBe(2000);   // pending (E2 SENT)
    expect(jordan.winRate).toBe(100);        // Jordan: 1 won, 0 declined → 100%
    expect(jordan.rank).toBe(1);             // highest revenue
    const casey = b.find((r) => r.rep === 'Casey')!;
    expect(casey.revenue).toBe(4000);        // E4 — won, not yet scheduled, still real revenue
    expect(casey.winRate).toBe(50);          // Casey: 1 won (E4), 1 declined (E6)
    expect(casey.rank).toBe(2);              // 4000 < Jordan's 5000
  });
});
