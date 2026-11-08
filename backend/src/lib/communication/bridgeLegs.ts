import type { BridgeRingCallerMode } from '../../config/bridgeRingCaller';
import { normalizeNAPhone } from '../comms-identity';

/**
 * The ring-first fields a bridge request may carry (placeCall sends only those
 * present). `call_number`, when present, REPLACES the default call_number (the
 * customer) at the call site: in call_number_caller mode it is the caller's own
 * phone, which CTM rings first.
 */
export interface BridgeLegs {
  call_number?: string;
  to_number?: string;
  user_id?: string;
  to_agent?: string;
}

export type BridgeLegsRefusal = 'missing' | 'invalid' | 'extension' | 'caller_is_customer' | 'agent_missing';

export type BridgeLegsResult =
  | { ok: true; legs: BridgeLegs }
  | { ok: false; reason: BridgeLegsRefusal };

export interface BridgeCaller {
  id: string;
  phone: string | null | undefined;
  phone_ext: string | null | undefined;
}

/**
 * The ONE mapping from the CTM_BRIDGE_RING_CALLER switch to request fields
 * (see config/bridgeRingCaller.ts for what each mode means and why).
 *
 * Role-agnostic on purpose: it never looks at the caller's role.
 *
 * In every mode except 'off' the caller needs a usable profile phone: present
 * ('missing'), dialable as E.164 ('invalid'), and WITHOUT an extension, whether
 * in phone_ext or typed inline after the number ('extension': an extension
 * cannot be the first leg of a bridge - nobody would be there to dial it). It
 * also must not be the number being called ('caller_is_customer'). 'off' never
 * reads the profile phone, so today's callers are unaffected while it is off.
 *
 * call_number_caller (PROVEN live, 2026-10-03) returns the caller's phone as
 * call_number and the customer as to_number: CTM rings call_number first.
 */
export function buildBridgeLegs(
  mode: BridgeRingCallerMode,
  caller: BridgeCaller,
  agentIds: ReadonlyMap<string, string>,
  customerE164: string,
): BridgeLegsResult {
  if (mode === 'off') return { ok: true, legs: {} };

  const raw = caller.phone?.trim() ?? '';
  if (!raw) return { ok: false, reason: 'missing' };
  const e164 = normalizeNAPhone(raw);
  if (!e164) {
    // More than 11 digits = a full 10/11-digit number with extra digits after
    // it, i.e. an extension typed into the phone box ("609-555-0142 x204").
    return { ok: false, reason: raw.replace(/\D/g, '').length > 11 ? 'extension' : 'invalid' };
  }
  if (caller.phone_ext && caller.phone_ext.trim() !== '') return { ok: false, reason: 'extension' };
  if (customerE164 === e164) return { ok: false, reason: 'caller_is_customer' };

  if (mode === 'call_number_caller') return { ok: true, legs: { call_number: e164, to_number: customerE164 } };

  const agentId = agentIds.get(caller.id.toLowerCase());
  if (!agentId) return { ok: false, reason: 'agent_missing' };

  // UNTESTED live; same leg order as the disproven to_number mode (customer in
  // call_number), so it very likely rings the customer first.
  if (mode === 'to_number_user_id') return { ok: true, legs: { to_number: e164, user_id: agentId } };
  return { ok: true, legs: { to_agent: agentId } };
}

/**
 * Mask phone-like digit runs (7+ digits, separators allowed) to their last 4,
 * for logging vendor error text that may echo the caller's own phone back.
 */
export function maskLongDigitRuns(text: string): string {
  return text.replace(/\+?\(?\d[\d\s().-]*\d/g, (run) => {
    const digits = run.replace(/\D/g, '');
    return digits.length >= 7 ? `***${digits.slice(-4)}` : run;
  });
}
