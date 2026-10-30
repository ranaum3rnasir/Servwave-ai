import { describe, it, expect, beforeAll, vi } from 'vitest';
import { runNightlyReconcile } from '../services/payment-reconcile';
import { getTenantContext } from '../lib/tenant-context';

/**
 * Server start (src/index.ts), payments go-live slice 37: the nightly reconcile is scheduled, in
 * UTC, after the fee sweep (07:00) and the account-status refresh (07:30) it reads the results of,
 * and runs without a tenant of its own (it lists the orgs, then enters each org's context itself).
 */

const scheduled: Array<{ expr: string; fn: () => unknown; options?: { timezone?: string } }> = vi.hoisted(() => []);

vi.mock('../instrument', () => ({}));
vi.mock('node-cron', () => ({
  default: { schedule: vi.fn((expr: string, fn: () => unknown, options?: { timezone?: string }) => { scheduled.push({ expr, fn, options }); }) },
}));
vi.mock('../app', () => ({
  default: { listen: vi.fn((_port: number, _host: string, cb?: () => void) => { cb?.(); return {}; }) },
}));
vi.mock('../services/notifications/invoiceDueCron', () => ({ runInvoiceDueChecks: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../services/automations/cron', () => ({ runAutomationTick: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/account-status', () => ({ refreshAllAccountStatuses: vi.fn().mockResolvedValue({ orgs: [] }) }));

const tenantSeen: Array<ReturnType<typeof getTenantContext>> = [];
vi.mock('../services/payment-reconcile', () => ({
  runNightlyReconcile: vi.fn(async () => { tenantSeen.push(getTenantContext()); return { orgs: [], driftCount: 0, errorCount: 0 }; }),
}));

beforeAll(async () => {
  await import('../index.js');
});

describe('server start', () => {
  it('schedules the nightly payment reconcile at 08:07 UTC, unscoped, and does not run it at boot', async () => {
    const job = scheduled.find((s) => s.expr === '7 8 * * *');
    expect(job).toBeDefined();
    expect(job!.options).toEqual({ timezone: 'UTC' });
    expect(runNightlyReconcile).not.toHaveBeenCalled();

    await job!.fn();
    await new Promise((r) => setTimeout(r, 20));

    expect(runNightlyReconcile).toHaveBeenCalledTimes(1);
    expect(tenantSeen[0]).toMatchObject({ unscoped: true });
  });
});
