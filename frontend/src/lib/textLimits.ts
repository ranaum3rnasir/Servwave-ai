/**
 * Length tiers for free text a person types (the 2026-10-14 text length limits spec).
 *
 * This MUST stay in step with `backend/src/lib/text-limits.ts`. The server is the gate; this copy
 * lets a form stop the user at the boundary, inline, instead of bouncing a long note off the API.
 */
import './zodErrorMap';

/** Descriptions, notes, reasons, comments: anything a person writes about the work. */
export const LONG_TEXT_MAX = 20_000;

/** Email bodies, document terms, support messages. */
export const VERY_LONG_TEXT_MAX = 65_000;

/** Anything sent as a text message. 1,600 is the carrier hard maximum. */
export const SMS_BODY_MAX = 1_600;

/** A long-text counter appears from this share of the limit upward, and not before. */
export const COUNTER_FROM = 0.9;

/** The message a field over `max` shows; the same words the global Zod error map produces. */
export function tooLongMessage(max: number): string {
  return `Too long (maximum ${max.toLocaleString('en-US')} characters)`;
}
