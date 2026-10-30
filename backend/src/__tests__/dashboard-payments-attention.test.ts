/**
 * Needs attention: payments that need a person (payments go-live slice 35, repointed by P9). The item is for everyone
 * who may SEE the Payments page (View payments), counts every kind of item the page's Needs attention view holds
 * (the P4 count, privacy applied), opens that page on its attention chip when the caller may open it, and is sent
 * with no link (shown, not clickable) when they may not. It is always the first item.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearTokenCache } from '../middleware/authenticate';
import { mockRoleSwitches } from './helpers';
import { countOpenAttention } from '../services/payment-attention';

// The page's own count (P4) is its own suite's business; here the item must use exactly that number.
vi.mock('../services/payment-attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/payment-attention')>()),
  countOpenAttention: vi.fn(),
}));
const openCount = countOpenAttention as unknown as Mock;
const withOpen = (open: number) => openCount.mockResolvedValue({ open, by_type: {} });

function stubEveryDashboardQuery() {
  (prisma.job.groupBy as Mock).mockResolvedValue([]);
  (prisma.job.count as Mock).mockResolvedValue(0);
  (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
  (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
  (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
  (prisma.lead.findMany as Mock).mockResolvedValue([]);
  (prisma.lead.groupBy as Mock).mockResolvedValue([]);
  (prisma.lead.count as Mock).mockResolvedValue(0);
  (prisma.estimate.findMany as Mock).mockResolvedValue([]);
  (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
  (prisma.user.findMany as Mock).mockResolvedValue([]);
  (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
  (prisma.invoice.findMany as Mock).mockResolvedValue([]);
  (prisma.visit.findMany as Mock).mockResolvedValue([]);
  (prisma.$queryRaw as Mock).mockResolvedValue([]);
  (prisma.job.findMany as Mock).mockResolvedValue([]);
  (prisma.workflowEnrollment.findMany as Mock).mockResolvedValue([]);
}

type Item = { id: string; type: string; severity: string; title: string; meta: string; badge: string; link: string | null };

async function paymentItems(user: 'admin' | 'technician' = 'admin'): Promise<Item[]> {
  mockAuthAs(user);
  if (user === 'admin') mockRoleSwitches(SEES_PAGE);
  const res = await request(app).get('/api/dashboard').set(authHeader(user));
  expect(res.status).toBe(200);
  return (res.body.data.needs_attention as Item[]).filter((a) => a.type === 'payments_attention');
}

const SEES_PAGE = { view_payments: true, show_payments_page: true };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-17T12:00:00Z') });
  vi.clearAllMocks();
  clearTokenCache();
  stubEveryDashboardQuery();
  withOpen(0);
});

afterEach(() => vi.useRealTimers());

describe('GET /api/dashboard needs attention: payments needing attention', () => {
  it('lists one item for a View payments holder, linking to the Payments page on the attention chip', async () => {
    withOpen(3);
    mockAuthAs('admin');
    mockRoleSwitches(SEES_PAGE);
    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    const items = (res.body.data.needs_attention as Item[]).filter((a) => a.type === 'payments_attention');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      severity: 'warning', link: '/payments?tab=payments&chip=attention', badge: '3', title: '3 payments need attention',
      meta: 'Failed payments, refunds, disputes and payouts',
    });
    expect(JSON.stringify(items[0])).not.toMatch(/stripe|settings\/payments/i);
  });

  it('says "payment" for one', async () => {
    withOpen(1);
    expect((await paymentItems())[0].title).toBe('1 payment needs attention');
  });

  it('is absent when nothing is open', async () => {
    expect(await paymentItems()).toHaveLength(0);
  });

  it('shows a failed payout alone (no unapplied money open), which it did not before', async () => {
    // Before P9 the number was the unapplied-capture count only; now it is the page's count of every kind.
    (prisma.unappliedCapture.count as Mock).mockResolvedValue(0);
    openCount.mockResolvedValue({ open: 1, by_type: { PAYOUT_FAILED: 1 } });
    const items = await paymentItems();
    expect(items).toHaveLength(1);
    expect(items[0].badge).toBe('1');
  });

  it('carries exactly the number countOpenAttention returns for the caller, and counts through the caller\'s own request', async () => {
    withOpen(7);
    const items = await paymentItems();
    expect(items[0].badge).toBe('7');
    expect(openCount).toHaveBeenCalledTimes(1);
    expect(openCount.mock.calls[0][0].user.organization_id).toEqual(expect.any(String));
    // The old unapplied-money count is not run here any more.
    expect(prisma.unappliedCapture.count).not.toHaveBeenCalled();
  });

  it('is not shown to, nor counted for, someone without View payments', async () => {
    withOpen(5);
    mockAuthAs('technician');
    mockRoleSwitches({ view_payments: false, show_payments_page: false });
    const res = await request(app).get('/api/dashboard').set(authHeader('technician'));
    expect((res.body.data.needs_attention as Item[]).filter((a) => a.type === 'payments_attention')).toHaveLength(0);
    expect(openCount).not.toHaveBeenCalled();
  });

  it('is clickable for a role holding View payments and Show Payments page, whatever its name', async () => {
    withOpen(2);
    mockAuthAs('technician');
    mockRoleSwitches(SEES_PAGE);
    const res = await request(app).get('/api/dashboard').set(authHeader('technician'));
    const [item] = (res.body.data.needs_attention as Item[]).filter((a) => a.type === 'payments_attention');
    expect(item.link).toBe('/payments?tab=payments&chip=attention');
  });

  it('is shown, and not clickable, to a View payments holder with Show Payments page off', async () => {
    withOpen(2);
    mockAuthAs('technician');
    mockRoleSwitches({ view_payments: true, show_payments_page: false });
    const res = await request(app).get('/api/dashboard').set(authHeader('technician'));
    const [item] = (res.body.data.needs_attention as Item[]).filter((a) => a.type === 'payments_attention');
    expect(item).toMatchObject({ badge: '2' });
    expect(item.link).toBeNull();
  });

  it('is the first item the API returns, ahead of danger items, so the six-row widget always shows it (slice 33b)', async () => {
    withOpen(4);
    (prisma.invoice.findMany as Mock).mockResolvedValue([1, 2, 3].map((n) => ({
      id: `inv-${n}`, invoice_number: `I${n}`, due_date: new Date('2026-06-01T12:00:00Z'), amount_due: 10,
      job: { customer: { first_name: 'A', last_name: 'B', company_name: null } },
    })));
    mockAuthAs('admin');
    mockRoleSwitches(SEES_PAGE);
    const res = await request(app).get('/api/dashboard').set(authHeader('admin'));
    const items = res.body.data.needs_attention as Item[];
    expect(items.filter((a) => a.type === 'overdue_invoice').length).toBeGreaterThan(0);
    expect(items[0].type).toBe('payments_attention');
  });
});
