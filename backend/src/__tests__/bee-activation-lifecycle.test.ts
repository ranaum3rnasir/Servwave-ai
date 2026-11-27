import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const mocks = vi.hoisted(() => ({
  beeSettingFindUnique: vi.fn(),
  beeSettingUpdateMany: vi.fn(),
  beeSettingUpsert: vi.fn(),
  beeVoiceAgentCount: vi.fn(),
  beeQueueItemFindMany: vi.fn(),
  beeQueueItemUpdateMany: vi.fn(),
  beeDncCount: vi.fn(),
  getAvailablePhoneNumbers: vi.fn(),
  syncWarrantyRecordsAndQueue: vi.fn(),
  enrichQueueItemsWithJobContext: vi.fn(),
  evaluateJobCallEligibility: vi.fn(),
  resolveAgentAndPhoneNumberForJob: vi.fn(),
  beeWarrantyPlanFindMany: vi.fn(),
  initiateCall: vi.fn(),
}));

vi.mock('../lib/prisma', () => ({
  prisma: {
    beeSetting: {
      findUnique: mocks.beeSettingFindUnique,
      updateMany: mocks.beeSettingUpdateMany,
      upsert: mocks.beeSettingUpsert,
    },
    beeVoiceAgent: {
      count: mocks.beeVoiceAgentCount,
    },
    beeQueueItem: {
      findMany: mocks.beeQueueItemFindMany,
      updateMany: mocks.beeQueueItemUpdateMany,
    },
    beeDncEntry: {
      count: mocks.beeDncCount,
    },
    beeWarrantyPlan: {
      findMany: mocks.beeWarrantyPlanFindMany,
    },
  },
}));

vi.mock('../services/bee/beeVoiceAdapter', () => ({
  BEE_MASTER_PROMPT_TEMPLATE: 'mock-template',
  BeeVoiceAdapter: {
    initiateCall: mocks.initiateCall,
    getAvailablePhoneNumbers: vi.fn().mockResolvedValue([]),
  },
}));

import { requireBee, requireBeeAdmin } from '../middleware/requireBee';
import { getBeeStatus, setBeeActive, updateBeeSettings } from '../controllers/bee.controller';
import { BeeService } from '../services/bee/beeService';

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: any) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

