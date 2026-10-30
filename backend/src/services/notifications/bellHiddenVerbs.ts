import type { Prisma } from '@prisma/client';

/**
 * Notification verbs that are a per-person record for another surface, never an alert in the bell.
 *
 * Both Spider verbs are a per-person record for Spider's own surfaces (its button, its panel and the
 * red frame), never a bell alert (Ran, 20 Oct, D3): the bell's list, its counts, opening the bell
 * and "mark all read" leave these rows out, whatever priority a row was stored with. Spider marks
 * its own alerts read through PATCH /api/notifications/:id/read, which is why that one endpoint
 * carries no bell filter.
 *
 * `spider.alert`: Spider's in-app alert.
 *
 * `spider.frame`: Spider's red frame with in-app alerts switched off (Ran, 15 Oct: the contractor's
 * Red Frame works on its own). The sweep records one per recipient so the frame can show and end
 * like an in-app alert does, but with in-app alerts off nothing may reach the bell: its list, its
 * counts and "mark all read" leave these rows out.
 */
export const SPIDER_ALERT_VERB = 'spider.alert';
export const SPIDER_FRAME_VERB = 'spider.frame';

export const BELL_HIDDEN_VERBS: readonly string[] = [SPIDER_ALERT_VERB, SPIDER_FRAME_VERB];

/** The `notification` filter every bell query adds. */
export const BELL_VISIBLE: { notification: Prisma.NotificationWhereInput } = {
  notification: { verb: { notIn: [...BELL_HIDDEN_VERBS] } },
};
