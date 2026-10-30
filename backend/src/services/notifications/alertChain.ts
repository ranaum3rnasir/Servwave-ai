/**
 * alertChain.ts - M6's two-lane alert rule (Roles & Permissions, PRD 4).
 *
 * The programme's one rule for who an alert about a record goes to. It is async because "someone" is asked of the
 * database (active, can open the record, not the person who acted); the recipient resolver stays free of reads and is
 * handed the answer through the entity, the way the other pre-resolved recipient lists are.
 *
 *   Lane 1, the record's people: always told.
 *   Lane 2, who must act: the record's Dispatcher, else the holders of the step's switch, else the company's Admins (who
 *     manage people and roles since AL-18). It stops at the first step that finds someone.
 *   Copies: holders of the area's "Alert me about every ..." switch, on top.
 *
 * Nobody comes from a role name. A person found by more than one lane is one person: the caller's resolver merges them.
 * A chain that ends with nobody at all (no record people, nobody who must act, no copies) is logged, never dropped
 * silently.
 */

import { logger } from '../../lib/logger';
import { alertSomeone } from '../../lib/permissions/alertSomeone';
import { ADMINS, activeSwitchHolders } from '../../lib/permissions/switchHolders';
import type { EntityRef } from '../../lib/tasks/entityAccess';
import {
  dispatcherMadeChangeStem,
  dispatcherUnavailableStem,
  nobodyCanLine,
  nobodyCanOpenLine,
  nobodyWhoCanOpenRecordLine,
  noDispatcherStem,
  whyLine,
  type WhyStem,
} from './whyLines';

export interface TwoLaneInput {
  organizationId: string;
  /**
   * The record the alert is about, or null for an alert that has none (money that no invoice of the company carries): there
   * are no record people and no Dispatcher, nobody has to be able to open anything, and the chain starts at the step's holders.
   */
  record: EntityRef | null;
  /** The person who caused the alert; never someone for it. */
  actorId: string | null;
  /** Lane 1: the record's people (Owner or Sold By, crew, Dispatcher), as the alert names them. */
  recordPeople: string[];
  /** The record's Dispatcher, or null when it has none. */
  dispatcherId: string | null;
  /** Lane 2's second step: the switch whose holders must act next (Complete jobs for "all visits finished"). */
  stepSwitch: string;
  /**
   * The "Alert me about every ..." switch of the record's area. An alert that belongs to two areas (a deposit paid is an
   * estimate alert and a payment alert) names both: a person holding either gets ONE copy, never one per switch.
   */
  copySwitch: string | string[];
  /**
   * A second record everybody must also be able to open. An estimate alert is about the estimate, and its people are those
   * of its lead or job: `record` is the estimate (the one the alert names), this is the lead or job whose people it goes to,
   * so a person who can open one but not the other is not "someone" and the chain goes on to the next step.
   */
  alsoOpen?: EntityRef;
  /** The why line's stem when the record has no Dispatcher to start from, for a record that has no people either (whyLines.ts). */
  noDispatcherReason?: WhyStem;
  /**
   * Lane 2 normally starts at the record's Dispatcher and goes on to the step's holders only when the Dispatcher cannot
   * take it. An alert whose step is its holders' own (Ready to close: closing is the Close jobs holders' job, Dispatcher or
   * not) sets this: the step's holders are told whether or not the record has a Dispatcher, who stays in lane 1.
   */
  stepHoldersAlways?: boolean;
  /**
   * Who holds a switch, asked of the company. An alert sent for many records at once (the nightly invoice sweep) hands in a reader
   * that remembers its answers, so the company's holders are read once for the whole sweep instead of once per record.
   */
  holdersOf?: (organizationId: string, switchKey: string) => Promise<string[]>;
  /**
   * False when this walk is not the alert itself but a second look at the same people (the owner email that follows a money alert asks
   * who the bell reached): the alert has already logged its gap, and the email must not log it a second time.
   */
  logGap?: boolean;
  /** Words for the fallback reasons and the log line. */
  words: { record: string; step: string; alert: string };
}

export interface TwoLaneAnswer {
  laneOne: string[];
  laneTwo: string[];
  copies: string[];
  /** Why lane 2 reached these people, when the record's Dispatcher did not; null when the Dispatcher took it. */
  fallbackReason: string | null;
}

/**
 * The suffix on the dedup key of the alert that carries the why line. An alert that is deduplicated (several doors report one
 * event) keeps its key on the first and suffixes the second, so neither is mistaken for the other.
 */
export const WHY_KEY = ':why';

