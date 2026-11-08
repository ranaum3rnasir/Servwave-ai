import { mulberry32, hashStr } from './random';
import {
  buildReport,
  DEFAULT_CONFIG,
  type CommRole,
  type JobRow,
  type RawCall,
  type RawTextMessage,
  type QaInteraction,
  type TrainingCompletionRec,
  type CommReportPayload,
  type RubricItem,
} from './communication-tracking-logic';

// Fixed "now" so the demo is stable regardless of wall clock.
export const DEMO_NOW = new Date('2026-06-06T12:00:00Z');

const REPS: { id: string; name: string; role: CommRole }[] = [
  { id: 'rep_lena', name: 'Lena Ortiz', role: 'csr' },
  { id: 'rep_marco', name: 'Marco Bianchi', role: 'dispatch' },
  { id: 'rep_sara', name: 'Sara Klein', role: 'sales' },
  { id: 'rep_devon', name: 'Devon Pierce', role: 'sales' },
  { id: 'rep_mike', name: 'Mike Russo', role: 'tech' },
  { id: 'rep_rosa', name: 'Rosa (AI Receptionist)', role: 'csr' },
];

const JOB_TYPES = ['locksmith', 'door', 'security', 'install'];
const CUSTOMERS = [
  'Rolex 5th Ave', 'Equinox SoHo', "McDonald's Midtown", 'Chase Bank Plaza',
  'Equinox Tribeca', 'WeWork Bryant', 'Hilton Garden', 'CVS Union Sq',
];

const RUBRIC_BY_ROLE: Record<CommRole, string[]> = {
  csr: ['Greeting on script', 'Identified company', 'Captured name+number', 'Qualified need', 'Attempted booking'],
  sales: ['Opened correctly', 'Confirmed job context', 'Advanced the deal', 'Handled objection', 'Set next action'],
  dispatch: ['Confirmed job+window', 'Set tech expectation', 'Captured access notes', 'Logged the change'],
  tech: ['Identified self', 'Reviewed scope', 'Presented change order', 'Confirmed next step'],
};

function iso(now: Date, daysAgo: number, hour: number): string {
  const d = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** Build the full deterministic demo dataset and return the report payload. */
export function buildDemoPayload(): CommReportPayload {
  const rng = mulberry32(hashStr('comm-tracking-demo-v1'));
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)] as T;
  const between = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

  const jobs: JobRow[] = [];
  const calls: RawCall[] = [];
  const texts: RawTextMessage[] = [];
  const qa: QaInteraction[] = [];

  const JOB_COUNT = 36;
  for (let i = 0; i < JOB_COUNT; i++) {
    const owner = REPS.filter((r) => r.role === 'sales')[i % 2] as { id: string; name: string; role: CommRole };
    const jobType = pick(JOB_TYPES);
    const closed = rng() < 0.15;
    const jobId = `demo_job_${i}`;
    const customerId = `demo_cust_${i}`;
    const customerName = pick(CUSTOMERS);
    jobs.push({
      jobId,
      jobNumber: `J-${1900 + i}`,
      customerId,
      customerName,
      ownerId: owner.id,
      ownerName: owner.name,
      jobType,
      closed,
    });

    // Target a spread of bands: ~25% under, ~55% healthy, ~20% over.
    const roll = rng();
    const target = roll < 0.25 ? between(0, 4) : roll < 0.8 ? between(5, 12) : between(13, 18);
    const recencyMax = rng() < 0.3 ? 20 : 6; // some jobs go stale

    for (let k = 0; k < target; k++) {
      const daysAgo = between(0, recencyMax);
      const handler = rng() < 0.6 ? owner : pick(REPS);
      if (rng() < 0.5) {
        // a connected call
        calls.push({
          id: `demo_call_${i}_${k}`,
          jobId,
          customerId,
          repId: handler.id,
          role: handler.role,
          direction: rng() < 0.7 ? 'outbound' : 'inbound',
          startedAt: iso(DEMO_NOW, daysAgo, between(8, 17)),
          durationSec: between(25, 400),
        });
      } else {
        // a two-way text exchange in one day
        const threadId = `demo_thr_${i}_${k}`;
        const day = between(0, recencyMax);
        texts.push({
          threadId, jobId, customerId, repId: handler.id, role: handler.role,
          direction: 'out', ts: iso(DEMO_NOW, day, 10),
        });
        texts.push({
          threadId, jobId, customerId, repId: null, role: handler.role,
          direction: 'in', ts: iso(DEMO_NOW, day, 11),
        });
      }
    }

    // A few "attempts" (short calls / one-way blasts) so the attempts column is non-zero.
    if (rng() < 0.5) {
      calls.push({
        id: `demo_miss_${i}`, jobId, customerId, repId: owner.id, role: owner.role,
        direction: 'outbound', startedAt: iso(DEMO_NOW, between(0, recencyMax), 9), durationSec: between(0, 10),
      });
    }
  }

  // QA interactions: one scored item per rep across the period.
  const QA_PER_REP = 14;
  for (const rep of REPS) {
    for (let k = 0; k < QA_PER_REP; k++) {
      const labels = RUBRIC_BY_ROLE[rep.role];
      const base = between(55, 99);
      const rubricItems: RubricItem[] = labels.map((label, idx) => ({
        key: `${rep.role}_${idx}`,
        label,
        hit: rng() < base / 100,
      }));
      const disputed = rng() < 0.05;
      qa.push({
        id: `demo_qa_${rep.id}_${k}`,
        kind: rng() < 0.6 ? 'call' : 'text',
        role: rep.role,
        repId: rep.id,
        repName: rep.name,
        jobId: `demo_job_${between(0, JOB_COUNT - 1)}`,
        customerName: pick(CUSTOMERS),
        timestamp: iso(DEMO_NOW, between(0, 28), between(8, 17)),
        aiScore: base,
        managerScore: rng() < 0.1 ? Math.min(100, base + between(-15, 15)) : null,
        disputed,
        rubricItems,
        flags: base < 70 ? ['Missed booking attempt'] : [],
        sentiment: base > 85 ? 'positive' : base > 65 ? 'neutral' : 'negative',
      });
    }
  }

  // Training completions: 4 reps trained ~14 days before DEMO_NOW.
  const completions: TrainingCompletionRec[] = [
    { repId: 'rep_lena', repName: 'Lena Ortiz', role: 'csr', scenarioId: 'trn_book_new', scenarioTitle: 'Inbound booking — new customer', completedAt: iso(DEMO_NOW, 14, 12) },
    { repId: 'rep_marco', repName: 'Marco Bianchi', role: 'dispatch', scenarioId: 'trn_dispatch', scenarioTitle: 'Same-day reschedule', completedAt: iso(DEMO_NOW, 13, 12) },
    { repId: 'rep_sara', repName: 'Sara Klein', role: 'sales', scenarioId: 'trn_close', scenarioTitle: 'Closing the follow-up', completedAt: iso(DEMO_NOW, 16, 12) },
    { repId: 'rep_devon', repName: 'Devon Pierce', role: 'sales', scenarioId: 'trn_close', scenarioTitle: 'Closing the follow-up', completedAt: iso(DEMO_NOW, 12, 12) },
  ];

  return buildReport(
    { jobs, calls, texts, qa, completions, config: DEFAULT_CONFIG },
    DEMO_NOW,
  );
}
