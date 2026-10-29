import { describe, it, expect } from 'vitest';
import {
  deriveTouches,
  DEFAULT_CONFIG,
  type RawCall,
  type RawTextMessage,
} from '../services/communication-tracking-report';
import {
  computeJobCadence,
  type JobRow,
  type Touch as TouchT,
} from '../services/communication-tracking-report';
import { computeQa, type QaInteraction } from '../services/communication-tracking-report';
import {
  computeTrainingImpact,
  buildReport,
  type TrainingCompletionRec,
  type ReportInput,
} from '../services/communication-tracking-report';

function call(over: Partial<RawCall> = {}): RawCall {
  return {
    id: 'c1', jobId: 'job_1', customerId: 'cust_1', repId: 'rep_1',
    role: 'sales', direction: 'outbound',
    startedAt: '2026-06-01T10:00:00Z', durationSec: 120,
    ...over,
  };
}
function msg(over: Partial<RawTextMessage> = {}): RawTextMessage {
  return {
    threadId: 'thr_1', jobId: 'job_1', customerId: 'cust_1', repId: 'rep_1',
    role: 'sales', direction: 'out', ts: '2026-06-01T10:00:00Z',
    ...over,
  };
}

describe('deriveTouches', () => {
  it('a long-enough call is one connected touch', () => {
    const t = deriveTouches([call({ durationSec: 30 })], [], DEFAULT_CONFIG);
    expect(t).toHaveLength(1);
    expect(t[0].channel).toBe('call');
    expect(t[0].connected).toBe(true);
  });

  it('a short call is an attempt, not a connected touch', () => {
    const t = deriveTouches([call({ durationSec: 5 })], [], DEFAULT_CONFIG);
    expect(t).toHaveLength(1);
    expect(t[0].connected).toBe(false);
  });

  it('a two-way text exchange in one day is one connected touch', () => {
    const texts = [
      msg({ direction: 'out', ts: '2026-06-01T09:00:00Z' }),
      msg({ direction: 'in', repId: null, ts: '2026-06-01T09:05:00Z' }),
    ];
    const t = deriveTouches([], texts, DEFAULT_CONFIG);
    expect(t).toHaveLength(1);
    expect(t[0].channel).toBe('text');
    expect(t[0].connected).toBe(true);
  });

  it('a one-way text blast in a day is an attempt, not a connected touch', () => {
    const texts = [
      msg({ direction: 'out', ts: '2026-06-01T09:00:00Z' }),
      msg({ direction: 'out', ts: '2026-06-01T11:00:00Z' }),
    ];
    const t = deriveTouches([], texts, DEFAULT_CONFIG);
    expect(t).toHaveLength(1);
    expect(t[0].connected).toBe(false);
  });

  it('two-way texts across two days are two touches', () => {
    const texts = [
      msg({ direction: 'out', ts: '2026-06-01T09:00:00Z' }),
      msg({ direction: 'in', repId: null, ts: '2026-06-01T09:05:00Z' }),
      msg({ direction: 'out', ts: '2026-06-02T09:00:00Z' }),
      msg({ direction: 'in', repId: null, ts: '2026-06-02T09:05:00Z' }),
    ];
    const t = deriveTouches([], texts, DEFAULT_CONFIG);
    expect(t.filter((x) => x.connected)).toHaveLength(2);
  });
});

function jobRow(over: Partial<JobRow> = {}): JobRow {
  return {
    jobId: 'job_1', jobNumber: 'J-1', customerId: 'cust_1', customerName: 'Acme',
    ownerId: 'rep_1', ownerName: 'Sam Rep', jobType: 'locksmith', closed: false,
    ...over,
  };
}
function touch(over: Partial<TouchT> = {}): TouchT {
  return {
    jobId: 'job_1', customerId: 'cust_1', repId: 'rep_1', role: 'sales',
    channel: 'call', direction: 'outbound', connected: true,
    timestamp: '2026-06-01T10:00:00Z', durationSec: 60,
    ...over,
  };
}

