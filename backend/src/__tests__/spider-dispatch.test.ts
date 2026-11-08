import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { sendAutomationEmail } from '../lib/email';
import { sendStaffAlertSms } from '../lib/ctm/sendSms';
import { dispatchSpiderAlerts } from '../services/notifications/spiderDispatch.service';

vi.mock('../lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email')>();
  return {
    ...actual,
    sendAutomationEmail: vi.fn().mockResolvedValue({ status: 'sent', providerMessageId: 'resend-msg-123' }),
  };
});

vi.mock('../lib/ctm/sendSms', () => ({
  sendStaffAlertSms: vi.fn().mockResolvedValue({ delivered: true }),
}));

describe('Spider Agent Alert Dispatch (Email & SMS)', () => {
  const mockOrgId = '00000000-0000-4000-a000-000000000001';
  const mockOrgBId = '00000000-0000-4000-a000-000000000002';
  const mockUserId = '11111111-1111-4000-a000-111111111111';
  const mockLeadId = '22222222-2222-4000-a000-222222222222';
  const mockCustomerId = '33333333-3333-4000-a000-333333333333';
  const mockOwnerId = '44444444-4444-4000-a000-444444444444';
  const mockAdmin2Id = '55555555-5555-4000-a000-555555555555';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects another company lead with 404/not found, asserting lead lookup where clause and ensuring nothing was sent or written (SEC-2)', async () => {
    (prisma.lead.findFirst as any).mockImplementation(({ where }: any) => {
      // If queried for Org A, but lead belongs to Org B, return null
      if (where.organization_id === mockOrgBId && where.id === mockLeadId) {
        return Promise.resolve({ id: mockLeadId, organization_id: mockOrgBId });
      }
      return Promise.resolve(null);
    });

    const result = await dispatchSpiderAlerts({
      organizationId: mockOrgId,
      leadId: mockLeadId,
      stageLabel: 'New',
      elapsedValue: 1,
      elapsedUnit: 'Day',
      assignments: {
        adminRoles: ['ADMIN'],
        users: [],
        owner: true,
      },
      notifications: {
        email: true,
        sms: true,
        inApp: true,
      },
    });

    // 1. Assert where clause strictly included organization_id
    expect(prisma.lead.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: mockLeadId,
          organization_id: mockOrgId,
        },
      })
    );

    // 2. Assert failure response
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Lead not found');

    // 3. Assert nothing sent or written
    expect(sendAutomationEmail).not.toHaveBeenCalled();
    expect(sendStaffAlertSms).not.toHaveBeenCalled();
    expect(prisma.spiderAlertLog.create).not.toHaveBeenCalled();
    expect(prisma.messageThread.findFirst).not.toHaveBeenCalled();
    expect(prisma.messageThread.create).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('skips SMS when staff member has no phone, recording SKIPPED status and never using the customer phone (SEC-4)', async () => {
    (prisma.lead.findFirst as any).mockResolvedValue({
      id: mockLeadId,
      lead_number: '101',
      customer_id: mockCustomerId,
      organization_id: mockOrgId,
      assigned_to: mockOwnerId,
      customer: {
        id: mockCustomerId,
        organization_id: mockOrgId,
        first_name: 'Customer',
        last_name: 'Person',
        phone: '+12015559999', // Customer HAS a phone number
      },
    });

    (prisma.organization.findUnique as any).mockResolvedValue({
      id: mockOrgId,
      name: 'Alpha HVAC',
    });

    (prisma.user.findMany as any)
      .mockResolvedValueOnce([
        { id: mockUserId, role: 'ADMIN' },
      ])
      .mockResolvedValueOnce([
        { id: mockUserId, email: 'admin@alphahvac.com', phone: null, first_name: 'Admin', last_name: 'User', role: 'ADMIN' }, // Staff has NO phone
      ]);

    (prisma.spiderAlertLog.create as any).mockResolvedValue({ id: 'log-no-phone-1' });
    (prisma.spiderAlertLog.update as any).mockResolvedValue({ id: 'log-no-phone-1' });

    const result = await dispatchSpiderAlerts({
      organizationId: mockOrgId,
      leadId: mockLeadId,
      stageLabel: 'New',
      elapsedValue: 2,
      elapsedUnit: 'Hour',
      assignments: {
        adminRoles: ['ADMIN'],
        users: [],
        owner: false,
      },
      notifications: {
        email: false,
        sms: true,
        inApp: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.smsSent).toBe(0);
    expect(result.smsSkipped).toBe(1);
    expect(result.smsFailed).toBe(0);

    // SMS was NEVER called (customer phone was not used)
    expect(sendStaffAlertSms).not.toHaveBeenCalled();

    // No threads or messages were created
    expect(prisma.messageThread.findFirst).not.toHaveBeenCalled();
    expect(prisma.messageThread.create).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();

    // Alert log status recorded as SKIPPED, not FAILED
    expect(prisma.spiderAlertLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          channels: expect.objectContaining({
            sms: expect.objectContaining({
              status: 'SKIPPED',
              sent: 0,
              skipped: 1,
              failed: 0,
            }),
          }),
        }),
      })
    );
  });

  it('dispatches SMS to two staff recipients without thread collision or duplicate errors, never sending to customer phone (AIF-8, SEC-4)', async () => {
    const customerPhone = '+12015550000';
    const staffPhone1 = '+12015551111';
    const staffPhone2 = '+12015552222';

    (prisma.lead.findFirst as any).mockResolvedValue({
      id: mockLeadId,
      lead_number: '102',
      customer_id: mockCustomerId,
      organization_id: mockOrgId,
      assigned_to: mockOwnerId,
      customer: {
        id: mockCustomerId,
        organization_id: mockOrgId,
        first_name: 'John',
        last_name: 'Customer',
        phone: customerPhone,
      },
    });

    (prisma.organization.findUnique as any).mockResolvedValue({
      id: mockOrgId,
      name: 'Alpha HVAC',
    });

    (prisma.user.findMany as any)
      .mockResolvedValueOnce([
        { id: mockUserId, role: 'ADMIN' },
        { id: mockAdmin2Id, role: 'ADMIN' },
      ])
      .mockResolvedValueOnce([
        { id: mockUserId, email: 'admin1@alphahvac.com', phone: staffPhone1, first_name: 'Admin', last_name: 'One', role: 'ADMIN' },
        { id: mockAdmin2Id, email: 'admin2@alphahvac.com', phone: staffPhone2, first_name: 'Admin', last_name: 'Two', role: 'ADMIN' },
      ]);

    (prisma.spiderAlertLog.create as any).mockResolvedValue({ id: 'log-2recipients-1' });
    (prisma.spiderAlertLog.update as any).mockResolvedValue({ id: 'log-2recipients-1' });

    const result = await dispatchSpiderAlerts({
      organizationId: mockOrgId,
      leadId: mockLeadId,
      stageLabel: 'New',
      elapsedValue: 3,
      elapsedUnit: 'Hour',
      assignments: {
        adminRoles: ['ADMIN'],
        users: [],
        owner: false,
      },
      notifications: {
        email: false,
        sms: true,
        inApp: false,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.smsSent).toBe(2);
    expect(result.smsSkipped).toBe(0);
    expect(result.smsFailed).toBe(0);

    // Verified sendStaffAlertSms called twice for the exact staff phone destinations
    expect(sendStaffAlertSms).toHaveBeenCalledTimes(2);
    expect(sendStaffAlertSms).toHaveBeenNthCalledWith(
      1,
      prisma,
      expect.objectContaining({
        orgId: mockOrgId,
        toE164: staffPhone1,
        body: expect.stringContaining('Spider Alert - John Customer (LD-102)'),
      })
    );
    expect(sendStaffAlertSms).toHaveBeenNthCalledWith(
      2,
      prisma,
      expect.objectContaining({
        orgId: mockOrgId,
        toE164: staffPhone2,
        body: expect.stringContaining('Spider Alert - John Customer (LD-102)'),
      })
    );

    // Verified customer's phone was NEVER sent to
    const allCalls = (sendStaffAlertSms as any).mock.calls;
    allCalls.forEach((callArgs: any[]) => {
      expect(callArgs[1].toE164).not.toBe(customerPhone);
    });

    // Verified no message threads or messages were created
    expect(prisma.messageThread.findFirst).not.toHaveBeenCalled();
    expect(prisma.messageThread.create).not.toHaveBeenCalled();
    expect(prisma.message.create).not.toHaveBeenCalled();
  });

  it('dispatches email alerts to resolved recipients when email notification is enabled', async () => {
    (prisma.lead.findFirst as any).mockResolvedValue({
      id: mockLeadId,
      lead_number: '103',
      customer_id: mockCustomerId,
      organization_id: mockOrgId,
      assigned_to: mockOwnerId,
      assigned_to_user_id: mockOwnerId,
      customer: {
        id: mockCustomerId,
        organization_id: mockOrgId,
        first_name: 'Jane',
        last_name: 'Doe',
        phone: '+12015551234',
        service_street: '123 Main St',
        service_city: 'Paterson',
        service_state: 'NJ',
        service_postal_code: '07501',
      },
    });

    (prisma.organization.findUnique as any).mockResolvedValue({
      id: mockOrgId,
      name: 'Alpha HVAC',
      brand_color: '#0c2d3a',
    });

    (prisma.user.findMany as any)
      .mockResolvedValueOnce([
        { id: mockUserId, role: 'ADMIN' },
        { id: mockOwnerId, role: 'SALES' },
      ])
      .mockResolvedValueOnce([
        { id: mockOwnerId, email: 'owner@alphahvac.com', phone: '+12015559999', first_name: 'John', last_name: 'Owner', role: 'SALES' },
      ]);

    (prisma.spiderAlertLog.create as any).mockResolvedValue({ id: 'log-dispatch-1' });

    const result = await dispatchSpiderAlerts({
      organizationId: mockOrgId,
      leadId: mockLeadId,
      stageLabel: 'Contacted',
      elapsedValue: 3,
      elapsedUnit: 'Day',
      assignments: {
        owner: true,
        adminRoles: [],
        users: [],
      },
      notifications: {
        email: true,
        sms: false,
        inApp: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.emailsSent).toBe(1);
    expect(sendAutomationEmail).toHaveBeenCalledTimes(1);

    const emailCall = (sendAutomationEmail as any).mock.calls[0][0];
    expect(emailCall.to).toBe('owner@alphahvac.com');
    expect(emailCall.senderIdentity).toBe('spider-alert');
    expect(emailCall.subject).toBe('Spider Alert - Jane Doe (LD-103)');
    expect(emailCall.html).toContain('Spider AI Lead Watcher Alert');
    expect(emailCall.html).toContain('This lead was contacted 3 days ago, but a walkthrough has not yet been scheduled.');
    expect(emailCall.html).toContain('John Owner');
  });
});

