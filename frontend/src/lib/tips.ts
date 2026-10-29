// SRVW-55 — chip percentages for tip UIs that have no public invoice payload to read
// tip_preset_bps from (RecordPaymentDialog). Mirrors the platform constant at
// backend/src/lib/stripe.ts CARD_TIP_PRESET_BPS. Percentages are a render-only affordance,
// never persisted and never reconciled against, so drift between the two lists only changes
// which dollar figure a chip pre-fills - bounded and cosmetic.
export const TIP_PRESET_PCT = [10, 15, 20];
