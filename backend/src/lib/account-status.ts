import Stripe from 'stripe';
import { Prisma, type PaymentMethod } from '@prisma/client';
import { prisma } from './prisma';
import { retrieveAccount, checkPlatformKey } from './stripe';
import { env } from '../config/env';
import { logger } from './logger';
import { runWithOrg } from './tenant-context';
import { sendAccountNotices } from './payments-notifications';
import { decide, decideAccountStatusSync, type AccountEvent, type AccountSnapshot } from '../services/payment-reconciler/decide';
import { syncOrgBranding } from './stripe-branding';
import { applyActions, type AppliedEffects } from '../services/payment-reconciler/apply';
import { destinationLabelOf } from './payout-sync';

/**
 * Connected-account status refresh (payments go-live, Module 1 / slice 06, #1987).
 *
 * The one place that turns "what the processor says about an org's connected account" into
 * the org's stored capability flags. It FAILS CLOSED on any answer about the account
 * (`account_invalid`, `resource_missing` on a live key, any other account error): "can take
 * cards" is written false. Two kinds of error keep the stored flags untouched instead (see
 * decideAccountStatus and the conductor decision of 2026-10-06 in the slice 06 file): a
 * missing resource on a test-mode key, and a platform-side failure (rate limit, connection,
 * 5xx, the platform key failing authentication or lacking a permission), which says nothing
 * about the account and must not mark every org unable to take cards at once.
 */

export interface AccountStatusFlags {
  stripe_charges_enabled: boolean;
  stripe_payouts_enabled: boolean;
  stripe_details_submitted: boolean;
  stripe_requirements_due: string[];
  stripe_disabled_reason: string | null;
}

export type AccountStatusDecision =
  // cardActive / achActive (slices 10, 19): the account's card and bank-debit capabilities are
  // active. They are not columns; they decide whether CARD and ACH sit in accepted_payment_methods
  // (syncedAcceptedMethods). A failed-closed write reads as both false.
  | { kind: 'write'; outcome: 'refreshed'; flags: AccountStatusFlags; cardActive: boolean; achActive: boolean }
  | { kind: 'write'; outcome: 'failed_closed'; flags: Pick<AccountStatusFlags, 'stripe_charges_enabled' | 'stripe_payouts_enabled'> }
  | { kind: 'keep'; outcome: 'kept_test_mode_missing' | 'kept_platform_error' };

export type AccountLookup = { account: Stripe.Account } | { error: unknown };

/** Pure: what to write for an org given the processor's answer. */
export function decideAccountStatus(lookup: AccountLookup, opts: { testMode: boolean }): AccountStatusDecision {
  if ('error' in lookup) {
    // The one documented exception (research §4 row 12): a missing resource on a test-mode
    // key keeps the stored flags, so sandbox fixtures are not flipped by a refresh. A bogus
    // or foreign account id is NOT this case: the processor answers 403 `account_invalid`
    // for it (measured in the sandbox), and that fails closed like every other error.
    if (opts.testMode && errorCode(lookup.error) === 'resource_missing') {
      return { kind: 'keep', outcome: 'kept_test_mode_missing' };
    }
    // A platform-side failure is not an answer about the account. Failing closed on it would
    // drop card payments for every org on a short processor outage or a bad platform key;
    // the stored flags stay and the next refresh or account-updated event settles them.
    if (isPlatformSideError(lookup.error)) {
      return { kind: 'keep', outcome: 'kept_platform_error' };
    }
    return {
      kind: 'write',
      outcome: 'failed_closed',
      flags: { stripe_charges_enabled: false, stripe_payouts_enabled: false },
    };
  }
  const acct = lookup.account;
  return {
    kind: 'write',
    outcome: 'refreshed',
    flags: {
      stripe_charges_enabled: !!acct.charges_enabled,
      stripe_payouts_enabled: !!acct.payouts_enabled,
      stripe_details_submitted: !!acct.details_submitted,
      stripe_requirements_due: acct.requirements?.currently_due ?? [],
      stripe_disabled_reason: acct.requirements?.disabled_reason ?? null,
    },
    cardActive: acct.capabilities?.card_payments === 'active',
    achActive: acct.capabilities?.us_bank_account_ach_payments === 'active',
  };
}