describe('computeJobCadence', () => {
  const now = new Date('2026-06-10T00:00:00Z');

  it('classifies under / healthy / over by connected-touch count', () => {
    const jobs = [
      jobRow({ jobId: 'job_under', jobNumber: 'J-U' }),
      jobRow({ jobId: 'job_ok', jobNumber: 'J-OK' }),
      jobRow({ jobId: 'job_over', jobNumber: 'J-OV' }),
    ];
    const touches: TouchT[] = [
      ...Array.from({ length: 3 }, () => touch({ jobId: 'job_under' })),
      ...Array.from({ length: 7 }, () => touch({ jobId: 'job_ok' })),
      ...Array.from({ length: 15 }, () => touch({ jobId: 'job_over' })),
    ];
    const res = computeJobCadence(jobs, touches, DEFAULT_CONFIG, now);
    const byId = Object.fromEntries(res.rows.map((r) => [r.jobId, r]));
    expect(byId['job_under'].band).toBe('under');
    expect(byId['job_ok'].band).toBe('healthy');
    expect(byId['job_over'].band).toBe('over');
  });

  it('ignores attempts (non-connected) in the touch count', () => {
    const touches = [
      ...Array.from({ length: 5 }, () => touch({ connected: true })),
      ...Array.from({ length: 4 }, () => touch({ connected: false })),
    ];
    const res = computeJobCadence([jobRow()], touches, DEFAULT_CONFIG, now);
    expect(res.rows[0].touchCount).toBe(5);
    expect(res.rows[0].attempts).toBe(4);
    expect(res.rows[0].band).toBe('healthy');
  });

  it('excludes closed jobs', () => {
    const res = computeJobCadence([jobRow({ closed: true })], [touch()], DEFAULT_CONFIG, now);
    expect(res.rows).toHaveLength(0);
  });

  it('marks a job stale when last touch is older than staleDays', () => {
    const touches = Array.from({ length: 6 }, () =>
      touch({ timestamp: '2026-06-01T10:00:00Z' }),
    );
    const res = computeJobCadence([jobRow()], touches, DEFAULT_CONFIG, now);
    expect(res.rows[0].stale).toBe(true);
    expect(res.rows[0].daysSinceLastTouch).toBe(9);
  });

  it('staleDays boundary: exactly staleDays (7) days is not stale; 8 days is stale', () => {
    const fixedNow = new Date('2026-06-10T00:00:00Z');
    // Last touch exactly 7 days before now → not stale
    const ts7 = '2026-06-03T00:00:00Z'; // 7 days before 2026-06-10
    // Last touch 8 days before now → stale
    const ts8 = '2026-06-02T00:00:00Z'; // 8 days before 2026-06-10

    const jobs = [
      jobRow({ jobId: 'job_exact', jobNumber: 'J-EX' }),
      jobRow({ jobId: 'job_over', jobNumber: 'J-OV' }),
    ];
    // Need enough connected touches to be in-band (5-12 for default config)
    const touchesExact = Array.from({ length: 6 }, () =>
      touch({ jobId: 'job_exact', timestamp: ts7 }),
    );
    const touchesOver = Array.from({ length: 6 }, () =>
      touch({ jobId: 'job_over', timestamp: ts8 }),
    );
    const res = computeJobCadence(jobs, [...touchesExact, ...touchesOver], DEFAULT_CONFIG, fixedNow);
    const byId = Object.fromEntries(res.rows.map((r) => [r.jobId, r]));
    expect(byId['job_exact'].daysSinceLastTouch).toBe(7);
    expect(byId['job_exact'].stale).toBe(false);
    expect(byId['job_over'].daysSinceLastTouch).toBe(8);
    expect(byId['job_over'].stale).toBe(true);
  });

  it('honors a per-job-type band override', () => {
    const config = { ...DEFAULT_CONFIG, bandByJobType: { install: { min: 10, max: 20 } } };
    const touches = Array.from({ length: 7 }, () => touch());
    const res = computeJobCadence([jobRow({ jobType: 'install' })], touches, config, now);
    expect(res.rows[0].band).toBe('under'); // 7 < 10
    expect(res.rows[0].min).toBe(10);
  });

  it('stats summarize the open-job population', () => {
    const jobs = [
      jobRow({ jobId: 'a' }), jobRow({ jobId: 'b' }), jobRow({ jobId: 'c' }),
    ];
    const touches = [
      ...Array.from({ length: 2 }, () => touch({ jobId: 'a' })),  // under
      ...Array.from({ length: 6 }, () => touch({ jobId: 'b' })),  // healthy
      ...Array.from({ length: 14 }, () => touch({ jobId: 'c' })), // over
    ];
    const res = computeJobCadence(jobs, touches, DEFAULT_CONFIG, now);
    expect(res.stats.openJobs).toBe(3);
    expect(res.stats.under).toBe(1);
    expect(res.stats.over).toBe(1);
    expect(res.stats.healthyPct).toBe(33);
  });
});

function qa(over: Partial<QaInteraction> = {}): QaInteraction {
  return {
    id: 'q1', kind: 'call', role: 'csr', repId: 'rep_1', repName: 'Lena',
    jobId: 'job_1', customerName: 'Acme', timestamp: '2026-06-01T10:00:00Z',
    aiScore: 80, managerScore: null, disputed: false,
    rubricItems: [{ key: 'greeting', label: 'Greeting', hit: true }],
    flags: [], sentiment: 'positive',
    ...over,
  };
}

