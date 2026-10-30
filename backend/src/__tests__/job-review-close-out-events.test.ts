import { describe, it, expect } from 'vitest';
import { CLOSE_OUT_OWN_EVENT_TYPES, JOB_COMPLETED_EVENT, OFFICE_REVIEW_STARTED_EVENT } from '../lib/job-review-changeset';
import { OFFICE_REVIEW_FINISHED_EVENT, CUSTOMER_DECISION_APPLIED_EVENT } from '../lib/job-review-finish';
import { JOB_MARKED_DONE_EVENT } from '../lib/job-mark-done';
import { JOB_MOVED_BACK_EVENT } from '../lib/job-back-out';
import { JOB_REOPENED_EVENT } from '../lib/job-reopen';
import { CLOSE_OUT_UPGRADE_EVENT } from '../lib/job-close-out-upgrade';

/**
 * The review's own list of the close-out's history entries (entries that are not changes to the job's details) is written
 * out in the pure change-set module, which cannot import the writers. This pins each name to the module that writes it, so
 * a renamed event cannot quietly start un-checking the job summary.
 */
describe('the close-out entries the review ignores when it checks the job summary', () => {
  it('names every entry the close-out writes, as its writer spells it', () => {
    for (const type of [OFFICE_REVIEW_FINISHED_EVENT, CUSTOMER_DECISION_APPLIED_EVENT, JOB_MARKED_DONE_EVENT, JOB_REOPENED_EVENT, JOB_MOVED_BACK_EVENT, CLOSE_OUT_UPGRADE_EVENT]) {
      expect(CLOSE_OUT_OWN_EVENT_TYPES).toContain(type);
    }
  });

  it('names the two entries the controller that completes a job writes, as the history spells them', () => {
    expect(JOB_COMPLETED_EVENT).toBe('COMPLETED');
    expect(OFFICE_REVIEW_STARTED_EVENT).toBe('OFFICE_REVIEW_STARTED');
    expect(CLOSE_OUT_OWN_EVENT_TYPES).toContain(JOB_COMPLETED_EVENT);
    expect(CLOSE_OUT_OWN_EVENT_TYPES).toContain(OFFICE_REVIEW_STARTED_EVENT);
  });

  it('does not name any entry that is a change to the job', () => {
    for (const type of ['JOB_UPDATED', 'ATTACHMENT_DELETED', 'JOB_NOTE_ADDED', 'JOB_CONTACT_ENTRY_ADDED', 'STATUS_CHANGED', 'CANCELLED']) {
      expect(CLOSE_OUT_OWN_EVENT_TYPES).not.toContain(type);
    }
  });
});
