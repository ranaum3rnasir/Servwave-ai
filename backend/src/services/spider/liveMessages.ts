/**
 * Spider's messages on the live line (#3472, services/live/liveLines.ts): the ONE function every Spider message is sent
 * through, and the one place that decides who each is for. A screen that gets one shows or drops the pop-up card or the
 * red frame at once, or re-reads, instead of waiting for its next 30-second check.
 *
 * - `spider.alert.added`: to each person the alert was written for, their own new cards (the same serializer the
 *   unread-alerts read uses, unreadCards.ts, so no read is needed) and the ids of their new red-frame-only records.
 * - `spider.alert.ended`: to each person whose records were ended, the ids of their own rows that ended.
 * - `spider.settings.changed`: to the company's people, no data: the screen re-reads once, after a random 0-3 s.
 * - `spider.summary.ready`: to the people the starting summary tells and the company's Admins, no data: the summary card
 *   and page re-read.
 *
 * Sent only after the rows it is about are written (every Prisma call is its own committed statement), from: the sweep's
 * write and ending steps (sweep.ts writeAlertRecords, endFinishedAlerts, endOpenSpiderRecords; the check, tick.ts, writes
 * and ends through the same steps), the switch, settings and
 * exclusions saves (spider.controller.ts, spider-picker.controller.ts) and the summary's READY step (summary.ts).
 * Pinned by __tests__/spider-live-publish-guard.test.ts.
 *
 * Never reads the database and never throws: a message that cannot be sent leaves the screen to its next check.
 * Logs carry ids and counts only.
 */
import { logger } from '../../lib/logger';
import { deliverLive } from '../live/liveLines';
import { spiderAlertCard, type SpiderCardRow } from './unreadCards';

/** One person's new alert row, with the lead's status now (the card's click routes on it). */
export interface SpiderAddedAlertRow extends SpiderCardRow {
  recipient_id: string;
  leadStatus: string | undefined;
}

/** One person's Spider row (an alert's or a red-frame-only record's). */
export interface SpiderRecordRow {
  id: string;
  recipient_id: string;
}

export type SpiderLiveMessage =
  | { type: 'alerts_added'; alerts: readonly SpiderAddedAlertRow[]; frames: readonly SpiderRecordRow[] }
  | { type: 'alerts_ended'; rows: readonly SpiderRecordRow[] }
  | { type: 'settings_changed' }
  | { type: 'summary_ready'; recipientIds: readonly string[] };

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(key(row)) ?? [];
    list.push(row);
    out.set(key(row), list);
  }
  return out;
}

/** Sends one Spider message to the people of one company it concerns. */
export function publishSpiderLive(orgId: string, message: SpiderLiveMessage): void {
  try {
    let type: string;
    let lines: number;
    switch (message.type) {
      case 'alerts_added': {
        if (message.alerts.length === 0 && message.frames.length === 0) return;
        type = 'spider.alert.added';
        const cards = groupBy(message.alerts, (r) => r.recipient_id);
        const frames = groupBy(message.frames, (r) => r.recipient_id);
        lines = deliverLive(orgId, type, (p) =>
          cards.has(p.id) || frames.has(p.id)
            ? {
                alerts: (cards.get(p.id) ?? []).map((r) => spiderAlertCard(r, r.leadStatus)),
                frame_ids: (frames.get(p.id) ?? []).map((r) => r.id),
              }
            : null,
        );
        break;
      }
      case 'alerts_ended': {
        if (message.rows.length === 0) return;
        type = 'spider.alert.ended';
        const ended = groupBy(message.rows, (r) => r.recipient_id);
        lines = deliverLive(orgId, type, (p) => (ended.has(p.id) ? { ids: ended.get(p.id)!.map((r) => r.id) } : null));
        break;
      }
      case 'settings_changed':
        type = 'spider.settings.changed';
        lines = deliverLive(orgId, type, () => ({}));
        break;
      case 'summary_ready': {
        type = 'spider.summary.ready';
        const told = new Set(message.recipientIds);
        lines = deliverLive(orgId, type, (p) => (p.isAdmin || told.has(p.id) ? {} : null));
        break;
      }
      default:
        return;
    }
    logger.debug('[spider] live message sent', { orgId, type, lines });
  } catch (err) {
    logger.warn('[spider] live message not sent', { orgId, type: message.type, error: err instanceof Error ? err.name : 'unknown error' });
  }
}
