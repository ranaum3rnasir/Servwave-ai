# Open Questions — prioritized interview set

Conduct ONE topic at a time. Tier-0 = blocking (must answer before PRD). Tier-1 = high. Tier-2 = medium (defaults proposed).

## Interview topic order
1. **Product shape & tenancy** (G5, G2, G17) — is this Alpha's internal tool or a SaaS for other contractors? Existing phone system/numbers today?
2. **Backbone confirm** (G1, G2) — after CTM report: CTM-as-P1-backbone-with-CPaaS-escape-hatch vs CTM-permanent.
3. **Markets & compliance appetite** (G4, G13, G12) — states at launch, AI-disclosure stance, recording retention.
4. **Inbound shape** (G6, G15, G7, G10) — AI receptionist vs missed-call-recovery-first; after-hours policy; booking target; bilingual.
5. **Outbound aggressiveness** (G3) — confirm safe-layer-only for P1.
6. **Messaging & dispatch-by-text** (G9, G18, G14) — W-2 vs sub channel hierarchy; pay-by-text scope; numbers strategy.
7. **Data ownership** (G8) — does this module own Customer/Contact?
8. **UI placement** (G16) — sidebar routes, call console placement.
9. **Budget** (G11) — cost ceilings / spend caps.

## Tier-0 (blocking)
- T0.1 (G5) SaaS-for-others or Alpha-internal-only? White-label needed?
- T0.2 (G2) Current phone setup: provider, numbers, do we port? Already on CTM?
- T0.3 (G1) After CTM report: is CTM the permanent backbone or the fast Phase-1 path with a CPaaS adapter underneath for AI voice/outbound?
- T0.4 (G4) Which states besides NY at launch? Any all-party-consent states in scope?
- T0.5 (G3) Confirm outbound P1 = human dialer + AI-assist + warm-consented AI voice ONLY (no consumer AI cold-call / predictive).

## Tier-1 (high)
- T1.1 (G6) Talking AI receptionist day-1, or recovery stack (text-back + voicemail transcription + callback queue) first?
- T1.2 (G7) What schedule do calls book into? Define booking write target.
- T1.3 (G8) Does phone module own Customer/Contact entity, or align to a planned Customers module?
- T1.4 (G9) Channel hierarchy for techs vs subs (app-push→SMS→call escalation)?
- T1.5 (G10) EN/ES bilingual at launch?
- T1.6 (G11) Monthly cost ceiling / per-tenant budget / spend caps by time window?
- T1.7 (G12) Recording + transcript retention period?

## Tier-2 (medium — defaults proposed, confirm/override)
- T2.1 (G13) AI disclosure: always disclose (recommended)?
- T2.2 (G14) Numbers: one main tracked # vs per-branch/per-trade/per-campaign tracking #s?
- T2.3 (G15) After-hours policy + emergency triage per trade?
- T2.4 (G16) Sidebar routes + call console placement (reuse alert-bus)?
- T2.5 (G17) Human CSRs/dispatchers today (does human QA matter in P1)?
- T2.6 (G18) Pay-by-text in scope for phone module or billing module?

## Tier-3 (roadmap — capture, don't interview)
- WhatsApp timing/markets (G19); branded calling (G20); supervisor desk (G21); extra channels (G22).
