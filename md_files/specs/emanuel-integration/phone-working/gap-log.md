# Gap Log — decisions research does NOT settle

Each gap → an interview question (see open-questions.md). Resolved gaps move to decisions-log.md.

## Resolved by framing round (see decisions-log §A)
- ~~Backend reality~~ → F1 (spec the contract)
- ~~Missing research~~ → F2 (Emanuel supplies)
- ~~Backbone leaning~~ → F3 (lean CTM; still needs report 10 + reconciliation)
- ~~Phase-1 scope~~ → F4 (4 sub-modules)

## RESOLVED — BLOCKING gaps now closed (PRD written 2026-05-28)
- ~~**G1. CTM vs CPaaS final**~~ → RESOLVED §C LOCKED: CTM P1 backbone + CPaaS adapter from day one. Report 10 not supplied; decision made on interview (I2/I1) + R02; adapter de-risks later swap. (PRD §5.2)
- ~~**G2. Existing CTM/telephony account?**~~ → RESOLVED (I2: Alpha already on CTM). Current numbers/port details = open assumption A-3 (onboarding-time, non-blocking).
- ~~**G3. Outbound aggressiveness ceiling**~~ → RESOLVED (Round 3b): "ship all tools, warn, tenant decides" + un-bypassable compliance engine + high-risk gates. (PRD §4.4, §9)
- ~~**G4. Markets / states for compliance**~~ → RESOLVED (R3: national, per-state aware; engine handles one/all-party + hours by called-party locale + DNC). (PRD §9)
- ~~**G5. Multi-tenant or single-tenant?**~~ → RESOLVED (I1: multi-tenant SaaS; tenant = CTM sub-account; white-label likely). (PRD §5.6)

## Still open — HIGH (shape feature specs but not blocking architecture)
- **G6. AI voice receptionist in P1, or missed-call-recovery-first?** R01 says cheapest reliable win is missed-call text-back + voicemail transcription + callback queue; full AI booking is riskier. Does Emanuel want a talking AI receptionist day 1, or the recovery stack first with AI booking as a fast-follow?
- **G7. Booking integration target.** AI/calls book into *what* schedule? The dashboard has Jobs w/ scheduledFor + assignedTechId but no scheduling board/calendar UI yet. Is there a scheduler this hooks to, or does the phone module define booking writes to the Jobs store?
- **G8. Customer/Contact entity ownership.** Phone module must introduce Customer + Contact + phone-number entities (today customer is a bare string on Job). Does Emanuel want this module to OWN that entity, or is a Customers module planned separately that we should align to?
- **G9. Dispatch-by-text: W-2 techs vs subcontractors.** Workiz model is app-less subs. Alpha has both (techs.ts has `subcontractor` role + 1099 Alex). Do W-2 techs get app-push-first (SMS fallback) and only subs get the SMS+secure-link flow? Confirm channel hierarchy.
- **G10. Bilingual (EN/ES) in P1?** R01 says EN/ES is now standard. Alpha's workforce/customer base — Spanish needed at launch for receptionist + texts?
- **G11. Budget posture / cost ceiling.** Telephony has real per-minute/per-message/per-seat costs. Is there a monthly cost ceiling or per-tenant budget target that should cap AI-minutes / recording retention / outbound volume? Spend caps by time window (R01) — desired?
- **G12. Recording retention period.** How long to retain recordings/transcripts? (Storage cost + compliance minimization both push on this.)

## Still open — MEDIUM (defaults proposed; Emanuel confirms or overrides)
- **G13. AI disclosure stance** — always disclose "you're speaking with an AI assistant"? (R01: configurable; FCC AI-voice rules push toward disclosure.) Recommend: always-disclose default.
- **G14. Numbers strategy** — one main tracked number, or per-branch / per-trade / per-campaign tracking numbers? (CTM excels at the latter.)
- **G15. After-hours/overflow policy** — what happens after hours in P1: AI books / AI captures + callback queue / voicemail + text-back? Per-trade emergency triage (gas/CO/no-heat/burst-pipe/lockout)?
- **G16. Phone UI placement in dashboard** — new top-level sidebar routes? Which: "Calls"/"Inbox"/"Dispatch"? Floating call console (softphone) docked persistently, or per-page? (Reuse alert-bus pattern for incoming-call toasts.)
- **G17. Who answers calls** — does Alpha have human CSRs/dispatchers today, or is AI receptionist filling a no-CSR gap? (Shapes whether human QA scorecards matter in P1.)
- **G18. Payments by text/link** — is pay-by-text in scope (R07 lists it high-value), or out of scope for the phone module (handled by a billing module)?

## Still open — LOW (roadmap; capture, don't block)
- **G19.** WhatsApp phase timing + which markets justify it (international customers?).
- **G20.** Branded calling (logo/name on mobile) — Phase 2/3 nice-to-have.
- **G21.** Live supervisor desk (listen/whisper/barge) — when?
- **G22.** Multi-channel beyond SMS/WhatsApp (Instagram/Messenger/Apple Messages) — roadmap only.
