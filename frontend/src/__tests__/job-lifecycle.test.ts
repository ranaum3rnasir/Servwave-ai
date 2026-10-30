import { computeLifecycle, isPaidOff } from '@/lib/jobs/lifecycle';
import type { JobVisitRow } from '@/lib/visits';

// S5 (D11): the fixed Scheduled and On Site nodes this case used to name are gone - a trip's
// own node carries its own state now. The rule it asserts is unchanged: a node with its own
// stamp is reached, and a later node with none is not.
it('marks a stamped node reached and a later unstamped one not', () => {
  const stages = computeLifecycle(
    { created_at: '2026-05-01T00:00:00Z', completed_at: null, status: 'IN_PROGRESS', cancelled_at: null },
    { final_invoice: null },
    [{
      id: 'v-1', visit_seq: 1, status: 'COMPLETED',
      scheduled_at: '2026-05-10T14:00:00Z', scheduled_end: null, is_all_day: false,
      on_site_at: '2026-05-10T14:05:00Z', completed_at: '2026-05-10T16:00:00Z',
      created_at: '2026-05-01T00:00:00Z',
    }],
  );
  const by = Object.fromEntries(stages.map((s) => [s.key, s]));
  expect(by.created!.reached).toBe(true);
  expect(by['visit:v-1']!.reached).toBe(true);
  expect(by.completed!.reached).toBe(false);
});

it('lights invoice_sent and payment_received from the final invoice', () => {
  const stages = computeLifecycle(
    { created_at: 'x', completed_at: 'y', status: 'COMPLETED', cancelled_at: null },
    { final_invoice: { sent_at: '2026-05-11T00:00:00Z', paid_at: '2026-05-12T00:00:00Z', status: 'PAID', amount_due: '0' } },
  );
  const by = Object.fromEntries(stages.map((s) => [s.key, s]));
  expect(by.invoice_sent.reached).toBe(true);
  expect(by.payment_received.reached).toBe(true);
});

it('does NOT light payment_received when the invoice is sent but unpaid', () => {
  const stages = computeLifecycle(
    { created_at: 'x', completed_at: 'y', status: 'COMPLETED', cancelled_at: null },
    { final_invoice: { sent_at: '2026-05-11T00:00:00Z', paid_at: null, status: 'SENT', amount_due: '500' } },
  );
  const by = Object.fromEntries(stages.map((s) => [s.key, s]));
  expect(by.invoice_sent.reached).toBe(true);
  expect(by.payment_received.reached).toBe(false);
  expect(by.invoice_sent.current).toBe(true);
});

it('freezes the bar and reports cancellation (no current node)', () => {
  const stages = computeLifecycle({ created_at: 'x', status: 'CANCELLED', cancelled_at: 'z' }, { final_invoice: null });
  expect(stages.some((s) => s.current)).toBe(false);
});

// isPaidOff (final-review fix): standalone export so JobDetailPage's payment_received
// interactivity gate can reuse the SAME signal computeLifecycle uses, without re-deriving the
// hasTotals/fallback logic or paying for the whole stage pipeline.
describe('isPaidOff', () => {
  it('is false when a balance remains under the aggregate totals', () => {
    expect(isPaidOff({ final_invoice: null, total_invoiced: 1000, total_paid: 600 })).toBe(false);
  });

  it('is true once total_paid meets total_invoiced', () => {
    expect(isPaidOff({ final_invoice: null, total_invoiced: 1000, total_paid: 1000 })).toBe(true);
  });

  it('is true on an overpayment', () => {
    expect(isPaidOff({ final_invoice: null, total_invoiced: 1000, total_paid: 1100 })).toBe(true);
  });

  it('is false for an uninvoiced job (the 0 >= 0 trap)', () => {
    expect(isPaidOff({ final_invoice: null, total_invoiced: 0, total_paid: 0 })).toBe(false);
  });

  it('falls back to final_invoice.status when the totals are stripped (price-blind requester)', () => {
    expect(isPaidOff({ final_invoice: { status: 'PAID' } })).toBe(true);
    expect(isPaidOff({ final_invoice: { status: 'SENT', amount_due: '500' } })).toBe(false);
    expect(isPaidOff({ final_invoice: { status: 'SENT', amount_due: '0' } })).toBe(true);
  });

  it('is false with no financials at all', () => {
    expect(isPaidOff(undefined)).toBe(false);
    expect(isPaidOff(null)).toBe(false);
  });
});

