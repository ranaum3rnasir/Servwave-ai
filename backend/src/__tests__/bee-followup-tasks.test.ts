import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/prisma', () => {
  const mockPrisma = {
    beeQueueItem: {
      findUnique: vi.fn(),
    },
    beeWarrantyRecord: {
      findFirst: vi.fn(),
    },
    beeSetting: {
      findUnique: vi.fn(),
    },
    job: {
      findFirst: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Test Org',
        logo_url: null,
        brand_color: '#0C2D3A',
      }),
    },
    taskCategory: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    task: {
      create: vi.fn(),
    },
    beeCallLog: {
      update: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => cb(mockPrisma)),
  };
  return { prisma: mockPrisma, default: mockPrisma };
});

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue([]),
}));

vi.mock('../lib/ctm/sendSms', () => ({
  sendStaffAlertSms: vi.fn().mockResolvedValue({ delivered: true }),
}));

vi.mock('../lib/numbering', () => ({
  allocateNumber: vi.fn().mockResolvedValue('T00100'),
  withNumberCollisionRetry: vi.fn((fn: any) => fn()),
}));

import { prisma } from '../lib/prisma';
import { emit } from '../services/notifications/notificationService';
import { sendStaffAlertSms } from '../lib/ctm/sendSms';
import { sendAutomationEmail } from '../lib/email';
import { BeeService } from '../services/bee/beeService';

