/* =============================================================================
   Spider switched off while a sweep is running (SPEC-2, D4): the real sweep, with the database,
   the recipient rule, the in-app emit and the email and text senders faked, so the stored switch
   can be flipped at each exact point of an alert.

   An alert re-checks the switch before it claims, after its in-app record is written and before
   the text. No send ever happens before its check. The database test (spider-sweep-db) covers the
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

vi.mock('@prisma/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@prisma/client')>();
  // The sweep's lock is held on a client of its own: this one always gets it.
  class LockClient {
    $transaction(fn: (tx: unknown) => unknown) {
      return fn({ $queryRaw: async () => [{ locked: true }] });
    }
    async $disconnect() {}
  }
  return { ...actual, PrismaClient: LockClient };
});

vi.mock('../../../lib/prisma', () => ({
  prisma: {
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
            watch_all_leads: true,
            selected_lead_ids: [],
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
      findMany: vi.fn(async () =>
        state.leads.map((id) => ({
          id, status: 'NEW', created_at: new Date('2026-09-20T00:00:00.000Z'), contacted_at: null,
          walkthrough_first_booked_at: null, last_visit_completed_at: null, first_estimate_sent_at: null,
          won_at: null, lost_at: null, cancelled_at: null,
        })),
      ),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id, lead_number: `L-${where.id}`, customer_id: 'cust-1', service_request: 'Fix the door',
        commission_owner_id: null, commission_owner: null, lead_assignees: [],
        customer: { first_name: 'Pat', last_name: 'Payer', company_name: null, service_locations: [] },
        service_location: null,
      })),
    },
    spiderAlert: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: { lead_id: string } }) => {
        h.at('claim');
        return { id: `alert-${data.lead_id}` };
      }),
      update: vi.fn(async () => ({})),
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
  resolveSpiderRecipients: vi.fn(async () => [
    { id: 'user-1', first_name: 'Ada', last_name: 'Admin', email: 'ada@example.test', role: 'ADMIN', chosen_as: 'admin', phone: '+16175550101' },
  ]),
}));

vi.mock('../../notifications/notificationService', () => ({
  emit: vi.fn(async () => {
    h.at('emit');
    return ['user-1'];
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
import { emit } from '../../notifications/notificationService';
import { deliverSpiderEmails, deliverSpiderTexts } from '../delivery';
import { runSpiderSweep } from '../sweep';

/** What the alert's History row recorded for its email and text. */
function recordedDelivery() {
  const calls = vi.mocked(prisma.spiderAlert.update).mock.calls as unknown as [{ data: { delivery: Record<string, { outcome: string }>; channels: Record<string, Record<string, unknown>> } }][];
  expect(calls).toHaveLength(1);
  return calls[0]![0].data;
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

  it('with Spider on throughout, each send comes after its check: check, claim, emit, check, email, check, text', async () => {
    const result = await runSpiderSweep(NOW);
    expect(result.alertsSent).toBe(1);
    expect(state.steps).toEqual(['settings', 'check', 'claim', 'emit', 'check', 'email', 'check', 'text']);
  });

  it('off before the claim: nothing is claimed, shown, emailed or texted', async () => {
    state.leads = ['lead-a', 'lead-b'];
    state.flip = { at: 'settings', change: switchOff };

    const result = await runSpiderSweep(NOW);

    expect(result.alertsSent).toBe(0);
    expect(prisma.spiderAlert.create).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(deliverSpiderEmails).not.toHaveBeenCalled();
    expect(deliverSpiderTexts).not.toHaveBeenCalled();
  });

  it('off after the in-app alert is written: that alert is ended at once, and no email or text goes out', async () => {
    state.flip = { at: 'emit', change: switchOff };

    const result = await runSpiderSweep(NOW);

    expect(result.alertsSent).toBe(0);
    expect(state.steps).toEqual(['settings', 'check', 'claim', 'emit', 'check', 'end']);
    expect(vi.mocked(prisma.notificationRecipient.updateMany).mock.calls[0]![0]).toMatchObject({
      where: {
        organization_id: ORG,
        read_at: null,
        notification: { dedup_key: { in: ['spider.alert:alert-lead-a', 'spider.frame:alert-lead-a'] } },
      },
    });
    expect(deliverSpiderEmails).not.toHaveBeenCalled();
    expect(deliverSpiderTexts).not.toHaveBeenCalled();
    const { delivery, channels } = recordedDelivery();
    expect(delivery.email!.outcome).toBe('Email skipped: Spider was switched off');
    expect(delivery.text!.outcome).toBe('Text skipped: Spider was switched off');
    expect(channels.email).toMatchObject({ enabled: true, status: 'SKIPPED', skipped: 1, skip_reason: 'Spider was switched off' });
    expect(channels.sms).toMatchObject({ enabled: true, status: 'SKIPPED', skipped: 1, skip_reason: 'Spider was switched off' });
  });

  it('off after the email: the email went once, the text is skipped and recorded, and the alert is ended', async () => {
    state.flip = { at: 'email', change: switchOff };

    const result = await runSpiderSweep(NOW);

    expect(result.alertsSent).toBe(0);
    expect(state.steps).toEqual(['settings', 'check', 'claim', 'emit', 'check', 'email', 'check', 'end']);
    expect(deliverSpiderEmails).toHaveBeenCalledTimes(1);
    expect(deliverSpiderTexts).not.toHaveBeenCalled();
    const { delivery, channels } = recordedDelivery();
    expect(delivery.email!.outcome).toBe('Email sent');
    expect(delivery.text!.outcome).toBe('Text skipped: Spider was switched off');
    expect(channels.sms).toMatchObject({ enabled: true, status: 'SKIPPED', skip_reason: 'Spider was switched off' });
  });

  it('switched off and on again in between: a new switched-on period, so the old run stops', async () => {
    state.leads = ['lead-a', 'lead-b'];
    state.flip = {
      at: 'email',
      change: () => {
        state.stored = { is_active: true, activated_at: new Date(ACTIVATED.getTime() + 60_000) };
      },
    };

    await runSpiderSweep(NOW);

    expect(prisma.spiderAlert.create).toHaveBeenCalledTimes(1);
    expect(deliverSpiderTexts).not.toHaveBeenCalled();
  });

  // A check that cannot read the switch is not a switch-off: the alert carries on as it would have
  // before the checks existed, and its History row is still written.
  describe('when an on/off check itself fails', () => {
    /** What was logged as an error, joined. */
    const errors = () => vi.mocked(logger.error).mock.calls.map((c) => c.map(String).join(' ')).join('\n');

    beforeEach(() => {
      vi.spyOn(logger, 'error').mockImplementation(() => logger);
    });

    it('after the in-app alert: the email and text still go, the alert stays open, delivery is recorded and the failure logged', async () => {
      state.failCheck = 2;

      const result = await runSpiderSweep(NOW);

      expect(result.alertsSent).toBe(1);
      expect(state.steps).toEqual(['settings', 'check', 'claim', 'emit', 'check', 'email', 'check', 'text']);
      expect(prisma.notificationRecipient.updateMany).not.toHaveBeenCalled();
      const { delivery } = recordedDelivery();
      expect(delivery.email!.outcome).toBe('Email sent');
      expect(delivery.text!.outcome).toBe('Text message sent');
      expect(errors()).toContain(`org ${ORG}`);
      expect(errors()).toContain('alert-lead-a');
      expect(errors()).toContain('PoolTimeoutError');
      expect(errors()).not.toContain('ada@example.test');
    });

    it('after the email: the text still goes, delivery is recorded and the failure logged', async () => {
      state.failCheck = 3;

      const result = await runSpiderSweep(NOW);

      expect(result.alertsSent).toBe(1);
      expect(state.steps).toEqual(['settings', 'check', 'claim', 'emit', 'check', 'email', 'check', 'text']);
      expect(deliverSpiderEmails).toHaveBeenCalledTimes(1);
      expect(deliverSpiderTexts).toHaveBeenCalledTimes(1);
      const { delivery } = recordedDelivery();
      expect(delivery.email!.outcome).toBe('Email sent');
      expect(delivery.text!.outcome).toBe('Text message sent');
      expect(errors()).toContain('alert-lead-a');
      expect(errors()).toContain('PoolTimeoutError');
      expect(errors()).not.toContain('ada@example.test');
    });
  });
});
