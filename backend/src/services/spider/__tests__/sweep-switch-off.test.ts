/* =============================================================================
   Spider switched off while a sweep is running (SPEC-2, D4, and Ran's 2026-11-04 ruling "Next run"): the real
   sweep, with the database, the recipient rule, the in-app emit and the email and text senders faked, so the stored
   switch can be flipped at each exact point of an alert.

   The run reads the switch twice for its per-lead alerts, however many it sends: once just before its claims (the
   run's claims go in with one insert, #2990), so a company switched off before the run claims and sends nothing; and
   once at the end step, after the run's bell records are written (emitMany, #2990), so a switch-off during the run
   ends those records at once. A switch-off during the run does not stop the run's emails and texts: it takes effect
   from the next run (at most about 45 s, up to 100 alerts, #2991). The database test (spider-sweep-db) covers the
   same rule end to end; this file pins the order of the steps.
   ========================================================================== */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const ORG = '00000000-0000-4000-8000-000000000001';
const ACTIVATED = new Date('2026-09-01T00:00:00.000Z');
const NOW = new Date('2026-10-01T12:00:00.000Z');

const h = vi.hoisted(() => {
  const state = {
    stored: { is_active: true, activated_at: null as Date | null },
    steps: [] as string[],
    settingsReads: 0,
    /** Runs once, at the named step, to change the stored switch. */
    flip: null as null | { at: string; change: () => void },
    leads: [] as string[],
    /** The on/off check (1 = the first after the run's settings read) whose read fails. */
    failCheck: null as number | null,
  };
  const at = (step: string) => {
    state.steps.push(step);
    if (state.flip?.at === step) {
      const { change } = state.flip;
      state.flip = null;
      change();
    }
  };
  return { state, at };
});

const { state } = h;

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    // The sweep's lease (sweepLease.ts): the claim always gets it, and every renewal and the release find it. Any other
    // raw read is the ending step's page of unread Spider records (#2992): none open.
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => ([...sql].join('').includes('spider_sweep_leases') ? [{ claimed: true }] : [])),
    $executeRaw: vi.fn(async () => 1),
    spiderSettings: {
      findMany: vi.fn(async () => [
        { organization_id: ORG, organization: { is_demo: true, plan: 'SCALE', trial_ends_at: null, feature_overrides: {} } },
      ]),
      findUnique: vi.fn(async () => {
        state.settingsReads += 1;
        // The run's own settings read comes first; every later read is an on/off check.
        if (state.settingsReads === 1) {
          const settings = {
            organization_id: ORG,
            is_active: state.stored.is_active,
            activated_at: state.stored.activated_at,
            status_limits: {
              NEW: { enabled: true, value: 1, unit: 'HOUR' },
              CONTACTED: { enabled: false, value: 1, unit: 'DAY' },
              WALKTHROUGH_COMPLETED: { enabled: false, value: 1, unit: 'DAY' },
            },
            channels: { in_app: true, red_frame: true, email: true, text: true },
            recipients: { roles: ['ADMIN'], user_ids: [], lead_owner: false },
            excluded_lead_ids: [],
          };
          h.at('settings');
          return settings;
        }
        const answer = { ...state.stored };
        h.at('check');
        if (state.settingsReads - 1 === state.failCheck) {
          throw Object.assign(new Error('pool timed out holding lead-a for ada@example.test'), { name: 'PoolTimeoutError' });
        }
        return answer;
      }),
    },
    lead: {
      // Two reads: the stage visits (the lead's stage timestamps), then every alert's content at once (#2990).
      findMany: vi.fn(async ({ select }: { select: Record<string, unknown> }) =>
        select.lead_number
          ? state.leads.map((id) => ({
              id, lead_number: `L-${id}`, customer_id: 'cust-1', service_request: 'Fix the door',
              commission_owner_id: null, commission_owner: null, lead_assignees: [],
              customer: { first_name: 'Pat', last_name: 'Payer', company_name: null, service_locations: [] },
              service_location: null,
            }))
          : state.leads.map((id) => ({
              id, status: 'NEW', created_at: new Date('2026-09-20T00:00:00.000Z'), contacted_at: null,
              walkthrough_first_booked_at: null, last_visit_completed_at: null, first_estimate_sent_at: null,
              won_at: null, lost_at: null, cancelled_at: null,
            })),
      ),
    },
    spiderAlert: {
      findMany: vi.fn(async () => []),
      // The run's claims, in one insert (#2990): every one is this run's.
      createManyAndReturn: vi.fn(async ({ data }: { data: { lead_id: string }[] }) => {
        h.at('claim');
        return data.map((d) => ({ id: `alert-${d.lead_id}`, lead_id: d.lead_id }));
      }),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
    },
    // The people of the run's alerts, stored once per distinct list (#3107): none stored yet, so each list is written.
    spiderRecipientSet: {
      findMany: vi.fn(async () => []),
      createManyAndReturn: vi.fn(async ({ data }: { data: { id: string; hash: string }[] }) => data.map((d) => ({ id: d.id, hash: d.hash }))),
    },
    notificationRecipient: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => {
        h.at('end');
        return { count: 1 };
      }),
      createMany: vi.fn(async () => ({ count: 1 })),
    },
    notification: { create: vi.fn(async () => ({ id: 'n-1' })) },
  },
}));

