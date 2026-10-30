/* =============================================================================
   Payments go-live slice 10 - account events through the reconciler's decide step.

   account.updated: the processor's answer about the account (read back on the event, never taken
   from its payload) decides the org's stored status and its accepted methods. CARD is there while
   the card capability is active, ACH while the bank-debit capability is; each leaves when lost.
   Requirements due or a paused account tell the owner. account.application.deauthorized
   disconnects the org: it can no longer take payments, and the owner is told.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import { decide, decideAccountStatusSync, type AccountEvent, type AccountSnapshot, type LedgerAction } from '../decide';
import { decideAccountStatus } from '../../../lib/account-status';

const ORG = 'org_1';
const ACCT = 'acct_1';

function accountEvent(type: AccountEvent['type'] = 'account.updated', id = 'evt_acct_1'): AccountEvent {
  return { id, type, account: ACCT, data: { object: { id: ACCT, object: 'account' } } };
}

/** The processor's account, as retrieved at the pinned API version. */
function processorAccount(over: {
  card?: string; ach?: string; charges?: boolean; payouts?: boolean; due?: string[]; disabled?: string | null; details?: boolean;
} = {}): Stripe.Account {
  return {
    id: ACCT, object: 'account',
    charges_enabled: over.charges ?? true, payouts_enabled: over.payouts ?? true, details_submitted: over.details ?? true,
    capabilities: {
      ...(over.card !== undefined ? { card_payments: over.card } : { card_payments: 'active' }),
      ...(over.ach !== undefined ? { us_bank_account_ach_payments: over.ach } : {}),
      transfers: 'active',
    },
    requirements: { currently_due: over.due ?? [], disabled_reason: over.disabled ?? null },
  } as unknown as Stripe.Account;
}

function snapshot(
  account: Stripe.Account | { error: unknown },
  stored: Partial<AccountSnapshot['stored']> = {},
): AccountSnapshot {
  return {
    eventAlreadyProcessed: false,
    organizationId: ORG,
    accountId: ACCT,
    stored: { acceptedMethods: [], chargesEnabled: false, payoutsEnabled: false, ...stored },
    status: decideAccountStatus('error' in account ? account : { account }, { testMode: true }),
  };
}

const statusUpdate = (actions: LedgerAction[]) =>
  actions.find((a): a is Extract<LedgerAction, { type: 'update_account_status' }> => a.type === 'update_account_status');

describe('decide: account.updated -> accepted methods', () => {
  it('the card capability active adds CARD, after the methods the owner chose', () => {
    const actions = decide(accountEvent(), snapshot(processorAccount({ card: 'active' }), { acceptedMethods: ['CHECK', 'CASH'] }));

    expect(statusUpdate(actions)).toMatchObject({
      organizationId: ORG, accountId: ACCT, acceptedMethods: ['CHECK', 'CASH', 'CARD'],
    });
  });

  it('the card capability lost removes CARD; the methods the owner chose stay in order', () => {
    const actions = decide(accountEvent(), snapshot(processorAccount({ card: 'inactive' }), { acceptedMethods: ['CHECK', 'CARD', 'CASH'], chargesEnabled: true }));

    expect(statusUpdate(actions)?.acceptedMethods).toEqual(['CHECK', 'CASH']);
  });

  it('an account that can no longer take charges loses CARD even while the capability still reads active', () => {
    const actions = decide(accountEvent(), snapshot(processorAccount({ card: 'active', charges: false, disabled: 'requirements.past_due' }), { acceptedMethods: ['CARD'], chargesEnabled: true }));

    expect(statusUpdate(actions)).toMatchObject({ flags: { stripe_charges_enabled: false }, acceptedMethods: [] });
  });

  it('the bank-debit capability active adds ACH; lost, it removes ACH', () => {
    const on = decide(accountEvent(), snapshot(processorAccount({ ach: 'active' }), { acceptedMethods: ['CARD'] }));
    expect(statusUpdate(on)?.acceptedMethods).toEqual(['CARD', 'ACH']);

    const off = decide(accountEvent(), snapshot(processorAccount({ ach: 'inactive' }), { acceptedMethods: ['CARD', 'ACH'] }));
    expect(statusUpdate(off)?.acceptedMethods).toEqual(['CARD']);
  });

  it('an account that can no longer take charges loses ACH too, even while the bank-debit capability still reads active', () => {
    const actions = decide(accountEvent(), snapshot(processorAccount({ ach: 'active', charges: false, disabled: 'requirements.past_due' }), { acceptedMethods: ['CHECK', 'ACH'] }));

    expect(statusUpdate(actions)?.acceptedMethods).toEqual(['CHECK']);
  });

  it('both capabilities turning active add CARD then ACH; both lost remove both', () => {
    const on = decide(accountEvent(), snapshot(processorAccount({ card: 'active', ach: 'active' }), { acceptedMethods: ['ZELLE'] }));
    expect(statusUpdate(on)?.acceptedMethods).toEqual(['ZELLE', 'CARD', 'ACH']);

    const off = decide(accountEvent(), snapshot(processorAccount({ card: 'inactive', ach: 'pending', charges: false }), { acceptedMethods: ['CARD', 'ZELLE', 'ACH'] }));
    expect(statusUpdate(off)?.acceptedMethods).toEqual(['ZELLE']);
  });

  it('nothing to change in the methods leaves them unwritten (null), while the status is still stored', () => {
    const actions = decide(accountEvent(), snapshot(processorAccount({ card: 'active', ach: 'active' }), { acceptedMethods: ['CARD', 'ACH'] }));

    expect(statusUpdate(actions)).toMatchObject({
      flags: { stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_details_submitted: true },
      acceptedMethods: null,
    });
  });

  it('an account the processor answers is not readable fails closed: cards off, CARD and ACH removed', () => {
    const accountInvalid = Object.assign(new Error('no access to account'), { code: 'account_invalid' });
    const actions = decide(accountEvent(), snapshot({ error: accountInvalid }, { acceptedMethods: ['CHECK', 'CARD', 'ACH'], chargesEnabled: true }));

    expect(statusUpdate(actions)).toMatchObject({
      flags: { stripe_charges_enabled: false, stripe_payouts_enabled: false },
      acceptedMethods: ['CHECK'],
    });
  });

  it('a replayed event changes nothing, where its first delivery stored the status and added CARD', () => {
    const first = snapshot(processorAccount(), { acceptedMethods: [] });
    expect(statusUpdate(decide(accountEvent(), first))?.acceptedMethods).toEqual(['CARD']);

    expect(decide(accountEvent(), { ...first, eventAlreadyProcessed: true })).toEqual([]);
  });
});

