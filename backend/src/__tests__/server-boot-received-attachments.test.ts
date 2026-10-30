import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getTenantContext } from '../lib/tenant-context';

/**
 * Server start (src/index.ts), Roles & Permissions PRD 10, slice S10.17: the retry of received mail's attachments is scheduled
 * (every 10 minutes), runs without a tenant of its own (it looks across companies, then works on each message by id), and is not
 * run at boot.
 */

const scheduled: Array<{ expr: string; fn: () => unknown }> = vi.hoisted(() => []);

vi.mock('../instrument', () => ({}));
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn((expr: string, fn: () => unknown) => { scheduled.push({ expr, fn }); }) },
}));
vi.mock('../app', () => ({
  default: { listen: vi.fn((_port: number, _host: string, cb?: () => void) => { cb?.(); return {}; }) },
}));
vi.mock('../services/notifications/invoiceDueCron', () => ({ runInvoiceDueChecks: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/automations/cron', () => ({ runAutomationTick: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/account-status', () => ({ refreshAllAccountStatuses: vi.fn().mockResolvedValue({ orgs: [] }) }));
vi.mock('../services/payment-reconcile', () => ({ runNightlyReconcile: vi.fn().mockResolvedValue({ orgs: [], driftCount: 0, errorCount: 0 }) }));

const tenantSeen: Array<ReturnType<typeof getTenantContext>> = [];
vi.mock('../lib/inbound-attachments', () => ({
  sweepReceivedAttachments: vi.fn(async () => { tenantSeen.push(getTenantContext()); return 0; }),
}));

import { sweepReceivedAttachments } from '../lib/inbound-attachments';

beforeAll(async () => {
  await import('../index.js');
});

describe('server start', () => {
  it('schedules the retry of received attachments every 10 minutes, unscoped, and does not run it at boot', async () => {
    const job = scheduled.find((s) => s.expr === '*/10 * * * *');
    expect(job).toBeDefined();
    expect(sweepReceivedAttachments).not.toHaveBeenCalled();

    await job!.fn();
    await new Promise((r) => setTimeout(r, 20));

    expect(sweepReceivedAttachments).toHaveBeenCalledTimes(1);
    expect(tenantSeen[0]).toMatchObject({ unscoped: true });
  });
});
