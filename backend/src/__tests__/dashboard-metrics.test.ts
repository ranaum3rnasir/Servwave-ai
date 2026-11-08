import { describe, it, expect } from 'vitest';
import {
  buildScoreboard,
  buildJobsByStatus,
  comingUpLabel,
  buildPipeline,
  buildLeadSources,
  buildRevenueByJobType,
  buildRecurring,
  buildScheduleLanes,
  type ScheduleJobIn,
  type ScheduleWalkthroughIn,
} from '../services/dashboard-metrics';

describe('buildScoreboard', () => {
  it('ranks entries by revenue descending and caps at the limit', () => {
    const rows = [
      { user_id: 'a', name: 'Ann', revenue: 100, jobs: 2 },
      { user_id: 'b', name: 'Bob', revenue: 300, jobs: 5 },
      { user_id: 'c', name: 'Cay', revenue: 200, jobs: 3 },
    ];
    const out = buildScoreboard(rows, 2);
    expect(out.map((e) => e.name)).toEqual(['Bob', 'Cay']);
  });

  it('drops contributors with no revenue and no jobs', () => {
    const rows = [
      { user_id: 'a', name: 'Ann', revenue: 0, jobs: 0 },
      { user_id: 'b', name: 'Bob', revenue: 0, jobs: 3 },
      { user_id: 'c', name: 'Cay', revenue: 500, jobs: 0 },
    ];
    const out = buildScoreboard(rows, 5);
    expect(out.map((e) => e.name)).toEqual(['Cay', 'Bob']);
  });
});

describe('buildJobsByStatus', () => {
  it('maps counts to labelled slices in canonical status order, skipping zeros', () => {
    const out = buildJobsByStatus([
      { status: 'COMPLETED', count: 4 },
      { status: 'SCHEDULED', count: 7 },
      { status: 'CANCELLED', count: 0 },
      { status: 'IN_PROGRESS', count: 2 },
    ]);
    expect(out).toEqual([
      { key: 'scheduled', label: 'Scheduled', count: 7 },
      { key: 'in_progress', label: 'In progress', count: 2 },
      { key: 'completed', label: 'Completed', count: 4 },
    ]);
  });
});

describe('comingUpLabel', () => {
  const now = new Date('2026-06-10T12:00:00Z');

  it('formats minutes, hours, and days ahead', () => {
    expect(comingUpLabel(new Date('2026-06-10T12:30:00Z'), now)).toBe('in 30 minutes');
    expect(comingUpLabel(new Date('2026-06-11T03:00:00Z'), now)).toBe('in 15 hours');
    expect(comingUpLabel(new Date('2026-06-13T12:00:00Z'), now)).toBe('in 3 days');
  });

  it('uses singular units and collapses past/now to "now"', () => {
    expect(comingUpLabel(new Date('2026-06-10T13:00:00Z'), now)).toBe('in 1 hour');
    expect(comingUpLabel(new Date('2026-06-10T11:00:00Z'), now)).toBe('now');
  });
});

describe('buildLeadSources', () => {
  it('returns an empty array for no rows', () => {
    expect(buildLeadSources([])).toEqual([]);
  });

  it('ranks by lead count desc, Title-Cases labels, and rounds lead_pct (% of total leads)', () => {
    const out = buildLeadSources([
      { source: 'website', leads: 20, revenue: 1000 },
      { source: 'google', leads: 60, revenue: 5000 },
      { source: 'access_control', leads: 20, revenue: 2000 },
    ]);
    expect(out).toEqual([
      { source: 'google', label: 'Google', lead_pct: 60, revenue: 5000 },
      { source: 'website', label: 'Website', lead_pct: 20, revenue: 1000 },
      { source: 'access_control', label: 'Access Control', lead_pct: 20, revenue: 2000 },
    ]);
  });

  it('rounds lead_pct and revenue', () => {
    const out = buildLeadSources([
      { source: 'repeat', leads: 1, revenue: 100.7 },
      { source: 'yelp', leads: 2, revenue: 0 },
    ]);
    // 1/3 = 33%, 2/3 = 67%
    expect(out).toEqual([
      { source: 'yelp', label: 'Yelp', lead_pct: 67, revenue: 0 },
      { source: 'repeat', label: 'Repeat', lead_pct: 33, revenue: 101 },
    ]);
  });
});

describe('buildRevenueByJobType', () => {
  it('returns an empty array for no rows', () => {
    expect(buildRevenueByJobType([])).toEqual([]);
  });

  it('computes pct of total revenue, Title-Cases labels, sorts desc, drops zero-revenue', () => {
    const out = buildRevenueByJobType([
      { job_type: 'lock_rekey', revenue: 2500 },
      { job_type: 'gate-operator', revenue: 7500 },
      { job_type: 'cctv_install', revenue: 0 },
    ]);
    expect(out).toEqual([
      { label: 'Gate Operator', pct: 75, revenue: 7500 },
      { label: 'Lock Rekey', pct: 25, revenue: 2500 },
    ]);
  });
});