/**
 * Codes that are the processor's answer about the account itself. `account_invalid` arrives
 * as a 403 permission error (measured in the sandbox), so it must be checked before the
 * permission class is treated as platform-side.
 */
const ACCOUNT_ANSWER_CODES = new Set(['account_invalid', 'resource_missing']);

/**
 * Errors about the platform, not the account (conductor decision 2026-10-06): rate limit,
 * connection failure, a processor-side 5xx, or the platform key failing authentication or
 * lacking a permission. Everything else is an answer about the account and fails closed.
 */
function isPlatformSideError(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeError)) return false;
  const code = errorCode(err);
  if (code && ACCOUNT_ANSWER_CODES.has(code)) return false;
  if (
    err instanceof Stripe.errors.StripeRateLimitError ||
    err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError ||
    err instanceof Stripe.errors.StripeAuthenticationError ||
    err instanceof Stripe.errors.StripePermissionError
  ) {
    return true;
  }
  const status = err.statusCode;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Payouts slice P2: when and where the company is paid out, as stored on the organization (organizations.payout_summary). */
export interface PayoutSummary {
  interval: string | null;
  weekly_anchor: string | null;
  delay_days: number | null;
  bank_label: string | null;
}

/** Pure: the payout schedule and bank label of an account, read from the account object already in hand. */
export function payoutSummaryOf(acct: Stripe.Account): PayoutSummary {
  const schedule = acct.settings?.payouts?.schedule;
  const bank = acct.external_accounts?.data?.find((e) => e.object === 'bank_account') as { bank_name?: string | null; last4?: string | null } | undefined;
  return {
    interval: schedule?.interval ?? null,
    weekly_anchor: schedule?.weekly_anchor ?? null,
    delay_days: typeof schedule?.delay_days === 'number' ? schedule.delay_days : null,
    bank_label: bank ? destinationLabelOf(bank) : null,
  };
}

/** Payouts slice BE-3 (V7-02a): the four verification rows of the payout account page. */
export type VerificationValue = 'verified' | 'pending' | 'not_started' | 'action_needed' | 'restricted';
export type VerificationArea = 'business_details' | 'owner_identity' | 'bank_account' | 'tax_id';
export type Verification = Record<VerificationArea, VerificationValue>;

/** A rejected or disconnected account: every row reads restricted. */
export const RESTRICTED_VERIFICATION: Verification = {
  business_details: 'restricted', owner_identity: 'restricted', bank_account: 'restricted', tax_id: 'restricted',
};

const VERIFICATION_AREAS: readonly VerificationArea[] = ['business_details', 'owner_identity', 'bank_account', 'tax_id'];

/**
 * Pure: which of the four rows a requirement key belongs to. The order of the checks matters: the two
 * tax keys under `individual.` are Tax ID, so they are tested before the `individual.` prefix; a key
 * naming a verification (a document, say) is owner identity wherever it sits. Anything left over is
 * business details, so an unrecognised key can never leave a row reading "verified".
 */
export function verificationAreaOf(key: string): VerificationArea {
  if (key === 'company.tax_id' || key === 'individual.id_number' || key === 'individual.ssn_last_4') return 'tax_id';
  if (key === 'external_account') return 'bank_account';
  if (
    key.startsWith('individual.') || key.startsWith('person_') || key.startsWith('representative.') || key.startsWith('relationship.') ||
    key.startsWith('company.owners') || key.startsWith('company.directors') || key.startsWith('company.executives') ||
    key.includes('verification')
  ) return 'owner_identity';
  return 'business_details';
}

/**
 * Pure: the four verification rows of an account, read from its requirement lists. Never carries a
 * requirement key or an account id; only the four values leave this function.
 */
