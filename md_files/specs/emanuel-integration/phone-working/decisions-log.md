# Decisions Log — Phone System + AI Communication Module

Authoritative record of locked decisions. PRD requirements must trace to a row here or to cited research.

---

## A. Framing decisions (locked by Emanuel, 2026-05-28, AskUserQuestion round 1)

| # | Decision | Choice | Source |
|---|----------|--------|--------|
| F1 | Backend reality | **Spec the backend contract.** Dashboard prototype is the UI of record; this PRD defines the webhook/API + event contracts the phone module needs (to be built). No backend exists in repo today. | Emanuel |
| F2 | Missing research handling | **Emanuel will supply** the 3 missing reports (CTM vendor-fit, phone VoC, phone competitor-teardown). → Step 2/3 synthesis of those + final architecture wait on delivery. | Emanuel |
| F3 | Telephony backbone leaning | **Lean CTM (CallTrackingMetrics).** ⚠️ Conflicts with R02 (recommends CPaaS/Telnyx, never mentions CTM). To be reconciled in §C once CTM report lands; confirm in interview. | Emanuel |
| F4 | Phase-1 scope | **4 sub-modules: (1) Inbound + call capture, (2) Two-way SMS + dispatch-by-text, (3) Call intelligence, (4) Outbound AI dialer.** WhatsApp + advanced routing/dispatch = later phases. | Emanuel |

### Derived implications (Director, pending confirmation)
- F4 + R03 tension → **Outbound P1 must be scoped to the SAFE layer**: human preview/power dialer + AI-assisted notes/dispositioning + tightly-bounded AI voice for *warm/consented* flows only. Consumer AI cold-calling + predictive dialing = explicitly deferred behind legal gates. (CONFIRM in interview — Topic: outbound aggressiveness.)
- F4 → WhatsApp deferred is consistent with R08 (WhatsApp not the NA centerpiece). But "basic call routing" is implicit in Inbound (you cannot capture calls without ring/answer/overflow), so a *minimal* routing slice rides along in P1; the *job-aware routing graph* (R06) is the later-phase feature.

---

## B. Director default decisions (from research, no Emanuel input needed unless he overrides)

| # | Decision | Default | Research basis |
|---|----------|---------|----------------|
| D1 | Architecture shape | FSM-native control plane (CRM owns identity/routing/context/auto-log/compliance ledgers) + outsourced transport (carrier/BSP). | X1 (R01/R02/R06/R08) |
| D2 | Auto-log model | Confidence-gated writes (high→auto, medium→suggest, low→review queue w/ evidence span). Never "zero manual entry." | R04 |
| D3 | Recording storage | Provider capture → encrypted canonical storage in our cloud (KMS, tenant isolation); app DB stores metadata only; log every playback/export. | R02, R04 |
| D4 | Recording consent UX | Universal disclosure at call start, tenant-configurable per queue/number/user; store consent evidence on the call record; assume stricter rule on interstate. | R02, R04 |
| D5 | Consent + campaign ledger | First-class consent ledger (who/when/how/number/seller/channel/use-case + evidence) + campaign classification driving hours/DNC/opt-out behavior. | R03, R07 |
| D6 | STT engine | Deepgram (Nova-3/Flux) primary for real-time + voice agents; batch summarization via LLM. Test on own 8kHz recordings before locking. Address VALIDATION (not transcription) for service addresses. | R04 |
| D7 | Voice biometrics | DEFERRED from MVP (IL BIPA voiceprint risk). | R04 |
| D8 | Unified inbox model | Canonical record = Customer/Contact; channel identities are child objects; one longitudinal timeline linked to job/estimate; per-message normalized event w/ channel-specific permission/pricing/window semantics. | R07, R08 |
| D9 | SMS registration | A2P 10DLC mandatory; first-class registration workflow in admin; disable production sending pre-registration; separate campaigns by function (customer-care / marketing-review / technician-ops). | R02, R07 |
| D10 | WhatsApp transport (when built) | Direct Meta Cloud API + Embedded Signup (customer-owned WABA); 360dialog as thin fallback; AVOID Twilio for WhatsApp utility volume. | R08 |
| D11 | Dispatch-by-text mechanic | Structured SMS (job ref + customer + address + window + scope + ONE next action) + secure link page (accept/decline/ack/maps/masked-call/notes); full state machine; channel hierarchy app-push → SMS → office-call escalation. | R07 |
| D12 | "Follow-the-tech" | Model the 3 distinct meanings separately: masked outbound display / proxy two-way temp masking / routing ownership by job stage. | R06 |
| D13 | QA / performance | Manage AI as a named employee; eligibility-aware metrics (gross/eligible/capacity-adjusted); review queues ordered by expected lost revenue; disputable/explainable scorecards; historical snapshots. | R05 |

