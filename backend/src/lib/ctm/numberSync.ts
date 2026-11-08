import type { Request } from 'express';
import type { PhoneNumber } from '@prisma/client';
import { prisma } from '../prisma';
import { logAudit } from '../audit';
import { logger } from '../logger';
import { enableSms, listNumbers } from './client';

/**
 * The one routine that makes an org's stored phone numbers match its phone
 * account. Connect, the admin's Sync button, the background sync a
 * phone-numbers screen asks for on open, and the phone webhook (a call or text
 * on a number not stored yet) all call it, so they cannot drift
 * apart again (connect and the button had: connect switched texting on but
 * ignored forwarding and status, the button read those but never switched
 * texting on).
 *
 * One sync:
 *  - reads the account's whole number list (every page);
 *  - upserts each number by (org, E.164) - it never deletes one, and never
 *    buys or releases one;
 *  - switches texting on for every number the phone system reports with
 *    texting off. Ran's ruling (2026-09-30): this is system policy on every
 *    sync, not only at connect. 'ok' and 'alreadyenabled' store the number as
 *    able to text; 'notfound', 'failure', a failed request, or a number
 *    listed without an id ('noid') leave it calls-only, are reported, and
 *    are retried by the next sync. Texting is never switched OFF here;
 *  - maps the phone system's active/stopped to active/paused, and stores a
 *    forward destination only for a single-destination forward;
 *  - names numbers (see `nameFor`);
 *  - records one audit entry, which also names the stored calls-only numbers
 *    the phone system already reported able to text (`texting_found_on`).
 *
 * A failure to read the list throws (a `CtmApiError` from the client) before
 * anything is written, so a caller never mistakes an outage for an empty
 * account.
 *
 * Every caller goes through a per-org throttle (see `syncNumbers`), so no
 * call site can sync around it.
 */

/** What caused a sync; recorded on the audit entry.
 *  - 'connect': the org just connected its phone account.
 *  - 'manual': an admin pressed Sync numbers.
 *  - 'page-open': someone opened a phone-numbers screen (automatic).
 *  - 'unknown-number': a call or text arrived on a number the org does not
 *    have stored (automatic; see `unknownNumberSync.ts`). */
export type NumberSyncTrigger = 'connect' | 'manual' | 'page-open' | 'unknown-number';

/**
 * Whether a trigger is AUTOMATIC: nobody asked for this sync, so it is skipped
 * when the org synced recently, and it is attributed to the system rather than
 * to whoever happened to cause it. Exhaustive on purpose: a new trigger has to
 * say which kind it is.
 */
const AUTOMATIC: Record<NumberSyncTrigger, boolean> = {
  connect: false,
  manual: false,
  'page-open': true,
  'unknown-number': true,
};

export function isAutomaticTrigger(trigger: NumberSyncTrigger): boolean {
  return AUTOMATIC[trigger];
}

/** An automatic sync is skipped when the org's last sync finished less than
 *  this long ago. */
export const AUTO_SYNC_WINDOW_MS = 60_000;

export interface NumberSyncInput {
  orgId: string;
  /** The org's phone-system account id. */
  accountId: string;
  trigger: NumberSyncTrigger;
  /** The request of the person who caused the sync, when there is one. It
   *  names the audit entry's actor. Ignored for an automatic trigger: the
   *  texting switch-on is system policy (Ran, 2026-09-30), not the act of the
   *  person who opened a screen, so an automatic sync has no person as actor. */
  req?: Request;
  /** False when the caller ignores `numbers` unless the sync actually ran
   *  (the webhook's unknown-number sync): a skipped or given-up sync then
   *  answers with an empty `numbers` instead of reading the stored list.
   *  Default true; a numbers screen needs the list either way. */
  needsNumbers?: boolean;
}

/** Why switching texting on did not take: the phone system's own answer
 *  ('notfound', 'failure'), 'error' when the request itself failed, or 'noid'
 *  when the phone system listed the number without the id the switch-on call
 *  needs. */
export type TextingFailure = 'notfound' | 'failure' | 'error' | 'noid';

