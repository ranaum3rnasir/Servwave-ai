import { describe, it, expect } from 'vitest';
import { milestoneClears, clearsCompletion, type Milestone } from '../lib/job-milestones';

const ALL: Milestone[] = ['scheduled', 'on_site', 'started', 'completed'];

describe('milestoneClears', () => {
  // S8 (RATIFIED, A5): en_route_at/on_site_at DROPPED from `jobs` entirely - only
  // started_at/completed_at are left to clear at the job level. The VISIT's own
  // en_route_at/on_site_at (a separate column on a separate table) were never this function's
  // job and are untouched either way.
  it('clears every later job timestamp when moving back to Scheduled', () => {
    expect(milestoneClears('scheduled')).toEqual({
      started_at: null, completed_at: null,
      cancelled_at: null, cancelled_reason: null,
    });
  });

  it('never names en_route_at or on_site_at — those columns are gone from `jobs` (S8)', () => {
    for (const m of ALL) {
      expect(milestoneClears(m)).not.toHaveProperty('en_route_at');
      expect(milestoneClears(m)).not.toHaveProperty('on_site_at');
    }
  });

  it('clears start and completion when moving back to On Site', () => {
    expect(milestoneClears('on_site')).toEqual({
      started_at: null, completed_at: null,
      cancelled_at: null, cancelled_reason: null,
    });
  });

  it('clears only completion when moving back to Start', () => {
    expect(milestoneClears('started')).toEqual({
      completed_at: null, cancelled_at: null, cancelled_reason: null,
    });
  });

  it('clears nothing but the cancellation when moving to Completed (the last job stage)', () => {
    expect(milestoneClears('completed')).toEqual({
      cancelled_at: null, cancelled_reason: null,
    });
  });

  it('NEVER clears scheduled_start or scheduled_end from any milestone', () => {
    // The load-bearing invariant. Nothing precedes Scheduled but Job Created, which is not
    // actionable — so no node click ever un-schedules a job. Clearing scheduled_start would
    // break assignJobSchema's start/end pairing refine, drop the job out of the board's
    // date-range query, and misfire the JOB_SCHEDULED vs JOB_RESCHEDULED automation branch.
    for (const m of ALL) {
      expect(milestoneClears(m)).not.toHaveProperty('scheduled_start');
      expect(milestoneClears(m)).not.toHaveProperty('scheduled_end');
      expect(milestoneClears(m)).not.toHaveProperty('is_all_day');
    }
  });

  it('always un-cancels — cancellation is not terminal', () => {
    for (const m of ALL) {
      expect(milestoneClears(m).cancelled_at).toBeNull();
      expect(milestoneClears(m).cancelled_reason).toBeNull();
    }
  });

  it('NEVER clears work product or the customer-email send guard', () => {
    // completion_notes and signature_* stay valid on re-completion. Clearing
    // customer_scheduled_email_sent_at would re-email the customer.
    for (const m of ALL) {
      const cleared = milestoneClears(m);
      for (const k of ['completion_notes', 'signature_data', 'signature_ip', 'signature_at',
                       'customer_scheduled_email_sent_at']) {
        expect(cleared).not.toHaveProperty(k);
      }
    }
  });

  it('NEVER touches invoice or payment state', () => {
    for (const m of ALL) {
      const cleared = milestoneClears(m);
      for (const k of ['amount_invoiced', 'invoices', 'sent_at', 'paid_at']) {
        expect(cleared).not.toHaveProperty(k);
      }
    }
  });
});

describe('clearsCompletion', () => {
  it('is true for every milestone that nulls completed_at', () => {
    expect(clearsCompletion('scheduled')).toBe(true);
    expect(clearsCompletion('on_site')).toBe(true);
    expect(clearsCompletion('started')).toBe(true);
  });

  it('is false for completed, which sets it rather than clearing it', () => {
    expect(clearsCompletion('completed')).toBe(false);
  });

  it('agrees with milestoneClears — no drift between the two', () => {
    for (const m of ALL) {
      expect(clearsCompletion(m)).toBe(milestoneClears(m).completed_at === null);
    }
  });
});
