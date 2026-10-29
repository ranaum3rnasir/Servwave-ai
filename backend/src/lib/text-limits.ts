/**
 * Shared length tiers for free text a person types (spec 2026-10-14, text-length-limits).
 *
 * Every description, notes, reason and message column is unbounded Postgres `text`, so these are
 * product choices, not storage limits. They exist to stop a runaway paste from becoming a
 * multi-megabyte row. The old 2,000 / 5,000 caps came from the first scaffolding commit with no
 * reason behind them, and cut off real service requests.
 *
 * The frontend mirror is `frontend/src/lib/textLimits.ts` and MUST stay in step, the same way
 * `LINE_DESCRIPTION_MAX` pairs `lib/line-items.ts` with `frontend/src/lib/lineItems.ts`.
 */

/** Descriptions, notes, reasons, comments: anything a person writes about the work. */
export const LONG_TEXT_MAX = 20_000;

/** Email bodies, document terms, support messages. */
export const VERY_LONG_TEXT_MAX = 65_000;

/** Anything sent as a text message. 1,600 is the carrier hard maximum. */
export const SMS_BODY_MAX = 1_600;