export function verificationOf(acct: Stripe.Account): Verification {
  const reason: string | null = acct.requirements?.disabled_reason ?? null;
  if (reason && (reason.startsWith('rejected.') || reason === 'deauthorized')) return { ...RESTRICTED_VERIFICATION };

  const dueNow = [...(acct.requirements?.past_due ?? []), ...(acct.requirements?.currently_due ?? [])];
  const submitted = !!acct.details_submitted;
  // Details are in, the account cannot take charges yet and nothing is asked of the owner: it is being reviewed.
  if (submitted && !acct.charges_enabled && dueNow.length === 0) {
    return { business_details: 'pending', owner_identity: 'pending', bank_account: 'pending', tax_id: 'pending' };
  }

  const areasOf = (keys: readonly string[] | null | undefined) => new Set((keys ?? []).map(verificationAreaOf));
  const due = areasOf(dueNow);
  const pending = areasOf(acct.requirements?.pending_verification);
  const eventually = areasOf(acct.requirements?.eventually_due);
  const hasBank = !!acct.external_accounts?.data?.some((e) => e.object === 'bank_account');

  const out = {} as Verification;
  for (const area of VERIFICATION_AREAS) {
    let value: VerificationValue;
    if (due.has(area)) value = 'action_needed';
    else if (pending.has(area)) value = 'pending';
    else if (!submitted && eventually.has(area)) value = 'not_started';
    else value = 'verified';
    // C-6: with no bank account on file the bank row is never verified.
    if (area === 'bank_account' && !hasBank && value === 'verified') value = 'pending';
    out[area] = value;
  }
  return out;
}

/** Test mode = the platform runs on a sandbox key. The exception in decideAccountStatus is gated on it. */
function isTestModeKey(): boolean {
  const key = env.STRIPE_SECRET_KEY ?? '';
  return key.startsWith('sk_test_') || key.startsWith('rk_test_');
}

export type RefreshOutcome = AccountStatusDecision['outcome'] | 'no_account';

export interface RefreshResult {
  outcome: RefreshOutcome;
  /** "Can take cards" as stored after the refresh. */
  stripe_charges_enabled: boolean;
}

/**
 * Re-read one org's connected account from the processor and store its status. The caller
 * supplies the tenant context (a request already has one; the nightly job wraps each org in
 * runWithOrg). Every read and write is keyed on this org's id.
 */
export async function refreshAccountStatus(orgId: string): Promise<RefreshResult> {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    select: { stripe_account_id: true, stripe_charges_enabled: true },
  });
  if (!org?.stripe_account_id) {
    return { outcome: 'no_account', stripe_charges_enabled: org?.stripe_charges_enabled ?? false };
  }
  const synced = await syncAccountStatus({ organizationId: orgId, accountId: org.stripe_account_id });
  if (synced.outcome === 'duplicate' || synced.outcome === 'deauthorized') {
    // Neither arises without an event; kept total for the type.
    return { outcome: 'refreshed', stripe_charges_enabled: synced.chargesEnabled };
  }
  return { outcome: synced.outcome, stripe_charges_enabled: synced.chargesEnabled };
}

export type AccountSyncOutcome = RefreshOutcome | 'duplicate' | 'deauthorized';

/**
 * The one writer of an org's account status: account.updated and account.application.deauthorized
 * (through the payment event reconciler, with the event) and the status refresh (onboarding return,
 * nightly; no event) all come through here.
 *
 * Both writers used to read the account and then write without coordinating, so a refresh that
 * read before an account.updated could store its older answer over the event's newer one (slice 06
 * conductor note). Now each writer notes the org row's version (updated_at, which every write of the
 * status moves) BEFORE it asks the processor, and writes only if the row is still at that version
 * once it holds the row lock; otherwise another write landed while it waited for its answer, which
 * may be newer, so it asks again. The processor is read outside any transaction, so a slow answer
 * holds no database connection and no lock another writer waits on.
 *
 * Why that is enough: a writer that commits saw no other commit between noting the version and
 * writing, so any answer read after its own was not stored before it. Whatever changes on the account
 * later raises its own account.updated, whose read starts after the change.
 *
 * With an event, its id is claimed in the same transaction as the write (a replay changes nothing).
 * A platform-side processor failure on an event throws before anything is claimed, so the processor
 * delivers the event again; the refresh keeps the stored flags instead.
 */
