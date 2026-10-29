# Phone System + AI Communication Module — Product Requirements Document

**Product:** Alpha FSM CRM — Phone System + AI Communication Module
**Owner:** Emanuel Dahan (Alpha Security US)
**Author:** Director Architect (PRD synthesis)
**Status:** Draft for build — Phase 1 MVP
**Date:** 2026-05-28 · **Revised:** 2026-05-30 (see §14 — Prototype Build Addendum)
**Traceability:** Every requirement traces to a research report (R01–R08, see §13) or a locked decision (F/D/I/E rows in `working/decisions-log.md`). Decisions cited inline as `[F3]`, `[D1]`, `[I2]`, `[E2]`, etc.

> **Compliance disclaimer (applies to the whole document, expanded in §9):** This PRD specifies product capabilities and a compliance-evidence engine. **It is not legal advice.** The platform is a tool + compliance-evidence provider; legal responsibility for telephony, recording, and outbound campaigns sits with the tenant and their counsel. Tenants must obtain telecom/TCPA counsel review before enabling high-risk features.

---

## 1. Overview & Goals

### 1.1 What this is
The Phone System + AI Communication Module turns the Alpha FSM CRM from a back-office record system into the **communication backbone** of a field-service business: every inbound call, outbound call, SMS, voicemail, and (later) WhatsApp/chat message flows through one CRM-owned control plane that knows the customer, the job, the assigned tech, the hours, and the compliance posture. AI assists — capturing, transcribing, summarizing, qualifying, dispositioning, and (for warm/consented flows) talking — but the CRM, not the carrier, owns identity, routing, context, auto-logging, and the compliance ledgers. `[D1, X1]`