vi.mock('../recipients', () => ({
  // The run's one batched lookup: every lead it may alert gets the same one person.
  resolveSpiderRecipientsForLeads: vi.fn(async (_db: unknown, { leads }: { leads: { id: string }[] }) => new Map(leads.map((l) => [l.id, [
    { id: 'user-1', first_name: 'Ada', last_name: 'Admin', email: 'ada@example.test', role: 'ADMIN', chosen_as: 'admin', phone: '+16175550101' },
  ]]))),
}));

vi.mock('../../notifications/notificationService', () => ({
  // The run's in-app alerts, written in one step at its end (#2990): every one reaches the one person.
  emitMany: vi.fn(async (list: unknown[]) => {
    h.at('emit');
    return list.map(() => ['user-1']);
  }),
}));

vi.mock('../delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../delivery')>();
  const sent = (outcome: string) => ({
    outcome,
    recipients: [{ user_id: 'user-1', outcome }],
    results: [{ user_id: 'user-1', result: 'sent' as const, reason: null }],
  });
  return {
    ...actual,
    deliverSpiderEmails: vi.fn(async () => {
      h.at('email');
      return sent('Email sent');
    }),
    deliverSpiderTexts: vi.fn(async () => {
      h.at('text');
      return sent('Text message sent');
    }),
  };
});

import { prisma } from '../../../lib/prisma';
import { logger } from '../../../lib/logger';
import { emitMany } from '../../notifications/notificationService';
import { deliverSpiderEmails, deliverSpiderTexts } from '../delivery';
import { runSpiderSweep } from '../sweep';

/**
 * What the alert's History row recorded for its email and text: the run's one delivery-record write (#2990,
 * alertLog.ts), whose bound values are each row's id, delivery and channels, then the company.
 */
function recordedDelivery() {
  const writes = vi.mocked(prisma.$executeRaw).mock.calls
    .map(([q]) => q as unknown as { sql?: string; values?: unknown[] })
    .filter((q) => typeof q.sql === 'string' && q.sql.includes('SET channels'));
  expect(writes).toHaveLength(1);
  const values = writes[0]!.values!;
  expect(values).toHaveLength(4);
  expect(values[0]).toBe('alert-lead-a');
  expect(values[3]).toBe(ORG);
  return {
    delivery: JSON.parse(values[1] as string) as Record<string, { outcome: string }>,
    channels: JSON.parse(values[2] as string) as Record<string, Record<string, unknown>>,
  };
}

const switchOff = () => {
  state.stored = { ...state.stored, is_active: false };
};