export async function syncAccountStatus(args: {
  organizationId: string;
  accountId: string;
  event?: AccountEvent;
}): Promise<{ outcome: AccountSyncOutcome; chargesEnabled: boolean }> {
  for (let round = 1; round <= MAX_SYNC_ROUNDS; round++) {
    const result = await syncOnce(args);
    if (result === 'stale') continue;
    if (result.effects?.accountStatusWritten) {
      await sendAccountNotices(result.effects.accountNotices, result.orgName);
    }
    // Slice 36: onboarding just finished, so the checkout branding goes out once, the logo included.
    if (result.onboardingFinished && result.effects?.accountStatusWritten) void syncOrgBranding(args.organizationId, { logo: 'stored' });
    return { outcome: result.outcome, chargesEnabled: result.chargesEnabled };
  }
  // Only a row written over and over while the processor answers gets here. An event fails, so the
  // processor delivers it again; a refresh fails and the next one (or the next event) settles it.
  throw new Error(`account status of ${args.accountId} for org ${args.organizationId} kept changing while it was read; nothing written`);
}

/** Rounds of "note the version, ask the processor, write if unchanged" before giving up. */
const MAX_SYNC_ROUNDS = 5;

type SyncRound =
  | 'stale'
  | { outcome: AccountSyncOutcome; chargesEnabled: boolean; effects: AppliedEffects | null; orgName: string | null; onboardingFinished?: boolean };

