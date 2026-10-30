/* =============================================================================
   Roles & Permissions (scenario pass 2, second re-check): the live-update pings must not hold the request open.

   The alert writer (`emit`) used to end with `await publishNotificationsChanged(...)`: one vendor round trip per
   recipient, about 0.08 s each on the hosted service, so Reopen (91 people) and Complete (about 105) answered after 7
   to 12 seconds with nobody listening to the pings. The alert rows are what a person finds in the bell; the ping is
   best-effort and runs after the answer.

   Seam: `emit()` as the alert writer's callers use it, with the fetch to the live service stubbed. The
   module under test is loaded fresh for every case, so a ping stuck in one case never fills the next one's queue.
   ========================================================================== */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/notifications/filterByAccess', () => ({
  filterRecipientsByAccess: vi.fn((_t: string, _i: string, ids: string[]) => Promise.resolve(ids)),
}));

type Stub = { send: ReturnType<typeof vi.fn> };

async function load() {
  vi.resetModules();
  const { prisma } = await import('../lib/prisma.js');
  const { logger } = await import('../lib/logger.js');
  const { emit } = await import('../services/notifications/notificationService.js');
  const { flushRealtimePublishes } = await import('../services/notifications/realtimePublish.js');
  const warn = vi.spyOn(logger, 'warn').mockImplementation((() => logger) as never);
  const send = vi.fn();
  vi.stubGlobal('fetch', send);
  (prisma.notification.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (prisma.notification.create as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'n1' });
  return { prisma, emit, flushRealtimePublishes, warn, stub: { send } as Stub };
}

function reopenAlert(emit: Awaited<ReturnType<typeof load>>['emit'], lanes = { lane_one_ids: ['sales1', 'admin1'], lane_two_ids: ['disp1'] }) {
  return emit({
    verb: 'estimate.approved', organizationId: 'org1', actorId: 'sales1',
    object: { type: 'ESTIMATE', id: 'e1', label: 'E0042' },
    entity: { commission_owner_id: 'sales1', ...lanes, copy_ids: [] },
    data: { customer_name: 'Customer' },
  });
}

let ctx: Awaited<ReturnType<typeof load>>;
beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  ctx = await load();
  (ctx.prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
    { id: 'admin1', role: 'ADMIN' }, { id: 'disp1', role: 'DISPATCHER' }, { id: 'sales1', role: 'SALES' },
  ]);
});

describe('emit — the live-update pings run after the alert is written', () => {
  it('resolves and has written the alert rows while a ping never answers', async () => {
    ctx.stub.send.mockImplementation(() => new Promise<never>(() => {}));

    // Raced against a short timer: a ping waited for would hold emit() for the whole 15 s give-up time, which a test
    // timeout longer than that would sit through and pass.
    let stopWaiting: () => void = () => {};
    const tooSlow = new Promise<'waited'>((resolve) => {
      const timer = setTimeout(() => resolve('waited'), 1_500);
      stopWaiting = () => clearTimeout(timer);
    });
    const outcome = await Promise.race([reopenAlert(ctx.emit), tooSlow]);
    stopWaiting();
    if (outcome === 'waited') throw new Error('emit() was still waiting for a ping after 1.5 s');
    const notified = outcome;

    expect([...notified].sort()).toEqual(['admin1', 'disp1']);
    expect(ctx.prisma.notification.create).toHaveBeenCalledOnce();
    const rows = (ctx.prisma.notificationRecipient.createMany as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(rows.map((r: { recipient_id: string }) => r.recipient_id).sort()).toEqual(['admin1', 'disp1']);
  });

  it('resolves, throws nothing and logs one warning when the ping is refused', async () => {
    (ctx.prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 'disp1', role: 'DISPATCHER' }]);
    ctx.stub.send.mockRejectedValue(new Error('vendor down'));

    await expect(reopenAlert(ctx.emit, { lane_one_ids: [], lane_two_ids: ['disp1'] })).resolves.toEqual(['disp1']);
    await ctx.flushRealtimePublishes();

    expect(ctx.stub.send).toHaveBeenCalledOnce();
    expect(ctx.warn).toHaveBeenCalledOnce();
    expect(String(ctx.warn.mock.calls[0]![0])).toContain('realtimePublish');
  });

  it('still pings every recipient exactly once, once the background work has drained', async () => {
    ctx.stub.send.mockResolvedValue(new Response(null, { status: 202 }));

    await reopenAlert(ctx.emit);
    await ctx.flushRealtimePublishes();

    const messages = ctx.stub.send.mock.calls.flatMap((c) => (JSON.parse((c[1] as { body: string }).body) as { messages: Array<{ topic: string }> }).messages);
    expect(messages.map((m) => m.topic).sort()).toEqual(['org:org1:user:admin1', 'org:org1:user:disp1']);
    expect(ctx.stub.send).toHaveBeenCalledOnce();
  });
});