describe('Job Follow-up Tasks Configuration in Setup & Task Creation Workflow', () => {
  const orgId = '00000000-0000-0000-0000-000000000001';
  const jobId = '11111111-1111-1111-1111-111111111111';
  const customerId = '22222222-2222-2222-2222-222222222222';
  const dispatcherUserId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const sellerUserId = 'ssssssss-ssss-ssss-ssss-ssssssssssss';
  const techUserId1 = 'tttttttt-1111-1111-1111-tttttttttttt';
  const techUserId2 = 'tttttttt-2222-2222-2222-tttttttttttt';
  const fallbackDispatcherId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const adminWatcherUserId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. Priority and Category are independently configured and applied to created tasks', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce({
      id: jobId,
      job_number: 'J00150',
      dispatcher_id: dispatcherUserId,
      salesperson_id: null,
      visits: [],
    } as any);

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        taskPriority: 'URGENT',
        taskCategory: 'Customer Escalation',
        taskAssigneeRoles: ['Job Dispatcher'],
        fallbackDispatcherId,
      },
    } as any);

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-custom-1',
      name: 'Customer Escalation',
      organization_id: orgId,
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-1',
      task_number: 'T00100',
      priority: 'URGENT',
      category_id: 'cat-custom-1',
      title: 'Bee Follow-up: Warranty Plan - Alice · Job #J00150',
    } as any);

    const task = await BeeService.createTaskFromCall({
      orgId,
      jobId,
      customerId,
      customerName: 'Alice',
      customerPhone: '555-0100',
      outcome: 'INTERESTED_WARRANTY',
      summary: 'Customer wants a quote for warranty renewal',
      callLogId: 'call-101',
    });

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          priority: 'URGENT',
          category_id: 'cat-custom-1',
        }),
      })
    );
    expect(task).toBeDefined();
  });

  it('2. Multiple assignee roles (Job Dispatcher, Job Seller, Assigned Technician) resolve to correct assignees', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce({
      id: jobId,
      job_number: 'J00150',
      dispatcher_id: dispatcherUserId,
      salesperson_id: sellerUserId,
      visits: [
        {
          id: 'v1',
          status: 'COMPLETED',
          assignees: [
            { user_id: techUserId1 },
            { user_id: techUserId2 },
          ],
        },
      ],
    } as any);

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        taskAssigneeRoles: ['Job Dispatcher', 'Job Seller', 'Assigned Technician'],
        fallbackDispatcherId,
      },
    } as any);

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-default',
      name: 'Bee Follow-up',
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-2',
      task_number: 'T00101',
    } as any);

    await BeeService.createTaskFromCall({
      orgId,
      jobId,
      customerId,
      customerName: 'Bob',
      customerPhone: '555-0200',
      outcome: 'INTERESTED_NEW_WORK',
      summary: 'Needs estimate for storefront door replacement',
    });

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignee_ids: expect.arrayContaining([
            dispatcherUserId,
            sellerUserId,
            techUserId1,
            techUserId2,
          ]),
        }),
      })
    );
  });

  it('3. Fallback rule: If a selected job-assignee role has no valid assignee on the job, fallback dispatcher is applied', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce({
      id: jobId,
      job_number: 'J00150',
      dispatcher_id: null, // missing dispatcher on job!
      salesperson_id: null,
      visits: [], // no technicians!
    } as any);

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        taskAssigneeRoles: ['Job Dispatcher'],
        fallbackDispatcherId,
      },
    } as any);

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-default',
      name: 'Bee Follow-up',
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-3',
      task_number: 'T00102',
    } as any);

    await BeeService.createTaskFromCall({
      orgId,
      jobId,
      customerId,
      customerName: 'Carol',
      customerPhone: '555-0300',
      outcome: 'CALLBACK_REQUESTED',
      summary: 'Customer asked for callback later today',
    });

    // Fallback dispatcher was applied because job dispatcher was null
    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignee_ids: [fallbackDispatcherId],
        }),
      })
    );
  });

  it('4. Deduplication: multiple roles that resolve to the same user or fallback do not create duplicate assignments', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce({
      id: jobId,
      job_number: 'J00150',
      dispatcher_id: null,
      salesperson_id: null, // both missing -> both resolve to fallback
      visits: [],
    } as any);

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        taskAssigneeRoles: ['Job Dispatcher', 'Job Seller'],
        fallbackDispatcherId,
      },
    } as any);

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-default',
      name: 'Bee Follow-up',
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-4',
      task_number: 'T00103',
    } as any);

    await BeeService.createTaskFromCall({
      orgId,
      jobId,
      customerId,
      customerName: 'Dan',
      customerPhone: '555-0400',
      outcome: 'COMPLAINT',
      summary: 'Door alignment is noisy',
    });

    // Both roles failed to resolve, but assignee_ids must contain fallbackDispatcherId exactly once
    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          assignee_ids: [fallbackDispatcherId],
        }),
      })
    );
  });

  it('5. Custom description with dynamic variables resolves correctly at task creation time', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce({
      id: jobId,
      job_number: 'J00150',
      dispatcher_id: dispatcherUserId,
    } as any);

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        taskDescription: 'Hello! Task for {customer_name} ({customer_phone}) on job #{job_number}. Reason: {summary} [Ref: {call_log_id}]',
        fallbackDispatcherId,
      },
    } as any);

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-default',
      name: 'Bee Follow-up',
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-5',
      task_number: 'T00104',
    } as any);

    await BeeService.createTaskFromCall({
      orgId,
      jobId,
      customerId,
      customerName: 'Eva Green',
      customerPhone: '555-0555',
      outcome: 'HANDOFF_HUMAN',
      summary: 'Customer wants a senior technician on site',
      callLogId: 'call-uuid-999',
    });

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'Hello! Task for Eva Green (555-0555) on job #J00150. Reason: Customer wants a senior technician on site [Ref: call-uuid-999]',
        }),
      })
    );
  });

  it('6. Missing dynamic-variable values are handled safely without task failure', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce(null); // No job!

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        taskDescription: 'Job: #{job_number} | Customer: {customer_name} | Summary: {summary}',
        fallbackDispatcherId,
      },
    } as any);

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-default',
      name: 'Bee Follow-up',
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-6',
      task_number: 'T00105',
    } as any);

    await BeeService.createTaskFromCall({
      orgId,
      jobId: null,
      customerId,
      customerName: '', // empty name
      customerPhone: '555-0600',
      outcome: 'NEEDS_REVIEW',
      summary: '', // empty summary
    });

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          description: 'Job: # | Customer:  | Summary: ',
        }),
      })
    );
  });

  it('7. Fixed Task Title is strictly preserved and non-editable', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce({
      id: jobId,
      job_number: 'J00180',
      dispatcher_id: dispatcherUserId,
    } as any);

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        fallbackDispatcherId,
      },
    } as any);

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-default',
      name: 'Bee Follow-up',
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-7',
      task_number: 'T00106',
    } as any);

    await BeeService.createTaskFromCall({
      orgId,
      jobId,
      customerId,
      customerName: 'Frank Sinatra',
      customerPhone: '555-0700',
      outcome: 'INTERESTED_WARRANTY',
      summary: 'Customer called back',
    });

    expect(prisma.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          title: 'Bee Follow-up: Warranty Plan - Frank Sinatra · Job #J00180',
        }),
      })
    );
  });

  it('8. Follow-up tasks are triggered solely by configured Call Outcomes without requiring Trigger Words', () => {
    expect(BeeService.isFollowupTaskOutcome('INTERESTED_WARRANTY')).toBe(true);
    expect(BeeService.isFollowupTaskOutcome('INTERESTED_NEW_WORK')).toBe(true);
    expect(BeeService.isFollowupTaskOutcome('CALLBACK_REQUESTED')).toBe(true);
    expect(BeeService.isFollowupTaskOutcome('HANDOFF_HUMAN')).toBe(true);
    expect(BeeService.isFollowupTaskOutcome('COMPLAINT')).toBe(true);
    expect(BeeService.isFollowupTaskOutcome('NEEDS_REVIEW')).toBe(true);
    expect(BeeService.isFollowupTaskOutcome('NOT_INTERESTED')).toBe(false);
    expect(BeeService.isFollowupTaskOutcome('VOICEMAIL')).toBe(false);
    expect(BeeService.isFollowupTaskOutcome('NO_ANSWER')).toBe(false);

    // Custom allowed outcomes list
    expect(BeeService.isFollowupTaskOutcome('INTERESTED_WARRANTY', false, ['COMPLAINT'])).toBe(false);
    expect(BeeService.isFollowupTaskOutcome('COMPLAINT', false, ['COMPLAINT'])).toBe(true);
  });

  it('9. Dispatches In-app, SMS, and Email notifications when configured in alertChannels', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce({
      id: jobId,
      job_number: 'J00200',
      dispatcher_id: dispatcherUserId,
      salesperson_id: null,
      visits: [],
    } as any);

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        taskPriority: 'HIGH',
        taskAssigneeRoles: ['Job Dispatcher'],
        adminWatcherId: adminWatcherUserId,
        alertChannels: ['In-app', 'Text message', 'Email'],
      },
    } as any);

    (vi.mocked(prisma.user.findFirst) as any).mockImplementation(async (query: any) => {
      if (query?.where?.id === adminWatcherUserId) {
        return { id: adminWatcherUserId, is_active: true } as any;
      }
      return null;
    });

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-1',
      name: 'Bee Follow-up',
      organization_id: orgId,
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-notif-1',
      task_number: 'T00201',
      priority: 'HIGH',
      title: 'Bee Follow-up: New Job - Grace · Job #J00200',
    } as any);

    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      {
        id: dispatcherUserId,
        first_name: 'Dan',
        last_name: 'Dispatcher',
        email: 'dan@example.com',
        phone: '+15551234567',
      },
      {
        id: adminWatcherUserId,
        first_name: 'Alice',
        last_name: 'Admin',
        email: 'alice@example.com',
        phone: '+15559876543',
      },
    ] as any);

    await BeeService.createTaskFromCall({
      orgId,
      jobId,
      customerId,
      customerName: 'Grace',
      customerPhone: '+15550001111',
      outcome: 'INTERESTED_NEW_WORK',
      summary: 'Customer wants a bathroom remodel estimate',
      callLogId: 'call-201',
    });

    // 1. In-app notification verification (rings default ServWave notification bell)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: 'task.assigned',
        organizationId: orgId,
        actorId: null,
        object: { type: 'TASK', id: 'task-notif-1', label: 'Bee Follow-up: New Job - Grace · Job #J00200' },
        entity: { added_assignee_ids: [dispatcherUserId] },
        data: { task_number: 'T00201' },
      })
    );

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: 'task.watching',
        organizationId: orgId,
        actorId: null,
        object: { type: 'TASK', id: 'task-notif-1', label: 'Bee Follow-up: New Job - Grace · Job #J00200' },
        entity: { added_watcher_ids: [adminWatcherUserId] },
        data: { task_number: 'T00201' },
      })
    );

    // 2. SMS alert verification (uses sendStaffAlertSms with the org outbound CTM number)
    expect(sendStaffAlertSms).toHaveBeenCalledTimes(2);
    expect(sendStaffAlertSms).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId,
        toE164: '+15551234567',
        body: expect.stringContaining('Bee AI Follow-up Task #T00201: New Job'),
      })
    );
    expect(sendStaffAlertSms).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId,
        toE164: '+15559876543',
        body: expect.stringContaining('Customer: Grace'),
      })
    );

    // 3. Email alert verification (uses sendAutomationEmail)
    expect(sendAutomationEmail).toHaveBeenCalledTimes(2);
    expect(sendAutomationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        to: 'dan@example.com',
        subject: 'Bee Follow-up Task #T00201: New Job - Grace',
      })
    );
    expect(sendAutomationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        to: 'alice@example.com',
        subject: 'Bee Follow-up Task #T00201: New Job - Grace',
      })
    );
  });

  it('10. Respects channel selection: does not send SMS or Email when only In-app is enabled', async () => {
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce({
      id: jobId,
      job_number: 'J00202',
      dispatcher_id: dispatcherUserId,
      salesperson_id: null,
      visits: [],
    } as any);

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        taskPriority: 'MEDIUM',
        taskAssigneeRoles: ['Job Dispatcher'],
        adminWatcherId: 'none',
        alertChannels: ['In-app'],
      },
    } as any);

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-1',
      name: 'Bee Follow-up',
      organization_id: orgId,
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-notif-2',
      task_number: 'T00202',
      priority: 'MEDIUM',
      title: 'Bee Follow-up: Warranty Plan - Henry · Job #J00202',
    } as any);

    await BeeService.createTaskFromCall({
      orgId,
      jobId,
      customerId,
      customerName: 'Henry',
      customerPhone: '+15552223333',
      outcome: 'INTERESTED_WARRANTY',
      summary: 'Extend warranty by 1 year',
    });

    // In-app should be emitted
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: 'task.assigned',
        entity: { added_assignee_ids: [dispatcherUserId] },
      })
    );

    // Neither SMS nor Email should be called
    expect(sendStaffAlertSms).not.toHaveBeenCalled();
    expect(sendAutomationEmail).not.toHaveBeenCalled();
  });

  it('11. In case of No job assignee, falls back to fallback dispatcher and notifies the fallback dispatcher', async () => {
    // Job has no dispatcher or salesperson or visit assignees
    vi.mocked(prisma.job.findFirst).mockResolvedValueOnce({
      id: jobId,
      job_number: 'J00203',
      dispatcher_id: null,
      salesperson_id: null,
      visits: [],
    } as any);

    vi.mocked(prisma.beeSetting.findUnique).mockResolvedValueOnce({
      organization_id: orgId,
      setup_config: {
        taskAssigneeRoles: ['Job Dispatcher'],
        fallbackDispatcherId: fallbackDispatcherId,
        adminWatcherId: 'none',
        alertChannels: ['Text message', 'Email'],
      },
    } as any);

    (vi.mocked(prisma.user.findFirst) as any).mockImplementation(async (query: any) => {
      return { id: fallbackDispatcherId, is_active: true } as any;
    });

    vi.mocked(prisma.taskCategory.findFirst).mockResolvedValueOnce({
      id: 'cat-1',
      name: 'Bee Follow-up',
      organization_id: orgId,
    } as any);

    vi.mocked(prisma.task.create).mockResolvedValueOnce({
      id: 'task-notif-3',
      task_number: 'T00203',
      priority: 'HIGH',
      title: 'Bee Follow-up: Call Back Later - Ian · Job #J00203',
    } as any);

    vi.mocked(prisma.user.findMany).mockResolvedValueOnce([
      {
        id: fallbackDispatcherId,
        first_name: 'Fiona',
        last_name: 'Fallback',
        email: 'fallback@example.com',
        phone: '+15554445555',
      },
    ] as any);

    await BeeService.createTaskFromCall({
      orgId,
      jobId,
      customerId,
      customerName: 'Ian',
      customerPhone: '+15559998888',
      outcome: 'CALLBACK_REQUESTED',
      summary: 'Call back next Tuesday',
    });

    // In-app was not selected in alertChannels
    expect(emit).not.toHaveBeenCalled();

    // SMS sent to fallback dispatcher
    expect(sendStaffAlertSms).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId,
        toE164: '+15554445555',
        body: expect.stringContaining('Bee AI Follow-up Task #T00203: Call Back Later'),
      })
    );

    // Email sent to fallback dispatcher
    expect(sendAutomationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: orgId,
        to: 'fallback@example.com',
        subject: 'Bee Follow-up Task #T00203: Call Back Later - Ian',
      })
    );
  });
});