---

## C. CRITICAL — Telephony Backbone: CTM vs. CPaaS (Step 3) — DRAFT, AWAITING CTM REPORT

> Status: **OPEN.** Emanuel leans CTM (F3); R02 recommends CPaaS/Telnyx and never evaluates CTM. The CTM vendor-fit report (being supplied) is the deciding input. Architecture section of the PRD is BLOCKED until this resolves.

### What CallTrackingMetrics (CTM) actually is (Director knowledge — to be validated against supplied report)
- CTM is a **call-tracking + conversation-analytics + light contact-center platform**, not a raw CPaaS. Strengths: marketing attribution (dynamic number insertion, source/keyword tracking), IVR/routing builder, call recording + transcription + AI conversation analytics, two-way SMS, softphone, form tracking, reporting dashboards, and an **open API + webhooks**. It resells numbers/minutes (Twilio-class economics marked up) and offers white-label/agency tiers.
- CTM is **closer to "buy" than "build"**: faster time-to-market for inbound tracking + routing + recording + basic SMS, less control over number ownership / recording storage economics / branded calling / E911 specifics, and per-seat + usage pricing that compresses margin at scale.

### Side-by-side (to be finalized with report 10 figures)
| Dimension | Build on CTM (Emanuel's lean) | Build on raw CPaaS (R02 rec: Telnyx primary) |
|-----------|-------------------------------|----------------------------------------------|
| Time-to-market | **Faster** — routing/IVR/recording/tracking/SMS exist out of the box | Slower — must build control plane + adapters |
| Control / white-label | Medium — CTM agency/white-label tier, but UX & number ownership constrained | **High** — own numbers, recording storage, branding |
| API depth | Good REST + webhooks; bounded by CTM's feature set | **Full** programmable voice/SMS primitives |
| Cost / margin | **Flat plan + usage** ($79/$179/$329/$1,999/mo, **unlimited seats**) + per-min/number/transcription usage → margin pressure from *usage* at volume, not seats [web research, corrects earlier "per-seat" note] | **Better margin** at volume; you keep the spread |
| Compliance handling | CTM handles much (recording, 10DLC via partner, consent tools) — less to build | You build/own 10DLC + recording + E911 + STIR/SHAKEN flows |
| AI voice / real-time | Limited to CTM's AI analytics; real-time voice-agent media streaming weaker | **Strong** — Telnyx/Twilio bidirectional media streams for AI agents |
| Fit to existing webhook contract (F1) | Webhook-friendly; CTM posts call/SMS events to our endpoints | Native — our control plane defines the contract |
| Risk | Vendor lock-in; ceiling on AI/branded-calling/E911 sophistication | Telnyx ops risk (mitigate w/ adapter + fallback); more build surface |

### Director's preliminary read (NOT final)
- **The two are not mutually exclusive, and that may be the answer.** A pragmatic Phase-1 path: **use CTM to ship Inbound capture + routing + recording + call tracking + basic two-way SMS fast** (matches Emanuel's lean and F4 priorities), while **defining the provider-adapter abstraction (D1/R02) from day one** so the AI-voice-agent + outbound-dialer + real-time-media + branded-calling layers can sit on CPaaS (Telnyx/Twilio) where CTM is weak — and so we are never locked in.
- This honors F3 (CTM) AND R02 (don't anchor on a single platform; adapters from day one). **Confirm with Emanuel after reading report 10:** is CTM the Phase-1 backbone with a CPaaS escape hatch, or is it the permanent backbone?
- Open economic question report 10 should settle: CTM per-seat/usage pricing vs. the R02 CPaaS cost model (~$9.3K/mo Telnyx vs ~$21K Twilio at the modeled volume).

### Decision: **LOCKED 2026-05-28 — Hybrid: CTM is the Phase-1 backbone; provider-adapter abstraction from day one; CPaaS (Telnyx) is the escape hatch for AI-voice / outbound real-time media.**

> **UPDATE 2026-05-28:** The supplied "CTM report" was the wrong document (a depression-RCT pilot). Director ran live **web research** instead (synthesis-notes Step-3 Supplement; PRD §13.5). Findings **strengthen** this decision and corrected one draft error (CTM is flat-plan + usage with unlimited seats, NOT per-seat). The CPaaS escape-hatch rationale **narrows** because CTM now ships a native AI voice agent (VoiceAI, $0.12/min) + Deepgram STT + 10DLC Trust Center + sub-account multi-tenancy.
>
> Decision made on the strength of the interview (I2: Alpha already runs on CTM; I1: multi-tenant SaaS → CTM agency/sub-account model is a ready multi-tenant substrate) + research (R02: never anchor on one platform, adapters from day one) + web vendor-fit research. This honors F3 (CTM lean) AND R02 (don't lock in). Rationale:
> - **CTM carries Phase-1 inbound**: number provisioning + tracking pools (D14/T2.2), IVR/routing, call recording + transcription hooks, two-way SMS, softphone/screen-pop, marketing attribution. Fastest time-to-market and matches Alpha's current state.
> - **CTM account/sub-account (agency) tier = the multi-tenant substrate** for P1 (one sub-account per tenant; numbers/recordings/campaigns/users scoped to the sub-account).
> - **The provider-adapter interface (D1) is mandatory from day one** so the AI-voice-agent, outbound real-time media (bidirectional streaming for AI agents), and branded-calling layers — where CTM is thin — can sit on Telnyx/Twilio without re-platforming. The CRM owns the control plane (identity, routing graph, consent/compliance ledgers, recording canonical storage, auto-log); CTM and CPaaS are interchangeable transports behind the adapter.
> - **Recording canonical storage is OURS regardless of transport** (D3): provider captures, we pull to encrypted tenant-isolated storage, app DB holds metadata only.
> - **RESOLVED via web research (2026-05-28):** CTM API surface (REST + bidirectional webhooks, near-real-time call/SMS/recording/transcription events), multi-tenant sub-accounts, 10DLC Trust Center, Deepgram STT, native VoiceAI agent, porting (2–4 wk). Pricing corrected to flat-plan + usage / unlimited seats.
> - **STILL OPEN (non-blocking, verify with CTM directly):** VoiceAI **bilingual EN-ES** (PRD requires ES in P1 → if absent, ES AI voice rides the CPaaS adapter); raw **real-time bidirectional media-streaming API** for custom agents; **recording retention + canonical-copy export**; **E911 / Kari's-Law / RAY-BAUM'S** dynamic location; full **predictive-dialer abandonment** controls; **at-scale usage economics** vs Telnyx (~$9.3K/mo) / Twilio (~$21K/mo) — needs Alpha's actual minute/number/message volumes. The adapter lets us shift any of these to CPaaS without a control-plane/UI rewrite → does not block the PRD.

---

## D. Interview-confirmed decisions (Round 2, 2026-05-28)

| # | Decision | Choice | Implication |
|---|----------|--------|-------------|
| I1 | **Tenancy** | **Multi-tenant SaaS** for other contractors (Alpha is tenant #1). | Every number/recording/campaign/WABA/consent record is tenant-scoped. Onboarding = per-tenant provisioning + 10DLC registration. White-label likely (confirm). |
| I2 | **Current backbone** | **Alpha already on CTM.** | Build on CTM; use CTM account/sub-account model as multi-tenant substrate for P1. Validates F3. Final CTM-vs-CPaaS scope still pending report 10. |
| I3 | **Who answers** | **Human CSR/dispatch team present.** | P1 includes human call console (screen-pop) + human QA scorecards + AI overflow/after-hours. Both human + AI agents tracked (R05). AI = backup, not default. |
| I4 | **CTM plan + integration model** (2026-05-28) | **Sales Engage plan** ($329/mo + usage). Create a **CTM sub-account**; integrate **headless**: the CRM is the UI of record, CTM is the backend via **REST API + webhooks**. ("White-labeling inside our CRM" = build our own UI on CTM's backend, NOT CTM's rebranded-UI white-label product.) | Sales Engage includes (verified web): **unlimited sub-accounts, API access, VOIP softphone (in+out), two-way SMS, VoiceAI, Smart Dialer**. Confirms the embedded-control-plane model (§5.1/D1): CRM owns UI + control plane; CTM behind the adapter. Alpha's Sales Engage = **parent/agency** account; each SaaS tenant = a **sub-account** (Alpha's own sub-account is tenant #1). VoiceAI/Smart-Dialer carry usage cost (VoiceAI $0.12/min after 250 free/agent). CTM domain-white-label tier = optional, not required for headless model. |

> I1 escalates G5→resolved (multi-tenant). G2 resolved (on CTM; Sales Engage + sub-account chosen — I4). G1/T0.3 resolved (§C LOCKED hybrid). I4 confirms commercial + integration model.
> **Verify with CTM at onboarding:** whether CTM's domain-white-label product is bundled in Sales Engage or needs the Marketing-Pro/agency add-on (only matters IF Alpha ever exposes CTM's native UI to a tenant — not needed for the headless CRM-UI model).

---

## E. Director-locked resolutions for the remaining open items (2026-05-28, Auto Mode — report 10 not supplied; reasonable calls made, flagged in PRD §12)

| # | Item | Resolution | Basis / flag |
|---|------|-----------|-------------|
| E1 | **After-hours / emergency (T2.3 / G15)** — answer rendered ambiguously as "1-3" | **Comprehensive triage (superset).** Rule-based emergency triage classifies by trade (gas/CO/no-heat/burst-pipe/electrical/lockout) → true emergencies escalate to on-call queue/number with priority + capture fee/authorization acknowledgment before dispatch; non-emergencies → missed-call text-back + callback queue + voicemail transcription; simple on-call forwarding supported as a per-tenant config. Emergency = structured dispatch object (R06), not "press 9." | R06 emergency object; R01 recovery stack. Confirm exact per-trade triage tree at build. |
| E2 | **Budget / cost ceiling (T1.6 / G11)** | **Per-tenant hard monthly ceiling = a configurable platform primitive**, set per tenant at onboarding (Alpha's number is a config value, not a platform constant). Spend governed by category sub-caps (AI voice minutes, recording storage GB-months, outbound message/min volume) with time-window caps (R01) + soft-alert thresholds (e.g. 80%) and a hard cutover behavior (degrade AI→human/voicemail, suspend non-critical outbound) when the ceiling is hit. Critical inbound + compliance never hard-blocked by spend caps. | R01 spend caps. Actual Alpha ceiling figure = open assumption (§12); product spec is the mechanism, which doesn't depend on the number. |
| E3 | **UI placement (T2.4 / G16)** | **Three new top-level sidebar routes** — `Inbox` (unified omnichannel), `Dispatch / Calls`, `Performance / QA`. Softphone/call-console = a component mounted inside Inbox + Dispatch routes (NOT a persistent global docked bar). Incoming-call + new-message notifications fire globally via the existing `alert-bus` (`subscribeAlertIntent`) → toast + route-jump, reusing the dashboard's established pattern. | Emanuel's R6 selection (3 routes, no global bar). alert-bus reuse per Step-1 inventory. |
| E4 | **Numbers strategy (T2.2 / G14)** → D14 | **Per tenant: one main business number + optional per-branch numbers + campaign/source tracking-number pools (marketing attribution) + purpose-separated pools (sales vs dispatch/reminders).** Plays directly to CTM's tracking-number strength. | R02 number layers; CTM strength; Emanuel R5. |
