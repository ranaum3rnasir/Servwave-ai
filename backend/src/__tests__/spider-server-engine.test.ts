import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { runSpiderWatcherSweep, SPIDER_STAGE_KEYS } from '../services/notifications/spiderWatcherCron';
import { sendAutomationEmail } from '../lib/email';
import { sendStaffAlertSms, sendCtmSms } from '../lib/ctm/sendSms';
import { clearTokenCache } from '../middleware/authenticate';

vi.mock('../lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email')>();
  return {
    ...actual,
    sendAutomationEmail: vi.fn().mockResolvedValue({ status: 'sent', providerMessageId: 'resend-123' }),
  };
});

vi.mock('../lib/ctm/sendSms', () => ({
  sendCtmSms: vi.fn().mockResolvedValue({ delivered: true }),
  sendStaffAlertSms: vi.fn().mockResolvedValue({ delivered: true }),
}));

describe('Spider Watcher Server Engine & Security (AIF-7, AIF-8, AIF-10, AIF-11)', () => {
  const mockOrgId = '00000000-0000-0000-0000-000000000001';
  const mockOrgBId = '00000000-0000-0000-0000-000000000002';
  const mockLeadId = '22222222-2222-4000-a000-222222222222';
  const mockCustomerId = '33333333-3333-4000-a000-333333333333';

  beforeEach(() => {
    vi.clearAllMocks();
    clearTokenCache();
  });

  describe('Spider Configuration & Access Control (ARCH-1, SEC-8, B-3)', () => {
    it('rejects non-demo orgs with 404 FEATURE_DISABLED via requireDemoOrg', async () => {
      mockAuthAs('admin', { is_demo: false });

      const getRes = await request(app)
        .get('/api/ai-farm/spider/config')
        .set(authHeader('admin'));
      expect(getRes.status).toBe(404);
      expect(getRes.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'spider' });

      const putRes = await request(app)
        .put('/api/ai-farm/spider/config')
        .set(authHeader('admin'))
        .send({ isActive: true });
      expect(putRes.status).toBe(404);
      expect(putRes.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'spider' });

      const logsRes = await request(app)
        .get('/api/ai-farm/spider/logs')
        .set(authHeader('admin'));
      expect(logsRes.status).toBe(404);
      expect(logsRes.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'spider' });
    });

    it('allows non-demo orgs when explicitly allowed via SPIDER_ALLOWED_ORG_IDS', async () => {
      process.env.SPIDER_ALLOWED_ORG_IDS = mockOrgId;
      mockAuthAs('admin', { is_demo: false });
      (prisma.spiderWatcherConfig.findUnique as any).mockResolvedValue(null);

      const getRes = await request(app)
        .get('/api/ai-farm/spider/config')
        .set(authHeader('admin'));
      expect(getRes.status).toBe(200);
      expect(getRes.body.ok).toBe(true);

      delete process.env.SPIDER_ALLOWED_ORG_IDS;
    });


    it('rejects GET /config from Sales, Dispatcher, and Technician with 403', async () => {
      for (const role of ['sales', 'dispatcher', 'technician'] as const) {
        mockAuthAs(role, { is_demo: true });
        const res = await request(app)
          .get('/api/ai-farm/spider/config')
          .set(authHeader(role));
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('Only administrators');
      }
    });

    it('rejects PUT /config from Sales, Dispatcher, and Technician with 403 (SEC-8)', async () => {
      for (const role of ['sales', 'dispatcher', 'technician'] as const) {
        mockAuthAs(role, { is_demo: true });
        const res = await request(app)
          .put('/api/ai-farm/spider/config')
          .set(authHeader(role))
          .send({
            isActive: true,
            notifications: { email: true },
          });

        expect(res.status).toBe(403);
        expect(res.body.error).toContain('Only administrators');
      }
    });

    it('rejects GET /logs from Sales, Dispatcher, and Technician with 403', async () => {
      for (const role of ['sales', 'dispatcher', 'technician'] as const) {
        mockAuthAs(role, { is_demo: true });
        const res = await request(app)
          .get('/api/ai-farm/spider/logs')
          .set(authHeader(role));
        expect(res.status).toBe(403);
        expect(res.body.error).toContain('Only administrators');
      }
    });

    it('confirms POST /api/ai-farm/spider/dispatch-alert is deleted and answers 404', async () => {
      mockAuthAs('admin', { is_demo: true });
      const res = await request(app)
        .post('/api/ai-farm/spider/dispatch-alert')
        .set(authHeader('admin'))
        .send({ leadId: mockLeadId });
      expect(res.status).toBe(404);
    });

    it('returns default config when no database row exists for demo org', async () => {
      mockAuthAs('admin', { is_demo: true });
      (prisma.spiderWatcherConfig.findUnique as any).mockResolvedValue(null);

      const res = await request(app)
        .get('/api/ai-farm/spider/config')
        .set(authHeader('admin'));

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.config.isActive).toBe(false);
      expect(res.body.config.autoEnrollAllLeads).toBe(true);
    });

    it('allows admins to update and upsert config in database with frontend stage keys (B-2, B-3)', async () => {
      mockAuthAs('admin', { is_demo: true });
      (prisma.spiderWatcherConfig.upsert as any).mockResolvedValue({
        id: 'cfg-1',
        organization_id: mockOrgId,
        is_active: true,
        auto_enroll_all_leads: true,
        selected_lead_ids: [],
        stage_thresholds: {
          'new-contacted': { value: 30, unit: 'Minute', enabled: true },
          'contacted-walkthrough-scheduled': { value: 2, unit: 'Hour', enabled: true },
          'walkthrough-completed-estimate': { value: 1, unit: 'Day', enabled: true },
        },
        notifications: { email: true, sms: false, inApp: true, redFrame: true },
        assignments: { adminRoles: ['ADMIN'], users: [], owner: true },
        updated_at: new Date(),
      });

      const res = await request(app)
        .put('/api/ai-farm/spider/config')
        .set(authHeader('admin'))
        .send({
          isActive: true,
          stageThresholds: {
            'new-contacted': { value: 30, unit: 'Minute', enabled: true },
          },
        });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.config.isActive).toBe(true);
    });

    it('rejects activating Spider without at least one stage threshold with duration > 0', async () => {
      mockAuthAs('admin', { is_demo: true });

      const resEmpty = await request(app)
        .put('/api/ai-farm/spider/config')
        .set(authHeader('admin'))
        .send({
          isActive: true,
          stageThresholds: {},
        });

      expect(resEmpty.status).toBe(400);
      expect(resEmpty.body.error).toContain('At least one stage threshold must be configured');

      const resZero = await request(app)
        .put('/api/ai-farm/spider/config')
        .set(authHeader('admin'))
        .send({
          isActive: true,
          stageThresholds: {
            'new-contacted': { value: 0, unit: 'Minute', enabled: true },
          },
        });

      expect(resZero.status).toBe(400);
      expect(resZero.body.error).toContain('At least one stage threshold must be configured');

      // Deactivating with no thresholds is permitted
      (prisma.spiderWatcherConfig.upsert as any).mockResolvedValue({
        id: 'cfg-1',
        organization_id: mockOrgId,
        is_active: false,
        auto_enroll_all_leads: true,
        selected_lead_ids: [],
        stage_thresholds: {},
        notifications: {},
        assignments: {},
        updated_at: new Date(),
      });

      const resDeactivate = await request(app)
        .put('/api/ai-farm/spider/config')
        .set(authHeader('admin'))
        .send({
          isActive: false,
          stageThresholds: {},
        });

      expect(resDeactivate.status).toBe(200);
      expect(resDeactivate.body.config.isActive).toBe(false);
    });
  });

  describe('Spider Alert Logs Security (SEC-1, SEC-6)', () => {
    it('requires authentication for /api/ai-farm/spider/logs and rejects requests even with old secret in header or query (SEC-1)', async () => {
      const resNoAuth = await request(app).get('/api/ai-farm/spider/logs');
      expect(resNoAuth.status).toBe(401);

      const resQuerySecret = await request(app).get('/api/ai-farm/spider/logs?secret=spider-sync-secret');
      expect(resQuerySecret.status).toBe(401);

      const resHeaderSecret = await request(app)
        .get('/api/ai-farm/spider/logs')
        .set('x-spider-secret', 'spider-sync-secret')
        .set('x-sync-secret', 'spider-sync-secret');
      expect(resHeaderSecret.status).toBe(401);

      const resBothSecrets = await request(app)
        .get('/api/ai-farm/spider/logs?secret=spider-sync-secret')
        .set('x-spider-secret', 'spider-sync-secret');
      expect(resBothSecrets.status).toBe(401);
    });

    it('validates page and limit query params with Zod and returns 400 on bad values', async () => {
      mockAuthAs('admin', { is_demo: true });

      const resBadPage = await request(app)
        .get('/api/ai-farm/spider/logs?page=abc')
        .set(authHeader('admin'));
      expect(resBadPage.status).toBe(400);

      const resBadLimit = await request(app)
        .get('/api/ai-farm/spider/logs?limit=all')
        .set(authHeader('admin'));
      expect(resBadLimit.status).toBe(400);

      const resLimitExceeded = await request(app)
        .get('/api/ai-farm/spider/logs?limit=200')
        .set(authHeader('admin'));
      expect(resLimitExceeded.status).toBe(400);

      const resNegativePage = await request(app)
        .get('/api/ai-farm/spider/logs?page=-1')
        .set(authHeader('admin'));
      expect(resNegativePage.status).toBe(400);
    });

    it('returns only the fields needed by the History screen and no raw logs, full bodies, or unneeded fields', async () => {
      mockAuthAs('admin', { is_demo: true });
      (prisma.spiderWatcherConfig.findUnique as any).mockResolvedValue({
        id: 'cfg-1',
        organization_id: mockOrgId,
        is_active: true,
      });
      (prisma.spiderAlertLog.findMany as any).mockResolvedValue([
        {
          id: 'log-1',
          lead_id: mockLeadId,
          lead_number: '101',
          customer_name: 'John Doe',
          company_name: 'Doe HVAC',
          service_request: 'AC Repair',
          service_location: '123 Main St',
          stage_name: 'New → Contacted',
          inactive_days: 2,
          inactive_unit: 'Day',
          channels: { email: { enabled: true, status: 'SENT' } },
          status: 'SENT',
          created_at: new Date('2026-09-29T10:00:00Z'),
        },
      ]);
      (prisma.spiderAlertLog.count as any).mockResolvedValue(1);

      const res = await request(app)
        .get('/api/ai-farm/spider/logs?page=1&limit=50')
        .set(authHeader('admin'));

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.records).toHaveLength(1);
      const record = res.body.records[0];
      expect(record).toHaveProperty('id');
      expect(record).toHaveProperty('lead_number');
      expect(record).toHaveProperty('customer_name');
      expect(record).toHaveProperty('stage_name');
      expect(record).not.toHaveProperty('email_body');
      expect(record).not.toHaveProperty('sms_message');
      expect(record).not.toHaveProperty('raw_log');
      expect(record).not.toHaveProperty('hostname');
      expect(record).not.toHaveProperty('source');

      expect(prisma.spiderAlertLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: {
            id: true,
            lead_id: true,
            lead_number: true,
            customer_name: true,
            company_name: true,
            service_request: true,
            service_location: true,
            stage_name: true,
            inactive_days: true,
            inactive_unit: true,
            channels: true,
            recipients: true,
            status: true,
            created_at: true,
          },
        })
      );
    });

    it('ensures a Company B admin receives only Company B rows and zero Company A rows', async () => {
      const companyARows = [
        {
          id: 'log-company-a-1',
          lead_id: mockLeadId,
          lead_number: '101',
          customer_name: 'Company A Customer',
          company_name: 'Org A Client',
          service_request: 'Repair',
          service_location: '123 Main St',
          stage_name: 'New',
          inactive_days: 1,
          inactive_unit: 'Day',
          channels: { email: { enabled: true, status: 'SENT' } },
          status: 'SENT',
          created_at: new Date('2026-09-29T10:00:00Z'),
        },
      ];
      const companyBRows = [
        {
          id: 'log-company-b-1',
          lead_id: '44444444-4444-4000-a000-444444444444',
          lead_number: '201',
          customer_name: 'Company B Customer',
          company_name: 'Org B Client',
          service_request: 'Installation',
          service_location: '456 Elm St',
          stage_name: 'Contacted',
          inactive_days: 2,
          inactive_unit: 'Hour',
          channels: { inApp: { enabled: true, status: 'SENT' } },
          status: 'SENT',
          created_at: new Date('2026-09-30T10:00:00Z'),
        },
      ];

      (prisma.spiderWatcherConfig.findUnique as any).mockImplementation(({ where }: any) => {
        if (where?.organization_id === mockOrgBId) {
          return Promise.resolve({ id: 'cfg-org-b', organization_id: mockOrgBId, is_active: true });
        }
        if (where?.organization_id === mockOrgId) {
          return Promise.resolve({ id: 'cfg-org-a', organization_id: mockOrgId, is_active: true });
        }
        return Promise.resolve(null);
      });

      (prisma.spiderAlertLog.findMany as any).mockImplementation(({ where }: any) => {
        if (where?.organization_id === mockOrgBId) {
          return Promise.resolve(companyBRows);
        }
        if (where?.organization_id === mockOrgId) {
          return Promise.resolve(companyARows);
        }
        return Promise.resolve([]);
      });

      (prisma.spiderAlertLog.count as any).mockImplementation(({ where }: any) => {
        if (where?.organization_id === mockOrgBId) return Promise.resolve(companyBRows.length);
        if (where?.organization_id === mockOrgId) return Promise.resolve(companyARows.length);
        return Promise.resolve(0);
      });

      // 1. Query as Company B admin
      mockAuthAs('orgB_admin', { is_demo: true });
      const resB = await request(app)
        .get('/api/ai-farm/spider/logs?page=1&limit=50')
        .set(authHeader('orgB_admin'));

      expect(resB.status).toBe(200);
      expect(resB.body.ok).toBe(true);
      expect(resB.body.records).toHaveLength(1);
      expect(resB.body.records[0].id).toBe('log-company-b-1');
      expect(resB.body.records[0].customer_name).toBe('Company B Customer');
      // Verify zero Company A rows
      const foundCompanyAInB = resB.body.records.some((r: any) => r.id === 'log-company-a-1');
      expect(foundCompanyAInB).toBe(false);

      // 2. Query as Company A admin
      mockAuthAs('admin', { is_demo: true });
      const resA = await request(app)
        .get('/api/ai-farm/spider/logs?page=1&limit=50')
        .set(authHeader('admin'));

      expect(resA.status).toBe(200);
      expect(resA.body.ok).toBe(true);
      expect(resA.body.records).toHaveLength(1);
      expect(resA.body.records[0].id).toBe('log-company-a-1');
      expect(resA.body.records[0].customer_name).toBe('Company A Customer');
      const foundCompanyBInA = resA.body.records.some((r: any) => r.id === 'log-company-b-1');
      expect(foundCompanyBInA).toBe(false);
    });

    it('returns existing historical logs even when Spider is deactivated for the company', async () => {
      mockAuthAs('admin', { is_demo: true });
      (prisma.spiderAlertLog.findMany as any).mockResolvedValue([
        {
          id: 'log-history-1',
          lead_id: mockLeadId,
          lead_number: '101',
          customer_name: 'Historical Customer',
          company_name: null,
          service_request: 'Repair',
          service_location: '123 Main St',
          stage_name: 'New Lead',
          inactive_days: 2,
          inactive_unit: 'Day',
          channels: { email: { enabled: true } },
          recipients: [{ id: 'admin-1', name: 'Admin', email: 'admin@example.com' }],
          status: 'SENT',
          created_at: new Date('2026-09-28T10:00:00Z'),
        },
      ]);
      (prisma.spiderAlertLog.count as any).mockResolvedValue(1);

      const res = await request(app)
        .get('/api/ai-farm/spider/logs')
        .set(authHeader('admin'));

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.records).toHaveLength(1);
      expect(res.body.records[0].id).toBe('log-history-1');
      expect(res.body.total).toBe(1);
    });
  });

  describe('Scheduled Server Sweeper & Deduplication (B-1, B-2, ARCH-1, BUG-1, BUG-2, BUG-3)', () => {
    it('sweeps active orgs using exact frontend stage keys and units (Minute/Hour/Day) (B-2)', async () => {
      const now = new Date('2026-09-29T12:00:00Z');
      const leadCreated45MinsAgo = new Date('2026-09-29T11:15:00Z');

      (prisma.spiderWatcherConfig.findMany as any).mockResolvedValue([
        {
          id: 'cfg-1',
          organization_id: mockOrgId,
          is_active: true,
          auto_enroll_all_leads: true,
          selected_lead_ids: [],
          stage_thresholds: {
            'new-contacted': { value: 30, unit: 'Minute', enabled: true },
            'contacted-walkthrough-scheduled': { value: 2, unit: 'Hour', enabled: true },
            'walkthrough-completed-estimate': { value: 1, unit: 'Day', enabled: true },
          },
          assignments: { adminRoles: ['ADMIN'], users: [], owner: true },
          notifications: { email: true, sms: false, inApp: true, redFrame: true },
        },
      ]);

      (prisma.lead.findMany as any).mockResolvedValue([
        {
          id: mockLeadId,
          lead_number: '105',
          status: 'NEW',
          created_at: leadCreated45MinsAgo,
          contacted_at: null,
          walkthrough_first_booked_at: null,
          last_visit_completed_at: null,
          first_estimate_sent_at: null,
        },
      ]);

      // Dedupe check: first run finds nothing
      (prisma.spiderAlertLog.findUnique as any).mockResolvedValue(null);

      (prisma.lead.findFirst as any).mockResolvedValue({
        id: mockLeadId,
        lead_number: '105',
        customer_id: mockCustomerId,
        organization_id: mockOrgId,
        customer: {
          id: mockCustomerId,
          organization_id: mockOrgId,
          first_name: 'Bob',
          last_name: 'Jones',
          phone: null,
        },
      });

      (prisma.organization.findUnique as any).mockResolvedValue({
        id: mockOrgId,
        name: 'Alpha HVAC',
      });

      (prisma.user.findMany as any).mockResolvedValue([
        {
          id: 'admin-1',
          email: 'admin@example.com',
          phone: null,
          first_name: 'Admin',
          last_name: 'User',
          role: 'ADMIN',
        },
      ]);

      (prisma.spiderAlertLog.create as any).mockResolvedValue({ id: 'log-sweep-1' });

      const sweepResult = await runSpiderWatcherSweep(now);

      expect(sweepResult.organizationsChecked).toBe(1);
      expect(sweepResult.leadsEvaluated).toBe(1);
      expect(sweepResult.alertsDispatched).toBe(1);
      expect(sendAutomationEmail).toHaveBeenCalledTimes(1);

      // Verify dedupe_key was passed and saved
      expect(prisma.spiderAlertLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            dedupe_key: expect.stringContaining(`spider:${mockOrgId}:${mockLeadId}:${SPIDER_STAGE_KEYS.NEW_CONTACTED}`),
          }),
        })
      );
    });

    it('running the job twice sends exactly ONE alert (B-1 stateful dedupe test)', async () => {
      const now = new Date('2026-09-29T12:00:00Z');
      const leadCreatedTwoDaysAgo = new Date('2026-09-27T12:00:00Z');

      (prisma.spiderWatcherConfig.findMany as any).mockResolvedValue([
        {
          id: 'cfg-1',
          organization_id: mockOrgId,
          is_active: true,
          auto_enroll_all_leads: true,
          selected_lead_ids: [],
          stage_thresholds: {
            'new-contacted': { value: 1, unit: 'Day', enabled: true },
          },
          assignments: { adminRoles: ['ADMIN'], users: [], owner: true },
          notifications: { email: true, sms: false, inApp: true, redFrame: true },
        },
      ]);

      (prisma.lead.findMany as any).mockResolvedValue([
        {
          id: mockLeadId,
          lead_number: '105',
          status: 'NEW',
          created_at: leadCreatedTwoDaysAgo,
          contacted_at: null,
          walkthrough_first_booked_at: null,
          last_visit_completed_at: null,
          first_estimate_sent_at: null,
        },
      ]);

      (prisma.lead.findFirst as any).mockResolvedValue({
        id: mockLeadId,
        lead_number: '105',
        customer_id: mockCustomerId,
        organization_id: mockOrgId,
        customer: { id: mockCustomerId, organization_id: mockOrgId, first_name: 'Bob', last_name: 'Jones' },
      });

      (prisma.organization.findUnique as any).mockResolvedValue({ id: mockOrgId, name: 'Alpha HVAC' });
      (prisma.user.findMany as any).mockResolvedValue([
        { id: 'admin-1', email: 'admin@example.com', phone: null, first_name: 'Admin', last_name: 'User', role: 'ADMIN' },
      ]);

      // Run 1: Dedupe check finds nothing, creates log
      (prisma.spiderAlertLog.findUnique as any).mockResolvedValue(null);
      (prisma.spiderAlertLog.create as any).mockResolvedValue({ id: 'log-sweep-1' });

      const firstRun = await runSpiderWatcherSweep(now);
      expect(firstRun.alertsDispatched).toBe(1);
      expect(sendAutomationEmail).toHaveBeenCalledTimes(1);

      // Run 2: Database already has the dedupe key saved from Run 1
      (prisma.spiderAlertLog.findUnique as any).mockResolvedValue({ id: 'log-sweep-1' });

      const secondRun = await runSpiderWatcherSweep(now);
      expect(secondRun.alertsDispatched).toBe(0);
      expect(sendAutomationEmail).toHaveBeenCalledTimes(1); // Still exactly 1, no duplicate send!
    });

    it('editing a note on a lead does not reset its time-in-stage (BUG-1)', async () => {
      const now = new Date('2026-09-29T12:00:00Z');
      const leadCreatedTwoDaysAgo = new Date('2026-09-27T12:00:00Z');
      const noteEditedJustNow = new Date('2026-09-29T11:59:00Z');

      (prisma.spiderWatcherConfig.findMany as any).mockResolvedValue([
        {
          id: 'cfg-1',
          organization_id: mockOrgId,
          is_active: true,
          auto_enroll_all_leads: true,
          selected_lead_ids: [],
          stage_thresholds: {
            'new-contacted': { value: 1, unit: 'Day', enabled: true },
          },
          assignments: { adminRoles: ['ADMIN'], users: [], owner: true },
          notifications: { email: true, sms: false, inApp: true, redFrame: true },
        },
      ]);

      (prisma.lead.findMany as any).mockResolvedValue([
        {
          id: mockLeadId,
          lead_number: '106',
          status: 'NEW',
          created_at: leadCreatedTwoDaysAgo,
          updated_at: noteEditedJustNow,
          contacted_at: null,
          walkthrough_first_booked_at: null,
          last_visit_completed_at: null,
          first_estimate_sent_at: null,
        },
      ]);

      (prisma.spiderAlertLog.findUnique as any).mockResolvedValue(null);
      (prisma.lead.findFirst as any).mockResolvedValue({
        id: mockLeadId,
        lead_number: '106',
        customer_id: mockCustomerId,
        organization_id: mockOrgId,
        customer: { id: mockCustomerId, organization_id: mockOrgId, first_name: 'Bob', last_name: 'Jones' },
      });
      (prisma.organization.findUnique as any).mockResolvedValue({ id: mockOrgId, name: 'Alpha HVAC' });
      (prisma.user.findMany as any).mockResolvedValue([
        { id: 'admin-1', email: 'admin@example.com', phone: null, first_name: 'Admin', last_name: 'User', role: 'ADMIN' },
      ]);
      (prisma.spiderAlertLog.create as any).mockResolvedValue({ id: 'log-sweep-note-1' });

      const sweepResult = await runSpiderWatcherSweep(now);
      // Evaluates stage start as lead.created_at (2 days), immune to note edit updated_at
      expect(sweepResult.alertsDispatched).toBe(1);
    });

    it('evaluates all open leads for a company with more than 100 open leads without pagination cutoff (BUG-2)', async () => {
      const now = new Date('2026-09-29T12:00:00Z');
      const leadCreatedTwoDaysAgo = new Date('2026-09-27T12:00:00Z');

      (prisma.spiderWatcherConfig.findMany as any).mockResolvedValue([
        {
          id: 'cfg-1',
          organization_id: mockOrgId,
          is_active: true,
          auto_enroll_all_leads: true,
          selected_lead_ids: [],
          stage_thresholds: {
            'new-contacted': { value: 1, unit: 'Day', enabled: true },
          },
          assignments: { adminRoles: ['ADMIN'], users: [], owner: true },
          notifications: { email: true, sms: false, inApp: true, redFrame: true },
        },
      ]);

      const manyLeads = Array.from({ length: 150 }, (_, i) => ({
        id: `lead-id-${i + 1}`,
        lead_number: `LD-${1000 + i}`,
        status: 'NEW',
        created_at: leadCreatedTwoDaysAgo,
        contacted_at: null,
        walkthrough_first_booked_at: null,
        last_visit_completed_at: null,
        first_estimate_sent_at: null,
      }));

      (prisma.lead.findMany as any).mockResolvedValue(manyLeads);

      const sweepResult = await runSpiderWatcherSweep(now);
      expect(sweepResult.leadsEvaluated).toBe(150);
      expect(prisma.lead.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: mockOrgId,
          }),
        })
      );
      // Ensure take parameter was never added to restrict leads
      const findManyCallArgs = (prisma.lead.findMany as any).mock.calls[0][0];
      expect(findManyCallArgs.take).toBeUndefined();
    });

    it('does nothing for a company whose Spider switch is off (SEC-8)', async () => {
      const now = new Date('2026-09-29T12:00:00Z');

      (prisma.spiderWatcherConfig.findMany as any).mockResolvedValue([]);

      const sweepResult = await runSpiderWatcherSweep(now);

      // Verify the sweep query explicitly filters on is_active: true
      expect(prisma.spiderWatcherConfig.findMany).toHaveBeenCalledWith({
        where: { is_active: true },
      });

      expect(sweepResult.organizationsChecked).toBe(0);
      expect(sweepResult.leadsEvaluated).toBe(0);
      expect(sweepResult.alertsDispatched).toBe(0);
      expect(sendAutomationEmail).not.toHaveBeenCalled();
      expect(prisma.lead.findMany).not.toHaveBeenCalled();
    });

    it('strictly isolates tenant leads during sweep so Org A never alerts on Org B leads (SEC-2)', async () => {
      const now = new Date('2026-09-29T12:00:00Z');

      (prisma.spiderWatcherConfig.findMany as any).mockResolvedValue([
        {
          id: 'cfg-org-a',
          organization_id: mockOrgId,
          is_active: true,
          auto_enroll_all_leads: true,
          selected_lead_ids: [],
          stage_thresholds: {
            'new-contacted': { value: 1, unit: 'Day', enabled: true },
          },
          assignments: { adminRoles: ['ADMIN'], users: [], owner: true },
          notifications: { email: true, sms: false, inApp: true, redFrame: true },
        },
      ]);

      (prisma.lead.findMany as any).mockResolvedValue([]);

      await runSpiderWatcherSweep(now);

      // Verify Org A sweep explicitly filters by mockOrgId only
      expect(prisma.lead.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organization_id: mockOrgId,
          }),
        })
      );
      // Never queries without organization_id
      const queryWhere = (prisma.lead.findMany as any).mock.calls[0][0].where;
      expect(queryWhere.organization_id).toBe(mockOrgId);
      expect(queryWhere.organization_id).not.toBe(mockOrgBId);
    });
  });
});