export async function twoLaneRecipients(input: TwoLaneInput): Promise<TwoLaneAnswer> {
  const { organizationId, record, actorId, words } = input;
  const holdersOf = input.holdersOf ?? activeSwitchHolders;
  const someone = async (candidateIds: string[]) => {
    // No record: the people asked about are switch holders, who are active already; only the actor is left out.
    if (!record) return [...new Set(candidateIds)].filter((id) => id !== actorId);
    const readers = await alertSomeone({ organizationId, candidateIds, record, actorId });
    return input.alsoOpen && readers.length
      ? alertSomeone({ organizationId, candidateIds: readers, record: input.alsoOpen, actorId })
      : readers;
  };

  const laneOne = await someone([...input.recordPeople, ...(input.dispatcherId ? [input.dispatcherId] : [])]);

  let laneTwo: string[] = [];
  let fallbackReason: string | null = null;
  const holdersOfStep = async () => someone(await holdersOf(organizationId, input.stepSwitch));
  const managers = async () => someone(await holdersOf(organizationId, ADMINS));
  if (input.stepHoldersAlways || !record) {
    // Nobody is covering for a missing Dispatcher here (Ready to close, or an alert with no record to have a Dispatcher), so only
    // the last step explains itself.
    laneTwo = await holdersOfStep();
    if (!laneTwo.length) {
      laneTwo = await managers();
      fallbackReason = record ? nobodyWhoCanOpenRecordLine(words.step, words.record) : nobodyCanLine(words.step);
    }
  } else {
    const dispatcher = input.dispatcherId ? await someone([input.dispatcherId]) : [];
    if (dispatcher.length) {
      laneTwo = dispatcher;
    } else {
      const why = !input.dispatcherId
        ? input.noDispatcherReason ?? noDispatcherStem(words.record)
        : input.dispatcherId === actorId
          ? dispatcherMadeChangeStem(words.record)
          : dispatcherUnavailableStem(words.record);
      laneTwo = await holdersOfStep();
      fallbackReason = whyLine(why);
      if (!laneTwo.length) {
        laneTwo = await managers();
        fallbackReason = nobodyCanOpenLine(why, words.step);
      }
    }
  }
  if (!laneTwo.length) fallbackReason = null;

  const copyHolders = new Set<string>();
  for (const key of [input.copySwitch].flat()) {
    for (const id of await holdersOf(organizationId, key)) copyHolders.add(id);
  }
  const copies = await someone([...copyHolders]);
  // The record's people and the copies are somebody too: only a chain that reaches no one at all is a gap to find.
  // The line carries the kind of alert, the record and the company, and nothing of the customer.
  if (input.logGap !== false && !laneOne.length && !laneTwo.length && !copies.length) logNobodyToTell(words.alert, organizationId, record);
  return { laneOne, laneTwo, copies, fallbackReason };
}

/**
 * The line for a chain that ends with nobody: the kind of alert, the record and the company, and nothing of the customer. One
 * format for every alert on M6, the customer-reply alert (emailReplyAlerts.ts) included.
 */
export function logNobodyToTell(alert: string, organizationId: string, record: EntityRef | null): void {
  logger.warn(`[alertChain] ${alert}: nobody to tell`, {
    alert, organizationId, recordType: record?.type ?? null, recordId: record?.id ?? null,
  });
}

/**
 * Who reads the why line. Lane 2's covering people (reached through step 2 or step 3) carry it; the record's people and
 * the copies are told without it, and a person found by both is told once, without it. Each list goes out as its own
 * alert, because an alert carries one line for everyone on it.
 */
export function splitByWhyLine(answer: TwoLaneAnswer): { plain: TwoLaneAnswer; covering: string[] } {
  if (!answer.fallbackReason) return { plain: { ...answer, fallbackReason: null }, covering: [] };
  const known = new Set([...answer.laneOne, ...answer.copies]);
  return {
    // A covering person who is also the record's own person (or has a copy) is told once, without the line, but is still one of
    // the people who must act: an alert that asks someone to act asks them whichever way they were found.
    plain: { laneOne: answer.laneOne, laneTwo: answer.laneTwo.filter((id) => known.has(id)), copies: answer.copies, fallbackReason: null },
    covering: answer.laneTwo.filter((id) => !known.has(id)),
  };
}

/** The lists one alert goes out with: who is told as the record's people, who must act, and who gets a copy. */
export interface ChainEntity {
  lane_one_ids: string[];
  lane_two_ids: string[];
  copy_ids: string[];
}

/**
 * Send what the chain found as up to two alerts: one for everybody who is told without the why line and one for the
 * covering people with it. Nobody is on both, and nothing is sent for an empty list.
 *
 * An alert whose words differ by person (the Office review attention alert lists only the items each person may see) passes
 * `groupOf`: it is asked ONCE for everybody the answer reaches and says which group each person belongs to, or null for a
 * person who is to be sent nothing. Each list above then goes out once per group, the group handed to `send`. The number of
 * alerts is the number of groups (a few), never the number of people, and `groupOf` owns keeping its own reads flat.
 */
export async function sendByWhyLine(
  answer: TwoLaneAnswer,
  send: (entity: ChainEntity, whyLine: string | null, group: string | null) => Promise<unknown>,
  groupOf?: (personIds: string[]) => Promise<ReadonlyMap<string, string | null>>,
): Promise<void> {
  const { plain, covering } = splitByWhyLine(answer);
  const groups = groupOf
    ? await groupOf([...new Set([...plain.laneOne, ...plain.laneTwo, ...plain.copies, ...covering])])
    : null;
  const sendTo = async (entity: ChainEntity, whyLine: string | null) => {
    if (!groups) {
      await send(entity, whyLine, null);
      return;
    }
    const keys = new Set([...entity.lane_one_ids, ...entity.lane_two_ids, ...entity.copy_ids].map((id) => groups.get(id) ?? null));
    for (const key of keys) {
      if (key === null) continue;
      const only = (ids: string[]) => ids.filter((id) => groups.get(id) === key);
      await send({ lane_one_ids: only(entity.lane_one_ids), lane_two_ids: only(entity.lane_two_ids), copy_ids: only(entity.copy_ids) }, whyLine, key);
    }
  };
  if (plain.laneOne.length || plain.laneTwo.length || plain.copies.length) {
    await sendTo({ lane_one_ids: plain.laneOne, lane_two_ids: plain.laneTwo, copy_ids: plain.copies }, null);
  }
  if (covering.length) await sendTo({ lane_one_ids: [], lane_two_ids: covering, copy_ids: [] }, answer.fallbackReason);
}