describe('Spider switched off during a sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.stored = { is_active: true, activated_at: ACTIVATED };
    state.steps = [];
    state.settingsReads = 0;
    state.flip = null;
    state.leads = ['lead-a'];
    state.failCheck = null;
  });

  /** The run's bell records were ended for exactly these alerts, by the end step's one write. */
  const expectEnded = (alertIds: string[]) => {
    expect(prisma.notificationRecipient.updateMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.notificationRecipient.updateMany).mock.calls[0]![0]).toMatchObject({
      where: {
        organization_id: ORG,
        read_at: null,
        notification: { dedup_key: { in: alertIds.flatMap((id) => [`spider.alert:${id}`, `spider.frame:${id}`]) } },
      },
    });
  };

  it('with Spider on throughout: check, claim, email, text; the bell record at the end, checked again', async () => {
    const result = await runSpiderSweep(NOW);
    expect(result.alertsSent).toBe(1);
    expect(state.steps).toEqual(['settings', 'check', 'claim', 'email', 'text', 'emit', 'check']);
    expect(prisma.notificationRecipient.updateMany).not.toHaveBeenCalled();
  });

  it('the switch is read twice for the per-lead alerts however many there are: before the claims and after the records', async () => {
    state.leads = ['lead-a', 'lead-b', 'lead-c'];
    const result = await runSpiderSweep(NOW);
    expect(result.alertsSent).toBe(3);
    expect(state.steps).toEqual(['settings', 'check', 'claim', 'email', 'text', 'email', 'text', 'email', 'text', 'emit', 'check']);
    // The run's own settings read, then the two checks.
    expect(state.settingsReads).toBe(3);
  });

  it('off before the run claims (the company switched off before the run): nothing is claimed, shown, emailed or texted', async () => {
    state.leads = ['lead-a', 'lead-b'];
    state.flip = { at: 'settings', change: switchOff };

    const result = await runSpiderSweep(NOW);

    expect(result.alertsSent).toBe(0);
    expect(prisma.spiderAlert.createManyAndReturn).not.toHaveBeenCalled();
    expect(emitMany).not.toHaveBeenCalled();
    expect(deliverSpiderEmails).not.toHaveBeenCalled();
    expect(deliverSpiderTexts).not.toHaveBeenCalled();
  });

  it('off after the claim, before the email: the alert still goes out in full (next run), and its bell record is ended at once', async () => {
    state.flip = { at: 'claim', change: switchOff };

    const result = await runSpiderSweep(NOW);

    expect(result.alertsSent).toBe(1);
    expect(state.steps).toEqual(['settings', 'check', 'claim', 'email', 'text', 'emit', 'check', 'end']);
    expect(deliverSpiderEmails).toHaveBeenCalledTimes(1);
    expect(deliverSpiderTexts).toHaveBeenCalledTimes(1);
    expectEnded(['alert-lead-a']);
    const { delivery, channels } = recordedDelivery();
    expect(delivery.in_app!.outcome).toBe('Shown in the app');
    expect(delivery.email!.outcome).toBe('Email sent');
    expect(delivery.text!.outcome).toBe('Text message sent');
    expect(channels.email).toMatchObject({ enabled: true, status: 'SENT', sent: 1 });
    expect(channels.sms).toMatchObject({ enabled: true, status: 'SENT', sent: 1 });
  });

  it('off after the email: the text still goes (next run), and the bell record is ended at once', async () => {
    state.flip = { at: 'email', change: switchOff };

    const result = await runSpiderSweep(NOW);

    expect(result.alertsSent).toBe(1);
    expect(state.steps).toEqual(['settings', 'check', 'claim', 'email', 'text', 'emit', 'check', 'end']);
    expect(deliverSpiderEmails).toHaveBeenCalledTimes(1);
    expect(deliverSpiderTexts).toHaveBeenCalledTimes(1);
    expectEnded(['alert-lead-a']);
    const { delivery, channels } = recordedDelivery();
    expect(delivery.email!.outcome).toBe('Email sent');
    expect(delivery.text!.outcome).toBe('Text message sent');
    expect(channels.sms).toMatchObject({ enabled: true, status: 'SENT' });
  });

  it('off after the text, before the run writes the bell records: the check after that write ends them', async () => {
    state.flip = { at: 'text', change: switchOff };

    const result = await runSpiderSweep(NOW);

    // The alert went out in full; only its bell record could still be open, and it is ended at once.
    expect(result.alertsSent).toBe(1);
    expect(state.steps).toEqual(['settings', 'check', 'claim', 'email', 'text', 'emit', 'check', 'end']);
    expectEnded(['alert-lead-a']);
    const { delivery } = recordedDelivery();
    expect(delivery.email!.outcome).toBe('Email sent');
    expect(delivery.text!.outcome).toBe('Text message sent');
  });

  it('switched off and on again during the run (a new switched-on period): the run still sends its claimed alerts, and ends their records', async () => {
    state.leads = ['lead-a', 'lead-b'];
    state.flip = {
      at: 'email',
      change: () => {
        state.stored = { is_active: true, activated_at: new Date(ACTIVATED.getTime() + 60_000) };
      },
    };

    const result = await runSpiderSweep(NOW);

    // Both visits were claimed in the run's one insert and both go out: the change takes effect from the next run.
    expect(result.alertsSent).toBe(2);
    expect(prisma.spiderAlert.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(state.steps).toEqual(['settings', 'check', 'claim', 'email', 'text', 'email', 'text', 'emit', 'check', 'end']);
    expect(prisma.spiderAlert.deleteMany).not.toHaveBeenCalled();
    expect(deliverSpiderEmails).toHaveBeenCalledTimes(2);
    expect(deliverSpiderTexts).toHaveBeenCalledTimes(2);
    // Both bell records are written, then ended: the run's period is no longer the switched-on one.
    expect(vi.mocked(emitMany).mock.calls[0]![0]).toHaveLength(2);
    expectEnded(['alert-lead-a', 'alert-lead-b']);
  });

  // A check that cannot read the switch is not a switch-off: the alert carries on, and its History row is still written.
  describe('when the end step\'s switch check itself fails', () => {
    /** What was logged as an error, joined. */
    const errors = () => vi.mocked(logger.error).mock.calls.map((c) => c.map(String).join(' ')).join('\n');

    beforeEach(() => {
      vi.spyOn(logger, 'error').mockImplementation(() => logger);
    });

    it('after the run writes its bell records: they stay open, delivery is recorded and the failure logged', async () => {
      // Check 1 is the one before the claims; check 2 is the end step's.
      state.failCheck = 2;

      const result = await runSpiderSweep(NOW);

      expect(result.alertsSent).toBe(1);
      expect(state.steps).toEqual(['settings', 'check', 'claim', 'email', 'text', 'emit', 'check']);
      expect(prisma.notificationRecipient.updateMany).not.toHaveBeenCalled();
      const { delivery } = recordedDelivery();
      expect(delivery.in_app!.outcome).toBe('Shown in the app');
      expect(delivery.email!.outcome).toBe('Email sent');
      expect(delivery.text!.outcome).toBe('Text message sent');
      expect(errors()).toContain(`org ${ORG}`);
      expect(errors()).toContain('alert-lead-a');
      expect(errors()).toContain('PoolTimeoutError');
      expect(errors()).not.toContain('ada@example.test');
    });
  });
});
