import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { BeeService } from '../services/bee/beeService';
import { BeeVoiceAdapter } from '../services/bee/beeVoiceAdapter';
import * as emailModule from '../lib/email';

vi.mock('../lib/email', async () => {
  const actual = await vi.importActual<typeof import('../lib/email')>('../lib/email');
  return {
    ...actual,
    sendWarrantyEmail: vi.fn(),
  };
});

describe('Bee Queue Scheduling, Warranty Start Origin, and Rescheduling', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';
  const jobId = '11111111-1111-1111-1111-111111111111';
  const customerId = '22222222-2222-2222-2222-222222222222';
  const invoiceId = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  describe('1. Job Complete setting', () => {
    it('schedules newly queued job based on job completion date when warrantyStartsOn is Job Complete', async () => {
      const completedAt = new Date('2026-06-01T10:00:00.000Z');
      const invoiceSentAt = new Date('2026-06-15T15:00:00.000Z');

      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        sent_at: invoiceSentAt,
        invoice_number: 'INV-101',
        job_id: jobId,
        job: {
          id: jobId,
          job_number: 'JOB-201',
          job_type: 'HVAC Service',
          completed_at: completedAt,
          customer: {
            id: customerId,
            first_name: 'John',
            last_name: 'Doe',
            email: 'john@example.com',
            phone: '+15551234567',
          },
        },
      } as any);

      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce({ job_type_options: [] } as any);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        organization_id: orgId,
        setup_config: { warrantyStartsOn: 'Job Complete' },
        job_type_warranties: [
          { job_type: 'HVAC Service', warranty_days: 365, call_threshold_days: 30, is_active: true },
        ],
      } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([]);
      vi.mocked(emailModule.sendWarrantyEmail).mockResolvedValueOnce({ status: 'sent', messageId: 'msg-1' } as any);

      let createdRecordData: any;
      (prisma.beeWarrantyRecord.create as any).mockImplementationOnce(async ({ data }: any) => {
        createdRecordData = data;
        return { id: 'rec-1', ...data } as any;
      });

      let createdQueueData: any;
      (prisma.beeQueueItem.create as any).mockImplementationOnce(async ({ data }: any) => {
        createdQueueData = data;
        return { id: 'queue-1', ...data } as any;
      });

      await BeeService.processInvoiceSent(invoiceId, orgId);

      // Verify warranty start date used job.completed_at
      expect(createdRecordData).toBeDefined();
      expect(createdRecordData.warranty_start_date).toEqual(completedAt);
      expect(createdRecordData.warranty_started_on).toBe('Job Complete');

      // Warranty end date is completed_at + 365 days
      const expectedEndDate = new Date(completedAt.getTime() + 365 * 86400000);
      expect(createdRecordData.warranty_end_date).toEqual(expectedEndDate);

      // Scheduled time is 30 days before expectedEndDate
      const expectedScheduled = new Date(expectedEndDate.getTime() - 30 * 86400000);
      expect(createdQueueData).toBeDefined();
      expect(createdQueueData.warranty_started_on).toBe('Job Complete');
      expect(createdQueueData.scheduled_for).toEqual(expectedScheduled);
      expect(createdQueueData.original_scheduled_for).toEqual(expectedScheduled);
      expect(createdQueueData.is_rescheduled).toBe(false);
    });
  });

  describe('2. Invoice Sent setting', () => {
    it('schedules newly queued job based on invoice sent date when warrantyStartsOn is Invoice Sent', async () => {
      const completedAt = new Date('2026-08-01T10:00:00.000Z');
      const invoiceSentAt = new Date('2026-08-20T12:00:00.000Z');

      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        sent_at: invoiceSentAt,
        invoice_number: 'INV-102',
        job_id: jobId,
        job: {
          id: jobId,
          job_number: 'JOB-202',
          job_type: 'HVAC Service',
          completed_at: completedAt,
          customer: {
            id: customerId,
            first_name: 'Sarah',
            last_name: 'Connor',
            email: 'sarah@example.com',
            phone: '+15559876543',
          },
        },
      } as any);

      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce({ job_type_options: [] } as any);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        organization_id: orgId,
        setup_config: { warrantyStartsOn: 'Invoice Sent' },
        job_type_warranties: [
          { job_type: 'HVAC Service', warranty_days: 180, call_threshold_days: 45, is_active: true },
        ],
      } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([]);
      vi.mocked(emailModule.sendWarrantyEmail).mockResolvedValueOnce({ status: 'sent', messageId: 'msg-2' } as any);

      let createdRecordData: any;
      (prisma.beeWarrantyRecord.create as any).mockImplementationOnce(async ({ data }: any) => {
        createdRecordData = data;
        return { id: 'rec-2', ...data } as any;
      });

      let createdQueueData: any;
      (prisma.beeQueueItem.create as any).mockImplementationOnce(async ({ data }: any) => {
        createdQueueData = data;
        return { id: 'queue-2', ...data } as any;
      });

      await BeeService.processInvoiceSent(invoiceId, orgId);

      // Verify warranty start date used invoice.sent_at
      expect(createdRecordData).toBeDefined();
      expect(createdRecordData.warranty_start_date).toEqual(invoiceSentAt);
      expect(createdRecordData.warranty_started_on).toBe('Invoice Sent');

      // Warranty end date is invoiceSentAt + 180 days
      const expectedEndDate = new Date(invoiceSentAt.getTime() + 180 * 86400000);
      expect(createdRecordData.warranty_end_date).toEqual(expectedEndDate);

      // Scheduled time is 45 days before expectedEndDate
      const expectedScheduled = new Date(expectedEndDate.getTime() - 45 * 86400000);
      expect(createdQueueData).toBeDefined();
      expect(createdQueueData.warranty_started_on).toBe('Invoice Sent');
      expect(createdQueueData.scheduled_for).toEqual(expectedScheduled);
    });
  });

  describe('3 & 4. Configuration Change & Preservation of Existing Queue Schedules', () => {
    it('preserves existing queued job schedule and warranty_started_on when global setting changes, while applying new setting to newly queued jobs', async () => {
      // Step A: Global setting changes from 'Job Complete' to 'Invoice Sent'
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValue({
        organization_id: orgId,
        setup_config: { warrantyStartsOn: 'Invoice Sent' },
        job_type_warranties: [
          { job_type: 'General Service', warranty_days: 365, call_threshold_days: 30, is_active: true },
        ],
      } as any);

      // Existing Job A: created previously under 'Job Complete'
      const jobACompletedAt = new Date('2026-01-10T09:00:00Z');
      const jobAOriginalScheduled = new Date('2026-12-11T09:00:00Z');
      const existingRecordA = {
        id: 'rec-job-a',
        organization_id: orgId,
        job_id: 'job-a',
        customer_id: 'cust-a',
        job_type: 'General Service',
        warranty_start_date: jobACompletedAt,
        warranty_end_date: new Date('2027-01-10T09:00:00Z'),
        warranty_started_on: 'Job Complete',
        status: 'active',
      };
      const existingQueueA = {
        id: 'queue-job-a',
        organization_id: orgId,
        warranty_record_id: 'rec-job-a',
        customer_id: 'cust-a',
        customer_name: 'Alice A',
        customer_phone: '+15551111111',
        status: 'scheduled',
        scheduled_for: jobAOriginalScheduled,
        original_scheduled_for: jobAOriginalScheduled,
        warranty_started_on: 'Job Complete',
        is_rescheduled: false,
      };

      // Job B: New job entering the queue after the global setting change
      const jobBCompletedAt = new Date('2026-02-01T08:00:00Z');
      const jobBInvoiceSentAt = new Date('2026-03-01T10:00:00Z'); // invoice sent a month after completion
      const newInvoiceB = {
        id: 'inv-b',
        organization_id: orgId,
        status: 'SENT',
        sent_at: jobBInvoiceSentAt,
        job_id: 'job-b',
        job: {
          id: 'job-b',
          job_number: 'JOB-B',
          job_type: 'General Service',
          completed_at: jobBCompletedAt,
          customer: {
            id: 'cust-b',
            first_name: 'Bob',
            last_name: 'Builder',
            phone: '+15552222222',
          },
        },
      };

      vi.mocked(prisma.invoice.findMany).mockResolvedValueOnce([
        {
          id: 'inv-a',
          organization_id: orgId,
          status: 'SENT',
          sent_at: new Date('2026-01-20T00:00:00Z'),
          job_id: 'job-a',
          job: {
            id: 'job-a',
            job_number: 'JOB-A',
            job_type: 'General Service',
            completed_at: jobACompletedAt,
            customer: { id: 'cust-a', first_name: 'Alice', phone: '+15551111111' },
          },
        },
        newInvoiceB,
      ] as any);

      // For Job A: findFirst finds existingRecordA and existingQueueA
      vi.mocked(prisma.beeWarrantyRecord.findFirst)
        .mockResolvedValueOnce(existingRecordA as any) // Job A
        .mockResolvedValueOnce(null); // Job B

      vi.mocked(prisma.beeWarrantyRecord.update).mockResolvedValueOnce(existingRecordA as any);

      let createdRecordBData: any;
      (prisma.beeWarrantyRecord.create as any).mockImplementationOnce(async ({ data }: any) => {
        createdRecordBData = data;
        return { id: 'rec-job-b', ...data } as any;
      });

      vi.mocked(prisma.beeQueueItem.findFirst)
        .mockResolvedValueOnce(existingQueueA as any) // Job A
        .mockResolvedValueOnce(null); // Job B

      let updatedQueueAData: any;
      (prisma.beeQueueItem.update as any).mockImplementationOnce(async ({ data }: any) => {
        updatedQueueAData = data;
        return { ...existingQueueA, ...data } as any;
      });

      let createdQueueBData: any;
      (prisma.beeQueueItem.create as any).mockImplementationOnce(async ({ data }: any) => {
        createdQueueBData = data;
        return { id: 'queue-job-b', ...data } as any;
      });

      // Run synchronization
      await BeeService.syncWarrantyRecordsAndQueue(orgId);

      // Verify Job A: schedule and warranty_started_on were NOT modified or recalculated
      expect(updatedQueueAData).toBeDefined();
      expect(updatedQueueAData.scheduled_for).toBeUndefined(); // MUST NOT overwrite schedule
      expect(updatedQueueAData.warranty_started_on).toBeUndefined(); // MUST NOT overwrite original event

      // Verify Job B: used 'Invoice Sent' setting
      expect(createdRecordBData).toBeDefined();
      expect(createdRecordBData.warranty_started_on).toBe('Invoice Sent');
      expect(createdRecordBData.warranty_start_date).toEqual(jobBInvoiceSentAt);

      expect(createdQueueBData).toBeDefined();
      expect(createdQueueBData.warranty_started_on).toBe('Invoice Sent');
      const expectedEndB = new Date(jobBInvoiceSentAt.getTime() + 365 * 86400000);
      const expectedScheduleB = new Date(expectedEndB.getTime() - 30 * 86400000);
      expect(createdQueueBData.scheduled_for).toEqual(expectedScheduleB);
    });
  });

  describe('5, 6 & 7. Manual Rescheduling, Persistence & Rescheduled Indicator', () => {
    it('manually reschedules an eligible queue item, sets is_rescheduled = true, retains original time, and persists', async () => {
      const originalTime = new Date('2026-11-15T14:00:00Z');
      const newTargetTime = new Date('2026-11-20T16:30:00Z');

      const existingQueueItem = {
        id: 'queue-resched-1',
        organization_id: orgId,
        status: 'scheduled',
        scheduled_for: originalTime,
        original_scheduled_for: null,
        is_rescheduled: false,
        warranty_started_on: 'Job Complete',
        customer_phone: '+15554443333',
        customer_name: 'Charlie Brown',
        warranty_record: {
          id: 'rec-1',
          warranty_start_date: new Date('2026-01-01'),
          warranty_end_date: new Date('2027-01-01'),
          warranty_started_on: 'Job Complete',
        },
      };

      vi.mocked(prisma.beeQueueItem.findFirst).mockResolvedValueOnce(existingQueueItem as any);
      (prisma.beeQueueItem.update as any).mockImplementationOnce(async ({ data }: any) => {
        return {
          ...existingQueueItem,
          ...data,
        } as any;
      });

      const updated = await BeeService.rescheduleQueueItem(orgId, 'queue-resched-1', newTargetTime.toISOString());

      expect(prisma.beeQueueItem.update).toHaveBeenCalledWith({
        where: { id: 'queue-resched-1' },
        data: expect.objectContaining({
          scheduled_for: newTargetTime,
          original_scheduled_for: originalTime,
          is_rescheduled: true,
          status: 'scheduled',
        }),
        include: { warranty_record: true },
      });

      // Verify the returned item has the new scheduled time, original time, and reschedule indicator
      expect(updated.scheduled_for).toEqual(newTargetTime);
      expect(updated.original_scheduled_for).toEqual(originalTime);
      expect(updated.is_rescheduled).toBe(true);
      expect(updated.warranty_started_on).toBe('Job Complete');
    });

    it('prevents rescheduling already completed or in_progress calls', async () => {
      vi.mocked(prisma.beeQueueItem.findFirst).mockResolvedValueOnce({
        id: 'queue-completed',
        organization_id: orgId,
        status: 'completed',
        scheduled_for: new Date(),
      } as any);

      await expect(
        BeeService.rescheduleQueueItem(orgId, 'queue-completed', '2026-12-01T10:00:00Z')
      ).rejects.toThrow(/Cannot reschedule a call that is already completed/i);
    });

    it('rejects invalid or unparseable date strings', async () => {
      await expect(
        BeeService.rescheduleQueueItem(orgId, 'queue-invalid', 'invalid-date-not-a-timestamp')
      ).rejects.toThrow(/Invalid scheduled time format/i);
    });
  });

  describe('8. Call Execution Honors Effective Rescheduled Time Without Duplicate Calls', () => {
    it('sweeps and triggers only when the rescheduled time is reached, without creating duplicates', async () => {
      const now = new Date('2026-11-20T17:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const dueRescheduledItem = {
        id: 'queue-due-rescheduled',
        organization_id: orgId,
        status: 'scheduled',
        scheduled_for: new Date('2026-11-20T16:30:00Z'), // reached!
        original_scheduled_for: new Date('2026-11-15T14:00:00Z'),
        is_rescheduled: true,
        attempt_count: 0,
        customer_id: customerId,
        customer_name: 'Diana Prince',
        customer_phone: '+15553334444',
        job_id: jobId,
        job_number: 'JOB-909',
        job_type: 'Lock Rekey',
        warranty_record: {
          job_id: jobId,
          job_type: 'Lock Rekey',
          warranty_start_date: new Date('2026-01-01'),
          warranty_end_date: new Date('2026-12-31'),
          status: 'active',
        },
      };

      vi.mocked(prisma.beeQueueItem.findMany).mockResolvedValueOnce([dueRescheduledItem as any]);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        organization_id: orgId,
        is_active: true,
        call_window_start: '08:00',
        call_window_end: '20:00',
        timezone: 'UTC',
        max_retries: 2,
      } as any);
      vi.mocked(prisma.beeDncEntry.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.beeVoiceAgent.findFirst).mockResolvedValueOnce({
        id: 'agent-1',
        name: 'Emma',
        is_active: true,
      } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([]);
      vi.spyOn(BeeService, 'isWithinCallWindow').mockReturnValue(true);

      const mockCallResult = {
        callId: 'call-vapi-999',
        status: 'initiated',
        provider: 'vapi',
      };
      vi.spyOn(BeeVoiceAdapter, 'initiateCall').mockResolvedValueOnce(mockCallResult as any);

      vi.mocked(prisma.beeQueueItem.update).mockResolvedValueOnce({
        ...dueRescheduledItem,
        status: 'in_progress',
      } as any);

      vi.mocked(prisma.beeCallLog.create).mockResolvedValueOnce({ id: 'log-1' } as any);

      const result = await BeeService.processDueQueueItems();

      expect(BeeVoiceAdapter.initiateCall).toHaveBeenCalledTimes(1);
      expect(prisma.beeQueueItem.update).toHaveBeenCalledWith({
        where: { id: 'queue-due-rescheduled' },
        data: expect.objectContaining({
          status: 'in_progress',
          attempt_count: 1,
        }),
      });

      vi.useRealTimers();
    });
  });

  describe('9. Edge Cases & Boundary Handling', () => {
    it('safely falls back to job.created_at or now if completed_at is null when warrantyStartsOn is Job Complete', async () => {
      const jobCreatedAt = new Date('2026-05-01T10:00:00Z');

      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        sent_at: new Date('2026-05-10T12:00:00Z'),
        invoice_number: 'INV-109',
        job_id: jobId,
        job: {
          id: jobId,
          job_number: 'JOB-209',
          job_type: 'General Service',
          completed_at: null, // missing!
          created_at: jobCreatedAt,
          customer: {
            id: customerId,
            first_name: 'Grace',
            email: 'grace@example.com',
            phone: '+15550009999',
          },
        },
      } as any);

      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce({ job_type_options: [] } as any);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        organization_id: orgId,
        setup_config: { warrantyStartsOn: 'Job Complete' },
      } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([]);
      vi.mocked(emailModule.sendWarrantyEmail).mockResolvedValueOnce({ status: 'sent', messageId: 'msg-edge' } as any);

      let createdRecordData: any;
      (prisma.beeWarrantyRecord.create as any).mockImplementationOnce(async ({ data }: any) => {
        createdRecordData = data;
        return { id: 'rec-edge', ...data } as any;
      });
      vi.mocked(prisma.beeQueueItem.create).mockResolvedValueOnce({ id: 'q-edge' } as any);

      await BeeService.processInvoiceSent(invoiceId, orgId);

      expect(createdRecordData).toBeDefined();
      expect(createdRecordData.warranty_start_date).toEqual(jobCreatedAt);
      expect(createdRecordData.warranty_started_on).toBe('Job Complete');
    });

    it('safely falls back to invoice.created_at if sent_at is null when warrantyStartsOn is Invoice Sent', async () => {
      const invoiceCreatedAt = new Date('2026-05-05T10:00:00Z');

      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        sent_at: null, // edge case
        created_at: invoiceCreatedAt,
        invoice_number: 'INV-110',
        job_id: jobId,
        job: {
          id: jobId,
          job_number: 'JOB-210',
          job_type: 'General Service',
          completed_at: new Date('2026-05-01'),
          customer: {
            id: customerId,
            first_name: 'Henry',
            email: 'henry@example.com',
            phone: '+15550008888',
          },
        },
      } as any);

      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce({ job_type_options: [] } as any);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        organization_id: orgId,
        setup_config: { warrantyStartsOn: 'Invoice Sent' },
      } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([]);
      vi.mocked(emailModule.sendWarrantyEmail).mockResolvedValueOnce({ status: 'sent', messageId: 'msg-edge-2' } as any);

      let createdRecordData: any;
      (prisma.beeWarrantyRecord.create as any).mockImplementationOnce(async ({ data }: any) => {
        createdRecordData = data;
        return { id: 'rec-edge-2', ...data } as any;
      });
      vi.mocked(prisma.beeQueueItem.create).mockResolvedValueOnce({ id: 'q-edge-2' } as any);

      await BeeService.processInvoiceSent(invoiceId, orgId);

      expect(createdRecordData).toBeDefined();
      expect(createdRecordData.warranty_start_date).toEqual(invoiceCreatedAt);
      expect(createdRecordData.warranty_started_on).toBe('Invoice Sent');
    });
  });

  describe('10. Regression: Retries, DNC Checks, and Recovery', () => {
    it('schedules retry when call fails and attempts < maxRetries', async () => {
      const now = new Date('2026-11-01T15:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const dueItem = {
        id: 'queue-retry-test',
        organization_id: orgId,
        status: 'scheduled',
        scheduled_for: new Date('2026-11-01T14:00:00Z'),
        attempt_count: 0,
        customer_id: customerId,
        customer_name: 'Frank Sinatra',
        customer_phone: '+15557778888',
        job_id: jobId,
        job_number: 'JOB-777',
        job_type: 'Plumbing',
        warranty_record: {
          job_id: jobId,
          warranty_start_date: new Date('2026-01-01'),
          warranty_end_date: new Date('2026-12-31'),
        },
      };

      vi.mocked(prisma.beeQueueItem.findMany).mockResolvedValueOnce([dueItem as any]);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        organization_id: orgId,
        is_active: true,
        call_window_start: '08:00',
        call_window_end: '20:00',
        timezone: 'UTC',
        max_retries: 2,
        retry_interval_hours: 48,
      } as any);
      vi.mocked(prisma.beeDncEntry.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.beeVoiceAgent.findFirst).mockResolvedValueOnce({
        id: 'agent-1',
        is_active: true,
      } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([]);
      vi.spyOn(BeeService, 'isWithinCallWindow').mockReturnValue(true);

      vi.spyOn(BeeVoiceAdapter, 'initiateCall').mockResolvedValueOnce({
        callId: 'call-failed-1',
        status: 'failed',
        error: 'Network timeout',
        provider: 'vapi',
      } as any);

      let updateData: any;
      (prisma.beeQueueItem.update as any).mockImplementationOnce(async ({ data }: any) => {
        updateData = data;
        return { ...dueItem, ...data } as any;
      });
      vi.mocked(prisma.beeCallLog.create).mockResolvedValueOnce({ id: 'log-f' } as any);

      await BeeService.processDueQueueItems();

      expect(updateData).toBeDefined();
      expect(updateData.status).toBe('scheduled');
      expect(updateData.attempt_count).toBe(1);
      // Scheduled for 48 hours later
      const expectedRetryTime = new Date(now.getTime() + 48 * 3600000);
      expect(updateData.scheduled_for).toEqual(expectedRetryTime);

      vi.useRealTimers();
    });
  });
});