/**
 * Multi-visit S5 (D11, D13): the bar becomes Job Created -> Visit 1..N -> Completed -> Invoice
 * Sent -> Payment Received. The fixed Scheduled and On Site nodes were only ever visit 1's
 * properties, so they go.
 */
describe('per-visit nodes (D11, D13)', () => {
  const visit = (over: Partial<JobVisitRow> & { id: string; visit_seq: number }): JobVisitRow => ({
    status: 'SCHEDULED',
    scheduled_at: null,
    scheduled_end: null,
    is_all_day: false,
    created_at: '2026-03-01T00:00:00Z',
    ...over,
  });

  it('orders visit nodes by TIME and labels them by CREATION order', () => {
    // Order and label deliberately disagree. D13: the number appears in the customer's email, so
    // sorting by visit_seq would renumber a trip they already hold a message about.
    const visits = [
      visit({ id: 'v-1', visit_seq: 1, scheduled_at: '2026-03-10T09:00:00Z', created_at: '2026-03-01T00:00:00Z' }),
      visit({ id: 'v-2', visit_seq: 2, scheduled_at: '2026-03-03T09:00:00Z', created_at: '2026-03-02T00:00:00Z' }),
      visit({ id: 'v-3', visit_seq: 3, scheduled_at: null, created_at: '2026-03-04T00:00:00Z' }),
    ];

    const stages = computeLifecycle(
      { created_at: '2026-03-01T00:00:00Z', completed_at: null, status: 'SCHEDULED', cancelled_at: null },
      { final_invoice: null },
      visits,
    );

    expect(stages.map((s) => s.key)).toEqual([
      'created', 'visit:v-2', 'visit:v-1', 'visit:v-3', 'completed', 'office_review', 'invoice_sent', 'payment_received', 'done',
    ]);
    expect(stages.map((s) => s.label)).toEqual([
      'Job Created', 'Visit 2', 'Visit 1', 'Visit 3', 'Completed', 'Office review', 'Invoice Sent', 'Payment Received', 'Done',
    ]);
  });
});

/**
 * S5 B4 (D11a): forward-fill dies. The bar marked a stage reached whenever ANY later stage carried
 * a timestamp, so a job billed before anyone marked it complete drew a green tick over a step that
 * never happened. `reached` becomes per-node truth.
 */
describe('per-node truth for the job nodes (D11a)', () => {
  it('does not mark Completed reached just because an invoice went out', () => {
    const stages = computeLifecycle(
      { created_at: '2026-03-01T09:00:00Z', completed_at: null, status: 'IN_PROGRESS', cancelled_at: null },
      { final_invoice: null, first_sent_at: '2026-03-10T12:00:00Z', total_invoiced: 900, total_paid: 0 },
    );
    const by = Object.fromEntries(stages.map((s) => [s.key, s]));
    expect(by.invoice_sent!.reached).toBe(true);
    expect(by.completed!.reached).toBe(false);
  });
});

/**
 * S5 B5 (D11a, D19): `at != null` is exactly the WRONG rule for a visit node. A booked trip's `at`
 * falls back to its scheduled_at, so a trip nobody has left for yet would draw a green tick - and
 * D11a's own wording ("a future visit sitting after a completed one") is this case. A cancelled
 * trip keeps its node and its number, greyed, and is never reached.
 */