### 1.2 Why (problem statement)
Field-service businesses lose revenue at the phone, not in the field. 27% of home-services calls go unanswered (18% weekday / 41% weekend); 60% of customers prefer to call; and speed-to-lead odds drop ~100× from a 5-minute to a 30-minute callback. `[R01]` The expensive failure is not "the AI sounded robotic" — it is **missed demand** and **bookings that never survive into the field app** (the #1 review complaint across ServiceTitan/Workiz/Housecall Pro). `[R01]` Logging is slow and manual; dispatch-by-text to subcontractors is validated but underserved `[R07]`; and outbound revenue sitting in the existing database (open estimates, dead leads, due renewals) goes unworked. `[R03]`

### 1.3 Goals (measurable outcomes)
| # | Goal | Target (per-tenant, evaluated 90 days post-launch) | Metric source |
|---|------|------|---------------|
| G-1 | Stop losing inbound demand | Unanswered-call rate ↓ to <10% (from ~27% baseline); 100% of missed calls get an automated text-back within 60s | R01, R05 |
| G-2 | Speed-to-lead | Median first-callback on a new-lead missed call <5 min during business hours | R01, R03 |
| G-3 | Bookings survive into the field | ≥98% of AI/console-created bookings appear correctly on the assigned tech's job within 60s; booking-integrity exceptions surfaced, not silent | R01 |
| G-4 | Logging is automatic & trustworthy | ≥70% of call data fields auto-logged at high confidence; 0 silent wrong-writes (low-confidence → review queue with evidence span) | R04 |
| G-5 | Outbound monetizes the database | Speed-to-lead callback, estimate follow-up, confirmations/on-the-way, and dead-lead reactivation all live, each gated by the compliance engine | R03 |
| G-6 | Compliance is provable | 100% of recorded calls carry consent evidence; 100% of outbound campaigns carry a classification + (for high-risk) a logged legal-acknowledgment; 0 sends before 10DLC registration | R02, R03, R07 |
| G-7 | Manage human + AI agents on one yardstick | One interaction ledger (call→intent→booking→job→estimate→revenue) powering eligibility-aware scorecards for both CSRs and AI agents | R05 |

### 1.4 Non-goals (Phase 1) — see §2.3 for the full phasing
- Not building carrier infrastructure; not anchoring on a white-label PBX/OEM. `[R02]`
- Not WhatsApp/Instagram/Apple Messages at launch (later phase). `[F4, T2, R08]`
- Not voice biometrics / voiceprints (IL BIPA risk — deferred). `[D7, R04]`
- Not payments/pay-by-text inside this module (a future billing module owns payments; messaging may carry a link). `[T2.6]`
- Not the full conversational AI booking agent day 1 (recovery stack + simple rules-based booking first; full conversational booking is a fast-follow). `[I_R4]`
- Not the job-aware routing *graph* as a premium feature at launch (a minimal routing slice rides along with inbound capture; the full graph is later phase). `[F4 derived, R06]`

---

## 2. Scope & Phasing

### 2.1 Phase-1 sub-modules (locked) `[F4]`
1. **Inbound + call capture** — call logging, CSR screen-pop, missed-call text-back, voicemail transcription, callback queue, after-hours/overflow AI that captures/qualifies and books simple rules-based jobs.
2. **Two-way SMS + dispatch-by-text** — customer texting (unified inbox) + technician/subcontractor dispatch-by-text with a secure-link state machine.
3. **Call intelligence** — transcription, summary, entity extraction, sentiment/disposition, confidence-gated auto-log.
4. **Outbound AI dialer** — full tool set (preview/power/predictive dialers, AI voice agents, voicemail drop, reactivation) behind an un-bypassable compliance engine. `[Round 3b]`

### 2.2 Cross-cutting Phase-1 foundations (required by all four)
- **Provider-adapter control plane** (CTM as P1 transport, CPaaS escape hatch). `[§C, D1]`
- **Customer/Contact/Channel-identity data model** (this module defines it). `[T1.3, D8]`
- **Consent + campaign + recording compliance ledgers.** `[D5, D4, X4]`
- **Multi-tenant scoping** (tenant = CTM sub-account; per-tenant numbers/recording/10DLC/users). `[I1]`
- **Three sidebar routes + alert-bus notifications + in-route softphone console.** `[E3]`
- **Bilingual EN + ES** across AI receptionist, texts, and templates. `[I_R4]`

### 2.3 Phasing summary (detail in §11)
| Phase | Theme | Headline contents |
|-------|-------|-------------------|
| **P1 (MVP)** | Capture demand, log automatically, dispatch by text, compliant outbound | The 4 sub-modules above + foundations |
| **P1.5 (fast-follow)** | Conversational AI booking; real-time alerts | Full conversational AI receptionist booking; real-time upset/emergency alerts; rubric QA scorecards |
| **P2** | Job-aware routing; WhatsApp; branded calling | Job-aware routing graph; WhatsApp (Embedded Signup); branded calling; supervisor desk (listen/whisper/barge) |
| **P3** | Multi-channel; advanced QA | Instagram/Messenger/Apple Messages; predictive QA; voiceprints only if BIPA risk resolved |

---

## 3. User Roles & Personas

Roles extend the existing `UserRole` union in `dashboard/src/data/current-user.ts` (owner | admin | office_admin | dispatcher | field_technician | subcontractor_tech | warehouse_manager | inventory_admin | purchaser | accountant). The phone module adds capability checks (not necessarily new roles) and one **non-human "agent" identity** type. `[Step-1 inventory, R05]`

| Persona | Role(s) | Phone-module needs |
|---------|---------|--------------------|
| **Owner** (Emanuel) | owner | Tenant config, compliance acknowledgments, spend ceilings `[E2]`, performance dashboards across human+AI. |
| **Office CSR / Dispatcher** | office_admin, dispatcher | Live screen-pop call console, unified inbox, callback queue, dispatch-by-text, booking writes, QA review of own calls. `[I3]` |
| **Field technician (W-2)** | field_technician | App-push dispatch first, masked callback, accept/reject, voicemail, disposition. `[T1.4, R06]` |
| **Subcontractor (1099)** | subcontractor_tech | App-less: structured SMS + secure-link page (accept/decline/maps/notes/close). `[T1.4, R07]` |
| **QA reviewer / supervisor** | owner, admin, office_admin | Eligibility-aware scorecards, review queues ordered by expected lost revenue, calibration/dispute. `[R05]` |
| **AI Agent (non-human)** | new `AgentIdentity` (managed like a named employee) | Has a roster card, KPIs, scorecards; appears in performance views beside humans. `[R05, D13]` |
| **Tenant admin (other contractors)** | owner/admin within their tenant | Per-tenant onboarding: number provisioning, 10DLC registration, recording policy, acceptable-use + legal acknowledgments, white-label. `[I1]` |
| **Platform operator** (Alpha-as-vendor) | platform-level | Provision tenants/sub-accounts, monitor number health, manage adapters. `[I1]` |

---

## 4. Feature Specifications (per sub-module)

> Acceptance criteria use Given/When/Then or checklists. Each feature cites its decision/research anchor.

### 4.1 Inbound + Call Capture `[F4-1, R01, R06]`

#### 4.1.A Call logging & the interaction record
Every inbound call creates a `CallSession` record (see §6) the moment it rings, regardless of answer. Captures: tenant, direction, from/to numbers, tracking-number/source attribution `[E4]`, ring/answer/end timestamps, answered-by (CSR id | AI agent id | voicemail | abandoned), recording ref + consent evidence, linked Customer/Contact/Job (resolved via the context graph), disposition.
- **AC:** Given any inbound call, when it rings, then a `CallSession` exists with status `ringing` and an attribution source; when it ends, then status, duration, recording ref, and disposition are persisted; an unanswered call is logged as `abandoned`, never dropped silently.

#### 4.1.B CSR screen-pop (call-context graph) `[R06]`
On inbound ring, resolve a **call-context graph** and push a screen-pop to the assigned/available CSR console: number-normalize → Customer/Contact match → service address → linked equipment/asset → open Job/estimate → assigned dispatcher → assigned/last tech → membership/SLA → priority flags. Unknown numbers create a provisional Contact.
- **AC:** Given an inbound call from a known number, when it rings, then the CSR sees the matched customer, last job, open jobs, and a one-click "book / add note / transfer" within 2s of ring (see NFR §10). Given an unknown number, then a provisional Contact is offered for one-click save.

#### 4.1.C Missed-call text-back `[R01, X5]`
Any unanswered/abandoned inbound call from an SMS-capable number triggers an automated, tenant-configurable, bilingual text-back within 60s ("Sorry we missed you — reply here and we'll help…"), creating/opening a unified-inbox thread and a callback-queue item. Respects 10DLC registration + quiet-hours rules `[§9]`.
- **AC:** Given a missed inbound call to a registered number, when the call ends unanswered, then a text-back is sent ≤60s, a callback-queue entry is created, and the outbound text is logged on the customer timeline; given the tenant is not 10DLC-registered, then no SMS is sent and the event is flagged.

#### 4.1.D Voicemail transcription & tagging `[R01, R04]`
Voicemails are recorded, transcribed (Deepgram `[D6]`), summarized, entity-extracted, and tagged with a disposition; placed in the callback queue ordered by expected value.
- **AC:** Given a voicemail, then within 2 min a transcript + summary + extracted callback number + suggested disposition appear on the call record and in the callback queue.

#### 4.1.E Callback queue `[R01, R05]`
A worklist of missed calls / voicemails / text-back threads, ordered by **expected lost revenue / speed-to-lead urgency**, with summary, customer context, and one-click call/text. `[R05 review-queue ordering]` **Surfaced to the owner as "Missed Calls"** (`status ∈ {missed, voicemail}`) on the Calls page KPI tiles `[see §14.4]`.
- **AC:** Given items in the queue, then they are sorted by urgency/expected-value with newest high-value leads on top; claiming an item assigns it to a CSR and removes it from others' queues.

#### 4.1.F After-hours / overflow AI receptionist (capture-first) `[I_R4, R01, E1]`
When no CSR answers (after hours / overflow / no-answer), an AI receptionist (bilingual, disclosure per §9) answers, identifies intent, qualifies urgency + service-area fit, and either (a) books a **simple rules-based job** directly to the Jobs store, (b) captures a structured packet → callback queue, or (c) runs **emergency triage** (§4.1.G). Full open-ended conversational booking is P1.5. The handoff is always a **structured packet** (transcript + summary + fields + urgency + accept/decline), never a blind bridge.
- **AC:** Given an after-hours inbound call, then the AI discloses per tenant policy, captures caller/intent/urgency/address, and either books a qualifying simple job or files a structured callback packet; the packet is visible to CSRs at open of business; booking failures raise a booking-integrity exception (not silent).

#### 4.1.G Emergency triage (structured dispatch object) `[E1, R06]`
Rule-based triage classifies by trade signal (gas/CO/no-heat/burst-pipe/electrical/lockout). True emergencies → escalate to the on-call queue/number with priority + capture fee/authorization acknowledgment before dispatch. Non-emergencies → text-back + callback queue. Simple on-call forwarding is a per-tenant config. Emergency is a **structured dispatch object** (issue type, risk, vulnerable-occupant, water/freeze flags, SLA override), not "press 9." **On the Calls page this rolls up into a broader owner-review queue surfaced as "Needs Attention"** — any of: `after_hours_emergency`, `needs_manager`, negative sentiment, or a low-confidence/flagged AI insight `[see §14.4]`.
- **AC:** Given a caller describing a gas leak after hours, then the system classifies it emergency, escalates to the on-call number with priority, captures authorization, and creates a structured emergency dispatch object linked to the call.

#### 4.1.H Booking write path & integrity `[I_R4, R01, G7-existing]`
Calls/AI create or update existing `Job` records (`scheduledFor` + `assignedTechId`) in the Jobs store via a structured booking write path. Every write is validated; failures/sync gaps raise **booking-integrity exception alerts** (the #1 FSM failure mode). `[R01]`
- **AC:** Given a confirmed booking, then a `Job` is created/updated with date/time + assigned tech + source call ref; given the write fails or conflicts, then an exception alert fires to dispatch and the caller-facing confirmation is withheld.

#### 4.1.I Minimal routing slice `[F4 derived, R06]`
P1 ships the routing primitives needed to capture calls: hours-based routing, simultaneous/sequential ring + overflow, a simple IVR, and after-hours/emergency override. The full job-aware routing graph and skills/territory/priority routing are P2.
- **AC:** Given configured business hours, then in-hours calls ring the CSR group (simultaneous or sequential per config), unanswered calls overflow to voicemail/AI, and after-hours calls follow the after-hours policy.

### 4.2 Two-Way SMS + Dispatch-by-Text `[F4-2, R07]`

#### 4.2.A Customer two-way SMS & unified inbox `[R07, D8, X6]`
Customer-facing texting on a unified inbox keyed to **Customer/Contact** (channel identities are child objects — §6), one longitudinal timeline linked to job/estimate. Supports confirmations/reminders, on-my-way/arrival, two-way conversation, quote follow-up, MMS/photos (with hosted-link fallback `[R07]`), and review asks. Consent-heavy: opt-in record, STOP/HELP keywords, one final opt-out confirmation. `[§9]`
- **AC:** Given an inbound customer text, then it lands in the unified inbox on the customer's timeline with full history; given a customer replies STOP, then they are suppressed and a single confirmation is sent; given an unregistered 10DLC tenant, production sending is disabled.

#### 4.2.B Dispatch-by-text — W-2 technicians `[T1.4, R07]`
Channel hierarchy for W-2 techs: **in-app push first → SMS fallback on no-ack → office-call escalation.** Carries the structured job packet.
- **AC:** Given a job assigned to a W-2 tech, when dispatched, then an app push fires; if unacknowledged within the configured window, an SMS fallback fires; if still unacknowledged, an office-call escalation is raised.

#### 4.2.C Dispatch-by-text — subcontractors (app-less) `[T1.4, R07, D11]`
Subs (no login) receive a **structured SMS** (job ref + customer + address + window + scope + ONE next action) + a **secure-link page** (accept/decline/ack/maps/masked-call/notes/close). Full state machine: sent→delivered→link-opened→acknowledged→accepted/declined→en route→arrived→completed→escalated.
- **AC:** Given a job dispatched to a subcontractor, then a structured SMS + unique secure link is sent; the link page lets them accept/decline, open maps, place a masked call, add notes, and close; every transition updates the job's dispatch state and is logged.

#### 4.2.D Sender/campaign separation `[R07, D9]`
Separate senders/campaigns by function: customer-care, marketing/review, technician-ops. Registration, opt-out state, and message delivery state surfaced in admin UI.
- **AC:** Given the three campaign types, then each maps to its own registered 10DLC campaign and sender pool; operational dispatch texts are not sent on the marketing campaign.

### 4.3 Call Intelligence `[F4-3, R04]`

#### 4.3.A Six-stage auto-log pipeline `[R04]`
Ingress + recording notice → streaming STT draft (Deepgram Nova-3/Flux `[D6]`) → post-call canonical transcript → redaction + normalization (PCI: DTMF-mask card data, no CVV in recordings `[§9]`) → separate prompts for summary / extraction / disposition → CRM orchestration (writes).
- **AC:** Given a completed recorded call, then within 2 min a canonical transcript, summary, extracted entities, and disposition exist; card numbers are masked; agent and customer audio channels are preserved separately where the transport allows (no diarization-only inference). `[R04]`

#### 4.3.B Five data families + confidence-gated writes `[D2, R04]`
Extract into five families: Customer&location / Problem&equipment / Commercial signal (price asked vs quoted) / Outcome&next-step / Evidence&confidence. **Confidence gates the write:** high → auto-write (callback #, window, booked y/n); medium → suggestion; low (exact street address, quote value, equipment model, emotion) → **review queue with the evidence span highlighted.** Address handling is **validation**, not transcription-only (44% STT error on US street names). `[D6, R04]`
- **AC:** Given a high-confidence callback number, then it auto-writes; given a low-confidence street address, then it goes to the review queue with the audio/transcript span linked and is validated against an address service before any write. Never a silent wrong-write.

#### 4.3.C Disposition taxonomy `[R04]`
Standard taxonomy: booked · quote requested · quote given not booked · reschedule · cancel · status check · billing · warranty · service-area mismatch · spam/vm · after-hours emergency · needs manager · follow-up.
- **AC:** Given any completed call, then exactly one primary disposition from the taxonomy is assigned (auto-suggested, CSR-overridable).

#### 4.3.D Real-time alerts (P1.5) `[R04]`
Real-time upset-customer / emergency-keyword alerts to supervisors. Flagged P1.5; P1 ships post-call only.

### 4.4 Outbound AI Dialer `[F4-4, R03, Round 3b]`

> **Posture (locked):** *Ship all tools, warn, tenant decides.* The platform ships the full capability set behind an **un-bypassable compliance engine** + in-product TCPA warnings + per-tenant acceptable-use + per-campaign legal-acknowledgment, all logged as evidence. Tenant + counsel own legal risk. `[Round 3b]` See §9 for the hard rules and the LINE HELD.

#### 4.4.A Dialers `[R03]`
Preview, power/progressive, and predictive dialers. Fit guidance surfaced in-product: Preview (high-ticket/commercial) > Power (SMB) > Predictive (call-center, high risk). Predictive enforces abandonment ≤3% (2s live-rep rule, ≥15s/4-ring), mandatory caller-ID transmission. `[§9]`
- **AC:** Given a predictive campaign, then the engine enforces ≤3% abandonment and the 2s/15s/4-ring rule; caller ID is always transmitted; these cannot be disabled in the UI.

#### 4.4.B AI voice agents (outbound) `[R03]`
AI voice agents for **warm/expected** flows. Four P1 use-cases: speed-to-lead callback, estimate/quote follow-up, appointment confirmations + on-the-way, dead-lead reactivation. AI voice = "artificial voice" under TCPA → telemarketing AI voice to consumer mobile/residential requires prior express **written** consent (verified against the consent ledger before dial). `[R03, §9]`
- **AC:** Given an AI-voice outbound campaign, then before each dial the consent ledger is checked for the required consent class for that number + use-case; missing consent → the number is suppressed from the campaign and logged.

#### 4.4.C Consent ledger `[D5, R03]`
First-class consent ledger: who / when / how / which number / seller / channel / use-case + evidence (form HTML, URL, timestamp, IP, e-sign, disclosure language). Drives all outbound gating.
- **AC:** Given a consent event, then it is stored with full evidence; given an outbound attempt, the engine resolves consent by number + use-case + channel before allowing the dial/send.

#### 4.4.D Campaign classification & gates `[D5, R03]`
Every campaign classified: informational / operational / estimate / reactivation / renewal / review / telemarketing. Classification drives consent gate, calling hours, DNC scope, opt-out behavior. **High-risk tier** (telemarketing · AI-voice-to-consumer-mobile · predictive-of-cold-lists · voicemail-drop) → per-campaign legal-acknowledgment screen + logged tenant risk acceptance + counsel-review prompt.
- **AC:** Given a campaign classified telemarketing with AI voice, then the tenant admin must pass a legal-acknowledgment screen (logged) before activation; activation is blocked until acknowledged.

#### 4.4.E Suppression & DNC engine `[D5, R03, §9]`
National DNC + state DNC + internal 5-yr suppression + per-tenant opt-out list; opt-outs honored ≤10 business days. Calling-hour windows by **called-party locale**. Number-health/reputation telemetry + warmup (legitimate; not spam-evasion).
- **AC:** Given an outbound dial, then the number is scrubbed against national + state + internal DNC and quiet-hours for the called-party's locale; a suppressed/out-of-hours number is not dialed and the reason is logged.

#### 4.4.F Voicemail drop & reactivation `[R03]`
Available as high-risk-tier tools behind §4.4.D gates. Reactivation campaigns key off the existing database (open estimates, dead leads, due renewals).

---

## 5. System Architecture

### 5.1 Architecture shape — FSM-native control plane + outsourced transport `[D1, X1, §C]`
The CRM owns a **telephony control plane**: identity resolution, routing, call-context graph, auto-log orchestration, and the consent/campaign/recording compliance ledgers. Transport (voice/SMS carriage, number provisioning, recording capture) is **outsourced behind a provider-adapter interface.** `[R02]`

```
┌─────────────────────────────────────────────────────────────┐
│  Alpha FSM CRM — Control Plane (we own)                       │
│  • Identity & context graph (Customer/Contact/Job/Tech)       │
│  • Routing engine (hours, ring, IVR, overflow, emergency)     │
│  • Auto-log pipeline (STT→extract→confidence-gate→write)      │
│  • Compliance ledgers (consent, campaign, recording, DNC)     │
│  • Canonical recording storage (encrypted, tenant-isolated)   │
│  • Unified inbox + interaction ledger (QA/perf)               │
│  • Multi-tenant scoping (tenant = sub-account)                │
└───────────────┬───────────────────────────┬─────────────────┘
                │  Provider-Adapter Interface │  (from day one)
        ┌───────▼────────┐          ┌─────────▼─────────┐
        │  CTM adapter    │          │  CPaaS adapter     │
        │  (P1 backbone)  │          │  (Telnyx primary,  │
        │  inbound, IVR,  │          │  Twilio secondary) │
        │  recording,SMS, │          │  AI-voice realtime │
        │  tracking #s    │          │  media, branded    │
        └───────┬────────┘          └─────────┬─────────┘
                │                              │
         ┌──────▼──────┐               ┌──────▼──────┐
         │   CTM        │               │ Telnyx/Twilio│
         └─────────────┘               └─────────────┘
        Deepgram (STT) ── batch/LLM summarization ── address-validation svc
```

### 5.2 Backbone decision (locked) `[§C — LOCKED 2026-05-28; sharpened with web vendor-fit research, §13.5]`
- **CTM is the Phase-1 transport backbone** for inbound capture, IVR/routing, recording, tracking-number pools, and two-way SMS — validated by Alpha already running on CTM `[I2]` and by CTM's account/sub-account model serving as the **multi-tenant substrate** (one sub-account per tenant). `[I1]` **Commercial model locked:** Alpha on **CTM Sales Engage** as the parent/agency account; tenants = sub-accounts; **headless API integration** (CRM = UI of record, CTM = backend). See §5.6. `[I4]`
- **CTM vendor-fit (confirmed via web research, May 2026):** flat-plan pricing **with unlimited users** ($79/$179/$329/$1,999/mo) **+ usage** (per-minute/number/transcription) — *not* per-seat; **agency sub-accounts** (Marketing Pro bundles 25; scales to unlimited) + **white-label** ($65/mo + $99 setup on own domain, or free subdomain); **REST API + bidirectional near-real-time webhooks** (call/SMS/recording/transcription/scoring events); a **native AI voice agent — VoiceAI** (inbound answer/FAQ/appointment-booking/intent-routing/human-handoff + outbound, $0.12/min after 250 free min/agent, SOC2+HIPAA+BAA); **Deepgram STT** deployed in CTM's own AWS VPC `[aligns D6]`; **Trust Center** 10DLC brand+campaign registration ($15/campaign) + STIR/SHAKEN + CNAM `[validates D9]`; number **porting 2–4 wks** `[R02]`. → CTM is **no longer "thin" on AI voice**; the escape-hatch rationale narrows accordingly.
- **The provider-adapter interface is mandatory from day one** so the *narrowed* set of CTM-weak/unconfirmed capabilities can run on **Telnyx (primary CPaaS) / Twilio (secondary)** without re-platforming: **(a)** bilingual EN-ES AI voice if VoiceAI is English-only (unconfirmed; PRD requires ES in P1), **(b)** custom/bespoke real-time agents needing raw **bidirectional media streaming**, **(c)** advanced **predictive dialing** with abandonment ≤3% controls at scale, **(d)** **branded calling**, **(e)** **E911 / Kari's Law / RAY BAUM'S** dynamic-location sophistication. `[R02, §13.5]`
- The CRM never depends on a single transport: adapters cover number search/order/port, call orchestration, recording lifecycle, SMS-registration state, E911/location, and reputation telemetry. `[R02]`
- **Open (non-blocking):** the items above marked *unconfirmed* + CTM's **at-scale usage economics** vs. CPaaS (needs Alpha's actual minute/number/message volumes; ref ~$9.3K/mo Telnyx vs ~$21K Twilio at the R02-modeled volume). Because transport sits behind the adapter, shifting any leg to Telnyx later is an internal swap, not a product change. `[§12]`

### 5.3 Backend contract (to be built) `[F1]`
There is **no backend in the repo today** — `dashboard/` is a frontend-only React/TS prototype with in-memory data modules. `[Step-1 inventory]` This PRD therefore **specifies the backend contract** the phone module requires; the frontend continues the existing prototype conventions until the backend lands.

Core services (logical, not prescriptive of deployment):
- **Telephony gateway** — receives provider webhooks (call/SMS/recording events) from CTM/CPaaS, normalizes to internal events, and exposes outbound command APIs (dial, send, transfer, record).
- **Context graph service** — identity resolution + call-context graph on inbound.
- **Auto-log pipeline service** — STT orchestration, extraction, confidence gating, CRM writes.
- **Compliance service** — consent/campaign/DNC/recording ledgers; the un-bypassable gate every outbound action passes through.
- **Recording storage service** — pulls provider recordings to encrypted tenant-isolated storage (KMS); app DB holds metadata only; logs every playback/export. `[D3]`
- **Realtime/notification bridge** — pushes incoming-call/new-message intents to the dashboard via the existing **alert-bus** pattern (`subscribeAlertIntent`). `[E3, Step-1 inventory]`

### 5.4 Webhook & event contract (normalized internal events)
Provider webhooks (CTM/Telnyx/Twilio) are adapted into a stable internal event envelope so the control plane is provider-agnostic:
```
Event {
  tenantId, eventId, ts, source: "ctm"|"telnyx"|"twilio",
  type: "call.ringing" | "call.answered" | "call.ended" |
        "recording.available" | "sms.received" | "sms.status" |
        "voicemail.available" | "dtmf" | "number.health",
  callSessionId?, messageId?, payload {…provider-normalized…}
}
```
- **AC (contract):** Given any provider webhook, then the adapter maps it to exactly one normalized event with a tenant scope and an idempotency key (`eventId`); duplicate deliveries are de-duplicated; unmapped event types are logged, not dropped.

### 5.5 Integration with the existing dashboard `[Step-1 inventory]`
- **Routing:** add three top-level routes to the state-based switch in `App.tsx` (no router library introduced): `inbox`, `dispatch`, `performance`. `[E3]`
- **Notifications:** incoming-call/new-message → `alert-bus` intent → toast + route-jump (reuse the nonce-stamped `PendingAlert` prop pattern). `[E3]`
- **Data modules:** new entities follow the established `export type X` + `export const xs: X[]` convention, citing `PRD §6` anchors in comments, until the backend replaces seeds. `[Step-1 inventory]`
- **RBAC:** new capability helpers added to `data/current-user.ts` (e.g. `canHandleCalls`, `canManageCampaigns`, `canReviewQA`, `canConfigureTelephony`). `[Step-1 inventory]`

### 5.6 Multi-tenancy & commercial/integration model `[I1, I4]`
- **Plan + account structure:** Alpha holds a **CTM Sales Engage** account ($329/mo + usage) as the **parent/agency** account. **Each tenant = one CTM sub-account** (Sales Engage includes unlimited sub-accounts); Alpha's own sub-account is **tenant #1**. Every telephony/messaging entity is scoped to its sub-account. `[I4]`
- **Headless integration (UI of record = the CRM):** The CRM is the only interface tenants and CSRs see; CTM runs as the **backend via REST API + bidirectional webhooks** behind the provider adapter (§5.1/§5.4). CTM's native UI is not exposed. "White-labeling inside our CRM" means **our own UI on CTM's backend**, *not* CTM's domain-white-label product (which rebrands CTM's own screens and is optional/unneeded here). `[I4]`
- **Onboarding per tenant:** provision the sub-account → numbers (main + per-branch + tracking pools, §E4) → 10DLC brand/campaign registration via CTM Trust Center → recording policy → acceptable-use/legal acknowledgments → (later) WhatsApp Embedded Signup.
- **Verify at onboarding:** whether CTM's domain-white-label tier is bundled in Sales Engage or a Marketing-Pro/agency add-on — only relevant if Alpha ever exposes CTM's native UI to a tenant (not required for the headless model). `[§13.5]`

---

## 6. Data Model

New entities introduced by this module (this module **owns** Customer/Contact `[T1.3, D8]`). Field lists are the contract; types follow the dashboard's TS convention.

### 6.1 Customer & identity (canonical record = Customer/Contact) `[D8, X6]`
```
Customer { id, tenantId, name, type: "commercial"|"residential",
           billingAddress?, sites: SiteId[], membershipTier?, slaProfile?,
           createdFrom: CallSessionId|ManualId, timeline: InteractionRef[] }

Contact  { id, tenantId, customerId, name, role?, preferredLang: "en"|"es",
           channelIdentities: ChannelIdentity[] }

ChannelIdentity { id, contactId, kind: "phone"|"sms"|"email"|"wa"|"ig"|"apple",
                  value, verified, consentRefs: ConsentId[] }   // child object, not the canonical record
```
- **Migration note:** today `Job.customer` is a bare string and `Job.site` a bare string. `[Step-1 inventory]` Add `Job.customerId?`, `Job.contactId?`, `Job.siteId?` (nullable, backfilled) and keep the string fields during transition. No phone fields exist on any entity today — all telephony identity is new.

### 6.2 Telephony core
```
CallSession { id, tenantId, direction: "in"|"out", fromNumber, toNumber,
              trackingSource?,          // surfaced in the call table as "Ad Source"
              callFlow?,                // routing rule that handled the call (e.g. "Forward to Emanuel") [§14.7]
              tags?: string[],          // free-form labels [§14.7]
              revenueAttributed?,       // $ attributed to this call [§14.7]
              jobLabel?,                // human job/lead ref shown in the table (e.g. "J-1850","Lead") [§14.7]
              branchId?, status: "ringing"|"answered"|"voicemail"|"completed"|"abandoned",
              answeredBy: { kind: "csr"|"ai"|"voicemail"|"none", id? },
              ringAt, answerAt, endAt, recordingRef?, consentEvidenceRef?,
              customerId?, contactId?, jobId?, disposition?, summaryRef?, transcriptRef? }

Recording { id, tenantId, callSessionId, storageUri (own cloud, KMS-encrypted),
            durationSec, consentEvidenceRef, accessLog: AccessEvent[] }   // app DB = metadata only [D3]

Transcript { id, callSessionId, language, canonicalText, segments[ {speaker, startMs, endMs, text, confidence} ],
             redactions[], summary, extracted: ExtractedEntities, disposition }

ExtractedEntities {  // 5 data families [R04]
  customerLocation { name?, address? (validated), confidence },
  problemEquipment { issue?, equipment?, confidence },
  commercialSignal { priceAsked?, priceQuoted?, confidence },
  outcomeNextStep  { booked?, callbackWindow?, callbackNumber?, confidence },
  evidence { lowConfidenceFields: { field, evidenceSpanRef }[] } }
```

### 6.3 Messaging
```
MessageThread { id, tenantId, customerId?, contactId?, channel, campaignType:
                "customer_care"|"marketing_review"|"tech_ops", jobId?, messages: Message[] }

Message { id, threadId, direction, body, mediaRefs[], status:
          "queued"|"sent"|"delivered"|"failed"|"received", ts, consentRef? }
```

### 6.4 Dispatch-by-text state machine `[D11, R07]`
```
DispatchTask { id, tenantId, jobId, assigneeKind: "w2"|"sub", assigneeId,
               channelPlan: ("push"|"sms"|"office_call")[],
               state: "sent"|"delivered"|"link_opened"|"acknowledged"|
                      "accepted"|"declined"|"en_route"|"arrived"|"completed"|"escalated",
               secureLinkToken?, transitions: { state, ts, actor }[] }
```

### 6.5 Compliance ledgers `[D5, D4, R02, R03]`
```
ConsentRecord { id, tenantId, contactId, number, channel, useCase, method,
                evidence { formUrl?, formHtmlRef?, ip?, timestamp, eSignRef?, disclosureText },
                grantedAt, revokedAt? }

Campaign { id, tenantId, classification:
           "informational"|"operational"|"estimate"|"reactivation"|"renewal"|"review"|"telemarketing",
           channel, riskTier: "standard"|"high", legalAckRef?, dialerType?, senderPoolId, a2pCampaignRef? }

SuppressionEntry { id, tenantId, number, scope: "national_dnc"|"state_dnc"|"internal"|"opt_out", source, addedAt, expiresAt? }

RecordingConsentPolicy { id, tenantId, scope: "tenant"|"queue"|"number"|"user",
                         mode: "one_party"|"all_party", disclosureText, perStateOverrides[] }

A2PRegistration { id, tenantId, brandRef, campaignRefs[], status: "pending"|"approved"|"rejected", sendingEnabled: bool }
```

### 6.6 Agents & performance `[R05, D13]`
```
AgentIdentity { id, tenantId, kind: "human"|"ai", name, rosterCard, active }

InteractionLedgerEntry {  // unified call→intent→booking→job→estimate→revenue [R05]
  id, tenantId, callSessionId?, threadId?, agentId, intent?, bookingJobId?,
  estimateId?, invoiceId?, revenueCollected?, eligibility: "gross"|"eligible"|"capacity_adjusted" }

Scorecard { id, tenantId, agentId, period, dimensions:
            { outcomes, experience, handoffs, governance },  // 4-D for AI [R05]
            scriptAdherencePct?,  // % of monitored calls following the approved script; <85% flags "needs attention" [§14.5]
            humanKpis?, snapshotAt, disputes: Dispute[] }
```

### 6.7 Tenant config
```
Tenant { id, name, ctmSubAccountId, branding?, recordingPolicyId,
         spendCeiling: { monthlyHardUsd, subCaps: { aiVoiceMin?, recordingGbMonth?, outboundVol? },
                         alertThresholdPct, onCeilingBehavior: "degrade_ai"|"suspend_noncritical" },  // [E2]
         numbers: PhoneNumber[], defaultLang: "en"|"es" }

PhoneNumber { id, tenantId, e164, kind: "main"|"branch"|"tracking"|"sales"|"dispatch",
              branchId?, campaignRef?, healthScore?, e911LocationRef? }   // [E4, R02]
```

---

## 7. Third-Party Integrations `[R02, R04, R08, §C]`

| Integration | Role | Phase | Notes |
|-------------|------|-------|-------|
| **CallTrackingMetrics (CTM)** — **Sales Engage** plan `[I4]` | P1 transport backbone: numbers + tracking pools, IVR/routing, recording capture + transcription (Deepgram in CTM's VPC), two-way SMS, VOIP softphone (in+out), attribution, **VoiceAI** native AI voice agent (inbound + outbound), **Smart Dialer**, **Trust Center** 10DLC/STIR-SHAKEN/CNAM | P1 | **Headless API integration** (CRM = UI of record). Sales Engage incl. **unlimited sub-accounts** (tenant = sub-account), API access, softphone, two-way SMS, VoiceAI, Smart Dialer. Flat plan **+ usage, unlimited seats** (not per-seat). **REST API + bidirectional near-real-time webhooks**. VoiceAI $0.12/min (250 free/agent), SOC2+HIPAA+BAA. Port 2–4 wks. Behind the CTM adapter. `[I2, I1, I4, §13.5]` |
| **Telnyx** | Primary CPaaS escape hatch: AI-voice real-time bidirectional media, outbound dialer media, programmable voice/SMS, dynamic E911 | P1 (adapter) / activated as needed | Cheapest serious API-first; mitigate ops risk w/ adapter + fallback. `[R02]` |
| **Twilio** | Secondary CPaaS: branded calling, SMS trust, highest SLA; store recordings in own S3 | P1 (adapter) / fallback | Most expensive; best docs/branded calling. `[R02]` Avoid for WhatsApp. `[R08]` |
| **Bandwidth** | Number economics / E911 option | P2 | Best per-number price; up to 4 track streams. `[R02]` |
| **Deepgram (Nova-3/Flux)** | Primary STT — real-time + voice agents; batch summarization via LLM | P1 | Test on Alpha's own 8kHz recordings before locking. `[D6, R04]` |
| **Address validation service** | Validate extracted service addresses (not transcription-only) | P1 | Addresses 44% STT error → must validate. `[R04]` |
| **A2P 10DLC / TCR** | Brand + campaign registration; gate production SMS | P1 | No production send pre-registration. `[D9, R07]` |
| **STIR/SHAKEN + Robocall Mitigation DB** | Caller-ID attestation + filing | P1 | Caller-ID transmission mandatory. `[R02, §9]` |
| **Meta Cloud API + Embedded Signup** | WhatsApp (customer-owned WABA) | P2 | Direct; 360dialog as thin fallback; avoid Twilio. `[D10, R08]` |
| **LLM (summary/extraction/disposition)** | Post-call NLP in the auto-log pipeline | P1 | Separate prompts per task; redaction before prompt. `[R04]` |

- **AC (adapter):** Given the CTM adapter is the active voice transport, when an AI-voice outbound campaign requires real-time bidirectional media, then the control plane routes that leg through the CPaaS (Telnyx) adapter without changing the control-plane data model or UI.

---

## 8. UI / Visual Specifications `[E3, Step-1 inventory]`

Reuse the dashboard's existing visual language: React 19 + Tailwind 3.4 + lucide-react, dialog-heavy patterns (~40 dialog components), preview/Email/Save-as-PDF/Print parity, inline e-signatures. New surfaces:

### 8.1 Sidebar routes (3 new) `[E3]`
- **Inbox** — unified omnichannel (calls, voicemails, SMS, later WhatsApp) on one timeline keyed to Customer/Contact. Left: thread list (filter by channel/campaign/unread/queue). Center: conversation/timeline. Right: customer-context panel (open jobs, last job, membership, quick-book).
- **Dispatch / Calls** — callback queue (ordered by expected value), live call console (screen-pop), dispatch board hooks, dispatch-by-text task list + state machine view.
- **Performance / QA** — human + AI agent roster cards, eligibility-aware scorecards, review queue ordered by expected lost revenue, calibration/dispute flow, historical snapshots. **Includes the script-adherence column** `[§14.5]`.

The prototype presents these inside a **Phone module shell** with a product header (business number + plan-usage meter) and a primary nav — **Calls · Phone numbers · Call flows · Call masking · Call groups · Blocked callers · Texting** — where **Calls** is the default page (date-range picker, clickable stat strip, faceted "Filter results", and the call table). Inbox / Dispatch / Performance live as sub-views under Calls. `[full spec in §14.1–§14.3]`

### 8.2 Softphone / call console (component, not a global bar) `[E3]`
Mounted inside Inbox + Dispatch routes. Functions: answer/hang up, mute/hold/transfer, click-to-call, live transcript draft, disposition picker, one-click book/note. **Not** a persistently docked global bar — incoming-call toasts fire globally via alert-bus and deep-link into the console. `[E3]`

Also openable as a **Dialer popup** from the module header (keypad dial-out + screen-pop). On **desktop**, the popup adds a **job/PO/customer search** that resolves the customer's number and prefills the dialer, plus a **pre-call history panel**: job card (status, schedule, assigned tech), **job notes**, **linked POs (expandable to line items)**, and **prior call transcripts**. Search + history are **desktop-only**; mobile/app shows the keypad only. `[full spec in §14.6]`

### 8.3 Screen-pop card
On inbound ring (alert-bus toast → console), show matched customer, open jobs, last interaction, service address, priority/SLA flags, and primary actions (book / add note / transfer / mark emergency) — populated within 2s (§10).

### 8.4 Compliance surfaces (first-class, not buried) `[X4, §9]`
- 10DLC registration workflow screen (brand + campaigns + status + sendingEnabled toggle hard-locked off until approved).
- Per-campaign classification + risk-tier badge; high-risk → legal-acknowledgment modal (logged) before activation.
- Recording-consent policy editor (tenant/queue/number/user scope; per-state overrides).
- Consent-ledger viewer (search by number; see evidence).
- Spend-ceiling config + live usage meters with threshold alerts. `[E2]`

### 8.5 Secure-link sub page (subcontractor dispatch) `[D11, R07]`
Mobile-first public page (token-authed, no login): job summary, accept/decline, maps link, masked-call button, notes, photo upload, close-job. Reflects dispatch state machine.

### 8.6 Bilingual `[I_R4]`
EN + ES across AI receptionist scripts, customer text templates, and the secure-link page. Contact `preferredLang` drives template language.

---

## 9. Compliance Requirements

> **This section is not legal advice.** It specifies a compliance-evidence engine and platform guardrails. The platform = tool + compliance-evidence provider; **legal responsibility sits with the tenant and their counsel.** The PRD recommends telecom/TCPA counsel review before enabling high-risk tiers. `[Round 3b]`

### 9.1 Non-bypassable compliance engine (mandatory) `[Round 3b, R02, R03, R07]`
Every outbound action passes through the compliance service. The engine enforces:
- **Consent ledger check** by number + use-case + channel before any AI-voice/telemarketing dial or marketing SMS. `[D5]`
- **DNC scrub:** national + state + internal 5-yr suppression; opt-outs honored ≤10 business days. `[R03]`
- **Calling-hour windows** by **called-party locale** (federal 8a–9p; tighter state overlays). `[R03]`
- **Predictive abandonment ≤3%** (2s live-rep rule, ≥15s/4-ring). `[R03]`
- **Mandatory caller-ID transmission** on every outbound call. `[R02, R03]`
- **A2P 10DLC gating:** no production SMS before registration approved. `[D9, R07]`
- **Recording consent:** universal disclosure at call start; tenant-configurable per queue/number/user; store consent evidence on the call record; assume the stricter rule on interstate calls (federal one-party / ~11 all-party states). `[D4, R04]`
- **PCI:** DTMF-mask card entry; no CVV in recordings. `[R04]`
- **E911:** Kari's Law (direct 911 + notification) + RAY BAUM'S (dispatchable location); dynamic location for softphone/mobile. `[R02]`

### 9.2 Campaign classification → gates `[D5, R03]`
Classification (informational / operational / estimate / reactivation / renewal / review / telemarketing) drives consent gate, hours, DNC scope, and opt-out behavior. **High-risk tier** = telemarketing · AI-voice-to-consumer-mobile · predictive-of-cold-lists · voicemail-drop → per-campaign legal-acknowledgment screen + logged tenant risk acceptance + counsel-review prompt before activation.

### 9.3 AI disclosure `[T2.1, RISK-1]`
Tenant chose **"disclose only when required."** Honor as a tenant-configurable setting with a **per-jurisdiction legal-minimum default**; log the tenant's choice in the compliance ledger. **PRD flags FCC artificial-voice exposure** (AI voice = artificial voice under TCPA, Feb 2024) and **recommends counsel.** Not legal advice. `[R03]`

### 9.4 Retention `[T1.7, RISK-2]`
Tenant chose **indefinite until deleted.** Honor as a tenant-configurable default; add legal-hold, manual purge, and per-state minimization override. **PRD flags CPRA/minimization + storage-cost exposure.** Recordings stored encrypted (KMS), tenant-isolated, every playback/export logged. `[D3]`

### 9.5 LINE HELD — will NOT be specified or built `[Round 3b — preserve verbatim]`
**Caller-ID spoofing/blocking, STIR/SHAKEN evasion, and bad-faith number-rotation-to-dodge-spam-labels are out of scope and will not be built.** These facilitate illegal robocalling/detection-evasion; research confirms caller-ID transmission is legally mandatory. **Legitimate number-health / reputation / warmup tooling IS in scope.** `[R02, R03]`

### 9.6 Voice biometrics `[D7, R04]`
Voiceprints deferred from MVP (IL BIPA risk). Not in P1.

---

## 10. Non-Functional Requirements

| # | Requirement | Target |
|---|-------------|--------|
| NFR-1 | Screen-pop latency | Context graph + screen-pop rendered ≤2s from inbound ring `[R06]` |
| NFR-2 | Missed-call text-back latency | ≤60s from call-end `[R01]` |
| NFR-3 | Post-call intelligence latency | Transcript+summary+extraction+disposition ≤2 min after call-end `[R04]` |
| NFR-4 | Real-time STT (voice agents) | Streaming partials sub-second (Deepgram Flux) `[D6]` |
| NFR-5 | Booking sync | AI/console booking appears on tech's job ≤60s; integrity exceptions surfaced `[R01]` |
| NFR-6 | Recording security | At-rest KMS encryption, tenant isolation, every access logged `[D3]` |
| NFR-7 | Multi-tenant isolation | No cross-tenant data access; numbers/recordings/campaigns/consent all tenant-scoped `[I1]` |
| NFR-8 | Provider resilience | Adapter + fallback; no active-active at launch but a 2nd carrier addable without control-plane change `[R02]` |
| NFR-9 | Idempotency | All provider webhooks de-duplicated by eventId; no double-logging `[§5.4]` |
| NFR-10 | Spend governance | Per-tenant hard ceiling + category sub-caps enforced; soft alert at threshold; critical inbound + compliance never blocked by caps `[E2]` |
| NFR-11 | Availability | Inbound call handling targets carrier-grade; degrade gracefully (AI→voicemail) on dependency failure |
| NFR-12 | Bilingual | EN + ES parity on receptionist, templates, secure-link page `[I_R4]` |
| NFR-13 | Accessibility | Console + inbox meet the dashboard's existing a11y bar (keyboard, ARIA on dialogs) |

---

## 11. Phasing & Milestones

### 11.1 Phase 1 — MVP (the four sub-modules + foundations)
**Milestone P1-A — Foundations & contract**
- Provider-adapter interface + CTM adapter (numbers, inbound webhooks, recording, SMS). `[§C]`
- Backend contract services (telephony gateway, context graph, compliance, recording storage). `[§5.3]`
- Customer/Contact/ChannelIdentity data model + Job back-links + RBAC helpers. `[§6, §5.5]`
- Tenant/sub-account provisioning + 10DLC registration workflow. `[I1, D9]`

**Milestone P1-B — Inbound capture & recovery stack**
- Call logging, screen-pop, minimal routing slice, missed-call text-back, voicemail transcription, callback queue, after-hours/overflow AI (capture + simple rules-based booking), emergency triage. `[§4.1]`

**Milestone P1-C — Messaging & dispatch-by-text**
- Customer two-way SMS + unified inbox; W-2 app-push→SMS→office-call hierarchy; subcontractor structured-SMS + secure-link state machine; sender/campaign separation. `[§4.2]`

**Milestone P1-D — Call intelligence**
- Six-stage auto-log pipeline; five data families; confidence-gated writes + review queue; disposition taxonomy; address validation; PCI masking. `[§4.3]`

**Milestone P1-E — Outbound + compliance engine**
- Consent ledger, campaign classification + gates, suppression/DNC engine, dialers (preview/power/predictive w/ abandonment cap), AI voice agents for the 4 warm use-cases, voicemail drop/reactivation behind high-risk gates. `[§4.4, §9]`

**Milestone P1-F — Performance/QA + spend governance**
- AgentIdentity (human+AI), interaction ledger, eligibility-aware scorecards (4-D for AI), review queue by expected lost revenue, calibration/dispute, snapshots; per-tenant spend ceiling + meters. `[§4, R05, E2]`

### 11.2 Phase 1.5 (fast-follow)
Full conversational AI receptionist booking; real-time upset/emergency alerts; rubric QA scorecards. `[§4.1.F, §4.3.D]`

### 11.3 Phase 2
Job-aware routing graph; WhatsApp (Meta Cloud API + Embedded Signup); branded calling; supervisor desk (listen/whisper/barge); follow-the-tech (3 distinct mechanics modeled separately). `[D12, R06, R08]`

### 11.4 Phase 3
Instagram/Messenger/Apple Messages; predictive QA; voiceprints only if BIPA risk resolved; advanced number/branded-calling sophistication.

---

## 12. Open Assumptions & Risks

### 12.1 Open assumptions (resolve during build; not architecture-blocking)
| # | Assumption | Owner | Note |
|---|-----------|-------|------|
| A-1 | CTM vendor-fit: ~~report not supplied~~ → **resolved via web research** (pricing, sub-accounts, API/webhooks, VoiceAI, Deepgram, 10DLC, porting all confirmed; §13.5). **Residual to verify with CTM directly:** VoiceAI bilingual EN-ES; raw real-time bidirectional media API for custom agents; recording retention + canonical-copy export; E911/Kari's-Law/RAY-BAUM'S; predictive-dialer abandonment controls; at-scale usage economics vs CPaaS (needs Alpha's volumes) | Emanuel / CTM | Each residual rides the CPaaS adapter if CTM falls short → none block the PRD. `[§C, §5.2, §13.5]` |
| A-2 | Alpha's specific monthly spend-ceiling figure | Emanuel | Mechanism specced `[E2]`; the number is a per-tenant config value, not a platform constant. |
| A-3 | Current Alpha business numbers + port details | Emanuel | Needed for onboarding/port (1–3 wk US). `[G2, R02]` |
| A-4 | phone VoC + phone competitor-teardown reports not supplied | Emanuel | Feature specs lean on R01–R08; these would refine prioritization, not change architecture. |
| A-5 | Exact per-trade emergency-triage decision tree | Emanuel/ops | Superset behavior locked `[E1]`; tree tuned at build. |
| A-6 | Deepgram accuracy on Alpha's 8kHz recordings | Eng | Must test before locking STT. `[D6, R04]` |

### 12.2 Risk register `[Interview Rounds 3/3b]`
| # | Risk | Mitigation | Residual |
|---|------|-----------|----------|
| RISK-1 | Minimal AI disclosure vs FCC artificial-voice rule → legal exposure on outbound AI voice | Tenant-configurable w/ per-jurisdiction legal-minimum default; log choice; in-product warning; counsel-review prompt | Accepted per-tenant w/ counsel. Not legal advice. `[T2.1, §9.3]` |
| RISK-2 | Indefinite retention vs CPRA minimization → privacy/storage exposure | Tenant-configurable; legal-hold + manual purge + per-state minimization override; storage-cost meters | Accepted per-tenant. `[T1.7, §9.4]` |
| RISK-3 | Aggressive outbound → TCPA/robocall exposure | Un-bypassable compliance engine (consent/DNC/hours/abandonment/caller-ID) + classification gates + per-campaign legal-ack + counsel prompt | Accepted per-tenant w/ counsel. `[Round 3b, §9]` |
| RISK-4 | Telnyx ops/support variability | Provider-adapter + Twilio fallback; no hard single-carrier dependency | Low. `[R02]` |
| RISK-5 | Booking not surviving into field app (the #1 FSM failure) | Structured booking write path + integrity exception alerts + ≤60s sync target | Monitored. `[R01, NFR-5]` |
| RISK-6 | STT field accuracy (44% street-name error) | Confidence-gated writes + address validation + review queue w/ evidence span; never silent wrong-writes | Low. `[R04]` |
| RISK-7 | 10DLC/registration delays block SMS launch | First-class registration workflow; sending hard-locked until approved; start early in onboarding | Schedule risk. `[D9, R07]` |

---

## 13. Appendix — Research Traceability

### 13.1 Research reports (supplied, read in full)
| ID | Report | Drives |
|----|--------|--------|
| R01 | Inbound AI Receptionists & Call Capture | §4.1 (recovery stack, structured packet, booking integrity, bilingual) |
| R02 | Telephony Infrastructure, Numbers & Compliance | §5 (control plane on CPaaS, adapters), §7, §9 (10DLC/recording/E911/STIR-SHAKEN), §C (CPaaS verdict). **Never mentions CTM** — see §C. |
| R03 | Outbound AI, Cold Calling & Sales Dialers | §4.4, §9 (consent ledger, campaign classification, dialer fit, FCC artificial-voice) |
| R04 | AI Call Intelligence | §4.3 (6-stage pipeline, 5 families, confidence gates, address validation, PCI/BIPA) |
| R05 | Agent Performance & QA (Human + AI) | §4 (interaction ledger, eligibility-aware scorecards, review-queue ordering, AI-as-named-employee) |
| R06 | Call Routing & Dispatch Integration | §4.1 (context graph, screen-pop, emergency object), §11.3 (job-aware routing, follow-the-tech) |
| R07 | Two-Way Texting & SMS | §4.2 (unified inbox, dispatch-by-text state machine, 10DLC, channel separation) |
| R08 | WhatsApp & Multi-Channel Messaging | §11.3 (WhatsApp Phase 2, Embedded Signup, avoid Twilio), §6.1 (canonical record = customer, channel IDs child objects) |

### 13.2 Cross-report convergence (high confidence — 3+ reports)
- **X1** FSM-native orchestration on CPaaS execution → §5.1.
- **X2** Structured capture + confidence-gated auto-log → §4.3.
- **X3** Revenue-linked, job-aware everything → §4 (interaction ledger), §11.3.
- **X4** Compliance is a first-class product surface → §8.4, §9.
- **X5** Missed-call recovery + speed-to-lead = cheapest highest-ROI win → §4.1, Goals.
- **X6** Unified inbox keyed to customer/contact → §6.1.

### 13.3 Decision trace (locked decisions → `working/decisions-log.md`)
- **Framing F1–F4** (backend contract, supplied research, CTM lean, 4 sub-modules) → §1, §2, §5.3.
- **Director defaults D1–D14** (architecture, auto-log, recording, consent, STT, biometrics, inbox, 10DLC, WhatsApp transport, dispatch mechanic, follow-the-tech, QA, numbers) → §4–§9.
- **Backbone §C — LOCKED hybrid** (CTM P1 backbone + CPaaS adapter from day one) → §5.2.
- **Interview I1–I3** (multi-tenant SaaS, on CTM, human CSRs) → §3, §5.6.
- **Resolutions E1–E4** (after-hours superset, per-tenant spend ceiling, 3 routes + alert-bus, numbers strategy) → §4.1.G, §8, §10.
- **Risk-tolerant choices** (T2.1 minimal disclosure, T1.7 indefinite retention, Round 3b ship-all-tools) → §9, §12.

### 13.4 Missing / substituted research (flagged)
The phone **Voice-of-Customer** and phone **Competitor-Teardown** reports were not supplied; the file delivered as the "CTM vendor-fit report" was the wrong document (a digital-mental-health RCT pilot plan, no telephony content). The backbone decision and feature priorities were made from R01–R08 + interview; the VoC/teardown reports would refine prioritization, not change the architecture (the adapter absorbs a transport swap). See §12 A-4.

### 13.5 CTM vendor-fit — web research (2026-05-28, in lieu of the missing report)
Director ran live web research to fill the CTM gap. Findings feed §5.2, §7, §12 A-1. Key sourced facts: flat-plan pricing + usage with **unlimited seats** (not per-seat); **agency sub-account** multi-tenancy + white-label; **REST API + bidirectional near-real-time webhooks**; native **VoiceAI** agent (inbound+outbound, $0.12/min, SOC2/HIPAA/BAA, launched Sep 8 2025); **Deepgram** STT in CTM's AWS VPC; **Trust Center** 10DLC + STIR/SHAKEN + CNAM; porting 2–4 wks. Residual items to verify directly with CTM are listed in §12 A-1.

Sources:
- [CTM Plans & Pricing](https://www.ctm.com/plans-pricing/)
- [VoiceAI by CTM — 24/7 AI Voice Agent](https://www.ctm.com/features/lead-management/voiceai)
- [CTM VoiceAI launch (PRNewswire, Sep 8 2025)](https://www.prnewswire.com/news-releases/calltrackingmetrics-launches-voiceai-solution-to-transform-contact-center-operations-with-responsible-ai-automation-302547808.html)
- [CTM Webhooks API Integration](https://www.calltrackingmetrics.com/support/integrations-account-management/webhooks-api/webhooks-api-integration/)
- [CTM API (Postman public workspace)](https://postman.calltrackingmetrics.com/)
- [CTM White-Label / Agency Partner Program](https://www.calltrackingmetrics.com/agencies-and-affiliates/white-label/)
- [How to Resell CTM (sub-accounts)](https://calltrackingmetrics.zendesk.com/hc/en-us/articles/7014340894093-How-to-Resell-CTM)
- [CTM Trust Center Walkthrough (10DLC/STIR-SHAKEN)](https://calltrackingmetrics.zendesk.com/hc/en-us/articles/17833410592269-Trust-Center-Walkthrough)
- [CTM Outbound Dialing / Softphone](https://www.calltrackingmetrics.com/support/softphone/1632239-outbound-dialing/)
- [CTM Call Recordings](https://calltrackingmetrics.zendesk.com/hc/en-us/articles/6520377052685-Call-Recordings)

---

## 14. Prototype Build Addendum `[2026-05-30]`

Captures UI/UX and data-model decisions made while building the interactive prototype (`dashboard/src/components/PhonePage.tsx`, `Softphone.tsx`, and seed data in `dashboard/src/data/`). These extend — and in a few places rename — the specs in §4, §6, and §8. Where this addendum and an earlier section disagree on a label, **this addendum wins** (it reflects owner review).

### 14.1 Phone-module shell & primary navigation `[extends §8.1]`
The Phone area is a multi-page hub with its own header and a Workiz-style primary tab bar, layered **above** the existing sub-views:
- **Module header:** product name ("Alpha Phone"), the tenant business number chip (e.g. `(551) 282-7064`) with a **hover/focus tooltip** ("Your main Alpha Phone number — clients can call and text you at this number"), **dual Phone-plan usage meters** (Calling + Texting, §14.8), and a **Dialer** button (§14.6). *(The **Simulate incoming** demo control was moved out of the header into the **Training** page, §14.9.)*
- **Primary nav (7 pages):** **Calls · Phone numbers · Call flows · Call masking · Call groups · Blocked callers · Texting.**
  - **Calls** is the default landing page (§14.2) and nests the prior sub-tabs: Calls overview, Unified Inbox, Dispatch & Calls, Performance & QA.
  - **Phone numbers** lists tenant numbers (number, type, **ad group**, assigned flow, status — §14.10).
  - **Call flows / Call masking / Call groups / Blocked callers / Texting** are scaffolded pages (description + primary action + empty state) to be built out.

### 14.2 Calls overview (the default page) `[extends §4.1, §8.1]`
A date-scoped command center over the call log:
- **Date-range picker** (top-right of the tab row): presets — Today, Last 7/30/90 days, This month, All time — plus a custom from/to range. Drives the whole page.
- **Stat strip (clickable filter toggles):** Missed calls · Calls · **New customers** · **Existing customers** · **Repeat callers** · Active calls · Avg call time · Revenue. Pressing a card scopes the table to that subset (the headline numbers stay as the period totals); a "Table scoped to …" chip clears it.
- **KPI tiles (single-select, cross-tab nav):** Calls today · **Missed Calls** · Unread messages · **Needs Attention**. Clicking a tile both navigates and applies the matching focus filter, with a clearable "Showing …" banner. Only one tile is active at a time.
- **Faceted "Filter results"** (§14.4).
- **Call table** columns: Status (direction/missed icon), From, To, Time (date + duration), Call Flow, Ad Source, Tags, Insights (AI sentiment / "needs review"), Answered By (CSR/AI + name), Jobs & Leads, Revenue, Quick Action (**Call Back** / **Dismiss**). Search, page-size, and CSV **Export** in the toolbar. Every column header except Quick Action is a **sortable control** (§14.12), and clicking any row opens the **call detail drawer** (§14.11).
- Filters compose: **date range → KPI focus → faceted filters → stat-card scope → search.**

### 14.3 Faceted call filter ("Filter results") `[new; extends §4.1.A]`
A multi-select faceted filter that narrows stats **and** table together. Facets:
**Direction** (incoming/outgoing) · **Call flow** · **Source / ad group** · **Status** (answered/missed/active/voicemail) · **Duration** (under 30s, under/over 1 min, under/over 3 min, over 5 min) · **User** (handling CSR, AI receptionist, voicemail, no-answer) · **Customer** (new/existing) · **Job** (linked / no job linked) · **Tags.** OR within a facet, AND across facets; active selections render as removable chips with "Clear all."

### 14.4 Naming & semantic changes `[supersedes §4.1.E, §4.1.G labels]`
- **"Callback queue" → "Missed Calls"** (KPI tile + focus label). Set = `status ∈ {missed, voicemail}`. The §4.1.E *callback queue* mechanic is unchanged; only the surfaced label changed.
- **"Emergencies" → "Needs Attention"**, with a **broadened trigger** (owner-review flag): a call surfaces if **any** of — `disposition = after_hours_emergency`, `disposition = needs_manager`, `sentiment = negative` (angry customer), or a low-confidence / flagged AI insight (`reviewFlag` set). This generalizes §4.1.G's emergency object into an owner "things to personally check" queue. *(Not yet wired: a script-deviation trigger — see §14.5; fold in once call-QA emits it.)*
- **New vs Existing customer:** a call is **Existing** when its caller resolves to a Customer record (`customerId` set), else **New** (unmatched, incl. unknown/spam — per owner choice).
- **Repeat callers:** distinct *external* parties (inbound `From`, outbound `To` — never the business line) appearing in **2+** calls in the period.

### 14.5 Performance & QA — script adherence `[extends §4.3, §6.6, R05]`
The agent scorecard adds a **Script** column: `scriptAdherencePct` — % of monitored calls that followed the approved script (greeting → qualifying questions → quote framing → close). Color-coded bar; **< 85% raises a "Needs attention" flag** (`SCRIPT_ATTENTION_THRESHOLD`). Scored identically for human CSRs and the AI receptionist (one yardstick, per R05). *Intended link:* feed low script-adherence calls into the §14.4 "Needs Attention" queue once the call-QA pipeline (§4.3.A) emits a per-call deviation signal.

### 14.6 Web dialer + job-aware calling `[extends §8.2]`
A click-to-open **Dialer** popup (centered modal) wrapping the softphone console (§8.2):
- **Keypad** dial-out (type/press digits → Call, with live timer, mute, hang-up) and screen-pop identity match.
- **Physical-keyboard dialing:** the number field **auto-focuses** when the dialer opens; typing **0–9, `*`, `#`, `+`** fills the number (works whether or not the field is focused), **Backspace** deletes, and **Enter** places the call (or **answers** a ringing call). Keystrokes inside another field (e.g. the job/PO search) are never hijacked.
- **Job/PO/customer search (desktop-only):** type a **job number, PO number, customer, or phone** to resolve the customer's number and **prefill the dialer** — no manual lookup. (PO search follows PO → job → customer to find the number.)
- **Job history / pre-call context panel (desktop-only):** customer + contact + membership; the **job card** (number, site, trade, status, scheduled date, assigned tech); **job notes** (access instructions, contact prefs, gotchas — new `Job.notes` field); **linked purchase orders, pressable to expand their line items**; and **recent call activity with expandable transcripts** so the user can read what was said before dialing.
- **Platform scope:** the search + history panes are **desktop-only**; mobile/app shows the keypad only.
- **Single softphone surface:** the prior **standalone softphone dock** in the Dispatch & Calls view was **removed** — the Dialer popup (and the global top-bar dialer, §14.14) is now the one place the softphone lives, avoiding a redundant second dialer in the corner. The Dispatch view now shows the **Callback queue + Recent calls full-width**. The **"Simulate incoming call"** demo opens the Dialer popup and rings the softphone *inside it* (screen-pop intact).
- **Audible call simulation (web test):** the softphone synthesizes call audio via the **Web Audio API** (no audio files) so a call can actually be *heard* in the browser. Outbound now has a **"Calling…" (ringback) phase** — US-style 440+480 Hz cadence — for ~3.5s before the other party "answers" (you can **Answer now** to connect early or **Hang up** to cancel), at which point a short **connect cue** plays and a **spoken greeting** (`SpeechSynthesis`) simulates the callee picking up. Inbound `ringing_in` plays a distinct **ring tone** until answered/declined. The **keypad emits DTMF dual-tones** per key. All audio is started by the user's click (satisfies the browser autoplay-gesture rule) and is torn down on hang-up/unmount. This is a **prototype demo aid**; in production the live audio leg is real WebRTC media over CTM softphone / CPaaS behind the provider adapter (§5.1, §8.2), not synthesized tones.
- **Call-back auto-dial:** the console accepts an `autoCallNumber` so other surfaces — e.g. **Call back** from the call detail drawer (§14.11) or the callback queue — can open the dialer **straight into the "Calling…" state** for that number (resolving screen-pop identity) instead of making the user re-type it. Consumed-once, like the prefill / incoming hooks.
- **Conference / add person:** during an **active** call the console can show a **"Conference / Add person"** control (`onConference`) that opens the office-contacts picker to pull a third party (dispatch, a manager, the assigned tech) onto the call. The console also emits an **`onEnded`** event on hang-up/decline so a host popup can close itself when the call finishes.

### 14.7 Data-model deltas (prototype seeds) `[extends §6.2, §6.6]`
- **`CallSession`** (§6.2) gains: `callFlow` (routing rule that handled the call), `tags` (free-form labels), `revenue` (attributed $), `jobLabel` (human job/lead reference shown in the table), and **`qaScore`** (per-call QA score 0–100, set once a recording is scored; surfaced in the call detail drawer §14.11). Existing `trackingSource` surfaces as **Ad Source**.
- **`PhoneAgent`** (§6.6) gains: `scriptAdherencePct` (§14.5).
- **`Job`** gains: `notes` (§14.6).

### 14.8 Plan-usage meters (header) `[extends §8.1, §14.1]`
- The module header shows **two usage meters** for the current billing cycle: **Calling** (minutes used / plan limit) and **Texting** (messages used / plan limit). Each renders a **label, percent, and a progress bar** toward the limit.
- **Threshold coloring:** green `<75%`, amber `75–89%`, red `≥90%` — so an owner sees at a glance when a plan is near its cap. Bars cap visually at 100% (overage still reads the true percent in production).
- Prototype values are seeded (`PLAN_USAGE`); in production the counters come from the **provider's usage/metering API** (CTM / CPaaS) per the telephony adapter. Meters are shown on `lg+` widths to preserve header space on small screens.
- **Limit-reached / upgrade path:** the usage box is a **clickable control** that opens a **plan panel** anchored beneath it. A **status pill + banner** reflect the worst meter — *Approaching limit* (amber, any meter ≥75%) or *Limit reached* (red, any meter ≥100%, with copy noting calls/texts may pause until upgrade or cycle reset). The panel shows the **current plan** (name · price · cycle), the two detailed meters, and a **"Choose your upgrade"** tier picker (Scale = recommended self-serve, Enterprise = custom; one selectable at a time).
- **Self-serve upgrade (instant, no sales contact) `[owner request 2026-05-30]`:** each upgrade tier carries concrete new allotments (`callingLimit` / `textingLimit`) and a `selfServe` flag. Pressing the primary button on a **self-serve** tier (e.g. *Scale*) **applies the upgrade immediately** — it re-bases the live meters to the new package's calling/texting limits (so the bars instantly re-compute and drop out of the warning band), updates the current-plan name/price, and toasts confirmation. No sales handoff: this is the "go straight to billing" path. The button label reflects the action (**"Upgrade to {plan} — {price}"**). A **custom** tier (e.g. *Enterprise*, no fixed price) instead shows **"Contact sales for {plan}"** and sends a sales request rather than self-billing. *(Prototype mutates in-memory `usage`/`plan` state; production posts the plan change to the billing provider and the new limits flow back from the metering API, gated by owner/admin RBAC and §6.7 `Tenant.spendCeiling` / §10 NFR-10 governance.)*
- **Reach sales (single button → email composer) `[owner request 2026-05-30]`:** below the upgrade button is **one** *Reach sales* action (the prior two-button *Call sales* / *Reach sales* pair was collapsed — calling was dropped per owner preference). Pressing it opens an **in-app email composer modal** (`ReachSalesModal`) rather than firing a blind request or handing off to a `tel:`/`mailto:` client. The composer:
  - **Pre-fills automatically:** **To** = the sales inbox (fixed, `SALES_EMAIL`), **From / reply-to** = the current user's email (editable), **Subject** = a context line seeded from the live plan + branch (e.g. *"Phone plan question — Scale (Brooklyn HQ)"*, editable).
  - **Preset questions ("Pick a question") `[owner request 2026-05-30]`:** a row of one-tap topic chips — *Upgrade my plan · Add phone numbers · Port a number · Raise call/text limits · Billing question* — sits above the body. Tapping one **fills both the subject and a ready-to-send message** (seeded with the live plan + branch) and highlights the active chip, so the owner can send in one or two clicks instead of writing from scratch. Both fields stay fully editable after a preset is applied.
  - **Lets the owner write what they want to ask** before sending — a **message body** ("What would you like to ask?") with prompts (pricing, add-on numbers, porting, contract questions). **Send to sales** is disabled until a message and reply-to are present; **Cancel** / **X** / **Esc** / backdrop dismiss it.
  - On **Send**, it toasts confirmation ("we'll reply to {reply-to} shortly") and closes — the model is *compose → send → the team is notified and emails back*. Prototype seeds: `CURRENT_PLAN`, `UPGRADE_PLANS`, `SALES_EMAIL`. In production the composed message creates a sales lead / sends the email (with the user's reply-to); the actual upgrade transaction remains an owner action, not an unattended charge.

### 14.9 Training history & recordings `[extends §4.3, R05]`
- The **Training** page splits into two sub-tabs: **Run training** (the role → scenario → simulation flow) and **History**.
- **Run training (role-based AI call sim) `[owner request 2026-05-30]`:** the trainee **picks a role** (Office/CSR · Field technician · Billing · Dispatch), then a **scenario** for that role; the matching **AI trainer bot** "calls" them and a **`SimulationModal`** runs the whole call in-app — **ringing** (Accept/Decline) → **in-call** → **done** (a color-toned score, coaching note, Run again / Done). This trains the whole office on the company script the same way. The **"Simulate incoming call"** demo control was **relocated here** from the module header (§14.1); it still rings the softphone inside the Dialer popup. Seeds: `TRAINING_ROLES`, `TRAINING_SCENARIOS` in `phone-training.ts`.
- **Multiple scripts per role `[owner request 2026-05-30]`:** each role now carries **three scenarios** (12 total), grounded in standard service-industry phone-script structure (greeting → qualify → frame/handle → close). New scenarios include *Price shopper — phone quote* (Office), *Maintenance plan offer — on site* (Technician), *Payment plan setup* (Billing), and *No-show recovery* + *Bumping a routine job for an emergency* (Dispatch).
- **Turn-by-turn script content `[owner request 2026-05-30]`:** every scenario carries a **`dialogue: TrainingTurn[]`** — each turn is `{ customer, rep, cue? }`: the line the **AI customer says**, the **on-script model line** the trainee practices, and a one-line **coaching cue**. A **"View full script"** toggle on the scenario start panel renders the readable Customer/You script (with cues) so an owner can **visualize the whole script before running it**.
- **Live voice conversation `[owner request 2026-05-30]`:** in-call, the simulation is a real back-and-forth, not a checklist. The AI customer **speaks each line aloud** (Web Speech `speechSynthesis` TTS); the trainee **answers by voice** (`SpeechRecognition` STT — "Tap to talk", interim text shown live) **or by typing**, and a **chat transcript** builds turn by turn (customer left, trainee right) with a per-turn **"Your line — read it aloud"** model card + cue. A **"Use model line"** button auto-answers with the ideal line, a **Voice on/off** toggle mutes TTS, and the flow **gracefully degrades** to type / Use-model-line when the browser lacks mic or speech support. The header shows `line N/total`; after the last exchange a **wrap** state enables **Finish** → score. *(Prototype: browser-side TTS/STT for visualization; production would use the telephony media stream plus a server-side speech + LLM voice agent.)*
- **History** is a filterable log of every completed/abandoned simulation so a manager can see **who was trained, on what, the score, and when**. Each row: trainee (name + role), scenario + difficulty, AI trainer, **score**, **result** (Passed / Needs work / Incomplete), timestamp, length, and a **Play recording** control.
- **Sortable column headers `[owner request 2026-05-30]`:** Trainee / Scenario / Trainer / Score / Result / When / Length headers are **clickable to sort** the table top-to-bottom (toggle asc/desc; active header is indigo with a direction chevron; text columns default ascending, numeric/date/result default descending — Result ranks Passed › Needs work › Incomplete). Recording is not sortable. Reuses the Calls-table sort pattern (`TrainSortHeader`, `ChevronsUpDown`/`ChevronUp`/`ChevronDown`); sorting reorders only the currently filtered set and does not affect the KPI breakdowns. Default sort: **When, newest first.**
- **Press a row → full session `[owner request 2026-05-30]`:** every row is **pressable** and opens a right-side **`TrainingSessionDrawer`** slide-over (mirrors the call detail drawer) with the complete record: trainee + role, **score** (color-toned) + **result** badge, scenario + difficulty, AI trainer, role, when, length, the **AI coaching summary** (AI-badged), and a **Play recording** control (or a "not completed" note when there's no recording). Closes via ×, scrim, or **Esc**. The in-row Play button stops propagation so it doesn't also open the drawer.
- **Filters:** by **person (trainee)**, role, result, and free-text search. A summary strip shows Sessions, People trained, Avg score, and Pass rate for the current filter.
- **Clickable KPI cards — drill into the stat `[owner request 2026-05-30]`:** the four summary cards are **pressable** (chevron affordance; the active card turns **black**) and toggle a **breakdown panel** beneath the row, computed from the *currently filtered* set. **Sessions** and **Pass rate** → counts/% by result (Passed / Needs work / Incomplete, green/amber/slate bars); **People trained** → per-trainee rows (role + session count, sorted by volume); **Avg score** → score-band distribution (90–100 / 80–89 / 70–79 / Below 70). Press again or the panel's **×** to close; switching cards swaps the panel. Components: `TrainStat` (button), `TrainStatBreakdown`; state `statView: TrainStatKey | null`.
- **Recordings** of training calls are **retained for review/QA**; results below the **pass threshold (`TRAINING_PASS_THRESHOLD`, 85)** are flagged "Needs work." Data model: `TrainingSession` (`traineeName`, `roleId`, `scenarioId`, `score`, `outcome`, `durationSec`, `completedAt`, `hasRecording`, `coachingNote`). Prototype seeds in `phone-training.ts`.
- **Session transcript `[owner request 2026-05-30]`:** the `TrainingSessionDrawer` carries a **Transcript** section (below Recording) showing the **turn-by-turn dialogue of the simulated call**, so an owner/coach can read exactly **what the agent (or technician) said and what the AI trainer said in reply**. Each turn renders an **initials avatar**, the **speaker name**, a **role label** (the trainee's role, e.g. "Senior CSR", vs. "AI trainer"), and a **mm:ss timestamp**; trainee lines are tinted indigo and trainer lines are white/bordered so it's easy to scan who said what. A **"N turns"** chip sits by the heading; a "No transcript available" note shows when a run has none (e.g. abandoned). Data model: a new optional **`transcript?: TranscriptTurn[]`** on `TrainingSession`, where `TranscriptTurn = { speaker: "trainee" | "trainer"; at: string; text: string }`. (This is the *actual* recorded dialogue of a completed run, distinct from the scenario's expected **`dialogue: TrainingTurn[]`** script in §14.9.) Prototype transcripts seeded for all sessions in `phone-training.ts`; rendered via the `initials()` helper in `PhonePage.tsx`.

### 14.10 Phone numbers — ad-group attribution & dropdown finish `[extends §8.1, §6.2 Ad Source]`
- The **Phone numbers** page gains an **Ad group** column. Each number row has an **"Assign An Ad Group"** picker so tracking numbers can be attributed to a campaign/source (Office, Account, Alpha Return customer, Google, Google Local Services Ad, Reserve with Google, Return customer, Village). Selection ties into call **Ad Source** attribution (§6.2).
- **Dropdown finish (module-wide standard):** this picker is a **custom menu** (not a native `<select>`) with the requested clean, **square white** finish — white surface, square option rows, and the **active choice filled solid blue**. The closed trigger shows the assignment (or the "Assign An Ad Group" placeholder) with a focus ring on open. The **Assigned flow** picker (`FlowSelect`) was **also converted to this clean white finish** `[owner request 2026-05-30]` — same white surface + solid-blue active row — adding **grouped section labels** (*Flows · Forwarding · People*); it previously used a native `<select>` whose OS menu rendered gray. **This finish is the standard for *every* dropdown in the Phone module — no native OS-gray menus.** All remaining selects (country in the "Get a number" drawer, the Calls table page-size, and the Training-history filters) use a shared `CleanSelect` component so each opens as a **white panel downward** with the same square rows + solid-blue active state, on `sm`/`md` sizes; new dropdowns must reuse it.
- **Create new ad group inline:** the menu ends with a **"+ Create new ad group"** affordance that reveals an inline name field + **Add** (commit on Enter, cancel on Esc). Creating a group adds it to the tenant's shared ad-group list, **immediately assigns it to the current number**, and makes it available in **every** number's picker (one tenant-scoped list, not per-row). This lets an owner spin up a new campaign/source bucket without leaving the table.
- Data model: `OwnedNumber` gains `adGroupId`. Ad groups are tenant-managed and mutable at runtime (`adGroups` state seeded from `AD_GROUP_SEED`); a created group gets an `id` (`grp_<ts>` in the prototype) + `label`. In production these are tenant-scoped CRM records, not seeds.

### 14.11 Call detail drawer — recording, transcript & scores `[extends §4.1, §4.3, §8.3]`
Clicking **any call row** (or its linked job chip) opens a right-hand **detail slide-over** that consolidates everything about that one call, so an owner never has to leave the call log to review it. **Every call surface is pressable** — the Calls-overview table, the Dispatch **Recent calls** table, and the **Callback queue** items all open this same drawer (per §14.15 "everything is pressable"). On the callback-queue item the inline **Resolve** action stops propagation so it doesn't also open the drawer.
- **Header:** Incoming/Outgoing call title with the matched **contact** (name, the other party's number) and quick **round actions** (add, message, call back).
- **Where the call came from:** a From / To / **Ad Source** / **Call Flow** grid plus status and tags — the full routing/attribution picture.
- **Recording (playback + download):** an in-drawer **recording player** with play/pause, **skip back / forward 15s**, a **playback-speed toggle** (1× / 1.5× / 2×), a scrub progress bar with `m:ss` position/duration, and a **Download** control. Calls without a recording show an explicit empty state.
- **Transcript** of the call beneath the player.
- **Two score cards:** **Answered by** (CSR/AI + name) with that agent's **Agent QA** (`scriptAdherencePct`, §14.5), and the **Call score** for this specific call (`qaScore`, §14.7) with its sentiment/disposition. Both use a shared tone scale — emerald ≥ 90, amber ≥ 80, rose < 80.
- **Linked job:** a button through to the connected job/lead when one is attached.
- *Compliance note:* recording playback/download remains subject to the §9 retention and consent rules; the download is an owner action, not automatic.

### 14.12 Sortable call-table columns `[extends §14.2]`
Every call-table header except **Quick Action** is a click-to-sort control:
- **First click** sorts by that column; **clicking the active column again** flips direction. A chevron on the active header shows the direction; idle headers show a faint up/down hint.
- **Default direction is column-aware:** numeric/temporal columns (**Time**, **Revenue**) lead **highest/newest-first**, then reverse on the second click; text columns (Status, From, To, Call Flow, Ad Source, Tags, Insights, Answered By, Jobs & Leads) lead **A→Z**, then Z→A. (e.g. Revenue: first click = largest amount down to smallest; second click = smallest up.)
- Sorting runs **after** all other narrowing (date range → KPI focus → faceted filters → stat-card scope → search), so it reorders only the currently visible result set and the page-size cap still applies.

### 14.13 Phone numbers — provisioning drawer & per-line routing `[extends §14.10, §6.7 PhoneNumber, §5.6 onboarding]`
The **Phone numbers** page is the tenant's roster of owned lines, where each number is an **individually routable row** (a "chart" of lines) and new lines are provisioned from a right-side drawer.

- **Number table (per-line routing):** each row is one owned number with **Number · Type · Ad group · Assigned flow · Status · Created · Action** columns. The **Assigned flow** picker is the per-line routing control — an owner can repoint any line independently (e.g. *Forward to Emanuel* → *Forward to Dispatch* → *Main IVR → CSR* → any other person/flow), or **Remove flow** to clear it. This is the prototype surface for the §4.1.I routing slice at the number level: one number → one selectable call flow, changeable at any time without touching other lines.
- **Status semantics:** a line reads **Active** once it has an assigned flow; a newly provisioned line with no flow reads **No flow** — a prompt to route it. (Maps to `OwnedNumber.status` + presence of `flowId`.)
- **"Get a number" drawer (right-side slide-over, not a centered modal):** opening **Get a number** slides in a panel from the right so the number table stays visible alongside it. Layout, top to bottom:
  - **Select country** (United States / Canada).
  - **Number type** toggle — **Local** / **Toll-free** (switching regenerates the result list; Local uses the typed area code, Toll-free draws from 800/833/844/855/888).
  - **Area code** + **Contains (optional)** search inputs (area code disabled for Toll-free); **Refresh** and **Search** re-query the available pool.
  - **Assign flow (optional)** — route the line at creation, or leave it and assign later from the table row.
  - **Choose a number from the list** — **the entire result row is pressable** (not just a trailing link); each row shows the number and a **✓ Get number · $2.00** affordance, and tapping anywhere on it selects *that* line for purchase. The foot note states the per-number price and that no charge happens until the buyer confirms.
- **Purchase confirmation (approval required, because it costs money):** selecting a number opens a **Confirm purchase** step before anything is provisioned. It summarizes **Number · Type · Assigned flow · Total due**, carries an explicit authorization line ("By clicking Buy, I authorize a one-time $2.00 charge … and accept the **Terms & Conditions**"), and offers **Cancel** / **Buy · $2.00**. Only **Buy** provisions the line — this is the owner's transaction approval (each number is a **one-time $2.00 charge**, `NUMBER_PRICE`). This satisfies the "user must approve a paid action" requirement: nothing is bought on the first tap.
  - On **Buy**, the line is added to the top of the table (status **No flow** unless a flow was chosen), a "✓ Purchased … · $2.00 charged" toast fires, and the drawer closes. **Cancel** returns to the list; **Esc** or the backdrop closes the drawer.
- **Production binding:** the available-number search, area-code/contains filtering, and provisioning are prototype-seeded; in production they call the **provider adapter's number search/order** path (CTM tracking-number pools / CPaaS, §5.1, §7) and the new line is registered to the tenant sub-account per §5.6 onboarding. The confirm-purchase + T&C step is the prototype stand-in for the **billed provisioning transaction** and the acceptable-use/legal acknowledgment logged at provisioning; production wires it to the tenant's billing/metering account and the real per-number price.
- Data model: `OwnedNumber` carries `number`, `type` (`Local`|`Toll-free`), `flowId`, `status`, `createdAt`, `adGroupId` (§14.10), `tag?` — aligning to §6.7 `PhoneNumber` (`kind`, `campaignRef`) as the canonical fields land. Per-number price is the `NUMBER_PRICE` constant (prototype = $2).

### 14.14 Global dialer (app top bar) `[extends §8.2, §14.6]`
- A **phone icon** lives in the **app's global top bar**, to the immediate left of the notifications **bell** (order: Help · **Dialer** · Bell), so the dialer is reachable from **every page in the system** — Inventory, Vendors, Price Book, Purchase Orders, Phone — not just the Phone module.
- Clicking it opens the **same centered Dialer popup** as the in-module Dialer button (§14.6): keypad dial-out, and on desktop the **job/PO/customer search** + **pre-call history panel**. It is self-contained (own open state + toast) and overlays whatever page is active.
- The Phone module's own header **Dialer** button (§14.1) remains; the top-bar dialer is the always-available global entry point. Implemented as `GlobalDialer` (reuses `DialerWorkspace`), mounted in `TopBar`.

### 14.15 "Everything is pressable" — drill-through principle `[cross-cutting; extends §14.11]`
A system-wide UX principle: **any row, card, list item, stat, or flagged risk that represents an underlying record is clickable and opens that record's detail** — the owner should never have to leave a tab/report and hunt for the same information elsewhere.
- **Done (Phone module):**
  - **Calls-overview** table rows, Dispatch **Recent calls** rows, **Callback queue** items, and risk/**Needs Attention** rows all open the **call detail drawer** (§14.11). Inline actions inside a pressable row (e.g. Resolve) stop propagation.
  - **Performance & QA**: each **agent card** and each **scorecard row** opens an **agent detail drawer** (metrics, script adherence, and the agent's **handled calls**). From there, clicking a handled call **drills through** to that call's detail drawer (agent → call).
  - **Unified Inbox**: threads open the conversation; the context panel's **Linked jobs** chips are pressable (drill to the job).
  - **Get a number** result rows are pressable end-to-end (whole row → purchase confirm, §14.13). KPI tiles, stat cards, faceted filters, and sortable headers are already interactive (§14.2, §14.3, §14.12).
- **Pattern:** a pressable element gets `cursor-pointer`, a hover state, a `title`/aria affordance, and opens either a **slide-over drawer** (record detail) or **routes** to the owning page with that record focused. Nested drill-through swaps drawers (close the parent, open the child) rather than stacking.
- **Other modules (already conformant):** Inventory rows → item detail, Vendors cards → vendor detail, Purchase Orders rows → PO/Pre-PO detail, Price Book rows → item editor. The principle is now consistent system-wide; remaining polish (e.g. a dedicated thread-detail view) is deferred to owner sign-off.

### 14.16 Call detail — live call, text, and conference actions `[extends §14.11, §8.2]`
The three round quick-actions in the call detail drawer (§14.11) are now live:
- **Call** (phone icon) → opens an **active-call popup**: the softphone opens straight into **dialing → connected** to the contact's number (audible ringback + connect cue), so the user can **mute, conference, and hang up** without leaving the record. Hanging up closes the popup.
- **Message** (chat icon) → opens a **docked SMS conversation** at the **bottom-right** (seeded with the customer's existing thread). The user can **type and send** from there; it stays open over whatever they're doing.
- **Add** (plus icon) → opens the **Conference picker** (also reachable from the active call's **"Conference / Add person"** button and the message panel's conference shortcut).
- **Conference picker:** lists **Office staff** (human CSRs) and **Field technicians** (the tech roster), each with an **Add to call** toggle (flips to "Added", with a running "N on the call" count), plus an **"or call an individual number"** keypad entry to add an off-roster party. In production these add legs to the live conference bridge via the telephony adapter (§5.1/§7); here they're prototype-mocked with toasts.
- **Implementation:** `Softphone` gained `autoCallNumber` (open straight into a call), `onConference`, and `onEnded`; new `ActiveCallPopup`, `MessagePanel`, and `ConferencePicker` components. Office roster = `phoneAgents` (human) + `techs`.

### 14.17 Unified Inbox — new-message composer & directory `[extends §4.2, §8.4]`
- The Unified Inbox thread list gets an **Inbox** header with a **New** button that opens a **new-message composer** for starting a fresh SMS to anyone — not just existing threads.
- **Thread-list directory filter `[owner request 2026-05-30]`:** a row of filter tabs sits across the top of the thread list and refiles the list below without leaving the view. Tabs: **Conversations** (customer threads, default), **Team** (internal threads with office staff / field techs), **Group** (multi-party crew threads, e.g. a job crew), and **Archive** (closed-out threads, hidden from the other buckets). **New** is an action (opens the composer), not a filter. Each tab carries an **unread-count badge**; switching tabs reselects the first thread in that bucket so the conversation pane never shows a hidden thread. Tabs wrap to a second row in the narrow column and use the module-standard pill styling (active = solid indigo). Selecting a thread opens it and the right-hand context panel resolves to that person/customer; a **customer or group thread tied to a job still shows the job** in the context panel's **Linked jobs** (more organized than a free-floating thread). A **team** thread (no Customer record) shows a lightweight `TeamInfoPanel` (name, role, internal-SMS note) instead.
- **Data model:** `MessageThread` gains optional `kind?: "customer" | "team" | "group"` (absent = customer), `archived?: boolean`, and `title?`/`subtitle?` display fields for team/group threads that aren't tied to a Customer. Helpers `threadKind`/`threadTitle`/`threadMeta`/`matchesFilter` back the filter and row rendering. Composing a customer thread snaps the filter back to **Conversations** so the new thread is visible.
- **Directory (left rail):** **Team** (office staff = human CSRs + field technicians from the tech roster), **Customers** (every customer + primary contact + number), and **By job** (search a **job # or customer**, resolving the job to its customer's number — the "search the jobs" path). A **search** box filters within the selected category.
- **Compose:** pick a recipient → a **To: …** compose view with a message box. **Send** to a **customer/job** opens (or creates) that customer's thread, appends the message, and **selects it in the inbox**; an empty body just **opens the conversation**. **Team** recipients are internal — sending toasts a confirmation (prototype) rather than creating a customer thread.
- **Bucket = full roster, not just open threads `[owner request 2026-05-30]`:** pressing a filter tab shows **everyone you can message in that bucket on the side**, not only people with an existing thread. **Team** lists live team threads first, then the rest of the roster (office staff + field techs) as tappable rows; **Conversations** lists open customer threads first, then every other customer. Roster rows render as a directory entry (avatar, name, subtitle, a **Text** affordance); tapping one **starts (or jumps to) the conversation** — a team tap spins up a `kind:"team"` thread titled with the member's name; a customer tap reuses `startCustomerThread` (find-or-create, empty body just opens it). Existing threads are de-duped from the roster so no one appears twice. **Group** and **Archive** stay thread-only (no standing roster).
- **Suggested additions (not yet built):** a **Vendors** category (needs vendor phone data), **Recents/favorites**, and group/broadcast send. Flagged for owner sign-off.
- **Implementation:** new `NewMessageDialog` + `buildRecipients(category)`; `InboxView` merges threads with `buildRecipients` into an `InboxRow[]` (`kind:"thread" | "person"`); `startCustomerThread()` / `startTeamThread()` find-or-create the thread. Directory sources: `phoneAgents` (human), `techs`, `customers`, `jobs`.

### 14.18 Call masking — proxy numbers & AI guardrails `[extends §4, §8; owner request 2026-05-30]`
Replaces the Call-masking placeholder with a real `CallMaskingView` so a tech's and a client's real numbers are never exposed on a job. Modeled on the owner-supplied reference (Workiz) — a five-step numbered accordion (`MaskStep`) in clean white cards, **collapsed by default** with a one-line summary on each header. Per owner preference the active-tab accent is **black** (open step = black number badge / neutral border), not the module's indigo. `CleanSelect` dropdowns and toast-on-save throughout.
- **Step 1 — Which techs get masked numbers:** **company-wide by default `[owner request 2026-05-30]`** — an **Auto-mask everyone in the company** toggle (on by default) means every user is masked and any **new user added to the system automatically joins** masking; turning it off lets the owner opt people in by hand. Below it, a checkbox grid over the **real tech roster** (`techs`, showing role + branch) with **Check all / Uncheck all** and a live **"N masked"** count lets you add/remove individuals. Manually unchecking anyone flips Auto-mask off (no longer everyone); re-selecting all of them (or Check all) turns it back on.
- **Step 2 — Record calls?:** radio (Don't record / Record). When recording, a disclaimer block with a **consent-style** `CleanSelect` (one-party "notice only" vs. all-party "explicit"), a **✨ Draft with AI** button that writes a state-appropriate disclaimer into the box, a **Try it out** preview (text-to-speech via `speechSynthesis`), and the federal/state consent legal note.
- **Step 3 — What number the client sees:** Caller-ID `CleanSelect` (main / ads / toll-free) + **Use smart tech callback** (route client callbacks to the relevant tech while the job is open; those calls are recorded too).
- **Step 4 — Your masking number:** displays the proxy line `(646) 718-4893`, explains the temporary **3-digit per-job extension**, an expandable **"Show me how it works"** 4-step explainer, and **Use masking for leads**.
- **Step 5 — AI guardrails & insights `[AI]`:** three toggles, each with a live example card. **Off-platform leak guard** — flags a tech sharing a personal number / "pay me directly" / taking the job off-platform (the core risk masking exists to prevent) and **alerts the owner** (shown as a high-risk call card); also drives an **AI-suggests** nudge in Step 1. **Call summary + transcript** — every masked call auto-transcribed & summarized to the job/client page (key points, promised price/time, next steps). **Sentiment & escalation alerts** — detects an upset client / risky language on a masked call and pings dispatch in real time.
- **State:** in-memory prototype (resets on reload), consistent with the rest of the module; production wires Steps 1–4 to the masking/proxy provider and Step 5 to the call-intelligence layer (§8). New components: `CallMaskingView`, `MaskStep`, `AiGuardrail`, `Toggle`; constants `MASKING_NUMBER`, `DISCLAIMER_TEMPLATES`, `CONSENT_OPTIONS`.

### 14.19 Call Flow Builder — phone automation `[extends §2.1, §4, §6; owner request 2026-05-30]`
Replaces the Call-flows placeholder with a working visual **call-flow builder** so owners can automate how an inbound call is greeted, screened by hours, and connected — modeled on the owner-supplied reference (Workiz). Lives in its own file `dashboard/src/components/CallFlows.tsx` to keep `PhonePage.tsx` focused.
- **Two views.** A **list** of saved flows (name · structure · assigned numbers · recording on/off · status · updated), each row clickable to edit, plus a **Create Call Flow** button. Seeded with two flows ("Main line" = Voice Menu, "After-hours" = Basic). **Create Call Flow** opens the **"Choose Your Call Flow Structure"** modal (two cards: **Basic** and **Voice Menu**); picking one spins up a draft from that template and opens the **builder**.
- **Editable, template-driven shape `[owner choice]`.** The builder is a vertical canvas: `Incoming Call → Business Hours →` an **Open** branch and a **Closed** branch. **Basic** = Open: Greeting → Forward · Closed: Voicemail. **Voice Menu** = Open: Greeting → Voice Menu (digit options) · Closed: Voicemail. Branch labels (Open/Closed) and the menu's digit fan-out render as connectors; the overall shape comes from the chosen template rather than free-form drag-building. `+` insert dots between Open-branch steps add an extra **Greeting** or **Forward**.
- **Node types `[owner choice]`.** **Greeting** (message text), **Business Hours** (Always open vs. On a schedule — sets the Open/Closed split), **Forward / Connect** (destination = a **Person** from `currentUser`/`phoneAgents`/`techs`, a **Group**, a typed **Number**, or **Voicemail**), **Voice Menu / IVR** ("press 1/2/3…" with editable digit options, each routing to its own destination), and **Voicemail** (greeting). Clicking any node opens a context **NodeEditorPanel** in the right rail; a node can be removed (except the structural Incoming/Business-Hours).
- **Basic Info panel.** Flow **Name**, **Business hours** mode, **Assigned numbers** (multi-select of owned numbers), and a **Record Call Flow** toggle. **Save** upserts the flow and sets its status (Active if any number is assigned, else Draft); **Cancel** discards.
- **Wired into the phone system `[owner choice]`.** Single source of truth = a number's `flowId`. `numbers` and `callFlows` are **lifted to `PhonePage`** and shared with both the Call-flows and Phone-numbers tabs. Saving a flow (or toggling its Assigned numbers) calls `assignFlowToNumbers(flowId, numberIds)`, which sets the selected numbers' `flowId` to `flow:<id>` and detaches any that were unselected. The Phone-numbers **"Assigned flow"** dropdown (`FlowSelect`) now lists custom flows under a **"My flows"** group, and a number row resolves its label via `flowNameForId(...)` — so the two tabs stay in sync automatically.
- **State:** in-memory prototype (resets on reload). New file `CallFlows.tsx` exporting `CallFlowsView`, types `CallFlow`/`FlowNode`/`ForwardTarget`/`MenuOption`, templates (Basic / Voice Menu), `CALL_FLOW_SEED`, and helpers `customFlowOptions` / `flowNameForId` / `flowStructureLabel`. Components: `StructureChoiceModal`, `CallFlowBuilder`, `FlowCanvas`, `NodeCard`, `NodeEditorPanel`, `TargetEditor`, `BasicInfoPanel`, `MiniSelect`. Production wires saved flows to the routing engine (§6) and recording to the compliance ledger (§9).

### 14.20 Call Groups — ring-together teams `[extends §2.1, §6; owner request 2026-05-30]`
Replaces the Call-groups placeholder with a working `CallGroupsView` so a call flow can ring several people/devices together. Modeled on the owner-supplied reference (Workiz "create group"). Lives in its own file `dashboard/src/components/CallGroups.tsx`.
- **List + create/edit modal.** A table of groups (name · ring strategy · member count + names · updated), each row clickable to edit, plus a **Create group** button. Seeded with three groups whose ids match the flow seeds (`grp_dispatch` "Dispatch team", `grp_sales` "Sales team", `grp_oncall` "On-call techs").
- **Ring strategy `[owner choice]`.** Each group picks **Ring all at once** (simultaneous — the Workiz default) or **Round-robin** (one member at a time until answered). A two-button toggle in the modal; the helper copy updates to match.
- **Members × devices.** "Members in group" lists the roster (`currentUser` + human `phoneAgents` + `techs`, each with name + role/branch). Every person exposes **two device toggles — Cell and Softphone** (a member is the person *and* the device, keyed `personId|device`), matching the reference's "User cell / Softphone" columns. A live **"N devices selected"** count sits in the footer. Note carried over from the reference: softphones only ring when open and the user is logged in.
- **Wired into the flow builder `[owner choice]`.** `callGroups` is **lifted to `PhonePage`** and shared. The Call Flow builder's **Forward → Group** picker (and each Voice-Menu option's destination) reads its options from `groupTargetOptions(callGroups)` via a `groupOptions` prop threaded `CallFlowsView → CallFlowBuilder → NodeEditorPanel → TargetEditor`, so a group created here is immediately selectable as a routing destination (and the picker shows a "create one on the Call groups tab" hint when none exist).
- **State:** in-memory prototype (resets on reload). New file `CallGroups.tsx` exporting `CallGroupsView`, types `CallGroup`/`CallGroupMember`/`RingStrategy`/`GroupDevice`, `CALL_GROUP_SEED`, and helpers `ringLabel` / `groupTargetOptions`. Components: `GroupModal`, `DeviceToggle`. Production rings real user devices via the telephony provider (§6).

### 14.21 Blocked callers — block-a-number popup & one-tap block from the log `[extends §4.1, §9; owner request 2026-05-30]`
Replaces the Blocked-callers placeholder with a working `BlockedCallersView`. The accent is **black** (header tile + "Block a number" button + popup chrome), matching the owner's masking-tab preference.
- **One source of truth.** Blocked numbers are **lifted to `PhonePage`** (`blocked`/`setBlocked`, seeded from `BLOCKED_SEED`) with `blockNumber()` / `unblockNumber()` helpers, so blocking from anywhere lands in the same list. `blockNumber` **dedupes by digits** (toasts "already blocked") and prepends new entries.
- **Block from the Calls log `[owner request].`** Every row's **Quick Action** column gains a **Block** button (danger/rose `QuickAction` tone). Pressing it blocks the call's **external party** (inbound → `fromNumber`, outbound → `toNumber`), auto-fills the **caller name** when known, sets the reason to **Customer** if it maps to a known customer else **Spam**, **and dismisses the row** — so it "goes straight to the Blocked callers tab."
- **Block-a-number popup `[owner request].`** The tab's **Block a number** button opens a small centered modal (`BlockNumberModal`): a **phone-number** field, a **Reason** `CleanSelect` (**Spam / Not spam / Customer / Other**), and an optional **Description** textarea ("why are you blocking it"). The **Block** button is disabled until a plausible number (≥7 digits) is entered; **Esc**/scrim/Cancel close it.
- **The log.** A card lists each blocked number (count header + "auto-blocked spam included" note): number (mono) · name · **reason pill** (toned per reason) · note · "Blocked {day} · {who}", with a per-row **Unblock** action and an empty state.
- **State / data:** new file `dashboard/src/data/phone-blocked.ts` — `BlockedNumber`, `BlockReason`, `BLOCK_REASON_LABELS`, `BLOCK_REASON_TONE`, `BLOCKED_SEED`. In-memory prototype (resets on reload); production reads/writes the carrier block-list. Components: `BlockedCallersView`, `BlockNumberModal`; `QuickAction` gained a `tone` prop.

### 14.22 Texting — templates, automations & SMS compliance `[extends §4.2, §8.4; owner request 2026-05-30]`
Replaces the Texting placeholder with a working **`TextingView`**, modeled on the reference field-service SMS settings page in our clean module styling. Three sub-tabs: **Templates & settings**, **Automations**, **Compliance & legal**. A sticky amber **Save Settings** bar pins to the bottom (prototype toast — no persistence yet).
- **Templates & settings.** Mirrors the reference: a **Messaging compliance** block (Caller ID field + green **Verified** badge + the carrier-disclaimer note), **Messaging settings** (Forward incoming messages — a repeatable Phone-number list with **+ Add number** / remove, and an **Enable Job Closing** checkbox), and **Text templates**.
- **Text templates `[owner request].`** Each template is an editable card: name + info tooltip + a **To customer / To team** audience badge, a multiline editor, and a row of **clickable merge-field chips** (`{{job_id}}`, `{{full_name}}`, …) that **insert the token at the caret**. Presets (Job Text Message, On the Way, Running late + a Notify-me checkbox, Appointment reminder, Review request, Job closing / payment link) carry **Reset to default**.
- **Create a new template type `[owner request].`** A **New template** button opens `NewTemplateModal` (name + audience + body with the full merge-field palette). Custom templates render with a **Custom** badge and a **Delete** action; they're reusable everywhere a template is referenced.
- **Automations `[owner request].`** A list of triggered texts — each row has an **enable toggle**, the **trigger** (Job booked · Appointment reminder 24h/1h · Tech on the way · Job completed · Missed call · Invoice unpaid), the **template it sends**, timing, audience, and Edit/Delete. **New automation** opens `AutomationModal`: pick a trigger, then **use an existing template *or* "Write from scratch"** (compose a message with merge chips — saved as a reusable custom template), set **timing** + **audience**, toggle **Active/Paused**. Seeds in `TEXT_AUTOMATIONS_SEED`.
- **Compliance & legal `[owner request].`** Surfaces the rules for business texting in plain English: an **A2P 10DLC — Verified** status panel, an editable **auto opt-out footer** (toggle; default "Reply STOP to opt out, HELP for help…"), a **quiet-hours** toggle (8 AM–9 PM local), and a numbered **"What the law requires"** panel (consent/TCPA, A2P 10DLC registration, honor STOP/UNSUBSCRIBE, quiet hours, identify yourself + no SHAFT content), closed by a **not-legal-advice** disclaimer. *(Penalties run $500–$1,500/message; production must wire real consent capture, opt-out processing, and time-zone-aware send gating.)*
- **State / data:** new file `dashboard/src/data/phone-texting.ts` — `MERGE_FIELDS`/`mergeLabel`, `TextTemplate` (+ `TEXT_TEMPLATES_SEED`), `TextAutomation` / `TextTrigger` / `TEXT_TRIGGERS` / `TIMING_OPTIONS` (+ `TEXT_AUTOMATIONS_SEED`), `SMS_COMPLIANCE` / `OPT_OUT_FOOTER` / `SMS_LEGAL_DISCLAIMER`. Components in `PhonePage.tsx`: `TextingView`, `TemplateCard`, `MergeChip`, `NewTemplateModal`, `AutomationModal`, `TextSubTab`, `AudienceBadge`, `InfoDot`. In-memory prototype (resets on reload).

### 14.23 Unified email inbox — team directory, groups & forwarding `[extends §14.17; owner request 2026-05-30]`
Adds a **team directory** to the unified email inbox (`InboxPage`) so the owner can email staff without leaving the inbox, plus manageable distribution groups and forwarding — "to run the business."
- **Team (sidebar) `[owner request].`** A **Team** section lists every user with avatar, name, role, and an online dot. Clicking a member **opens the composer pre-addressed to them** (individual email). A **Directory** link opens the manage modal's Members tab.
- **Groups (sidebar) `[owner request].`** A **Groups** section lists email groups (distribution lists: All staff, Field techs, Office / CSR, Billing, Dispatch) with a member count. Clicking a group **opens the composer addressed to the whole group** (comma-joined recipients) — one-click group email. A **Manage** link opens the Groups tab.
- **Manage modal (`ManageDirectoryModal`) `[owner request].`** Tabbed: **Members** (read-only roster of users + emails, each with a quick **Email** action; roster itself lives in Settings → Users), **Groups** (create / rename / delete groups, toggle members in/out via chips, email a group), and **Forwarding** (route incoming mail to a teammate or group — per-rule **from** field, On/Off, target picker, add/delete). Esc / scrim / Done to close.
- **Forwarding (sidebar) `[owner request].`** A compact **Forwarding** list shows each rule (source → target) with an off-state badge; seeded with After-hours → Dispatch, billing@ → Billing, Reviews → owner.
- **Collapsible rail `[owner request].`** The whole left rail (folders + Team + Groups + Forwarding) **collapses to a slim strip** to free up screen space. It **auto-collapses the moment an email is opened** (more room for the reading pane), and the owner can **reopen it** (expand button on the strip) and **re-close it** (collapse button in the rail's "Menu" header) any time. `railOpen` state; `PanelLeft` / `PanelLeftClose` affordances.
- **State / data:** new file `dashboard/src/components/InboxDirectory.tsx` exports `ManageDirectoryModal` (+ structural `TeamMember` / `EmailGroup` / `ForwardRule` types). `InboxPage.tsx` holds `TEAM_MEMBERS`, `EMAIL_GROUPS_SEED`, `FORWARD_RULES_SEED` and lifts `groups` / `forwards` / `manageTab` state; `emailMember` / `emailGroup` open the composer pre-filled. In-memory prototype (resets on reload); production reads the CRM user/RBAC table and writes provider-side forwarding.

### 14.24 Email inbox — Gmail-style reply/compose & AI assist `[extends §14.23; owner request 2026-05-30]`
Makes the inbox feel like the email client owners already use: **familiar, not new**.
- **Inline reply & forward `[owner request].`** Pressing **Reply** (or **Forward**) opens the composer **inline at the bottom of the open thread** — not a floating popup — exactly like Gmail. It shows the From-account row, a **To** prefilled with the sender (empty for forward), an auto-focused body, and the original tucked into a collapsed **"···" quoted-text** toggle. **Send** files to Sent; the trash icon **discards (saving a draft if there's text)**; a **pop-out** affordance lifts the inline draft into the docked window. Component: `InlineComposer` (rendered inside `ReadingPane`); parent state `reply: ReplyDraft | null`, cleared on navigation; handlers `startReply` / `startForward` / `sendReply` / `discardReply` / `popOutReply`.
- **New mail = docked side window `[owner request].`** **Compose** still opens the Gmail-style **`ComposeWindow` docked bottom-right** ("a new tab on the side"), leaving reply/forward inline. The two can coexist.
- **AI assist in every composer `[owner request].`** An **"✨ AI" menu** sits next to Send in the inline composer *and* the docked window. It can **Draft a reply / Draft an email** (context-aware for replies — pulls the sender name + subject; becomes **Regenerate** once text exists) and **Refine your text** Gemini-style: **Polish — professional · Make it friendlier · Shorten it · Elaborate · More bold & bombastic · Fix spelling & grammar**. Refine options disable until there's text; each drops the rewritten text into the body with a "✨ …" toast. Component `AiAssistMenu`; prototype helpers `aiDraft` / `aiRefine` (`RefineTone`) are **deterministic templated text** — production swaps them for a real LLM call.

### 14.25 Top-bar quick-access icons `[owner request 2026-05-30]`
The app header (`TopBar.tsx`) carries the global comms shortcuts. `[owner request]`
- **Pinned to the right corner.** The icon cluster (help · Messages · WhatsApp · Mail · phone/dialer · notifications) is pushed flush to the **right edge** via `ml-auto` (was floating mid-row because the search box caps at `max-w-xl`); it ends one standard `px-6` gutter from the edge.
- **Recognizable, prettier icons.** **WhatsApp** uses the real brand glyph (inline SVG `WhatsAppIcon`) in WhatsApp green `#25D366`; **texting/Messages** uses the nicer stacked-bubble `MessagesSquare`. **Mail (Outlook)** and the **phone/dialer** are unchanged. The notifications bell keeps its `9+` unread badge.
- **WhatsApp page header glyph `[owner request 2026-05-30].`** The **WhatsApp page** header (`WhatsAppPage.tsx`) was using a generic `MessageCircle` chat bubble; it now renders the **same real WhatsApp brand glyph** (a local `WhatsAppIcon` SVG matching the top-bar one) in the green `#25D366` tile, so the page matches the actual app.
- **Attention badges `[owner request 2026-05-30].`** Each comms icon now carries a small red count badge (shared `CountBadge`, same style as the bell — rose-500 circle, white ring, `9+` past 9; hidden at 0): **Messages** = unread SMS across non-archived threads, **WhatsApp** = unread WhatsApp chats, **Mail** = unread inbox emails, **phone/dialer** = missed calls + voicemails needing attention. Each icon's `title` tooltip spells out the count (e.g. "Inbox — 3 unread", "Dialer — 3 need attention"). Counts derive from the prototype seeds at load (`smsThreads`, `SEED_CHATS`, `SEED_EMAILS`, `callLog`) and are **static for now** — production lifts live unread/missed state to the app shell so badges decrement as items are handled.

### 14.26 Email inbox — Gmail-style message actions `[extends §14.23, §14.24; owner request 2026-05-30]`
Rounds out the open-message action bar with the Gmail actions owners expect, so working a message feels identical to Gmail.
- **Snooze `[owner request].`** A clock action opens a **"Snooze until"** menu (Later today · Tomorrow · This weekend · Next week). Snoozing sets `snoozedUntil`, **hides the message from the inbox** (filtered out of the inbox bucket), toasts the chosen time, and closes the reading pane. *(Prototype doesn't resurface on a timer; production reschedules delivery.)*
- **Mark as unread `[owner request].`** Re-flags the message **unread** and closes it, so it can be left unread in the list (also in the ⋮ menu).
- **More (⋮) overflow menu `[owner request].`** Mirrors Gmail: **Mark as unread · Mark as important** (toggles an `important` flag + Bookmark marker) **· Add/Remove star · Create event** (toast — hook to calendar in production) **· Mute** (moves the thread out of the inbox).
- **Toolbar `[owner request].`** Left group **Archive · Report spam · Delete | Mark as unread · Snooze · Add to tasks**; right group **Reply · Forward | Star · More (⋮)**. Both popovers close on outside-click / re-press.
- **State / data:** `Email` gains optional `important?` / `snoozedUntil?`; `InboxPage` adds an `updateEmail(id, patch)` helper passed to `ReadingPane` as `onUpdateEmail`; the inbox `visible` filter hides snoozed messages. Local menu state (`snoozeOpen` / `moreOpen`) lives in `ReadingPane`. In-memory prototype.

### 14.27 Communication hub — nav, WhatsApp, Gmail inbox, threading & compose `[extends §8.1, §14.17, §14.23; owner request 2026-05-30]`

The sidebar's **Phone** entry becomes a **Communication** hub, and the email inbox is upgraded to feel like Gmail.

- **Communication hub nav `[owner request].`** The sidebar **"Phone"** item is now an **expandable "Communication" group** (icon `MessagesSquare`, default-expanded) with three sub-tabs — **Phone** (the full phone workspace, §14.1+), **WhatsApp**, and **Inbox** (§14.23+). The parent-label click routes to **Phone**; the chevron toggles. New routes `whatsapp` / `inbox` wired in `Sidebar.tsx` and `App.tsx`.
- **WhatsApp Business page `[owner request].`** New `WhatsAppPage.tsx` — a two-pane WhatsApp inbox (searchable conversation list + chat thread) in WhatsApp green: inbound/outbound bubbles, **delivery → read ticks**, "end-to-end encrypted" note, unread pills, the connected business-number chip, and a working composer (send appends to the thread, ticks progress **sent → delivered → read**, opening a chat clears its unread). Seeded with field-service chats tied to the same customers used across the module.
- **Email inbox = a single Gmail integration `[owner request].`** Each tenant connects **one** mailbox (a different tenant might connect Outlook instead, but never both). The prototype is **Gmail-only** — Outlook and the multi-inbox filter chips were removed; the header shows a single **"Gmail · Connected"** status and the rail shows one **Connected account**. Model: `AccountId = "gmail"`, `PRIMARY_ACCOUNT`.
- **Reading pane — full-width list when idle `[owner request].`** The empty "Select a message" right column is gone: with nothing open the message **list fills the width**; the reader only mounts when a message is opened.
- **Conversation threading `[owner request].`** Messages group into **conversations** by `threadId` — replies/forwards inherit the original's thread; new mail starts a fresh one (seeds back-filled so existing reply/draft pairs group). The list shows **one row per conversation with a message count**; the reader renders the **whole chain oldest → newest**, the latest message expanded and older ones **collapsed to a one-line summary** (click to expand), with your own messages labeled **"You"**. A sent reply appears in the chain **immediately** (fixing "I send it and it doesn't show the chain"). Helpers `threadKey()` + `openThread`; opening a conversation marks the whole thread read.
- **Compose — Gmail-style toolbar + working attachments `[owner request].`** Both composers (the docked `ComposeWindow` and the inline `InlineComposer`) get a Gmail toolbar beside Send/AI: **Formatting · Attach · Link · Emoji · Image**. **Attach** opens a real file picker → **removable chips** (name + size) that ride along on Send and render in the conversation chain; **Emoji** inserts from a picker; **Link** drops an editable URL. Model: `Attachment { name, size }` on `Email` / `ComposeState` / `ReplyDraft`; shared `ComposerToolbar` + `AttachmentChips`; helpers `filesToAttachments` / `fmtFileSize`. Sent/draft mail carries its attachments (`hasAttachment` + `attachments`).
- **Dropdown clipping fix (extends §14.10) `[owner request].`** `CleanSelect` now renders its open menu in a **portal to `<body>`** with fixed positioning, **flip-up**, and viewport-capped height, so it escapes the `overflow` of modals/tables that was clipping it (reported on the Texting **automation → Timing** picker). Remains the standard for every Phone-module dropdown — no clipped or native OS-gray menus.

> These are prototype/UX decisions for owner sign-off; promote the confirmed ones into the canonical §4/§6/§8 specs in the next PRD revision.

---

*End of PRD. This document is the single source of truth for the Phone System + AI Communication Module build. Not legal advice; tenants must obtain telecom/TCPA counsel review before enabling high-risk features.*
