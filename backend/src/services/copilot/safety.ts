/**
 * Copilot safety: a deterministic, multilingual (EN/HE/ES) contradiction
 * detector that runs POST-HOC on every committed assistant turn.
 *
 * The structural guarantee is that no side effect happens without a gated,
 * user-confirmed tool call (see the design's Gateway-Tools architecture). This
 * detector is the second line of defence: it scans the assistant's *words* for
 * claims of having performed an action the copilot CANNOT actually do — namely
 * SENDING a message/email/SMS/WhatsApp (drafts only — there is no send path) or
 * DELETING a record (the copilot exposes no delete tool). When such a claim is
 * found, the caller swaps the turn for a generic safe fallback and logs a
 * content-free audit event.
 *
 * Scope is deliberately narrow (send + delete) to avoid false positives on
 * legitimately-supported, approval-gated actions like recording a payment.
 */

export interface ContradictionResult {
  tripped: boolean;
  reason?: string;
  matched?: string;
}

export const SAFE_FALLBACK = "I couldn't safely complete that response. No changes were made.";

// Each rule pairs a human-readable reason with patterns across the three
// first-class languages. Patterns target *completed* claims ("I sent…",
// "the email was sent", "נשלח", "se ha enviado") — not future/offer phrasing
// ("I can send", "would you like me to send", "I drafted…").
interface Rule {
  reason: string;
  patterns: RegExp[];
}

const RULES: Rule[] = [
  {
    reason: 'claimed to have sent a message/email/SMS (the copilot can only draft — nothing is ever sent)',
    patterns: [
      // English — completed send claims (guard against "draft"/"can"/"will"/"would").
      // "estimate" is deliberately carved out: sending an estimate through its
      // approval card is a sanctioned system email, so truthful "I sent the
      // estimate (email)" must not trip. Everything else — including "invoice
      // email" (no sanctioned invoice-send path exists) — still trips; the
      // optional filler word covers "the invoice email" / "a reminder text".
      /\bi(?:'ve| have)?\s+(?:just\s+)?sent\s+(?:the\s+|a\s+|an\s+|your\s+)?(?!estimate\b)(?:\w+\s+)?(?:e-?mail|message|text|sms|whatsapp|reminder|note|invoice|notification)/i,
      /\bi(?:'ve| have)?\s+(?:just\s+)?(?:e-?mailed|texted|messaged)\b/i,
      /\b(?:the\s+|your\s+|an\s+|a\s+)?(?:e-?mail|message|text|sms|whatsapp|reminder|notification)\s+(?:has been|have been|was|were|is|got)\s+sent\b/i,
      // Hebrew — שלחתי (I sent), נשלח/נשלחה (was sent). No \b: JS word
      // boundaries are ASCII-only and never match between Hebrew letters.
      /שלחתי/,
      /נשלח/,
      // Spanish — envié / he enviado / se ha enviado / fue enviado / mensaje enviado
      /\b(?:he\s+enviad[oa]|envi[ée]|se\s+(?:ha|han)\s+enviad[oa]|fue\s+enviad[oa]|(?:correo|mensaje|email)\s+enviad[oa])\b/i,
    ],
  },
  {
    reason: 'claimed to have deleted a record (the copilot exposes no delete capability)',
    patterns: [
      /\bi(?:'ve| have)?\s+(?:just\s+)?(?:deleted|removed|erased)\s+(?:the\s+|that\s+|this\s+|your\s+|a\s+|an\s+)/i,
      /\b(?:has been|have been|was|were)\s+(?:permanently\s+)?(?:deleted|removed|erased)\b/i,
      /מחקתי/,
      /\b(?:he\s+eliminad[oa]|elimin[ée]|he\s+borrad[oa]|borr[ée]|se\s+(?:ha|han)\s+eliminad[oa])\b/i,
    ],
  },
];

export function detectContradiction(text: string): ContradictionResult {
  if (!text) return { tripped: false };
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const m = pattern.exec(text);
      if (m) {
        return { tripped: true, reason: rule.reason, matched: m[0] };
      }
    }
  }
  return { tripped: false };
}