describe('per-node truth for the visit nodes (D11a, D19)', () => {
  it('reaches a COMPLETED visit only - not a booked one, and never a cancelled one', () => {
    const stages = computeLifecycle(
      { created_at: '2026-03-01T09:00:00Z', completed_at: null, status: 'IN_PROGRESS', cancelled_at: null },
      { final_invoice: null },
      [
        {
          id: 'v-1', visit_seq: 1, status: 'COMPLETED',
          scheduled_at: '2026-03-02T09:00:00Z', scheduled_end: null, is_all_day: false,
          completed_at: '2026-03-02T16:00:00Z', created_at: '2026-03-01T00:00:00Z',
        },
        {
          id: 'v-2', visit_seq: 2, status: 'SCHEDULED',
          scheduled_at: '2026-09-20T09:00:00Z', scheduled_end: null, is_all_day: false,
          created_at: '2026-03-01T01:00:00Z',
        },
        {
          id: 'v-3', visit_seq: 3, status: 'CANCELLED',
          scheduled_at: '2026-09-25T09:00:00Z', scheduled_end: null, is_all_day: false,
          cancelled_at: '2026-03-05T10:00:00Z', created_at: '2026-03-01T02:00:00Z',
        },
      ],
    );
    const by = Object.fromEntries(stages.map((s) => [s.key, s]));
    expect(by['visit:v-1']!.reached).toBe(true);
    expect(by['visit:v-2']!.reached).toBe(false);
    expect(by['visit:v-3']!.reached).toBe(false);
  });
});

/**
 * S5 B7: with forward-fill gone, the legacy "last reached stage" rule can never name a live visit -
 * B5 deliberately leaves a booked trip unreached. So `current` needs its own rule, and it must be
 * the SAME one the page hero's Next Visit tile uses, or the rail and the hero disagree on one screen.
 *
 * This matters beyond the tick: interactivity is gated on `!stage.current`, so getting this wrong
 * silently changes which nodes are clickable.
 */
describe('the current node names the live visit (B7)', () => {
  const DONE_VISIT = {
    id: 'v-1', visit_seq: 1, status: 'COMPLETED',
    scheduled_at: '2026-03-02T09:00:00Z', scheduled_end: null, is_all_day: false,
    completed_at: '2026-03-02T16:00:00Z', created_at: '2026-03-01T00:00:00Z',
  };
  const LIVE_VISIT = {
    id: 'v-2', visit_seq: 2, status: 'SCHEDULED',
    scheduled_at: '2026-09-20T09:00:00Z', scheduled_end: null, is_all_day: false,
    created_at: '2026-03-01T01:00:00Z',
  };
  const BILLED = { final_invoice: null, first_sent_at: '2026-03-10T12:00:00Z', total_invoiced: 900, total_paid: 0 };

  it('marks exactly the live trip current, not the last reached stage', () => {
    const stages = computeLifecycle(
      { created_at: '2026-03-01T09:00:00Z', completed_at: null, status: 'IN_PROGRESS', cancelled_at: null },
      BILLED,
      [DONE_VISIT, LIVE_VISIT],
    );
    expect(stages.filter((s) => s.current).map((s) => s.key)).toEqual(['visit:v-2']);
  });

  it('leaves a cancelled job with no current node at all (the bar freezes)', () => {
    const stages = computeLifecycle(
      { created_at: '2026-03-01T09:00:00Z', completed_at: null, status: 'CANCELLED', cancelled_at: '2026-03-04T09:00:00Z' },
      BILLED,
      [DONE_VISIT, LIVE_VISIT],
    );
    expect(stages.some((s) => s.current)).toBe(false);
  });

  it('falls back to the last reached stage when no trip is still live', () => {
    const stages = computeLifecycle(
      { created_at: '2026-03-01T09:00:00Z', completed_at: null, status: 'IN_PROGRESS', cancelled_at: null },
      BILLED,
      [DONE_VISIT],
    );
    expect(stages.filter((s) => s.current).map((s) => s.key)).toEqual(['invoice_sent']);
  });
});

/**
 * Roles & Permissions, PRD 6, S06.21 (M9): the bar is Created, Visits, Completed, Office review, Invoice sent, Payment
 * received, Done. The marker follows the job's status; a step the job moved past without reaching is skipped.
 */