async function syncOnce(args: { organizationId: string; accountId: string; event?: AccountEvent }): Promise<SyncRound> {
  const { organizationId, accountId, event } = args;

  // The version the processor's answer will be judged against, noted before asking.
  const before = await prisma.organization.findUnique({ where: { id: organizationId }, select: { updated_at: true } });

  // account.updated and the refresh read the account back (never the event payload: events
  // arrive out of order). A deauthorization is a teardown: there is nothing left to read.
  let status: AccountStatusDecision | null = null;
  let account: Stripe.Account | null = null;
  if (event?.type !== 'account.application.deauthorized') {
    let lookup: AccountLookup;
    try {
      account = await retrieveAccount(accountId);
      lookup = { account };
    } catch (error) {
      lookup = { error };
    }
    status = decideAccountStatus(lookup, { testMode: isTestModeKey() });
    logDecision(status, lookup, organizationId, accountId);
    if (event && status.outcome === 'kept_platform_error') {
      throw new Error(`account.updated ${event.id}: the account could not be read (platform-side error); the processor will deliver it again`);
    }
  }

  const outcome: AccountSyncOutcome = status?.outcome ?? 'deauthorized';
  try {
    return await prisma.$transaction(async (tx) => {
      if (event) {
        try {
          await tx.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
        } catch (err) {
          if ((err as { code?: string }).code === 'P2002') {
            return { outcome: 'duplicate' as AccountSyncOutcome, chargesEnabled: false, effects: null, orgName: null };
          }
          throw err;
        }
      }
      await tx.$executeRaw`SELECT id FROM organizations WHERE id = ${organizationId}::uuid FOR UPDATE`;
      const org = await tx.organization.findUnique({
        where: { id: organizationId },
        select: {
          name: true, updated_at: true, stripe_account_id: true, stripe_charges_enabled: true, stripe_payouts_enabled: true,
          stripe_details_submitted: true,
          accepted_payment_methods: true,
        },
      });
      // The org was unlinked from this account (or linked to another) meanwhile: nothing to write.
      if (!org || org.stripe_account_id !== accountId) {
        return { outcome, chargesEnabled: org?.stripe_charges_enabled ?? false, effects: null, orgName: null };
      }
      // Another write landed while the processor answered: this answer may be the older one.
      if (status && org.updated_at?.getTime() !== before?.updated_at?.getTime()) throw STALE;
      const snapshot: AccountSnapshot = {
        eventAlreadyProcessed: false,
        organizationId,
        accountId,
        stored: {
          acceptedMethods: Array.isArray(org.accepted_payment_methods) ? (org.accepted_payment_methods as PaymentMethod[]) : [],
          chargesEnabled: org.stripe_charges_enabled,
          payoutsEnabled: org.stripe_payouts_enabled,
        },
        status,
      };
      const actions = event ? decide(event, snapshot) : decideAccountStatusSync(snapshot);
      const effects = await applyActions(tx, actions, { organizationId, eventId: event?.id ?? 'account-status-refresh' });
      // Payouts slice P2: the schedule and bank label come from the same account read, written beside the status.
      // The verification rows (V7-02a) go in the same write. A failed-closed or kept refresh leaves them untouched.
      if (account && status?.outcome === 'refreshed' && effects.accountStatusWritten) {
        await tx.organization.updateMany({
          where: { id: organizationId, stripe_account_id: accountId },
          data: {
            payout_summary: payoutSummaryOf(account) as unknown as Prisma.InputJsonValue,
            stripe_verification: verificationOf(account) as unknown as Prisma.InputJsonValue,
          },
        });
      } else if (event?.type === 'account.application.deauthorized' && effects.accountStatusWritten) {
        // A disconnected account has nothing to read: all four rows read restricted.
        await tx.organization.updateMany({
          where: { id: organizationId, stripe_account_id: accountId },
          data: { stripe_verification: RESTRICTED_VERIFICATION as unknown as Prisma.InputJsonValue },
        });
      }
      const update = actions.find((a) => a.type === 'update_account_status');
      const chargesEnabled = update?.type === 'update_account_status' && update.flags.stripe_charges_enabled !== undefined
        ? update.flags.stripe_charges_enabled
        : org.stripe_charges_enabled;
      const onboardingFinished = update?.type === 'update_account_status' && update.flags.stripe_details_submitted === true && !org.stripe_details_submitted;
      return { outcome, chargesEnabled, effects, orgName: org.name, onboardingFinished };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (err) {
    if (err === STALE) return 'stale';
    throw err;
  }
}

/** Thrown inside the write transaction to roll it back (the event claim with it) and ask again. */
const STALE = new Error('account status changed while the processor answered');

function logDecision(status: AccountStatusDecision, lookup: AccountLookup, orgId: string, accountId: string): void {
  if (status.outcome === 'kept_platform_error') {
    logger.warn(`[account-status] lookup of ${accountId} for org ${orgId} failed with a platform-side error; stored flags kept`);
  } else if (status.outcome === 'kept_test_mode_missing') {
    logger.warn(`[account-status] ${accountId} for org ${orgId} is missing in test mode; stored flags kept`);
  } else if (status.outcome === 'failed_closed') {
    const error = (lookup as { error: unknown }).error;
    logger.warn(`[account-status] lookup of ${accountId} for org ${orgId} failed; card payments marked unavailable`, {
      error: errorCode(error) ?? String(error),
    });
  }
}

export type NightlyOrgResult = { orgId: string; outcome: 'error' } | ({ orgId: string } & RefreshResult);

export type NightlySummary =
  | { dryRun: true; orgs: Array<{ orgId: string }> }
  | { aborted: 'platform_check_failed'; orgs: [] }
  | { dryRun?: false; orgs: NightlyOrgResult[] };

/**
 * Nightly account-status refresh across every org with a connected account. Listing the orgs
 * is the only cross-org read (the caller runs it in runUnscoped, like the other crons); each
 * org is then refreshed inside its own tenant context. Orgs without an account are skipped.
 * A dry run lists the orgs it would refresh and makes no processor call and no write.
 *
 * Before any org, the platform key is checked once (conductor decision 2026-10-06): if that
 * check fails, every lookup would fail the same way, so the run aborts, logs a warning and
 * writes nothing for any org.
 */
export async function refreshAllAccountStatuses(opts: { dryRun?: boolean } = {}): Promise<NightlySummary> {
  const rows = await prisma.organization.findMany({
    where: { stripe_account_id: { not: null } },
    select: { id: true, stripe_account_id: true },
    orderBy: { id: 'asc' },
  });
  const orgIds = rows.filter((r) => !!r.stripe_account_id).map((r) => r.id);

  if (opts.dryRun) return { dryRun: true, orgs: orgIds.map((orgId) => ({ orgId })) };

  try {
    await checkPlatformKey();
  } catch (err) {
    logger.warn('[account-status] nightly refresh aborted: platform key check failed; no org written', {
      error: errorCode(err) ?? (err instanceof Error ? err.name : String(err)),
    });
    return { aborted: 'platform_check_failed', orgs: [] };
  }

  const orgs: NightlyOrgResult[] = [];
  for (const orgId of orgIds) {
    try {
      const result = await runWithOrg(orgId, () => refreshAccountStatus(orgId));
      orgs.push({ orgId, ...result });
    } catch (err) {
      logger.error(`[account-status] nightly refresh failed for org ${orgId}`, err);
      orgs.push({ orgId, outcome: 'error' });
    }
  }
  return { orgs };
}