export interface NumberSyncResult {
  /** Distinct numbers the phone system reported. */
  read: number;
  /** E.164 of every number stored for the first time by this sync. */
  added: string[];
  /** E.164 of every number whose texting this sync switched on. */
  textingEnabled: string[];
  /** Numbers where switching texting on did not succeed. They stay calls-only
   *  and are tried again on the next sync. */
  textingFailed: Array<{ e164: string; outcome: TextingFailure }>;
  /** Every stored number for the org after the sync, oldest first. Empty for
   *  a skipped or given-up sync when the caller passed `needsNumbers: false`. */
  numbers: PhoneNumber[];
  /** True when the sync changed what a numbers screen shows: a number added,
   *  or a stored number's name, texting, status, type or forward destination.
   *  False when nothing changed, and always false for a skipped sync. */
  changed: boolean;
  /** True when an automatic sync was skipped because the org synced the same
   *  phone account within the last `AUTO_SYNC_WINDOW_MS`. Nothing was read or
   *  written; `numbers` is the stored list and the counts are empty. */
  skipped: boolean;
  /** True when an automatic caller stopped waiting after `AUTO_SYNC_WAIT_MS`.
   *  The run carries on and stores its result; this caller got the stored list
   *  as it was, with `changed: false` and empty counts. */
  stillRunning: boolean;
}

/** How long an AUTOMATIC caller waits for a run before it answers with the
 *  stored list. A provider request can take about 90 seconds and the texting
 *  switch-ons run one at a time, so a run can last minutes; a page open must
 *  not hang on it, and a fire-and-forget caller never needs its result. Manual
 *  and connect callers always wait for the real result. */
export const AUTO_SYNC_WAIT_MS = 15_000;

// ─── Per-org throttle ────────────────────────────────────────────────────────
//
// Process memory, like the receiving-number roster cache. It only needs to move
// to the database if the backend ever runs more than one instance.
//
// Per org: the run in progress and the account it reads, and when the last
// run finished and for which account.
//  - A caller for the SAME account joins the run in progress.
//  - A caller for a DIFFERENT account (the org reconnected to another phone
//    account) waits for that run to settle, then runs its own. It never takes
//    the old account's result for the new one. An AUTOMATIC caller first
//    re-reads the org's account and is skipped if the org has moved off the
//    account it was triggered for.
//  - The 60-second window only skips an automatic sync of the account that
//    last synced.
//  - A FAILED run counts as finished: a phone-system outage must not turn
//    every page open into another call to it. The window is also what bounds
//    how often a number that can never text is retried, since every sync
//    re-attempts the switch-on for each calls-only number.
//  - A run STOPPED by a disconnect (`stopRunningSync`) stores nothing, so no
//    caller joins it (a reconnect waits for it, then runs its own) and it does
//    not count as finished.
//
// An entry is dropped once its window has passed and nothing is running, so
// the map holds only orgs that synced in the last minute.

/** Set by `stopRunningSync`; a run checks it before each write. */
interface StopSignal {
  stopped: boolean;
}

interface OrgSyncState {
  running?: { accountId: string; promise: Promise<NumberSyncResult>; stop: StopSignal };
  finished?: { accountId: string; at: number };
}

const throttle = new Map<string, OrgSyncState>();
let now: () => number = Date.now;
let autoWaitMs = AUTO_SYNC_WAIT_MS;

/** How long `stopRunningSync` waits for a run to settle. Disconnect awaits it
 *  inside the admin's request, so a run stuck on the phone system (each request
 *  can take 30 seconds, tried three times) must not hang that request. A run
 *  still going after this stops at its next write anyway (it checks the stop
 *  flag, and re-reads the org's account after reading the list). */
export const STOP_SYNC_WAIT_MS = 20_000;
let stopWaitMs = STOP_SYNC_WAIT_MS;

/** Tests only: forget every org's throttle state, and optionally replace the
 *  clock the window is measured with, how long an automatic caller waits, and
 *  how long `stopRunningSync` waits. */
export function resetNumberSyncThrottle(
  options: { now?: () => number; autoWaitMs?: number; stopWaitMs?: number } = {},
): void {
  throttle.clear();
  now = options.now ?? Date.now;
  autoWaitMs = options.autoWaitMs ?? AUTO_SYNC_WAIT_MS;
  stopWaitMs = options.stopWaitMs ?? STOP_SYNC_WAIT_MS;
}

/**
 * The org is disconnecting from its phone account: tell the org's running
 * sync, if any, to store nothing more, and wait (at most `STOP_SYNC_WAIT_MS`)
 * for it to settle, so a write already in flight lands BEFORE the caller marks
 * the numbers inactive rather than after. Never rejects: the run's own failure
 * is logged by the run.
 */