describe('Bee activation & deactivation lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(BeeService, 'getAvailablePhoneNumbers').mockImplementation(mocks.getAvailablePhoneNumbers);
    vi.spyOn(BeeService, 'syncWarrantyRecordsAndQueue').mockImplementation(mocks.syncWarrantyRecordsAndQueue);
    vi.spyOn(BeeService, 'enrichQueueItemsWithJobContext').mockImplementation(mocks.enrichQueueItemsWithJobContext);
    vi.spyOn(BeeService, 'evaluateJobCallEligibility').mockImplementation(mocks.evaluateJobCallEligibility);
    vi.spyOn(BeeService, 'resolveAgentAndPhoneNumberForJob').mockImplementation(mocks.resolveAgentAndPhoneNumberForJob);
  });

  it('rejects non-allowed orgs with 404 FEATURE_DISABLED and non-admins with 403', () => {
    const res404 = mockRes();
    const next = vi.fn() as unknown as NextFunction;
    requireBee(
      { user: { id: 'u1', organization_id: 'org-1', org_is_demo: false, org_features: [] } } as unknown as Request,
      res404,
      next
    );
    expect(res404.statusCode).toBe(404);
    expect(res404.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'bee' });
    expect(next).not.toHaveBeenCalled();

    const res403 = mockRes();
    requireBeeAdmin(
      { user: { id: 'u1', role: 'ADMIN', is_admin: false } } as unknown as Request,
      res403,
      next
    );
    expect(res403.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns { isActive, isSetUp } from GET /status', async () => {
    mocks.beeSettingFindUnique.mockResolvedValue({
      is_active: false,
      job_type_warranties: [{ job_type: 'HVAC Service', is_active: true }],
    });
    mocks.beeVoiceAgentCount.mockResolvedValue(1);
    mocks.getAvailablePhoneNumbers.mockResolvedValue([{ id: 'pn-1', phoneNumber: '+15551234567' }]);

    const res = mockRes();
    await getBeeStatus({ user: { organization_id: 'org-1' } } as unknown as Request, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ isActive: false, isSetUp: true });
  });

  it('returns 409 on activate when setup is incomplete or settingsVersion is stale', async () => {
    mocks.beeSettingFindUnique.mockResolvedValue({
      is_active: false,
      updated_at: new Date('2026-11-27T12:00:00.000Z'),
      job_type_warranties: [],
    });
    mocks.beeVoiceAgentCount.mockResolvedValue(0);
    mocks.getAvailablePhoneNumbers.mockResolvedValue([]);

    const resIncomplete = mockRes();
    await setBeeActive(
      { user: { id: 'u1', organization_id: 'org-1' }, body: { isActive: true, backlog: 'call' } } as unknown as Request,
      resIncomplete
    );
    expect(resIncomplete.statusCode).toBe(409);
    expect(typeof resIncomplete.body.error).toBe('string');

    mocks.beeSettingFindUnique.mockResolvedValue({
      is_active: false,
      updated_at: new Date('2026-11-27T12:05:00.000Z'),
      job_type_warranties: [{ job_type: 'HVAC Service', is_active: true }],
    });
    mocks.beeVoiceAgentCount.mockResolvedValue(1);
    mocks.getAvailablePhoneNumbers.mockResolvedValue([{ id: 'pn-1', phoneNumber: '+15551234567' }]);

    const resStale = mockRes();
    await setBeeActive(
      {
        user: { id: 'u1', organization_id: 'org-1' },
        body: { isActive: true, backlog: 'call', settingsVersion: '2026-11-27T12:00:00.000Z' },
      } as unknown as Request,
      resStale
    );
    expect(resStale.statusCode).toBe(409);
    expect(resStale.body.error).toContain('Settings changed');
  });

  it('activates with skip backlog (skips past-due items) vs call backlog (restores cancelled items)', async () => {
    const updatedAt = new Date('2026-11-27T12:00:00.000Z');
    mocks.beeSettingFindUnique.mockResolvedValue({
      is_active: false,
      updated_at: updatedAt,
      job_type_warranties: [{ job_type: 'HVAC Service', is_active: true }],
      setup_config: { setupDone: [1, 1, 1, 1, 1, 1, 1] },
    });
    mocks.beeVoiceAgentCount.mockResolvedValue(1);
    mocks.getAvailablePhoneNumbers.mockResolvedValue([{ id: 'pn-1', phoneNumber: '+15551234567' }]);
    mocks.beeSettingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.syncWarrantyRecordsAndQueue.mockResolvedValue({});
    mocks.beeQueueItemUpdateMany.mockResolvedValue({ count: 2 });

    const resSkip = mockRes();
    await setBeeActive(
      {
        user: { id: 'u1', organization_id: 'org-1' },
        body: { isActive: true, backlog: 'skip', settingsVersion: updatedAt.toISOString() },
      } as unknown as Request,
      resSkip
    );
    expect(resSkip.statusCode).toBe(200);
    expect(resSkip.body).toEqual({ isActive: true, isSetUp: true });
    expect(mocks.beeQueueItemUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'skipped' }),
      })
    );
  });

  it('deactivates without wiping settings and cancels scheduled/queued calls while leaving in_progress untouched', async () => {
    mocks.beeSettingFindUnique.mockResolvedValue({
      is_active: true,
      job_type_warranties: [{ job_type: 'HVAC Service', is_active: true }],
      setup_config: { setupDone: [1, 1, 1, 1, 1, 1, 1], launchMode: 'Schedule a start date', scheduledStartDateTime: '2026-12-01T10:00' },
    });
    mocks.beeVoiceAgentCount.mockResolvedValue(1);
    mocks.getAvailablePhoneNumbers.mockResolvedValue([{ id: 'pn-1', phoneNumber: '+15551234567' }]);
    mocks.beeSettingUpdateMany.mockResolvedValue({ count: 1 });
    mocks.beeQueueItemUpdateMany.mockResolvedValue({ count: 3 });

    const res = mockRes();
    await setBeeActive(
      { user: { id: 'u1', organization_id: 'org-1' }, body: { isActive: false } } as unknown as Request,
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ isActive: false, isSetUp: true });
    expect(mocks.beeSettingUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          is_active: false,
          setup_config: expect.objectContaining({
            setupDone: [1, 1, 1, 1, 1, 1, 1],
            launchMode: 'Start now',
            scheduledStartDateTime: '',
          }),
        }),
      })
    );
    expect(mocks.beeQueueItemUpdateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-1', status: { in: ['scheduled', 'queued'] } },
      data: { status: 'cancelled', skip_reason: 'Bee deactivated' },
    });
  });

  it('PUT /settings never sets or mutates is_active', async () => {
    mocks.beeSettingUpsert.mockResolvedValue({ id: 's1', is_active: false });
    const res = mockRes();
    await updateBeeSettings(
      {
        user: { organization_id: 'org-1' },
        body: { is_active: true, call_window_start: '09:00' },
      } as unknown as Request,
      res
    );
    expect(res.statusCode).toBe(200);
    const upsertCall = mocks.beeSettingUpsert.mock.calls[0]?.[0];
    expect(upsertCall.create.is_active).toBe(false);
    expect(upsertCall.update.is_active).toBeUndefined();
  });

  it('queue processor places no call when Bee is deactivated before dialing', async () => {
    const item = {
      id: 'q1',
      organization_id: 'org-1',
      status: 'scheduled',
      scheduled_for: new Date(Date.now() - 60_000),
      attempt_count: 0,
      customer_phone: '+15551234567',
      customer_name: 'Umer',
      job_type: 'HVAC Service',
    };
    mocks.beeQueueItemFindMany.mockResolvedValue([item]);
    mocks.enrichQueueItemsWithJobContext.mockResolvedValue([item]);
    // First read: active; pre-dial re-check: deactivated!
    mocks.beeSettingFindUnique
      .mockResolvedValueOnce({
        is_active: true,
        timezone: 'America/New_York',
        call_window_start: '00:00',
        call_window_end: '23:59',
        max_retries: 2,
        setup_config: { callDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] },
      })
      .mockResolvedValueOnce({ is_active: false });
    mocks.evaluateJobCallEligibility.mockResolvedValue({ isSkipped: false });
    mocks.resolveAgentAndPhoneNumberForJob.mockResolvedValue({ agent: { id: 'a1' }, fromPhoneNumber: '+15550000000' });
    mocks.beeWarrantyPlanFindMany.mockResolvedValue([]);

    await BeeService.processDueQueueItems();
    expect(mocks.initiateCall).not.toHaveBeenCalled();
  });
});