const notices = (actions: LedgerAction[]) =>
  actions.filter((a): a is Extract<LedgerAction, { type: 'notify_account' }> => a.type === 'notify_account');

describe('decide: account.updated -> what the owner hears', () => {
  it('requirements due: an action-needed notice, once per account and set of requirements, that also emails the admins', () => {
    const actions = decide(accountEvent(), snapshot(
      processorAccount({ due: ['individual.verification.document', 'external_account'] }),
      { acceptedMethods: ['CARD'], chargesEnabled: true, payoutsEnabled: true },
    ));

    expect(notices(actions)).toEqual([{
      type: 'notify_account', verb: 'billing.payments_action_needed', organizationId: ORG, accountId: ACCT,
      dedup: `action:${ACCT}:external_account,individual.verification.document`, emailAdmins: true,
      requirements: ['external_account', 'individual.verification.document'],
    }]);
  });

  it('nothing due and nothing paused: the status is stored, and the owner hears nothing', () => {
    const actions = decide(accountEvent(), snapshot(processorAccount(), { acceptedMethods: ['CARD'], chargesEnabled: true, payoutsEnabled: true }));

    expect(statusUpdate(actions)).toMatchObject({ flags: { stripe_requirements_due: [], stripe_disabled_reason: null } });
    expect(notices(actions)).toEqual([]);
  });

  it('a paused account: a paused notice keyed on the reason, that also emails the admins', () => {
    const actions = decide(accountEvent(), snapshot(
      processorAccount({ charges: false, payouts: false, disabled: 'requirements.past_due' }),
      { acceptedMethods: ['CARD'], chargesEnabled: true, payoutsEnabled: true },
    ));

    expect(notices(actions)).toEqual([{
      type: 'notify_account', verb: 'billing.payments_paused', organizationId: ORG, accountId: ACCT,
      dedup: `paused:${ACCT}:requirements.past_due`, emailAdmins: true,
    }]);
  });

  it('card payments and payouts turning on: one activation notice each, no email', () => {
    const actions = decide(accountEvent(), snapshot(processorAccount(), { chargesEnabled: false, payoutsEnabled: false }));

    expect(notices(actions)).toEqual([
      { type: 'notify_account', verb: 'billing.payments_activated', organizationId: ORG, accountId: ACCT, dedup: `activated:${ACCT}`, emailAdmins: false },
      { type: 'notify_account', verb: 'billing.payouts_activated', organizationId: ORG, accountId: ACCT, dedup: `payouts:${ACCT}`, emailAdmins: false },
    ]);
  });

  it('notices come after the status they describe is stored', () => {
    const actions = decide(accountEvent(), snapshot(processorAccount({ due: ['external_account'] })));

    expect(actions[0].type).toBe('update_account_status');
    expect(actions.slice(1).every((a) => a.type === 'notify_account')).toBe(true);
  });
});