export async function stopRunningSync(orgId: string): Promise<void> {
  const running = throttle.get(orgId)?.running;
  if (!running) return;
  running.stop.stopped = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, stopWaitMs);
    timer.unref?.();
  });
  try {
    await Promise.race([running.promise.then(() => undefined, () => undefined), bound]);
  } finally {
    clearTimeout(timer);
  }
}

/** How many orgs the throttle is currently holding state for. */
export function numberSyncThrottleSize(): number {
  return throttle.size;
}

function pruneThrottle(at: number): void {
  for (const [orgId, s] of throttle) {
    if (!s.running && (!s.finished || at - s.finished.at >= AUTO_SYNC_WINDOW_MS)) {
      throttle.delete(orgId);
    }
  }
}

const SKIPPED = Symbol('skipped');
const GAVE_UP = Symbol('gave-up');

/**
 * Sync an org's numbers, through the per-org throttle:
 *  - while a sync of the same phone account is running for the org, every
 *    caller (whatever its trigger) joins it and gets that run's result or
 *    failure; a caller for a different account waits, then runs its own;
 *  - an automatic trigger is skipped when the org's last sync of the same
 *    account finished less than `AUTO_SYNC_WINDOW_MS` ago, and gets the stored
 *    list back with `skipped: true, changed: false`;
 *  - an automatic trigger waits at most `AUTO_SYNC_WAIT_MS`, then gets the
 *    stored list back with `stillRunning: true, changed: false`;
 *  - connect and the manual button ignore the window and wait for the result.
 *
 * A phone-system failure rejects for a caller still waiting (see the module
 * comment); the caller decides what the person in front of it sees. Every
 * failed run is also logged here once, since an automatic caller that stopped
 * waiting never hears about it.
 */
export async function syncNumbers(input: NumberSyncInput): Promise<NumberSyncResult> {
  const outcome = startOrJoin(input);
  if (!isAutomaticTrigger(input.trigger)) {
    const result = await outcome;
    // Only an automatic trigger is ever skipped.
    return result === SKIPPED ? storedList(input, { skipped: true }) : result;
  }
  // The race subscribes to `outcome`, so a failure that lands after this
  // caller stopped waiting is handled (and was logged when the run failed);
  // it never becomes an unhandled rejection.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof GAVE_UP>((resolve) => {
    timer = setTimeout(() => resolve(GAVE_UP), autoWaitMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([outcome, deadline]);
    if (result === SKIPPED) return storedList(input, { skipped: true });
    if (result === GAVE_UP) return storedList(input, { stillRunning: true });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/** The run this caller should await, or SKIPPED when the window applies. */
async function startOrJoin(input: NumberSyncInput): Promise<NumberSyncResult | typeof SKIPPED> {
  const { orgId, accountId } = input;
  for (;;) {
    const at = now();
    pruneThrottle(at);
    const state = throttle.get(orgId);
    if (state?.running) {
      // A run that disconnect stopped stores nothing, so nobody joins it - a
      // reconnect to the same account made while it is still in flight waits
      // for it like another account's run, then syncs for real.
      if (state.running.accountId === accountId && !state.running.stop.stopped) return state.running.promise;
      // Another account's run, or a stopped one: let it settle, then look again.
      await state.running.promise.catch(() => undefined);
      // That run may have been the org connecting to a different account. An
      // automatic caller holds whatever account the org had when it was
      // triggered, so it checks the org is still on it before syncing: syncing
      // a superseded account would write its numbers back into the org. Connect
      // and the manual button act on the account they were given.
      if (isAutomaticTrigger(input.trigger) && (await currentAccountOf(orgId)) !== accountId) {
        return SKIPPED;
      }
      continue;
    }
    if (
      isAutomaticTrigger(input.trigger) &&
      state?.finished?.accountId === accountId &&
      at - state.finished.at < AUTO_SYNC_WINDOW_MS
    ) {
      return SKIPPED;
    }
    const stop: StopSignal = { stopped: false };
    const previous = state?.finished;
    const promise = runSync(input, stop).finally(() => {
      // A stopped run did not sync the org, so it does not open the window.
      throttle.set(orgId, { finished: stop.stopped ? previous : { accountId, at: now() } });
    });
    promise.catch((err) => logger.warn(`[number-sync] sync failed for org ${orgId}:`, err));
    throttle.set(orgId, { running: { accountId, promise, stop }, finished: state?.finished });
    return promise;
  }
}

/** The org's phone account as stored now, or null when it has none or the
 *  read fails (the sync is then skipped or stores nothing, never run on a
 *  guess). */
async function currentAccountOf(orgId: string): Promise<string | null> {
  try {
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { ctm_account_id: true },
    });
    return org?.ctm_account_id ?? null;
  } catch (err) {
    logger.warn(`[number-sync] could not read the phone account of org ${orgId}; not syncing:`, err);
    return null;
  }
}

