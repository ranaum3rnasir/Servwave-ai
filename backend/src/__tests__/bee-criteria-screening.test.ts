import { describe, it, expect } from 'vitest';

describe('Bee Call Queue and Call Logs Criteria Screening', () => {
  const validJobTypes = new Set([
    'HVAC Service',
    'HVAC Install',
    'Plumbing',
    'Electrical',
    'General Maintenance',
    'Other',
  ]);

  function screenQueueItem(item: any, validTypes: Set<string>): boolean {
    const jobInfo = item.job_info;
    if (!jobInfo || !jobInfo.job_id) return false;
    const jobType = (jobInfo.job_type || item.warranty_record?.job_type || '').trim();
    if (!jobType || !validTypes.has(jobType)) return false;

    const isCompleted =
      jobInfo.status === 'DONE' ||
      jobInfo.status === 'COMPLETED' ||
      Boolean(jobInfo.closed_at) ||
      Boolean(jobInfo.completed_at);
    const hasSentOrPaidInvoice = Array.isArray(jobInfo.invoices) && jobInfo.invoices.some(
      (inv: any) => inv.status === 'SENT' || inv.status === 'PAID'
    );
    return isCompleted || hasSentOrPaidInvoice;
  }

  function formatCallLogJob(
    r: { customer_name?: string; is_test_call?: boolean },
    matchedJob?: {
      id: string;
      job_number?: string;
      job_type?: string;
      status?: string;
      completed_at?: Date | string | null;
      invoices?: { status: string }[];
    },
    validTypes: Set<string> = validJobTypes
  ) {
    const lowerName = (r.customer_name || '').toLowerCase().trim();
    const isTestCall = Boolean(r.is_test_call) || lowerName === 'test call' || lowerName.includes('test call');

    let validJob = matchedJob;
    if (isTestCall) {
      validJob = undefined;
    } else if (validJob) {
      const rawJobType = (validJob.job_type || '').trim();
      const isCompleted =
        validJob.status === 'DONE' ||
        validJob.status === 'COMPLETED' ||
        Boolean(validJob.closed_at) ||
        Boolean(validJob.completed_at);
      const hasSentOrPaidInvoice = Array.isArray(validJob.invoices) && validJob.invoices.some(
        (inv: any) => inv.status === 'SENT' || inv.status === 'PAID'
      );
      if (!validTypes.has(rawJobType) || (!isCompleted && !hasSentOrPaidInvoice)) {
        validJob = undefined;
      }
    }

    if (isTestCall) {
      return 'Test Call';
    }

    if (!validJob) {
      return '—';
    }

    const rawJobNumber = validJob.job_number ? String(validJob.job_number).trim() : '';
    const jobNum = rawJobNumber
      ? rawJobNumber.startsWith('#')
        ? rawJobNumber
        : `#${rawJobNumber}`
      : `#${validJob.id.slice(0, 8)}`;
    const jobDesc = validJob.job_type || '—';

    return `${jobNum} · ${jobDesc}`;
  }

  describe('Call Queue Screening', () => {
    it('accepts job with valid type and status COMPLETED', () => {
      const item = {
        job_info: {
          job_id: 'job-1',
          job_type: 'HVAC Service',
          status: 'COMPLETED',
        },
      };
      expect(screenQueueItem(item, validJobTypes)).toBe(true);
    });

    it('accepts job with valid type and status DONE', () => {
      const item = {
        job_info: {
          job_id: 'job-done-1',
          job_type: 'HVAC Service',
          status: 'DONE',
        },
      };
      expect(screenQueueItem(item, validJobTypes)).toBe(true);
    });

    it('accepts job with valid type and SENT invoice even if status is not COMPLETED', () => {
      const item = {
        job_info: {
          job_id: 'job-2',
          job_type: 'Plumbing',
          status: 'IN_PROGRESS',
          invoices: [{ status: 'SENT' }],
        },
      };
      expect(screenQueueItem(item, validJobTypes)).toBe(true);
    });

    it('rejects job without job_id', () => {
      const item = {
        job_info: {
          job_type: 'HVAC Service',
          status: 'COMPLETED',
        },
      };
      expect(screenQueueItem(item, validJobTypes)).toBe(false);
    });

    it('rejects job with invalid job type not in system (e.g. legacy test hardware type)', () => {
      const item = {
        job_info: {
          job_id: 'job-3',
          job_type: 'Storefront Door Repair',
          status: 'COMPLETED',
        },
      };
      expect(screenQueueItem(item, validJobTypes)).toBe(false);
    });

    it('rejects job with valid type that has neither completed status nor sent/paid invoice', () => {
      const item = {
        job_info: {
          job_id: 'job-4',
          job_type: 'Electrical',
          status: 'DRAFT',
          invoices: [{ status: 'DRAFT' }],
        },
      };
      expect(screenQueueItem(item, validJobTypes)).toBe(false);
    });
  });

  describe('Call Log Job Association', () => {
    it('labels test calls cleanly as Test Call without dummy job info or warranty date', () => {
      const result = formatCallLogJob({ customer_name: 'Test Call', is_test_call: true });
      expect(result).toBe('Test Call');
    });

    it('labels test calls with arbitrary test name as Test Call and ignores customer warranty', () => {
      const result = formatCallLogJob({ customer_name: 'test call (626) 323-9523' });
      expect(result).toBe('Test Call');
    });

    it('formats valid customer job when completed and type is valid', () => {
      const result = formatCallLogJob(
        { customer_name: 'John Doe' },
        {
          id: '12345678-0000',
          job_number: '1001',
          job_type: 'HVAC Service',
          status: 'COMPLETED',
        }
      );
      expect(result).toBe('#1001 · HVAC Service');
    });

    it('falls back to dash instead of fabricating fake job if job has invalid type', () => {
      const result = formatCallLogJob(
        { customer_name: 'John Doe' },
        {
          id: '12345678-0000',
          job_number: '9999',
          job_type: 'Panic Hardware',
          status: 'COMPLETED',
        }
      );
      expect(result).toBe('—');
    });

    it('falls back to dash if job is uncompleted and has no sent invoice', () => {
      const result = formatCallLogJob(
        { customer_name: 'John Doe' },
        {
          id: '12345678-0000',
          job_number: '1002',
          job_type: 'Plumbing',
          status: 'SCHEDULED',
          invoices: [{ status: 'DRAFT' }],
        }
      );
      expect(result).toBe('—');
    });
  });
});