describe('buildRecurring', () => {
  it('returns null when there are no active plans', () => {
    expect(buildRecurring({ active_plans: 0, mrr: 0 })).toBeNull();
    expect(buildRecurring({ active_plans: 0, mrr: 1234 })).toBeNull();
  });

  it('rounds the MRR when there are active plans', () => {
    expect(buildRecurring({ active_plans: 8, mrr: 12345.67 })).toEqual({
      mrr: 12346,
      active_plans: 8,
    });
  });
});

describe('buildScheduleLanes', () => {
  const ann = { id: 'u-ann', first_name: 'Ann', last_name: 'Ames', avatar_path: null };
  const bob = { id: 'u-bob', first_name: 'Bob', last_name: 'Bane', avatar_path: null };
  const customer = { first_name: 'Eric', last_name: 'Bizzak', company_name: null };
  const location = { address_line1: '12 Main St', city: 'Passaic' };

  function makeJob(overrides: Partial<ScheduleJobIn> = {}): ScheduleJobIn {
    return {
      id: 'j-1',
      job_number: 'J00001',
      status: 'SCHEDULED',
      scope_notes: 'Fix door',
      scheduled_start: new Date('2026-07-02T09:00:00Z'),
      scheduled_end: new Date('2026-07-02T11:00:00Z'),
      visits: [{ assignees: [{ user: ann }] }],
      customer,
      service_location: location,
      ...overrides,
    };
  }

  function makeWalkthrough(overrides: Partial<ScheduleWalkthroughIn> = {}): ScheduleWalkthroughIn {
    return {
      id: 'l-1',
      lead_number: 'L00001',
      service_request: 'New gate operator',
      walkthrough_scheduled_at: new Date('2026-07-02T10:00:00Z'),
      walkthrough_duration_minutes: 90,
      walkthrough_completed_at: null,
      customer,
      service_location: location,
      performers: [ann],
      ...overrides,
    };
  }

  it('puts a pending walkthrough in every performer lane with WALKTHROUGH status and duration-based end', () => {
    const out = buildScheduleLanes([], [makeWalkthrough({ performers: [ann, bob] })]);
    expect(out).toHaveLength(2);
    for (const lane of out) {
      expect(lane.jobs).toHaveLength(1);
      expect(lane.jobs[0]).toEqual({
        id: 'l-1',
        job_number: 'L00001',
        status: 'WALKTHROUGH',
        scope_notes: 'New gate operator',
        scheduled_start: '2026-07-02T10:00:00.000Z',
        scheduled_end: '2026-07-02T11:30:00.000Z', // +90 minutes
        customer_name: 'Eric Bizzak',
        address: '12 Main St, Passaic',
        entity: 'walkthrough',
      });
    }
    expect(out.map((l) => l.user_id)).toEqual(['u-ann', 'u-bob']);
  });

  it('defaults walkthrough duration to 60 minutes when null', () => {
    const out = buildScheduleLanes([], [makeWalkthrough({ walkthrough_duration_minutes: null })]);
    expect(out[0].jobs[0].scheduled_end).toBe('2026-07-02T11:00:00.000Z');
  });

  it('keeps a completed walkthrough visible with WALKTHROUGH_COMPLETED status regardless of lead status', () => {
    // completeWalkthrough keeps walkthrough_scheduled_at set — calendar parity: the
    // entry stays for its day, in a done state keyed off walkthrough_completed_at.
    const out = buildScheduleLanes(
      [],
      [makeWalkthrough({ walkthrough_completed_at: new Date('2026-07-02T11:45:00Z') })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].jobs[0].status).toBe('WALKTHROUGH_COMPLETED');
    expect(out[0].jobs[0].entity).toBe('walkthrough');
  });

  it('puts a performer-less walkthrough in the Unassigned lane, which stays last', () => {
    const out = buildScheduleLanes(
      [makeJob()],
      [makeWalkthrough({ performers: [] })],
    );
    expect(out.map((l) => l.user_id)).toEqual(['u-ann', null]);
    const unassigned = out[out.length - 1];
    expect(unassigned.first_name).toBe('Unassigned');
    expect(unassigned.jobs[0].entity).toBe('walkthrough');
  });

  it('interleaves jobs and walkthroughs within a lane sorted by scheduled_start ascending', () => {
    const out = buildScheduleLanes(
      [makeJob({ scheduled_start: new Date('2026-07-02T13:00:00Z') })],
      [makeWalkthrough({ walkthrough_scheduled_at: new Date('2026-07-02T08:00:00Z') })],
    );
    expect(out).toHaveLength(1);
    expect(out[0].jobs.map((e) => e.entity)).toEqual(['walkthrough', 'job']);
  });

  it('reproduces the jobs-only output exactly (crew fan-out, unassigned last, stable same-timestamp order)', () => {
    // Two same-timestamp jobs in one lane: the per-lane sort must be a stable no-op
    // over Prisma's pre-sorted rows (Array.prototype.sort is stable on Node 20),
    // so extraction changes nothing for jobs-only payloads — a guarded invariant.
    const t = new Date('2026-07-02T09:00:00Z');
    const jobs: ScheduleJobIn[] = [
      makeJob({ id: 'j-1', job_number: 'J00001', scheduled_start: t, visits: [{ assignees: [{ user: ann }, { user: bob }] }] }),
      makeJob({ id: 'j-2', job_number: 'J00002', scheduled_start: t, visits: [{ assignees: [{ user: ann }] }] }),
      makeJob({ id: 'j-3', job_number: 'J00003', scheduled_start: new Date('2026-07-02T12:00:00Z'), visits: [{ assignees: [] }] }),
    ];
    const out = buildScheduleLanes(jobs, []);
    expect(out).toEqual([
      {
        user_id: 'u-ann',
        first_name: 'Ann',
        last_name: 'Ames',
        avatar_path: null,
        jobs: [
          {
            id: 'j-1', job_number: 'J00001', status: 'SCHEDULED', scope_notes: 'Fix door',
            scheduled_start: '2026-07-02T09:00:00.000Z', scheduled_end: '2026-07-02T11:00:00.000Z',
            customer_name: 'Eric Bizzak', address: '12 Main St, Passaic', entity: 'job',
          },
          {
            id: 'j-2', job_number: 'J00002', status: 'SCHEDULED', scope_notes: 'Fix door',
            scheduled_start: '2026-07-02T09:00:00.000Z', scheduled_end: '2026-07-02T11:00:00.000Z',
            customer_name: 'Eric Bizzak', address: '12 Main St, Passaic', entity: 'job',
          },
        ],
      },
      {
        user_id: 'u-bob',
        first_name: 'Bob',
        last_name: 'Bane',
        avatar_path: null,
        jobs: [
          {
            id: 'j-1', job_number: 'J00001', status: 'SCHEDULED', scope_notes: 'Fix door',
            scheduled_start: '2026-07-02T09:00:00.000Z', scheduled_end: '2026-07-02T11:00:00.000Z',
            customer_name: 'Eric Bizzak', address: '12 Main St, Passaic', entity: 'job',
          },
        ],
      },
      {
        user_id: null,
        first_name: 'Unassigned',
        last_name: '',
        avatar_path: null,
        jobs: [
          {
            id: 'j-3', job_number: 'J00003', status: 'SCHEDULED', scope_notes: 'Fix door',
            scheduled_start: '2026-07-02T12:00:00.000Z', scheduled_end: '2026-07-02T11:00:00.000Z',
            customer_name: 'Eric Bizzak', address: '12 Main St, Passaic', entity: 'job',
          },
        ],
      },
    ]);
  });

  it('applies customer_name and address fallbacks to walkthrough entries', () => {
    const out = buildScheduleLanes(
      [],
      [
        makeWalkthrough({
          id: 'l-a',
          customer: { first_name: null, last_name: null, company_name: 'Acme Doors' },
          service_location: null,
        }),
        makeWalkthrough({
          id: 'l-b',
          walkthrough_scheduled_at: new Date('2026-07-02T12:00:00Z'),
          customer: { first_name: null, last_name: null, company_name: null },
        }),
      ],
    );
    const entries = out[0].jobs;
    expect(entries[0].customer_name).toBe('Acme Doors');
    expect(entries[0].address).toBeNull();
    expect(entries[1].customer_name).toBe('Customer');
    expect(entries[1].address).toBe('12 Main St, Passaic');
  });
});

describe('buildPipeline', () => {
  it('assembles the seven funnel stages with correct kinds and links', () => {
    const out = buildPipeline({
      leads: 184,
      estimatesAmount: 1_200_000,
      approvedAmount: 540_000,
      depositAmount: 310_000,
      jobAmount: 290_000,
      invoicedAmount: 260_000,
      paidAmount: 222_000,
    });
    expect(out).toEqual([
      { key: 'leads', label: 'Leads', kind: 'count', value: 184, link: '/leads' },
      { key: 'estimates', label: 'Estimates', kind: 'amount', value: 1_200_000, link: '/estimates' },
      { key: 'approved', label: 'Approved', kind: 'amount', value: 540_000, link: '/estimates?status=approved' },
      { key: 'deposit', label: 'Deposit', kind: 'amount', value: 310_000, link: '/estimates' },
      { key: 'job', label: 'Job done', kind: 'amount', value: 290_000, link: '/jobs' },
      { key: 'invoiced', label: 'Invoiced', kind: 'amount', value: 260_000, link: '/invoices' },
      { key: 'paid', label: 'Paid', kind: 'amount', value: 222_000, link: '/invoices?status=paid' },
    ]);
  });
});
