import { z } from 'zod';

/**
 * Bridge "ring the caller first" switch (mobile slice 21).
 *
 * Click-to-call asks CTM to bridge: ring a first leg, then dial the second.
 * Which request shape makes the FIRST leg the caller's own phone is chosen
 * here, by env:
 *
 *   off                - today's body exactly ({ from_number, call_number = customer }). Default.
 *   call_number_caller - PROVEN on a live call (staging account, 2026-10-03):
 *                        { from_number, call_number = the caller's profile phone
 *                        (User.phone, E.164), to_number = the customer }. CTM
 *                        rings call_number first, then bridges to to_number;
 *                        the call was recorded.
 *   to_number_user_id  - UNTESTED on a live call. { from_number, call_number =
 *                        customer, to_number = caller, user_id = the caller's CTM
 *                        agent id }. Same leg order as the disproven to_number
 *                        mode below, so it very likely rings the CUSTOMER first too.
 *   to_agent           - UNTESTED on a live call. { from_number, call_number =
 *                        customer, to_agent = the caller's CTM agent id }.
 *
 * REJECTED at boot (see REJECTED_BRIDGE_RING_CALLER_MODES):
 *   to_number          - PROVEN (staging, 2026-10-03) to ring the CUSTOMER first:
 *                        { call_number = customer, to_number = caller } makes CTM
 *                        dial call_number first. It is kept out of
 *                        BRIDGE_RING_CALLER_MODES so no code path can build it.
 *
 * An unknown value FAILS THE BOOT, like every other z.enum in env.ts
 * (NODE_ENV, BRAIN_PROVIDER): a typo silently falling back to 'off' would hide
 * a misconfiguration.
 *
 * Kept in its own zod-only module so env.ts can use it without importing
 * anything that reaches prisma, and so the schema is unit-testable (env.ts
 * parses process.env at import time).
 */
export const BRIDGE_RING_CALLER_MODES = ['off', 'call_number_caller', 'to_number_user_id', 'to_agent'] as const;
export type BridgeRingCallerMode = (typeof BRIDGE_RING_CALLER_MODES)[number];

/**
 * Values that were once accepted and have since been DISPROVEN on a live call.
 * They fail the boot with a message saying why and what to use instead (the
 * message carries no secrets: just the value and the replacement mode).
 */
export const REJECTED_BRIDGE_RING_CALLER_MODES: Readonly<Record<string, string>> = {
  to_number:
    'CTM_BRIDGE_RING_CALLER=to_number rings the customer first (proven 2026-10-03); use call_number_caller',
};

// Trimmed first, like every env value (env.ts header: dashboard pastes add spaces).
export const bridgeRingCallerSchema = z
  .string()
  .trim()
  .default('off')
  .superRefine((value, ctx) => {
    const rejected = Object.prototype.hasOwnProperty.call(REJECTED_BRIDGE_RING_CALLER_MODES, value)
      ? REJECTED_BRIDGE_RING_CALLER_MODES[value]
      : undefined;
    if (rejected) ctx.addIssue({ code: z.ZodIssueCode.custom, message: rejected });
  })
  .pipe(z.enum(BRIDGE_RING_CALLER_MODES));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same shape the test-call kit accepts for an agent id.
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * CTM_BRIDGE_AGENT_IDS: "servwave-user-uuid=agentid,servwave-user-uuid=agentid".
 *
 * SPIKE-SCALE ONLY. ServWave stores no per-user CTM agent id (phone_access keys
 * agents by email), so the two agent modes read the id from this hand-written
 * map for the staging sitting. Rolling an agent mode out org-wide needs an
 * agent-sync build (slice 21's conditional path), not a longer env var.
 *
 * Unset/blank => empty map. A malformed entry fails the boot (same reasoning as
 * the mode). The map is never logged and never returned in an API response.
 */
export const bridgeAgentIdsSchema = z
  .string()
  .trim()
  .optional()
  .transform((raw, ctx): Map<string, string> => {
    const map = new Map<string, string>();
    if (!raw) return map;
    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const [userId, agentId, ...rest] = trimmed.split('=').map((s) => s.trim());
      if (rest.length || !userId || !agentId || !UUID_RE.test(userId) || !AGENT_ID_RE.test(agentId)) {
        // Deliberately does not echo the entry: it holds a vendor agent id.
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'CTM_BRIDGE_AGENT_IDS entries must look like <user-uuid>=<agent-id>, comma separated',
        });
        return z.NEVER;
      }
      map.set(userId.toLowerCase(), agentId);
    }
    return map;
  });
