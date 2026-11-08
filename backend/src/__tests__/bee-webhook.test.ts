import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';

const mockPrisma = prisma as any;

describe('Bee Agent Inbound Webhook (POST /api/bee/webhook & POST /api/ai-farm/bee/webhook)', () => {
  const orgId = ALPHA_ORG_ID;
  const mockCustomer = {
    id: '00000000-0000-0000-0000-0000000000c1',
    organization_id: orgId,
    customer_number: 'C10001',
    first_name: 'Alice',
    last_name: 'Smith',
    email: 'alice@example.com',
    phone: '+15551234567',
    kind: 'PERSON',
    segment: 'RESIDENTIAL',
  };

  const mockAgent = {
    id: '00000000-0000-0000-0000-0000000000a1',
    organization_id: orgId,
    name: 'Emma - Door & Lock Specialist',
    persona_name: 'Emma',
    is_active: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
    mockAuthAs('admin', { is_demo: true });

    // Default mock behavior for prisma
    mockPrisma.customer.findFirst.mockResolvedValue(mockCustomer);
    mockPrisma.beeVoiceAgent.findFirst.mockResolvedValue(mockAgent);
    mockPrisma.beeVoiceAgent.findMany.mockResolvedValue([mockAgent]);
    mockPrisma.beeQueueItem.findFirst.mockResolvedValue(null);
    mockPrisma.beeCallLog.findFirst.mockResolvedValue(null);
    mockPrisma.beeSetting.findUnique.mockResolvedValue({
      organization_id: orgId,
      is_active: true,
    });

    mockPrisma.beeCallLog.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: args.data.id || '00000000-0000-0000-0000-0000000000b1',
        ...args.data,
        called_at: args.data.called_at || new Date(),
      })
    );

    mockPrisma.beeCallLog.update.mockImplementation((args: any) =>
      Promise.resolve({
        id: args.where.id,
        ...args.data,
      })
    );

    mockPrisma.lead.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: '00000000-0000-0000-0000-0000000000L1',
        ...args.data,
      })
    );

    mockPrisma.beeDncEntry.upsert.mockResolvedValue({
      id: '00000000-0000-0000-0000-0000000000d1',
      organization_id: orgId,
      phone_number: '+15551234567',
    });

    mockPrisma.beeQueueItem.update.mockResolvedValue({
      id: '00000000-0000-0000-0000-0000000000q1',
      status: 'completed',
    });
  });

  describe('Authentication and Entitlement Gates', () => {
    it('accepts unauthenticated requests and auto-resolves demo organization for Postman testing', async () => {
      mockPrisma.organization.findMany.mockResolvedValueOnce([
        {
          id: orgId,
          name: 'Acme Test Org',
          is_demo: true,
          plan: 'GROWTH',
          feature_overrides: { bee: true },
        },
      ]);

      const res = await request(app)
        .post('/api/bee/webhook')
        .send({
          transcript: 'Test call transcript',
          recordingUrl: 'https://example.com/recording.mp3',
        });

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(mockPrisma.beeCallLog.create).toHaveBeenCalled();
    });

    it('rejects requests with invalid bearer token with 401', async () => {
      clearTokenCache();
      (supabaseAdmin.auth.getUser as any).mockResolvedValueOnce({
        data: { user: null },
        error: new Error('Invalid or expired token'),
      });

      const res = await request(app)
        .post('/api/bee/webhook')
        .set({ Authorization: 'Bearer invalid-token' })
        .send({
          transcript: 'Test call transcript',
          recordingUrl: 'https://example.com/recording.mp3',
        });

      expect(res.status).toBe(401);
    });


    it('rejects requests from orgs without Bee entitlement with 404 FEATURE_DISABLED', async () => {
      clearTokenCache();
      mockAuthAs('admin', { is_demo: false, feature_overrides: {} });

      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send({
          transcript: 'Test call transcript',
          recordingUrl: 'https://example.com/recording.mp3',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('FEATURE_DISABLED');
      expect(res.body.feature).toBe('bee');
      expect(mockPrisma.beeCallLog.create).not.toHaveBeenCalled();
    });
  });

  describe('Payload Validation', () => {
    it('rejects payload missing transcript with 400', async () => {
      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send({
          recordingUrl: 'https://example.com/recording.mp3',
        });

      expect(res.status).toBe(400);
      expect(mockPrisma.beeCallLog.create).not.toHaveBeenCalled();
    });

    it('rejects payload with empty transcript with 400', async () => {
      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send({
          transcript: '',
          recordingUrl: 'https://example.com/recording.mp3',
        });

      expect(res.status).toBe(400);
      expect(mockPrisma.beeCallLog.create).not.toHaveBeenCalled();
    });

    it('rejects payload missing recordingUrl with 400', async () => {
      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send({
          transcript: 'Hello, this is a test call.',
        });

      expect(res.status).toBe(400);
      expect(mockPrisma.beeCallLog.create).not.toHaveBeenCalled();
    });

    it('rejects payload with invalid URL for recordingUrl with 400', async () => {
      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send({
          transcript: 'Hello, this is a test call.',
          recordingUrl: 'not-a-valid-url',
        });

      expect(res.status).toBe(400);
      expect(mockPrisma.beeCallLog.create).not.toHaveBeenCalled();
    });
  });

  describe('Successful Webhook Processing & Post-Call Workflow', () => {
    it('processes a valid minimal payload via POST /api/bee/webhook', async () => {
      const payload = {
        callId: 'bee-test-call-001',
        transcript: 'Hello, this is a test call. The customer is interested in the service.',
        recordingUrl: 'https://example.com/test-recording.mp3',
        status: 'completed',
      };

      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(res.body.message).toBe('Bee call webhook processed successfully');
      expect(res.body.callId).toBeDefined();
      expect(res.body.idempotent).toBe(false);

      // Verifies database call was created with correct fields
      expect(mockPrisma.beeCallLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization_id: orgId,
            customer_name: 'Alice Smith',
            customer_phone: '+15551234567',
            audio_url: 'https://example.com/test-recording.mp3',
            outcome: 'warranty_lead',
          }),
        })
      );

      // Verifies post-call processing created a CRM lead
      expect(mockPrisma.lead.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organization_id: orgId,
            customer_id: mockCustomer.id,
            status: 'NEW',
          }),
        })
      );
    });

    it('processes a valid payload via canonical path POST /api/ai-farm/bee/webhook', async () => {
      const payload = {
        call_id: 'bee-test-call-002',
        transcript: 'Customer wants a quote for new work.',
        recording_url: 'https://example.com/call2.mp3',
        outcome: 'new_work_lead',
      };

      const res = await request(app)
        .post('/api/ai-farm/bee/webhook')
        .set(authHeader('admin'))
        .send(payload);

      expect(res.status).toBe(201);
      expect(res.body.ok).toBe(true);
      expect(mockPrisma.beeCallLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            outcome: 'new_work_lead',
            audio_url: 'https://example.com/call2.mp3',
          }),
        })
      );
    });

    it('accepts structured dialogue turns array for transcript', async () => {
      const payload = {
        callId: 'bee-dialogue-001',
        transcript: [
          { speaker: 'bee', text: 'Good morning! Calling about your warranty.', timestamp: 0 },
          { speaker: 'customer', text: 'Yes, I would like to extend it.', timestamp: 6 },
        ],
        recordingUrl: 'https://example.com/turns.mp3',
        outcome: 'warranty_lead',
      };

      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send(payload);

      expect(res.status).toBe(201);
      expect(mockPrisma.beeCallLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transcript: [
              { speaker: 'bee', text: 'Good morning! Calling about your warranty.', timestamp: 0 },
              { speaker: 'customer', text: 'Yes, I would like to extend it.', timestamp: 6 },
            ],
          }),
        })
      );
    });

    it('enforces idempotency: retrying same callId updates record and does not duplicate lead', async () => {
      const callId = 'bee-test-call-idempotent';

      // First call: not found, creates call
      mockPrisma.beeCallLog.findFirst.mockResolvedValueOnce(null);

      const res1 = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send({
          callId,
          transcript: 'First call intake.',
          recordingUrl: 'https://example.com/rec1.mp3',
          status: 'completed',
        });

      expect(res1.status).toBe(201);
      expect(res1.body.idempotent).toBe(false);
      expect(mockPrisma.beeCallLog.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.lead.create).toHaveBeenCalledTimes(1);

      // Second call: finds existing call record
      const resolvedUuid = res1.body.callId;
      mockPrisma.beeCallLog.findFirst.mockResolvedValueOnce({
        id: resolvedUuid,
        organization_id: orgId,
        customer_id: mockCustomer.id,
        duration_seconds: 45,
        outcome: 'warranty_lead',
        lead_id: '00000000-0000-0000-0000-0000000000L1',
        audio_url: 'https://example.com/rec1.mp3',
      });

      const res2 = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send({
          callId,
          transcript: 'First call intake - updated.',
          recordingUrl: 'https://example.com/rec1-updated.mp3',
          status: 'completed',
        });

      expect(res2.status).toBe(200);
      expect(res2.body.ok).toBe(true);
      expect(res2.body.idempotent).toBe(true);
      expect(res2.body.message).toContain('idempotent');

      // Crucial: create should NOT have been called a second time
      expect(mockPrisma.beeCallLog.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.lead.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.beeCallLog.update).toHaveBeenCalled();
    });

    it('registers DNC entry when outcome is opt_out_dnc', async () => {
      const payload = {
        callId: 'bee-dnc-test',
        transcript: 'Please remove me from your list and do not call again.',
        recordingUrl: 'https://example.com/dnc.mp3',
        outcome: 'opt_out_dnc',
      };

      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send(payload);

      expect(res.status).toBe(201);
      expect(mockPrisma.beeDncEntry.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id_phone_number: expect.objectContaining({
              organization_id: orgId,
              phone_number: '+15551234567',
            }),
          }),
        })
      );
    });

    it('flags needs_human_alert when customer requests a human or files complaint', async () => {
      const payload = {
        callId: 'bee-human-alert-test',
        transcript: 'I am unhappy with the service and want to speak with a manager.',
        recordingUrl: 'https://example.com/complaint.mp3',
        outcome: 'complaint',
      };

      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send(payload);

      expect(res.status).toBe(201);
      expect(mockPrisma.beeCallLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            needs_human_alert: true,
            outcome: 'complaint',
          }),
        })
      );
    });

    it('completes linked queue item when call finishes', async () => {
      const mockQueueItem = {
        id: '00000000-0000-0000-0000-0000000000e1',
        organization_id: orgId,
        customer_id: mockCustomer.id,
        status: 'scheduled',
      };
      mockPrisma.beeQueueItem.findFirst.mockResolvedValueOnce(mockQueueItem);

      const payload = {
        callId: 'bee-queue-completion-test',
        queueItemId: mockQueueItem.id,
        transcript: 'Customer completed call.',
        recordingUrl: 'https://example.com/queue.mp3',
        outcome: 'warranty_lead',
      };

      const res = await request(app)
        .post('/api/bee/webhook')
        .set(authHeader('admin'))
        .send(payload);

      expect(res.status).toBe(201);
      expect(mockPrisma.beeQueueItem.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockQueueItem.id },
          data: expect.objectContaining({ status: 'completed' }),
        })
      );
    });
  });

  describe('Call Log UI Visibility (GET /api/ai-farm/bee/calls)', () => {
    it('retrieves the call with transcript, recording URL, and outcome formatted for UI display', async () => {
      const callLogId = '00000000-0000-0000-0000-0000000000c9';
      const createdCall = {
        id: callLogId,
        organization_id: orgId,
        customer_id: mockCustomer.id,
        customer_name: 'Alice Smith',
        customer_phone: '+15551234567',
        duration_seconds: 65,
        outcome: 'warranty_lead',
        transcript: [
          { speaker: 'bee', text: 'Calling about your warranty.', timestamp: 0 },
          { speaker: 'customer', text: 'Sounds great, sign me up.', timestamp: 5 },
        ],
        ai_summary: 'Customer agreed to renew warranty extension.',
        audio_url: 'https://example.com/recording.mp3',
        lead_id: '00000000-0000-0000-0000-0000000000L1',
        needs_human_alert: false,
        called_at: new Date('2026-10-16T18:00:00Z'),
        queue_item: null,
      };

      mockPrisma.beeCallLog.findMany.mockResolvedValueOnce([createdCall]);
      mockPrisma.beeCallLog.count.mockResolvedValueOnce(1);
      mockPrisma.customer.findMany.mockResolvedValueOnce([mockCustomer]);
      mockPrisma.job.findMany.mockResolvedValueOnce([]);
      mockPrisma.beeVoiceAgent.findMany.mockResolvedValueOnce([mockAgent]);

      const res = await request(app)
        .get('/api/ai-farm/bee/calls')
        .set(authHeader('admin'));

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.records).toHaveLength(1);

      const record = res.body.records[0];
      expect(record.id).toBe(callLogId);
      expect(record.customer_name).toBe('Alice Smith');
      expect(record.customer_phone).toBe('+15551234567');
      expect(record.audio_url).toBe('https://example.com/recording.mp3');
      expect(record.transcript).toEqual(createdCall.transcript);
      expect(record.ai_summary).toBe('Customer agreed to renew warranty extension.');
      expect(record.outcome).toBe('LEAD_CREATED');
      expect(record.lead_id).toBe('00000000-0000-0000-0000-0000000000L1');
      expect(record.duration_seconds).toBe(65);
    });
  });
});
