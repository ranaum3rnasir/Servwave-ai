/**
 * The convert-to-job gate's state matrix (#2188 slice 15).
 *
 * The defect this suite pins: a non-convertible estimate used to collapse into the SAME answer
 * as "you hold no create Job grant" - invisible, unexplained - so an operator could not tell a
 * missing capability from a temporary block. The permission case must stay invisible; every
 * other refusal must be a VISIBLE, DISABLED control carrying the backend's own reason.
 */
import { describe, it, expect } from 'vitest';
import {
  CONVERT_BLOCK_REASONS,
  CONVERT_DEPOSIT_BLOCKED_REASON,
  CONVERT_JOB_LABELS,
  convertToJobState,
  isConvertibleEstimate,
} from './convertToJob';

const WON = { status: 'WON', job: null, job_id: null };
const OWN_JOB = 'job-own-1';
const OTHER_JOB = 'job-other-9';

describe('convertToJobState - a refusal the operator can read', () => {
  it('shows a DISABLED control saying why, on an estimate that is not won yet', () => {
    const state = convertToJobState({
      estimate: { status: 'SENT', job: null, job_id: null },
      depositInvoice: null,
      canCreateJob: true,
    });

    expect(state.visible).toBe(true);
    expect(state.disabled).toBe(true);
    expect(state.reason).toMatch(/won/i);
  });

  it('offers the control on a won, unattached estimate', () => {
    const state = convertToJobState({ estimate: WON, depositInvoice: null, canCreateJob: true });

    expect(state).toEqual({ visible: true, disabled: false, action: 'create' });
  });
});

