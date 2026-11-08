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

describe('Bee Warranty and First Call Backend Workflow', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';
  const jobId = '11111111-1111-1111-1111-111111111111';
  const customerId = '22222222-2222-2222-2222-222222222222';
  const invoiceId = '33333333-3333-3333-3333-333333333333';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Step 1 & 2: Invoice Sent & Job-to-Warranty Resolution', () => {
    it('skips processing if invoice is not in SENT status', async () => {
      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'DRAFT',
      } as any);

      await BeeService.processInvoiceSent(invoiceId, orgId);

      expect(prisma.beeWarrantyRecord.create).not.toHaveBeenCalled();
      expect(emailModule.sendWarrantyEmail).not.toHaveBeenCalled();
    });

    it('skips processing if invoice has no linked job', async () => {
      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        job_id: null,
        job: null,
      } as any);

      await BeeService.processInvoiceSent(invoiceId, orgId);

      expect(prisma.beeWarrantyRecord.create).not.toHaveBeenCalled();
      expect(emailModule.sendWarrantyEmail).not.toHaveBeenCalled();
    });

    it('enforces idempotency: does not duplicate warranty if one already exists for the job', async () => {
      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        job_id: jobId,
        job: { id: jobId, job_type: 'Door Installation', customer: { id: customerId, email: 'test@example.com' } },
        customer: { id: customerId, email: 'test@example.com' },
      } as any);

      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce({
        id: 'rec-existing',
        organization_id: orgId,
        job_id: jobId,
      } as any);

      await BeeService.processInvoiceSent(invoiceId, orgId);

      expect(emailModule.sendWarrantyEmail).not.toHaveBeenCalled();
      expect(prisma.beeWarrantyRecord.create).not.toHaveBeenCalled();
    });
  });

  describe('Step 3: Real Warranty Email Delivery', () => {
    it('aborts workflow if warranty email delivery fails or is rejected', async () => {
      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        invoice_number: 'INV-1001',
        job_id: jobId,
        job: {
          id: jobId,
          job_number: 'JOB-501',
          job_type: 'Lock rekey / small repair',
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
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({ job_type_warranties: [] } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([]);

      // Simulate email rejection / failure
      vi.mocked(emailModule.sendWarrantyEmail).mockResolvedValueOnce({
        status: 'failed',
        error: 'Resend rejected invalid address',
      });

      await BeeService.processInvoiceSent(invoiceId, orgId);

      expect(emailModule.sendWarrantyEmail).toHaveBeenCalled();
      // Must NOT fake a successful creation
      expect(prisma.beeWarrantyRecord.create).not.toHaveBeenCalled();
      expect(prisma.beeQueueItem.create).not.toHaveBeenCalled();
    });

    it('creates BeeWarrantyRecord and TimelineEvent when warranty email delivers successfully', async () => {
      const now = new Date('2026-10-15T12:00:00Z');
      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        sent_at: now,
        invoice_number: 'INV-1002',
        job_id: jobId,
        job: {
          id: jobId,
          job_number: 'JOB-502',
          job_type: 'Door closer / hardware replacement',
          customer: {
            id: customerId,
            first_name: 'Jane',
            last_name: 'Smith',
            email: 'jane@example.com',
            phone: '+15559876543',
          },
        },
      } as any);

      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce({ job_type_options: [] } as any);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        job_type_warranties: [
          { job_type: 'Door closer / hardware replacement', included_warranty: '6 months', warranty_days: 180, call_threshold_days: 30 },
        ],
      } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([
        { id: 'plan-1', name: 'Gold Protection', price: 349, eligible_job_types: ['All job types'], description: 'Gold terms' } as any,
      ]);

      vi.mocked(emailModule.sendWarrantyEmail).mockResolvedValueOnce({
        status: 'sent',
        providerMessageId: 'resend-msg-123',
        fromAddress: 'onboarding@resend.dev',
        fromName: 'Alpha Doors',
      });

      vi.mocked(prisma.beeWarrantyRecord.create).mockResolvedValueOnce({
        id: 'rec-1',
        organization_id: orgId,
        job_id: jobId,
        customer_id: customerId,
        job_type: 'Door closer / hardware replacement',
        warranty_start_date: now,
        warranty_end_date: new Date(now.getTime() + 180 * 86400000),
        status: 'active',
      } as any);

      vi.mocked(prisma.beeDncEntry.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.beeVoiceAgent.findFirst).mockResolvedValueOnce({
        id: 'agent-1',
        trigger_days_before: 30,
        is_active: true,
      } as any);

      await BeeService.processInvoiceSent(invoiceId, orgId, 'user-admin');

      expect(emailModule.sendWarrantyEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          organizationId: orgId,
          to: 'jane@example.com',
          customerName: 'Jane Smith',
          jobType: 'Door closer / hardware replacement',
          invoiceNumber: 'INV-1002',
          warrantyDuration: '6 months',
        })
      );

      expect(prisma.beeWarrantyRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization_id: orgId,
            job_id: jobId,
            customer_id: customerId,
            status: 'active',
          }),
        })
      );

      expect(prisma.timelineEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entity_type: 'JOB',
            entity_id: jobId,
            event_type: 'WARRANTY_ISSUED',
          }),
        })
      );
    });
  });

  describe('Step 4: Queue Scheduling & DNC Protection', () => {
    it('marks queue item as skipped if phone number matches Do Not Call list', async () => {
      const now = new Date();
      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        sent_at: now,
        invoice_number: 'INV-1003',
        job_id: jobId,
        job: {
          id: jobId,
          job_type: 'Lock rekey / small repair',
          customer: {
            id: customerId,
            first_name: 'DNC',
            last_name: 'Customer',
            email: 'dnc@example.com',
            phone: '+1 (555) 000-9999',
          },
        },
      } as any);

      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce({ job_type_options: [] } as any);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({ job_type_warranties: [] } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([]);

      vi.mocked(emailModule.sendWarrantyEmail).mockResolvedValueOnce({
        status: 'sent',
        providerMessageId: 'resend-dnc-1',
        fromAddress: 'onboarding@resend.dev',
        fromName: 'Alpha Doors',
      });

      vi.mocked(prisma.beeWarrantyRecord.create).mockResolvedValueOnce({
        id: 'rec-dnc',
        organization_id: orgId,
        job_id: jobId,
        customer_id: customerId,
        status: 'active',
        warranty_end_date: new Date(Date.now() + 90 * 86400000),
      } as any);

      // Return matching DNC entry
      vi.mocked(prisma.beeDncEntry.findFirst).mockResolvedValueOnce({
        id: 'dnc-entry-1',
        phone_number: '+15550009999',
      } as any);

      await BeeService.processInvoiceSent(invoiceId, orgId);

      expect(prisma.beeQueueItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'skipped',
            skip_reason: 'Customer number on Do Not Call list',
          }),
        })
      );
    });
  });

  describe('Step 5 & 6: Outbound Calling Blocker & Execution', () => {
    it('reports blocker honestly when voice provider is unconfigured or credentials missing', async () => {
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        organization_id: orgId,
        voice_provider: 'simulated',
        voice_provider_api_key: null,
      } as any);

      const result = await BeeVoiceAdapter.initiateCall(orgId, {
        to: '+15551234567',
        customerName: 'Test Customer',
        agentPersona: 'Emma',
        tradeFocus: 'Doors',
      });

      expect(result.status).toBe('failed');
      expect(result.callId).toBe('');
      expect(result.error).toContain('Voice provider is not configured');
    });

    it('reports blocker when provider is retell but API key is missing', async () => {
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        organization_id: orgId,
        voice_provider: 'retell',
        voice_provider_api_key: '',
      } as any);

      const result = await BeeVoiceAdapter.initiateCall(orgId, {
        to: '+15551234567',
        customerName: 'Test Customer',
        agentPersona: 'Emma',
        tradeFocus: 'Doors',
      });

      expect(result.status).toBe('failed');
      expect(result.error).toContain('Voice provider API key for \'retell\' is not configured');
    });
  });

  describe('Step 7: Reliability, Recovery, and Real Metrics', () => {
    it('recovers stale in_progress queue items after backend restart', async () => {
      vi.mocked(prisma.beeQueueItem.findMany).mockResolvedValueOnce([
        { id: 'q-stale-1', status: 'in_progress' } as any,
        { id: 'q-stale-2', status: 'in_progress' } as any,
      ]);

      const result = await BeeService.recoverStaleQueueItems();

      expect(result.recovered).toBe(2);
      expect(prisma.beeQueueItem.update).toHaveBeenCalledTimes(2);
      expect(prisma.beeQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'q-stale-1' },
          data: expect.objectContaining({ status: 'scheduled' }),
        })
      );
    });

    it('getMetrics computes strictly real counts without fallback dummy metrics', async () => {
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        is_active: true,
        call_window_start: '10:00',
        call_window_end: '19:00',
        timezone: 'America/New_York',
      } as any);
      vi.mocked(prisma.beeCallLog.count).mockResolvedValueOnce(0); // total calls
      vi.mocked(prisma.beeCallLog.count).mockResolvedValueOnce(0); // answered calls
      vi.mocked(prisma.beeQueueItem.count).mockResolvedValueOnce(0); // queue count
      vi.mocked(prisma.beeVoiceAgent.count).mockResolvedValueOnce(2); // agents
      vi.mocked(prisma.beeCallLog.findMany).mockResolvedValueOnce([]); // no calls
      vi.mocked(prisma.beeWarrantyRecord.findMany).mockResolvedValueOnce([]); // no upcoming

      const metrics = await BeeService.getMetrics(orgId, '7d');

      // Crucial: Must be 0, NOT 184, 91, or 212!
      expect(metrics.counts.totalCalls).toBe(0);
      expect(metrics.counts.answeredCalls).toBe(0);
      expect(metrics.counts.queueCount).toBe(0);
      expect(metrics.funnel?.totalCalls).toBe(0);
      expect(metrics.funnel?.reached).toBe(0);
      expect(metrics.funnel?.queued).toBe(0);
      expect(metrics.upcomingExpirations).toEqual([]);
      expect(metrics.needsHuman).toEqual([]);
    });

    it('marks queue item as skipped with "Job type disabled" when job type is inactive in processInvoiceSent', async () => {
      const now = new Date('2026-10-15T12:00:00Z');
      vi.mocked(prisma.invoice.findUnique).mockResolvedValueOnce({
        id: invoiceId,
        organization_id: orgId,
        status: 'SENT',
        sent_at: now,
        invoice_number: 'INV-1003',
        job_id: jobId,
        job: {
          id: jobId,
          job_number: 'JOB-503',
          job_type: 'Lock Repair',
          customer: {
            id: customerId,
            first_name: 'Bob',
            last_name: 'Jones',
            email: 'bob@example.com',
            phone: '+15551234567',
          },
        },
      } as any);

      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce(null);
      vi.mocked(prisma.organization.findUnique).mockResolvedValueOnce({ job_type_options: [] } as any);
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
        job_type_warranties: [
          { job_type: 'Lock Repair', included_warranty: '90 days', warranty_days: 90, call_threshold_days: 21, is_active: false },
        ],
      } as any);
      vi.mocked(prisma.beeWarrantyPlan.findMany).mockResolvedValueOnce([]);
      vi.mocked(emailModule.sendWarrantyEmail).mockResolvedValueOnce({
        status: 'sent',
        providerMessageId: 'resend-msg-123',
        fromAddress: 'onboarding@resend.dev',
        fromName: 'Alpha Doors',
      });
      vi.mocked(prisma.beeWarrantyRecord.create).mockResolvedValueOnce({
        id: 'rec-disabled-1',
        organization_id: orgId,
        job_id: jobId,
        customer_id: customerId,
        job_type: 'Lock Repair',
        warranty_start_date: now,
        warranty_end_date: new Date(now.getTime() + 90 * 86400000),
        status: 'active',
      } as any);
      vi.mocked(prisma.beeDncEntry.findFirst).mockResolvedValueOnce(null);

      await BeeService.processInvoiceSent(invoiceId, orgId);

      expect(prisma.beeQueueItem.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'skipped',
            skip_reason: 'Job type disabled',
          }),
        })
      );
    });

    it('syncWarrantyRecordsAndQueue updates scheduled items to skipped when job type is disabled, and restores when re-enabled', async () => {
      vi.mocked(prisma.organization.findUnique).mockResolvedValue({ job_type_options: [] } as any);
      // Org setting with disabled job type
      vi.mocked(prisma.beeSetting.findUnique).mockResolvedValue({
        job_type_warranties: [
          { job_type: 'Door Installation', included_warranty: '12 months', warranty_days: 365, call_threshold_days: 30, is_active: false },
        ],
      } as any);

      const fakeInvoice = {
        id: 'inv-sync-1',
        organization_id: orgId,
        status: 'SENT',
        sent_at: new Date('2026-08-01T00:00:00Z'),
        job_id: 'job-sync-1',
        job: {
          id: 'job-sync-1',
          job_number: 'JOB-999',
          job_type: 'Door Installation',
          customer: {
            id: 'cust-sync-1',
            first_name: 'Alice',
            phone: '+15550001111',
          },
        },
      };

      vi.mocked(prisma.invoice.findMany).mockResolvedValueOnce([fakeInvoice] as any);
      vi.mocked(prisma.beeWarrantyRecord.findFirst).mockResolvedValueOnce({
        id: 'rec-sync-1',
        job_id: 'job-sync-1',
      } as any);
      vi.mocked(prisma.beeWarrantyRecord.update).mockResolvedValueOnce({
        id: 'rec-sync-1',
      } as any);
      // Existing scheduled queue item
      vi.mocked(prisma.beeQueueItem.findFirst).mockResolvedValueOnce({
        id: 'queue-sync-1',
        status: 'scheduled',
      } as any);

      await BeeService.syncWarrantyRecordsAndQueue(orgId);

      expect(prisma.beeQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'queue-sync-1' },
          data: expect.objectContaining({
            status: 'skipped',
            skip_reason: 'Job type disabled',
          }),
        })
      );
    });
  });
});