/** The answer for a sync that stored nothing: the stored list (unless the
 *  caller said it needs none) and empty counts. */
async function storedList(
  input: Pick<NumberSyncInput, 'orgId' | 'needsNumbers'>,
  flags: { skipped?: boolean; stillRunning?: boolean },
): Promise<NumberSyncResult> {
  const numbers =
    input.needsNumbers === false
      ? []
      : await prisma.phoneNumber.findMany({
          where: { organization_id: input.orgId },
          orderBy: { created_at: 'asc' },
        });
  return {
    read: 0,
    added: [],
    textingEnabled: [],
    textingFailed: [],
    numbers,
    changed: false,
    skipped: flags.skipped ?? false,
    stillRunning: flags.stillRunning ?? false,
  };
}

/** What a numbers screen shows of a stored row, for spotting a change. */
function shownState(row: PhoneNumber): string {
  return JSON.stringify([row.label, row.sms_enabled, row.status, row.type, row.route_to ?? null]);
}

async function runSync(input: NumberSyncInput, stop: StopSignal): Promise<NumberSyncResult> {
  const { orgId, accountId } = input;
  const remote = await listNumbers(accountId);
  // Reading the list can take minutes. If the org disconnected (or moved to
  // another account) meanwhile, its numbers were marked inactive and nothing
  // read here may be stored over that.
  if (stop.stopped || (await currentAccountOf(orgId)) !== accountId) {
    logger.info(`[number-sync] org ${orgId} left the phone account while it was read; nothing stored`);
    return storedList(input, {});
  }
  const before = await prisma.phoneNumber.findMany({ where: { organization_id: orgId } });
  const storedLabel = new Map(before.map((r) => [r.e164, r.label]));
  const storedCanText = new Map(before.map((r) => [r.e164, r.sms_enabled === true]));

  const added: string[] = [];
  const textingEnabled: string[] = [];
  const textingFailed: Array<{ e164: string; outcome: TextingFailure }> = [];
  // Stored numbers that were calls-only and that the phone system already
  // reported able to text, so this sync stored them as able to text without
  // switching anything on. Audit only: without it such a flip shows in neither
  // texting_enabled nor texting_failed.
  const textingFoundOn: string[] = [];
  // The list is paged oldest-first, so a number can appear on two pages if
  // the list shifts mid-walk. Each number is handled once per sync.
  const seen = new Set<string>();
  for (const n of remote) {
    const e164 = String(n.number ?? n.phone_number ?? n.e164 ?? '');
    if (!e164 || seen.has(e164)) continue;
    seen.add(e164);
    const tpnId = n.id !== undefined && n.id !== null ? String(n.id) : null;
    const type = n.type === 'tollfree' || n.type === 'local' ? String(n.type) : null;
    const status = statusFromProvider(n.status);
    const forwardTo = forwardToFromProvider(n.route_to);
    const label = nameFor(n, storedLabel.get(e164) ?? null);

    if (stop.stopped) break;
    const reportedCanText = n.sms_enabled === true;
    let canText = reportedCanText;
    if (!canText && !tpnId) {
      textingFailed.push({ e164, outcome: 'noid' });
    } else if (!canText && tpnId) {
      const outcome = await switchTextingOn(accountId, tpnId);
      if (outcome === 'ok' || outcome === 'alreadyenabled') {
        canText = true;
        textingEnabled.push(e164);
      } else {
        textingFailed.push({ e164, outcome });
      }
    }

    // The switch-on above can take a while; disconnect may have landed.
    if (stop.stopped) break;
    await prisma.phoneNumber.upsert({
      where: { organization_id_e164: { organization_id: orgId, e164 } },
      create: {
        e164,
        formatted: typeof n.formatted === 'string' ? n.formatted : null,
        label,
        source: 'ctm',
        type,
        ctm_number_id: tpnId,
        ...(forwardTo && { route_to: { forward_to: forwardTo } }),
        sms_enabled: canText,
        status,
        organization_id: orgId,
      },
      update: {
        ctm_number_id: tpnId,
        type,
        status,
        ...(label && { label }),
        ...(forwardTo && { route_to: { forward_to: forwardTo } }),
        // Texting is only ever switched ON here. A number the phone system
        // reports as off, whose switch-on failed, keeps whatever was stored.
        ...(canText && { sms_enabled: true }),
      },
    });
    if (!storedLabel.has(e164)) added.push(e164);
    else if (reportedCanText && storedCanText.get(e164) === false) textingFoundOn.push(e164);
  }

  await logAudit({
    req: isAutomaticTrigger(input.trigger) ? undefined : input.req,
    orgId,
    action: 'numbers.synced',
    resourceType: 'Organization',
    resourceId: orgId,
    metadata: {
      trigger: input.trigger,
      read: seen.size,
      added,
      texting_enabled: textingEnabled,
      texting_failed: textingFailed,
      texting_found_on: textingFoundOn,
      // A disconnect stopped the run part-way; the counts are what it did.
      ...(stop.stopped ? { stopped: 'disconnected' } : {}),
    },
  });

  const numbers = await prisma.phoneNumber.findMany({
    where: { organization_id: orgId },
    orderBy: { created_at: 'asc' },
  });
  const shownBefore = new Map(before.map((r) => [r.e164, shownState(r)]));
  const changed =
    added.length > 0 || numbers.some((r) => shownBefore.has(r.e164) && shownBefore.get(r.e164) !== shownState(r));
  return {
    read: seen.size,
    added,
    textingEnabled,
    textingFailed,
    numbers,
    changed,
    skipped: false,
    stillRunning: false,
  };
}