describe('the close-out steps and the marker (S06.21)', () => {
  const JOB = { created_at: '2026-03-01T09:00:00Z', completed_at: '2026-03-05T09:00:00Z', cancelled_at: null };
  const stagesFor = (status: string, extra: Partial<typeof JOB> = {}, visits: JobVisitRow[] = [], money?: { money_owed: boolean; zero_total: boolean }) =>
    computeLifecycle({ ...JOB, ...extra, status }, { final_invoice: null }, visits, money);
  const byKey = (stages: ReturnType<typeof computeLifecycle>) => Object.fromEntries(stages.map((s) => [s.key, s]));
  const visit = (over: Partial<JobVisitRow> & { id: string; visit_seq: number }): JobVisitRow => ({
    status: 'SCHEDULED', scheduled_at: '2026-03-02T09:00:00Z', scheduled_end: null, is_all_day: false, created_at: '2026-03-01T00:00:00Z', ...over,
  });

  it('draws the steps in the PRD order with no visits', () => {
    expect(stagesFor('OFFICE_REVIEW').map((s) => s.key)).toEqual([
      'created', 'completed', 'office_review', 'invoice_sent', 'payment_received', 'done',
    ]);
  });

  it('puts the marker on the Office review step in Office review, labelled Office review, not yet reached', () => {
    const stages = stagesFor('OFFICE_REVIEW');
    expect(stages.filter((s) => s.current).map((s) => s.key)).toEqual(['office_review']);
    expect(byKey(stages).office_review!.label).toBe('Office review');
    expect(byKey(stages).office_review!.reached).toBe(false);
  });

  it('keeps the marker on the same step in Ready to close, which reads Ready to close and is reached', () => {
    const stages = stagesFor('READY_TO_CLOSE');
    expect(stages.filter((s) => s.current).map((s) => s.key)).toEqual(['office_review']);
    expect(byKey(stages).office_review!.label).toBe('Ready to close');
    expect(byKey(stages).office_review!.reached).toBe(true);
    expect(byKey(stages).done!.reached).toBe(false);
  });

  it('puts the marker on Done, reached, once the job is Done, and Office review is reached too', () => {
    const stages = stagesFor('DONE');
    expect(stages.filter((s) => s.current).map((s) => s.key)).toEqual(['done']);
    expect(byKey(stages).done!.reached).toBe(true);
    expect(byKey(stages).office_review!.reached).toBe(true);
    expect(byKey(stages).office_review!.label).toBe('Office review');
  });

  it('does not light Office review or Done before the review is finished', () => {
    for (const status of ['IN_PROGRESS', 'COMPLETED', 'OFFICE_REVIEW']) {
      const by = byKey(stagesFor(status, status === 'IN_PROGRESS' ? { completed_at: null } : {}));
      expect(by.office_review!.reached).toBe(false);
      expect(by.done!.reached).toBe(false);
    }
  });

  it('puts the marker on the status step even while a visit is still live', () => {
    const stages = stagesFor('OFFICE_REVIEW', {}, [visit({ id: 'v-1', visit_seq: 1, status: 'SCHEDULED' })]);
    expect(stages.filter((s) => s.current).map((s) => s.key)).toEqual(['office_review']);
  });

  it('leaves a cancelled job with no marker and no skipped step', () => {
    const stages = stagesFor('CANCELLED', { cancelled_at: '2026-03-06T09:00:00Z' }, [visit({ id: 'v-1', visit_seq: 1 })], { money_owed: true, zero_total: false });
    expect(stages.some((s) => s.current)).toBe(false);
    expect(stages.some((s) => s.skipped)).toBe(false);
  });
});