describe('convertToJobState - the state matrix', () => {
  it('DRAFT: visible, disabled, not-won reason', () => {
    expect(
      convertToJobState({ estimate: { status: 'DRAFT', job: null, job_id: null }, canCreateJob: true }),
    ).toEqual({ visible: true, disabled: true, code: 'NOT_WON', reason: CONVERT_BLOCK_REASONS.NOT_WON, action: 'create' });
  });

  it('SENT: visible, disabled, not-won reason', () => {
    expect(
      convertToJobState({ estimate: { status: 'SENT', job: null, job_id: null }, canCreateJob: true }),
    ).toEqual({ visible: true, disabled: true, code: 'NOT_WON', reason: CONVERT_BLOCK_REASONS.NOT_WON, action: 'create' });
  });

  it('WON with an unsettled deposit: visible, disabled, the EXISTING deposit wording', () => {
    const state = convertToJobState({
      estimate: WON,
      depositInvoice: { status: 'SENT' },
      canCreateJob: true,
    });

    expect(state).toEqual({
      visible: true,
      disabled: true,
      code: 'DEPOSIT_UNSETTLED',
      reason: CONVERT_DEPOSIT_BLOCKED_REASON,
      action: 'create',
    });
  });

  it.each(['PAID', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED'])(
    'WON with a %s deposit: settled, so the control is enabled (the backend accepts all four)',
    (status) => {
      expect(
        convertToJobState({ estimate: WON, depositInvoice: { status }, canCreateJob: true }),
      ).toEqual({ visible: true, disabled: false, action: 'create' });
    },
  );

  it('WON and attached to ANOTHER job: visible, disabled, the already-attached reason', () => {
    const state = convertToJobState({
      estimate: { status: 'WON', job: null, job_id: OTHER_JOB },
      canCreateJob: true,
    });

    expect(state).toEqual({
      visible: true,
      disabled: true,
      code: 'ATTACHED_TO_OTHER_JOB',
      reason: CONVERT_BLOCK_REASONS.ATTACHED_TO_OTHER_JOB,
      action: 'create',
    });
  });

  it('WON and re-converting to its OWN provenance job: still allowed, never reported as attached', () => {
    // The shape a converted estimate actually carries: the conversion writes BOTH pointers at the
    // same job (job.controller.ts). The backend answers this with its idempotent find-or-create.
    const state = convertToJobState({
      estimate: { status: 'WON', job: { id: OWN_JOB }, job_id: OWN_JOB },
      canCreateJob: true,
    });

    // Allowed, and honestly labelled: the click opens that same job.
    expect(state).toEqual({ visible: true, disabled: false, action: 'view' });
    expect(state.reason).toBeUndefined();
  });

  it('WON, eligible, with a SIBLING estimate already converted: unaffected - a lead may hold many jobs', () => {
    const sibling = { status: 'WON', job: { id: OWN_JOB }, job_id: OWN_JOB };
    const second = { ...WON };

    // The sibling's own conversion is a fact about the sibling; it says nothing about this one.
    expect(convertToJobState({ estimate: sibling, canCreateJob: true }).disabled).toBe(false);
    expect(convertToJobState({ estimate: second, canCreateJob: true })).toEqual({
      visible: true,
      disabled: false,
      action: 'create',
    });
  });

  it('names what the click DOES: View Job once the estimate holds its own job, Create Job before', () => {
    // Re-conversion is allowed and lands on the existing job, so the control must stop naming an
    // act it does not perform. The answer rides on the state, so the lead-side dialog reaches the
    // same one without re-deriving it from the estimate shape.
    const converted = convertToJobState({
      estimate: { status: 'WON', job: { id: OWN_JOB }, job_id: OWN_JOB },
      canCreateJob: true,
    });
    const eligible = convertToJobState({ estimate: WON, canCreateJob: true });

    expect(converted.action).toBe('view');
    expect(CONVERT_JOB_LABELS[converted.action]).toBe('View Job');
    expect(eligible.action).toBe('create');
    expect(CONVERT_JOB_LABELS[eligible.action]).toBe('Create Job');
    // Both are live - the relabel changes the word, not the affordance.
    expect(converted.disabled).toBe(false);
    expect(eligible.disabled).toBe(false);
  });

  it('a BLOCKED estimate still reads Create Job - there is no job of its own to view', () => {
    const blocked = convertToJobState({
      estimate: { status: 'WON', job: null, job_id: OTHER_JOB },
      canCreateJob: true,
    });

    expect(blocked.action).toBe('create');
    expect(blocked.disabled).toBe(true);
  });

  it('distinguishes all three refusals - no two share a reason', () => {
    const reasons = Object.values(CONVERT_BLOCK_REASONS);
    expect(new Set(reasons).size).toBe(3);
  });

  it('every refusal states a NEXT STEP, not just the rule', () => {
    for (const reason of Object.values(CONVERT_BLOCK_REASONS)) {
      // Rule sentence, then an actionable one - the operator must not have to ask support.
      expect(reason.split('. ').length).toBeGreaterThanOrEqual(2);
      expect(reason).toMatch(/\b(mark|open|duplicate|waive)\b/i);
    }
  });
});

describe('convertToJobState - a permission nobody holds stays silent', () => {
  it.each([
    ['eligible', WON],
    ['not won', { status: 'SENT', job: null, job_id: null }],
    ['attached elsewhere', { status: 'WON', job: null, job_id: OTHER_JOB }],
  ])('renders NOTHING without create Job, even when %s', (_label, estimate) => {
    expect(
      convertToJobState({ estimate, depositInvoice: { status: 'SENT' }, canCreateJob: false }),
    ).toEqual({ visible: false, disabled: false, action: 'create' });
  });
});

describe('isConvertibleEstimate - the multi-select candidate predicate', () => {
  // Unchanged by slice 15: the lead dialog picks candidates for the MULTI branch, which rejects
  // any estimate carrying either pointer. Only the single-estimate gate tolerates a re-conversion.
  it('accepts a won, unattached estimate', () => {
    expect(isConvertibleEstimate(WON)).toBe(true);
  });

  it('rejects an estimate that already produced a job, and one that is not won', () => {
    expect(isConvertibleEstimate({ status: 'WON', job: { id: OWN_JOB }, job_id: OWN_JOB })).toBe(false);
    expect(isConvertibleEstimate({ status: 'SENT', job: null, job_id: null })).toBe(false);
  });
});
