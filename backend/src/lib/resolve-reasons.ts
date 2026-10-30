import { z } from 'zod';

/**
 * The reasons a person picks when they mark a Needs attention item resolved (V7-05b, BE-4). The words are what the
 * Resolved view shows (the frontend adds "Resolved: " once), so they are stored plain. A missing reason is accepted
 * by the doors (older clients send none); an unknown one is refused.
 */
export const RESOLVE_REASONS_FAILED_REFUND = ['Returned the money another way', 'Handled outside ServWave'] as const;
export const RESOLVE_REASONS_OTHER = ['Handled outside ServWave', 'Duplicate entry', 'Not our payment'] as const;
export const CHOOSE_A_REASON = 'Choose a reason.';

/**
 * The body field of a resolve call: absent or null is no reason (older clients send none); anything else must be one of
 * the allowed words for this kind of item, or the call is refused with CHOOSE_A_REASON.
 */
export const resolveReasonSchema = (allowed: readonly [string, ...string[]]) => z.enum(allowed).nullish();