describe('skipped steps (S06.21)', () => {
  const JOB = { created_at: '2026-03-01T09:00:00Z', completed_at: '2026-03-05T09:00:00Z', cancelled_at: null };
  const visit = (over: Partial<JobVisitRow> & { id: string; visit_seq: number }): JobVisitRow => ({
    status: 'SCHEDULED', scheduled_at: '2026-03-02T09:00:00Z', scheduled_end: null, is_all_day: false, created_at: '2026-03-01T00:00:00Z', ...over,
  });
  const skippedKeys = (status: string, opts: {
    visits?: JobVisitRow[]; financials?: Parameters<typeof computeLifecycle>[1];
    money?: { money_owed: boolean; zero_total: boolean } | null; cancelled_at?: string | null;
  } = {}) =>
    computeLifecycle(
      { ...JOB, status, cancelled_at: opts.cancelled_at ?? null },
      'financials' in opts ? opts.financials : { final_invoice: null },
      opts.visits ?? [],
      opts.money,
    ).filter((s) => s.skipped).map((s) => s.key);

  const NOT_ZERO = { money_owed: false, zero_total: false };
  const SENT_UNPAID = { final_invoice: null, first_sent_at: '2026-03-10T12:00:00Z', total_invoiced: 500, total_paid: 100 };
  const PAID = { final_invoice: null, first_sent_at: '2026-03-10T12:00:00Z', total_invoiced: 500, total_paid: 500 };

  describe('a visit still live once the job is Completed or later', () => {
    it.each(['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'])('is skipped in %s', (status) => {
      expect(skippedKeys(status, { visits: [visit({ id: 'v-1', visit_seq: 1, status: 'EN_ROUTE' })], money: NOT_ZERO, financials: PAID }))
        .toEqual(['visit:v-1']);
    });

    it('is not skipped before the job is completed: it is the open trip', () => {
      expect(skippedKeys('IN_PROGRESS', { visits: [visit({ id: 'v-1', visit_seq: 1 })] })).toEqual([]);
    });

    it('never skips a finished visit, and never a cancelled one (kept grey, including the ones the complete cancelled)', () => {
      const keys = skippedKeys('OFFICE_REVIEW', {
        visits: [
          visit({ id: 'v-1', visit_seq: 1, status: 'COMPLETED' }),
          visit({ id: 'v-2', visit_seq: 2, status: 'CANCELLED', cancelled_at: '2026-03-05T09:00:00Z' }),
        ],
      });
      expect(keys).toEqual([]);
    });
  });

  describe('the money steps once the job is Done', () => {
    it('skips Invoice sent and Payment received on a job with a price that was never invoiced', () => {
      expect(skippedKeys('DONE', { money: NOT_ZERO, financials: { final_invoice: null, total_invoiced: 0, total_paid: 0 } }))
        .toEqual(['invoice_sent', 'payment_received']);
    });

    it('skips only Payment received on a job closed with money owed', () => {
      expect(skippedKeys('DONE', { money: { money_owed: true, zero_total: false }, financials: SENT_UNPAID })).toEqual(['payment_received']);
    });

    it('skips Payment received when the server says money is owed even if the invoices read as paid', () => {
      expect(skippedKeys('DONE', { money: { money_owed: true, zero_total: false }, financials: PAID })).toEqual(['payment_received']);
    });

    it('skips nothing on a job that was invoiced and paid', () => {
      expect(skippedKeys('DONE', { money: NOT_ZERO, financials: PAID })).toEqual([]);
    });

    it('never skips a money step on a job whose total is zero', () => {
      expect(skippedKeys('DONE', { money: { money_owed: false, zero_total: true }, financials: { final_invoice: null, total_invoiced: 0, total_paid: 0 } })).toEqual([]);
    });

    it('does not say a step was skipped while the server has not said whether the total is zero', () => {
      expect(skippedKeys('DONE', { financials: { final_invoice: null, total_invoiced: 0, total_paid: 0 } })).toEqual([]);
      expect(skippedKeys('DONE', { money: null, financials: SENT_UNPAID })).toEqual([]);
    });

    it('does not say a step was skipped while the job money is still loading', () => {
      expect(skippedKeys('DONE', { money: NOT_ZERO, financials: undefined })).toEqual([]);
    });

    it('draws a skipped step as not reached', () => {
      const stages = computeLifecycle({ ...JOB, status: 'DONE', cancelled_at: null }, SENT_UNPAID, [], { money_owed: true, zero_total: false });
      const payment = stages.find((s) => s.key === 'payment_received')!;
      expect(payment.skipped).toBe(true);
      expect(payment.reached).toBe(false);
    });

    it.each(['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE'])('skips no money step in %s: the job is not closed yet', (status) => {
      expect(skippedKeys(status, { money: NOT_ZERO, financials: { final_invoice: null, total_invoiced: 0, total_paid: 0 } })).toEqual([]);
    });
  });

  it('never skips Office review or Completed, whatever the status', () => {
    for (const status of ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE']) {
      const keys = skippedKeys(status, { money: NOT_ZERO, financials: { final_invoice: null, total_invoiced: 0, total_paid: 0 } });
      expect(keys).not.toContain('office_review');
      expect(keys).not.toContain('completed');
    }
  });
});
