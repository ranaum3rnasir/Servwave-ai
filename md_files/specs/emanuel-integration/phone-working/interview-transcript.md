# Interview Transcript — Emanuel Dahan

Phone System + AI Communication Module. Director Architect interview.

## Round 1 — Framing (2026-05-28, AskUserQuestion)
- **Backend reality** → Spec the backend contract (no backend in repo; dashboard is UI of record).
- **Missing research** → Emanuel will supply CTM vendor-fit + phone VoC + phone competitor-teardown.
- **Backbone leaning** → Lean CTM.
- **Phase-1 scope** → Inbound + call capture · Two-way SMS + dispatch-by-text · Call intelligence · Outbound AI dialer.

## Round 2 — Product shape & current state (pending)
_(Topic 1: tenancy, current phone setup, human CSRs)_

## Round 2 — Product shape & current state (2026-05-28, AskUserQuestion) — ANSWERED
- **Tenancy (T0.1)** → **SaaS for other contractors.** Multi-tenant. Per-tenant numbers, 10DLC brand/campaign registration, WhatsApp WABA (Embedded Signup), recording policy, white-label likely. Strongly aligns w/ R02 control-plane-owns-tenants + R08 Embedded Signup.
- **Current phones (T0.2)** → **Already on CTM.** Alpha uses CallTrackingMetrics today → validates F3 lean; product builds on CTM. CTM agency/sub-account tier relevant for multi-tenant. (Still need report 10 for final backbone + multi-tenant fit.)
- **Who answers (T2.5)** → **Office CSR/dispatch team.** Human-agent QA + performance scorecards ARE in P1 scope (R05). AI receptionist = overflow/after-hours backup, not the default front line.

### Derived implications
- Multi-tenant SaaS → every telephony/messaging entity is tenant-scoped; onboarding includes per-tenant number provisioning + 10DLC registration workflow + (later) WhatsApp Embedded Signup. White-label = likely requirement (confirm specifics).
- "Already on CTM" + multi-tenant: CTM's **account/sub-account (agency) model** is the natural multi-tenant substrate for P1 — strengthens the "CTM-as-Phase-1-backbone" path. CPaaS escape-hatch still recommended for AI-voice/outbound real-time media where CTM is thin.
- Human CSR team present → P1 includes: live screen-pop/call console for CSRs, human QA scorecards + review queues, AND AI overflow/after-hours. Both human and AI agents tracked (R05 "named employee" model applies to AI; human KPIs apply to CSRs).

## Round 3 — Markets & compliance appetite (2026-05-28, AskUserQuestion) — ANSWERED
- **Markets (T0.4)** → **National, per-state aware.** Engine handles per-state recording consent (one/all-party), calling-hour windows by called-party locale, DNC by default. ✓ aligns research.
- **AI disclosure (T2.1)** → **"Disclose only when required."** ⚠️ RISK-TOLERANT (Director recommended always-disclose). Honor, but: build disclosure as tenant-configurable with per-jurisdiction legal-minimum default; log tenant's choice in consent/compliance ledger; PRD must flag FCC artificial-voice exposure + recommend counsel. NOT legal advice.
- **Retention (T1.7)** → **Indefinite until deleted.** ⚠️ RISK-TOLERANT. Honor as tenant-configurable default; add legal-hold, manual purge, per-state minimization override; PRD flags CPRA/minimization + storage-cost exposure.
- **Outbound ceiling (T0.5)** → **"I want aggressive outbound."** Owner explicitly wants to push outbound. Director commitment: spec most capable engine + HARD compliance layer (consent ledger, DNC/suppression, hour windows, number-health, abandonment cap), and gate red-zone features (consumer AI cold-call, predictive of cold lists, voicemail-drop) behind explicit per-tenant legal-acknowledgment + logged risk acceptance. Clarifier asked (Round 3b).

### Risk register (carry into PRD §9 + §12)
- RISK-1: minimal AI disclosure vs FCC artificial-voice rule → legal exposure on outbound AI voice.
- RISK-2: indefinite retention vs CPRA minimization → privacy/storage exposure.
- RISK-3: aggressive outbound → TCPA/robocall exposure; mitigate with compliance engine + gates; residual risk accepted per-tenant w/ counsel.