describe('decide: account.application.deauthorized -> disconnect', () => {
  const deauthSnapshot = (stored: Partial<AccountSnapshot['stored']> = {}): AccountSnapshot => ({
    eventAlreadyProcessed: false, organizationId: ORG, accountId: ACCT,
    stored: { acceptedMethods: ['CHECK', 'CARD', 'ACH'], chargesEnabled: true, payoutsEnabled: true, ...stored },
    status: null,
  });

  it('marks the org disconnected: it cannot take payments, CARD and ACH leave, the methods the owner chose stay', () => {
    const actions = decide(accountEvent('account.application.deauthorized'), deauthSnapshot());

    expect(statusUpdate(actions)).toEqual({
      type: 'update_account_status', organizationId: ORG, accountId: ACCT,
      flags: {
        stripe_charges_enabled: false, stripe_payouts_enabled: false, stripe_details_submitted: false,
        stripe_requirements_due: [], stripe_disabled_reason: 'deauthorized',
      },
      acceptedMethods: ['CHECK'],
    });
  });

  it('tells the owner, once per account', () => {
    const actions = decide(accountEvent('account.application.deauthorized'), deauthSnapshot());

    expect(notices(actions)).toEqual([{
      type: 'notify_account', verb: 'billing.payments_disconnected', organizationId: ORG, accountId: ACCT,
      dedup: `disconnected:${ACCT}`, emailAdmins: false,
    }]);
  });

  it('a replayed deauthorization changes nothing, where its first delivery disconnected the org', () => {
    const event = accountEvent('account.application.deauthorized');
    expect(statusUpdate(decide(event, deauthSnapshot()))?.flags).toMatchObject({ stripe_disabled_reason: 'deauthorized' });

    expect(decide(event, { ...deauthSnapshot(), eventAlreadyProcessed: true })).toEqual([]);
  });
});

// Payments go-live slice 32 (conductor ruling 2026-10-08, from the slice 10 sign-up): a first-time
// owner went through onboarding and got ten "needs one more thing" and two "paused" interrupts,
// with admin emails, because every onboarding step changes the requirements and each set is a new
// notice. Until the account has details submitted the owner is inside onboarding and hears nothing
// about requirements; after that, one notice per set of requirements, and only for what the owner
// can act on.
describe('decide: account.updated -> no requirement notices while the owner is still onboarding', () => {
  const stored = { acceptedMethods: [] as never[], chargesEnabled: false, payoutsEnabled: false };
  const stepsOfOnboarding = [
    ['business_profile.url', 'external_account', 'individual.verification.document'],
    ['external_account', 'individual.verification.document'],
    ['individual.verification.document'],
  ];

  it('a sequence of onboarding steps (details not yet submitted) produces no action-needed or paused notice at all', () => {
    for (const due of stepsOfOnboarding) {
      const actions = decide(accountEvent(), snapshot(
        processorAccount({ details: false, charges: false, payouts: false, due, disabled: 'requirements.past_due' }), stored,
      ));
      expect(notices(actions), due.join(',')).toEqual([]);
      expect(statusUpdate(actions)?.flags).toMatchObject({ stripe_details_submitted: false, stripe_requirements_due: due });
    }
  });

  it('the status refresh at the onboarding return is held to the same rule', () => {
    const actions = decideAccountStatusSync(snapshot(
      processorAccount({ details: false, charges: false, payouts: false, due: ['external_account'], disabled: 'requirements.past_due' }), stored,
    ));
    expect(notices(actions)).toEqual([]);
  });

  it('once details are submitted, requirements the owner can act on are one notice per set', () => {
    const first = decide(accountEvent(), snapshot(processorAccount({ details: true, due: ['individual.verification.document'] }), stored));
    const again = decide(accountEvent('account.updated', 'evt_2'), snapshot(processorAccount({ details: true, due: ['individual.verification.document'] }), stored));
    const other = decide(accountEvent('account.updated', 'evt_3'), snapshot(processorAccount({ details: true, due: ['external_account'] }), stored));

    expect(notices(first).map((n) => n.verb)).toEqual(expect.arrayContaining(['billing.payments_action_needed']));
    expect(notices(first).find((n) => n.verb === 'billing.payments_action_needed')?.dedup)
      .toBe(notices(again).find((n) => n.verb === 'billing.payments_action_needed')?.dedup);
    expect(notices(other).find((n) => n.verb === 'billing.payments_action_needed')?.dedup)
      .not.toBe(notices(first).find((n) => n.verb === 'billing.payments_action_needed')?.dedup);
  });

  it('the processor reviewing what was submitted is not something the owner can act on: no paused notice, no admin email', () => {
    for (const disabled of ['requirements.pending_verification', 'under_review']) {
      const actions = decide(accountEvent(), snapshot(
        processorAccount({ details: true, charges: false, payouts: false, disabled }), stored,
      ));
      expect(notices(actions).filter((n) => n.verb === 'billing.payments_paused'), disabled).toEqual([]);
      expect(notices(actions).filter((n) => n.emailAdmins), disabled).toEqual([]);
    }
  });

  it('a pause that does need the owner still sends the paused notice', () => {
    const actions = decide(accountEvent(), snapshot(
      processorAccount({ details: true, charges: false, payouts: false, disabled: 'requirements.past_due' }), stored,
    ));
    expect(notices(actions).map((n) => n.verb)).toContain('billing.payments_paused');
  });
});
