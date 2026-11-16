import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { BeeService } from '../services/bee/beeService';
import { BeeVoiceAdapter } from '../services/bee/beeVoiceAdapter';

describe('Bee Skipped & Archived Jobs Management', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Eligibility Conditions & Skip Reasons Detection', () => {
    it('detects Customer to Skip Tag when customer has an excluded tag', async () => {
      const eligibility = await BeeService.evaluateJobCallEligibility({
        orgId,
        customerId: 'cust-1',
        customerPhone: '+15551112222',
        jobType: 'HVAC Repair',
        jobAmount: 500,
        beeSettings: {
          setup_config: { excludedTags: ['VIP Do Not Solicit', 'Skip Outbound'] },
        },
        customerTagNames: ['VIP Do Not Solicit'],
        jobRules: [{ job_type: 'HVAC Repair', is_active: true }],
      });

      expect(eligibility.isSkipped).toBe(true);
      expect(eligibility.reasons).toContain('Customer to Skip Tag');
      expect(eligibility.skipReason).toBe('Customer to Skip Tag');
    });

    it('detects Job Below Minimum Amount when job total is below threshold', async () => {
      const eligibility = await BeeService.evaluateJobCallEligibility({
        orgId,
        customerId: 'cust-2',
        customerPhone: '+15552223333',
        jobType: 'Plumbing',
        jobAmount: 75,
        beeSettings: {
          setup_config: { skipMinJobAmount: 150 },
        },
        customerTagNames: [],
        jobRules: [{ job_type: 'Plumbing', is_active: true }],
      });

      expect(eligibility.isSkipped).toBe(true);
      expect(eligibility.reasons).toContain('Job Below Minimum Amount');
      expect(eligibility.skipReason).toBe('Job Below Minimum Amount');
    });

    it('detects Do Not Call (DNC) when customer phone is on DNC list', async () => {
      vi.mocked(prisma.beeDncEntry.findFirst).mockResolvedValueOnce({
        id: 'dnc-1',
        phone_number: '+15559998888',
      } as any);

      const eligibility = await BeeService.evaluateJobCallEligibility({
        orgId,
        customerId: 'cust-3',
        customerPhone: '+1 (555) 999-8888',
        jobType: 'Electrical',
        jobAmount: 300,
        beeSettings: {
          setup_config: { skipMinJobAmount: 100 },
        },
        customerTagNames: [],
        jobRules: [{ job_type: 'Electrical', is_active: true }],
      });

      expect(eligibility.isSkipped).toBe(true);
      expect(eligibility.reasons).toContain('Do Not Call (DNC)');
      expect(eligibility.skipReason).toBe('Do Not Call (DNC)');
    });

    it('detects Job Type Disabled when the job type rule is deactivated', async () => {
      vi.mocked(prisma.beeDncEntry.findFirst).mockResolvedValueOnce(null);

      const eligibility = await BeeService.evaluateJobCallEligibility({
        orgId,
        customerId: 'cust-4',
        customerPhone: '+15554445555',
        jobType: 'Roofing Inspection',
        jobAmount: 600,
        beeSettings: {
          setup_config: { skipMinJobAmount: 100 },
        },
        customerTagNames: [],
        jobRules: [{ job_type: 'Roofing Inspection', is_active: false }],
      });

      expect(eligibility.isSkipped).toBe(true);
      expect(eligibility.reasons).toContain('Job Type Disabled');
      expect(eligibility.skipReason).toBe('Job Type Disabled');
    });

    it('handles multiple skip conditions simultaneously and retains all reasons joined', async () => {
      vi.mocked(prisma.beeDncEntry.findFirst).mockResolvedValueOnce({
        id: 'dnc-2',
        phone_number: '+15557778888',
      } as any);

      const eligibility = await BeeService.evaluateJobCallEligibility({
        orgId,
        customerId: 'cust-5',
        customerPhone: '+1 (555) 777-8888',
        jobType: 'Custom Carpentry',
        jobAmount: 50, // below 200 min
        beeSettings: {
          setup_config: {
            excludedTags: ['Exempt Customer'],
            skipMinJobAmount: 200,
          },
        },
        customerTagNames: ['Exempt Customer'],
        jobRules: [{ job_type: 'Custom Carpentry', is_active: false }],
      });

      expect(eligibility.isSkipped).toBe(true);
      expect(eligibility.reasons).toEqual([
        'Customer to Skip Tag',
        'Job Below Minimum Amount',
        'Do Not Call (DNC)',
        'Job Type Disabled',
      ]);
      expect(eligibility.skipReason).toBe(
        'Customer to Skip Tag, Job Below Minimum Amount, Do Not Call (DNC), Job Type Disabled'
      );
    });
  });

  describe('Queue Runner (processDueQueueItems) Skipped & Archived Handling', () => {
    it('skips processing and updates queue item when eligibility conditions fail', async () => {
      const now = new Date();
      vi.mocked(prisma.beeQueueItem.findMany).mockResolvedValueOnce([
        {
          id: 'q-item-skipped-1',
          organization_id: orgId,
          status: 'scheduled',
          scheduled_for: new Date(now.getTime() - 60000),
          customer_phone: '+15553334444',
          customer_id: 'c-1',
          attempt_count: 0,
          job_id: 'j-1',
          warranty_record: { job_id: 'j-1', job_type: 'General Service' },
        },
      ] as any);

      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValue({
        is_active: true,
        call_window_start: '00:00',
        call_window_end: '23:59',
        timezone: 'UTC',
        max_retries: 3,
        setup_config: {
          callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          skipMinJobAmount: 500, // min $500
        },
      } as any);

      vi.mocked(prisma.job.findMany).mockResolvedValueOnce([
        {
          id: 'j-1',
          total_amount: 150, // job below min amount ($150 < $500)
          job_number: 'JOB-001',
          job_type: 'General Service',
        },
      ] as any);

      const initiateCallSpy = vi.spyOn(BeeVoiceAdapter, 'initiateCall');

      await BeeService.processDueQueueItems();

      // Does NOT initiate a call
      expect(initiateCallSpy).not.toHaveBeenCalled();

      // Updates queue item to skipped with Job Below Minimum Amount
      expect(prisma.beeQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'q-item-skipped-1' },
          data: expect.objectContaining({
            status: 'skipped',
            skip_reason: 'Job Below Minimum Amount',
          }),
        })
      );
    });

    it('transitions queue items reaching max_retries limit to archived with reason Retry limit reached', async () => {
      const now = new Date();
      vi.mocked(prisma.beeQueueItem.findMany).mockResolvedValueOnce([
        {
          id: 'q-item-archive-1',
          organization_id: orgId,
          status: 'scheduled',
          scheduled_for: new Date(now.getTime() - 60000),
          customer_phone: '+15553335555',
          customer_id: 'c-2',
          attempt_count: 3, // reached max 3
          job_id: 'j-2',
          warranty_record: { job_id: 'j-2', job_type: 'General Service' },
        },
      ] as any);

      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValue({
        is_active: true,
        call_window_start: '00:00',
        call_window_end: '23:59',
        timezone: 'UTC',
        max_retries: 3,
        setup_config: {
          callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        },
      } as any);

      vi.mocked(prisma.job.findMany).mockResolvedValueOnce([]);

      const initiateCallSpy = vi.spyOn(BeeVoiceAdapter, 'initiateCall');

      await BeeService.processDueQueueItems();

      // Archived jobs never trigger outbound calls
      expect(initiateCallSpy).not.toHaveBeenCalled();

      // Correctly transitions to archived status with Retry limit reached reason
      expect(prisma.beeQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'q-item-archive-1' },
          data: expect.objectContaining({
            status: 'archived',
            skip_reason: 'Retry limit reached',
          }),
        })
      );
    });

    it('archives queue item when call fails and attempt_count reaches max_retries', async () => {
      const now = new Date();
      vi.mocked(prisma.beeQueueItem.findMany).mockResolvedValueOnce([
        {
          id: 'q-item-fail-last',
          organization_id: orgId,
          status: 'scheduled',
          scheduled_for: new Date(now.getTime() - 60000),
          customer_phone: '+15559991111',
          customer_id: 'c-3',
          attempt_count: 2, // 2 prior attempts, this is attempt #3
          job_id: 'j-3',
          warranty_record: { job_id: 'j-3', job_type: 'General Service' },
        },
      ] as any);

      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValue({
        is_active: true,
        call_window_start: '00:00',
        call_window_end: '23:59',
        timezone: 'UTC',
        max_retries: 3,
        setup_config: {
          callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        },
      } as any);

      vi.mocked(prisma.job.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.beeDncEntry.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.beeVoiceAgent.findFirst).mockResolvedValueOnce({
        id: 'agent-1',
        name: 'Emma',
        is_active: true,
      } as any);

      vi.spyOn(BeeVoiceAdapter, 'initiateCall').mockResolvedValueOnce({
        callId: 'call-fail-1',
        status: 'failed',
        error: 'Carrier rejected destination',
        provider: 'vapi',
      });

      await BeeService.processDueQueueItems();

      expect(prisma.beeQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'q-item-fail-last' },
          data: expect.objectContaining({
            attempt_count: 3,
            status: 'archived',
            skip_reason: 'Retry limit reached',
          }),
        })
      );
    });
  });

  describe('Sync Warranties and Queue Persistence & Idempotency', () => {
    it('preserves existing archived jobs without overwriting them back to scheduled', async () => {
      vi.mocked(prisma.organization.findUnique).mockResolvedValue({ job_type_options: [] } as any);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValue({
        job_type_warranties: [
          { job_type: 'HVAC Service', included_warranty: '12 months', warranty_days: 365, call_threshold_days: 30, is_active: true },
        ],
      } as any);

      const fakeInvoice = {
        id: 'inv-archive-sync',
        organization_id: orgId,
        status: 'SENT',
        sent_at: new Date('2026-08-01T00:00:00Z'),
        job_id: 'job-archive-1',
        job: {
          id: 'job-archive-1',
          job_number: 'JOB-ARCH',
          job_type: 'HVAC Service',
          customer: {
            id: 'cust-arch-1',
            first_name: 'David',
            phone: '+15558889999',
          },
        },
      };

      vi.mocked(prisma.invoice.findMany).mockResolvedValueOnce([fakeInvoice] as any);
      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce({
        id: 'rec-arch-1',
        job_id: 'job-archive-1',
      } as any);
      vi.mocked(prisma.beeWarrantyRecord.update).mockResolvedValueOnce({
        id: 'rec-arch-1',
      } as any);

      // Existing queue item is ARCHIVED
      vi.mocked(prisma.beeQueueItem.findFirst).mockResolvedValueOnce({
        id: 'queue-arch-1',
        status: 'archived',
        attempt_count: 3,
        skip_reason: 'Retry limit reached',
      } as any);

      const updateSpy = vi.spyOn(prisma.beeQueueItem, 'update');

      await BeeService.syncWarrantyRecordsAndQueue(orgId);

      // Must NOT update or un-archive the queue item
      expect(updateSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'queue-arch-1' },
          data: expect.objectContaining({
            status: 'scheduled',
          }),
        })
      );
    });

    it('enriches queue items with total_amount and archived_at fields accurately', async () => {
      const rawQueueItems = [
        {
          id: 'q-item-1',
          organization_id: orgId,
          status: 'archived',
          attempt_count: 3,
          skip_reason: 'Retry limit reached',
          scheduled_for: new Date('2026-10-01T12:00:00Z'),
          last_attempted_at: new Date('2026-10-05T14:30:00Z'),
          warranty_record: {
            id: 'rec-1',
            job_id: 'job-1',
            job_type: 'Plumbing',
          },
        },
      ];

      vi.mocked(prisma.job.findMany).mockResolvedValueOnce([
        {
          id: 'job-1',
          job_number: 'JOB-PLUMB-100',
          job_type: 'Plumbing',
          total_amount: 850.5,
          invoices: [{ total_amount: 850.5 }],
        },
      ] as any);

      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        max_retries: 3,
        timezone: 'America/New_York',
      } as any);

      const [enriched] = await BeeService.enrichQueueItemsWithJobContext(orgId, rawQueueItems);

      expect(enriched.status).toBe('archived');
      expect(enriched.skip_reason).toBe('Retry limit reached');
      expect(enriched.total_amount).toBe(850.5);
      expect(enriched.archived_at).toEqual(new Date('2026-10-05T14:30:00Z'));
    });
  });
});