/** One enable call, never thrown: a phone-system error on one number must not
 *  stop the rest of the sync. */
async function switchTextingOn(
  accountId: string,
  tpnId: string,
): Promise<'ok' | 'alreadyenabled' | TextingFailure> {
  try {
    return await enableSms(accountId, tpnId);
  } catch (err) {
    logger.warn(`[number-sync] switching texting on failed for ${tpnId}:`, err);
    return 'error';
  }
}

const trimmed = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

/**
 * The name a number should be stored under, or null to leave the stored one.
 *
 *  1. The number's own name in the phone system always wins.
 *  2. Otherwise an EMPTY stored name is filled from the number's source name.
 *  3. A stored name is never overwritten by a source name.
 *
 * The source arrives as a nested `{id, name, url}` object, not a scalar
 * (verified live 2026-08-04).
 */
function nameFor(n: Record<string, unknown>, stored: string | null): string | null {
  const own = trimmed(n.name);
  if (own) return own;
  if (trimmed(stored)) return null;
  const source = n.source;
  return source && typeof source === 'object' ? trimmed((source as Record<string, unknown>).name) : null;
}

/** The phone system says active/stopped; ServWave says active/paused. A record
 *  with no status at all is treated as active - the connect flow always did. */
function statusFromProvider(status: unknown): 'active' | 'paused' {
  return status === undefined || status === null || status === 'active' ? 'active' : 'paused';
}

/**
 * The forward destination a live provider record describes, if it describes one.
 *
 * The record's `route_to` is `{type:'receiving_number', dial:[{number}]}` when a
 * number simply forwards, `{type:'call_queue', dial:{…}}` when it is routed
 * some other way, and carries `dial: []` when the number rings nowhere at all.
 * Only the single-destination forward is a shape ServWave owns; everything else
 * returns null so the mirror reports "no simple forward" rather than inventing
 * one.
 */
export function forwardToFromProvider(routeTo: unknown): string | null {
  if (!routeTo || typeof routeTo !== 'object') return null;
  const record = routeTo as Record<string, unknown>;
  if (record.type !== 'receiving_number' || !Array.isArray(record.dial)) return null;
  // Several destinations ring at once; collapsing them to one would be a lie.
  if (record.dial.length !== 1) return null;
  const first = record.dial[0] as Record<string, unknown> | undefined;
  return trimmed(first?.number);
}