describe('computeQa', () => {
  it('manager score overrides ai score in averages', () => {
    const res = computeQa([qa({ aiScore: 40, managerScore: 90 })], DEFAULT_CONFIG);
    expect(res.byRep[0].avgScore).toBe(90);
  });

  it('aggregates by rep with call/text counts', () => {
    const res = computeQa(
      [
        qa({ repId: 'r', repName: 'R', kind: 'call', aiScore: 100 }),
        qa({ repId: 'r', repName: 'R', kind: 'text', aiScore: 60 }),
      ],
      DEFAULT_CONFIG,
    );
    const r = res.byRep.find((x) => x.repId === 'r')!;
    expect(r.count).toBe(2);
    expect(r.callCount).toBe(1);
    expect(r.textCount).toBe(1);
    expect(r.avgScore).toBe(80);
  });

  it('aggregates by role', () => {
    const res = computeQa(
      [qa({ role: 'csr', aiScore: 90 }), qa({ role: 'dispatch', aiScore: 70 })],
      DEFAULT_CONFIG,
    );
    const csr = res.byRole.find((x) => x.role === 'csr')!;
    expect(csr.avgScore).toBe(90);
  });

  it('review queue holds below-threshold or disputed interactions', () => {
    const res = computeQa(
      [
        qa({ id: 'low', aiScore: 50 }),
        qa({ id: 'ok', aiScore: 95 }),
        qa({ id: 'disp', aiScore: 95, disputed: true }),
      ],
      DEFAULT_CONFIG,
    );
    const ids = res.reviewQueue.map((r) => r.id).sort();
    expect(ids).toEqual(['disp', 'low']);
  });
});

describe('computeTrainingImpact', () => {
  const completions: TrainingCompletionRec[] = [
    {
      repId: 'rep_1', repName: 'Lena', role: 'csr',
      scenarioId: 'trn_book_new', scenarioTitle: 'Inbound booking',
      completedAt: '2026-06-10T00:00:00Z',
    },
  ];

  it('computes before/after delta around completion', () => {
    const interactions: QaInteraction[] = [
      qa({ repId: 'rep_1', role: 'csr', aiScore: 60, timestamp: '2026-06-05T10:00:00Z' }),
      qa({ repId: 'rep_1', role: 'csr', aiScore: 90, timestamp: '2026-06-15T10:00:00Z' }),
    ];
    const res = computeTrainingImpact(completions, interactions, DEFAULT_CONFIG);
    expect(res.rows[0].before).toBe(60);
    expect(res.rows[0].after).toBe(90);
    expect(res.rows[0].delta).toBe(30);
    expect(res.rows[0].improved).toBe(true);
  });

  it('flags trained-but-not-improved', () => {
    const interactions: QaInteraction[] = [
      qa({ repId: 'rep_1', role: 'csr', aiScore: 90, timestamp: '2026-06-05T10:00:00Z' }),
      qa({ repId: 'rep_1', role: 'csr', aiScore: 70, timestamp: '2026-06-15T10:00:00Z' }),
    ];
    const res = computeTrainingImpact(completions, interactions, DEFAULT_CONFIG);
    expect(res.rows[0].improved).toBe(false);
  });

  it('lists low-scoring reps with no matching training', () => {
    const interactions: QaInteraction[] = [
      qa({ repId: 'rep_2', repName: 'Marco', role: 'dispatch', aiScore: 50 }),
    ];
    const res = computeTrainingImpact([], interactions, DEFAULT_CONFIG);
    expect(res.needsTraining.map((r) => r.repId)).toContain('rep_2');
  });

  it('improved is false when rep has interactions only in the before-window (none after)', () => {
    const comp: TrainingCompletionRec[] = [
      {
        repId: 'rep_1', repName: 'Lena', role: 'csr',
        scenarioId: 'trn_book_new', scenarioTitle: 'Inbound booking',
        completedAt: '2026-06-10T00:00:00Z',
      },
    ];
    const interactions: QaInteraction[] = [
      // only in the before-window; nothing after completedAt
      qa({ repId: 'rep_1', role: 'csr', aiScore: 65, timestamp: '2026-06-05T10:00:00Z' }),
    ];
    const res = computeTrainingImpact(comp, interactions, DEFAULT_CONFIG);
    expect(res.rows[0].beforeN).toBe(1);
    expect(res.rows[0].afterN).toBe(0);
    expect(res.rows[0].improved).toBe(false);
  });
});

describe('buildReport', () => {
  it('assembles cadence + qa + training from raw input', () => {
    const now = new Date('2026-06-20T00:00:00Z');
    const input: ReportInput = {
      jobs: [jobRow()],
      calls: [call({ durationSec: 60 })],
      texts: [],
      qa: [qa()],
      completions: [],
      config: DEFAULT_CONFIG,
    };
    const payload = buildReport(input, now);
    expect(payload.cadence.rows).toHaveLength(1);
    expect(payload.qa.byRep).toHaveLength(1);
    expect(payload.training.rows).toHaveLength(0);
    expect(payload.cadence.rows[0].jobId).toBe('job_1');
    expect(payload.qa.byRep[0].repId).toBe('rep_1');
  });
});