## Round 3b — Outbound clarifier (2026-05-28, AskUserQuestion) — ANSWERED
- **Outbound posture** → **"Ship all tools, warn, tenant decides."** Tool-provider model: platform ships full capability set (preview/power/predictive dialers, AI voice agents, voicemail drop, reactivation) + UN-BYPASSABLE compliance engine + in-product TCPA warnings + per-tenant acceptable-use + per-campaign legal-acknowledgment, all logged as evidence. Tenant + counsel own legal risk. Consistent with how CTM/Twilio/Telnyx themselves operate (AUP + 10DLC + customer-is-responsible-party).
- **Outbound P1 use-cases** → ALL FOUR: speed-to-lead callback, estimate/quote follow-up, appointment confirmations + on-the-way, dead-lead reactivation.

### Director guardrails on "ship all tools" (PRD §9)
- Compliance engine is mandatory + non-bypassable: consent ledger; DNC scrub (national + state + internal 5yr); calling-hour windows by called-party locale; predictive abandonment ≤3% (2s live-rep rule, ≥15s/4-ring); mandatory caller-ID transmission; opt-out honored ≤10 business days; number-health telemetry; A2P 10DLC gating for SMS (no send pre-registration).
- Campaign classification drives gates (informational / operational / estimate / reactivation / renewal / review / telemarketing). Telemarketing + AI-voice-to-consumer-mobile + predictive-cold + voicemail-drop = HIGH-RISK tier → per-campaign legal-acknowledgment screen + logged tenant risk acceptance + counsel-review prompt.
- **LINE HELD (will NOT spec):** caller-ID spoofing/blocking, STIR/SHAKEN evasion, bad-faith number-rotation-to-dodge-spam-labels. These facilitate illegal robocalling/detection-evasion; research confirms caller-ID transmission is legally mandatory. Legitimate number-health/reputation/warmup tooling IS in scope.
- PRD §9 states plainly: platform = tool + compliance-evidence provider; legal responsibility sits with tenant + their counsel. NOT legal advice; recommend telecom/TCPA counsel review before enabling high-risk tiers.

## Round 4 — Inbound shape (2026-05-28, AskUserQuestion) — ANSWERED
- **Inbound P1 (T1.1)** → **Recovery stack + AI capture first.** P1 = call capture/logging + CSR screen-pop + missed-call text-back + voicemail transcription + callback queue + after-hours/overflow AI that captures/qualifies and books only simple rules-based jobs. Full conversational AI booking = fast-follow.
- **Booking target (T1.2)** → **Write to Jobs store.** Calls/AI create/update existing `Job` records (scheduledFor + assignedTechId). Dispatch-board UI later. → phone module extends Jobs; needs a structured-booking write path + booking-integrity exception alerts (R01).
- **Bilingual (T1.5)** → **EN + ES at launch.** AI receptionist + texts + templates support English & Spanish in P1.

## Round 5 — Messaging & dispatch-by-text (2026-05-28, AskUserQuestion) — ANSWERED
- **Dispatch channel (T1.4)** → **App-push for W-2, SMS-link for subs.** W-2: in-app push first → SMS fallback on no-ack → office-call escalation. Subs (no login): structured SMS + secure-link page (accept/decline/maps/notes/close). Full state machine (R07/D11).
- **Pay-by-text (T2.6)** → **Later phase.** Messaging may carry a link from a future billing module; phone module does NOT own payments in P1.
- **Numbers (T2.2)** → **Main + per-branch + tracking pools.** Per tenant: main business #, optional per-branch #s, campaign/source tracking-number pools (marketing attribution), separate purpose pools (sales vs dispatch/reminders). Plays to CTM strength.

## Round 6 — After-hours, data ownership, UI, budget (2026-05-28, AskUserQuestion) — ANSWERED
- **After-hours/emergency (T2.3)** → answer rendered as "1-3" (ambiguous; non-multiselect). INTERPRETING as the superset = comprehensive option: rule-based emergency triage → escalate true emergencies to on-call queue/number w/ priority + capture fee/authorization before dispatch; non-emergencies → text-back + callback queue; simple on-call forwarding supported as a config. CONFIRMING in Round 6b.
- **Customer/Contact ownership (T1.3)** → **This module defines it.** Phone module introduces Customer + Contact + phone-number/channel-identity entities (unified-inbox canonical record) + back-links Jobs. Future Customers/CRM module builds on it.
- **UI placement (T2.4)** → **Unified Inbox route + Dispatch/Calls route + Performance/QA route.** (Did NOT select a persistent global call console.) INTERPRETING: softphone/call-console lives as a component INSIDE the Inbox + Dispatch routes; incoming-call toasts still fire globally via alert-bus; no always-docked global bar. Note for confirmation.
- **Budget (T1.6)** → **Hard monthly ceiling.** Need the number + scope (per-tenant vs platform). Asking in Round 6b.
