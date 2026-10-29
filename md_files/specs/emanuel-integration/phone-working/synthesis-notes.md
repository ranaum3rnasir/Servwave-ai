# Synthesis Notes — Phone System + AI Communication Module

Director Architect working artifact. Started 2026-05-28.

---

## STEP 1 — Existing System Inventory (read-only, observed from repo)

### Stack
- **Frontend**: React 19.2 + TypeScript ~6.0 + Vite 8 + Tailwind 3.4 + lucide-react icons.
- **`dashboard/`** = the live FSM CRM prototype. Routes: `inventory`, `vendors`, `price-book`, `purchase-orders` (state-based switch in `App.tsx`, NO router library).
- **`viewer/`** = separate Radix/shadcn app that renders the PRD markdown (`src/content/prd.md`). Tooling, not the CRM. Runs on :5173 via pnpm.
- Dashboard runs on **:5174** via `npm --prefix dashboard run dev` (see `.claude/launch.json`).

### Backend / webhook reality — IMPORTANT DISCREPANCY
- **There is NO backend, server, or webhook in the repo.** No express/fastify/createServer, no `fetch`/axios calls, no api/ or server/ directory.
- `dashboard/` is **frontend-only**: all data is in-memory TypeScript modules under `src/data/*.ts` (inventory, jobs, techs, purchase-orders, staging, stock-approvals, current-user, pre-po). Mutations happen in React state.
- The prompt's premise ("existing webhook running on localhost") is NOT present in this codebase. → **BLOCKER Q for Emanuel** (see open-questions): is there a real backend/webhook elsewhere (e.g. a Make.com scenario — Make MCP tools are connected), or is "webhook" aspirational and the phone module specs against the same prototype convention + a to-be-built backend contract?

### Patterns & conventions to respect
- **Data modules**: each entity = a typed `export type X = {...}` + `export const xs: X[] = [...]` seed array. Comments cite the governing PRD section ("PRD §6", "PRD §11.7 RBAC").
- **RBAC**: centralized in `data/current-user.ts`. `UserRole` union = owner | admin | office_admin | dispatcher | field_technician | subcontractor_tech | warehouse_manager | inventory_admin | purchaser | accountant. Capability helpers (`canManageLocations`, `canApproveStockActions`, etc.) keep checks in one place "for easy refactor when auth lands."
- **Event bus**: `lib/alert-bus.ts` `subscribeAlertIntent()` — cross-route pub/sub so a bell-click on any route can drive navigation + state. Pattern: nonce-stamped intent props pushed down from `App`. The phone module's "incoming call / new message" notifications should reuse this bus pattern.
- **Dialog-heavy UI**: ~40 dialog components in `dashboard/src/components` (Add/Edit/Detail/Preview/Email). Heavy use of preview + Email + Save-as-PDF + Print parity. Inline e-signatures (type-to-sign, adopt-and-reuse) in `lib/signatures.ts`.
- **Domain helpers** live in `dashboard/src/lib/*.ts` (inventory-alerts, po-receive, vendor-spend, rfq, csv, signatures).

### Existing data model (entities the phone module will extend / reference)
- **`Job`** (`data/jobs.ts`): id, jobNumber, customer (string — NOT a first-class entity yet), site (string), trade ('locksmith'|'door'|'security'|'hvac'|'plumbing'|'multi'), scheduledFor, assignedTechId, status ('scheduled'|'in_progress'|'completed'|'on_hold').
- **`Tech`** (`data/techs.ts`): id, name, role ('field_tech'|'warehouse_lead'|'counter'|'subcontractor'), branch, vehicle, primaryTrade, certs[].
- **`CurrentUser`/`UserRole`** (`data/current-user.ts`).
- **Customer is currently a bare string** on Job — there is no Customer/Contact entity, no phone number field anywhere yet. The phone module will need to introduce Customer + Contact + phone-number entities and back-link Jobs. → flag as schema extension.
- Other modules (inventory, vendors, POs, staging) are price-book-domain; phone module links primarily to Job, Tech, Customer(new), and the notification/alert bus.

### ICP / business context (from seed data — high confidence)
- Owner: **Emanuel Dahan, Alpha Security US**, Brooklyn HQ + Queens branch.
- Customers in seed: Rolex 5th Ave, McDonald's, TikTok TriBeCa, Tiffany & Co, Equinox Hudson Yards, Whole Foods, Chase Bank, NYC DOE — **commercial multi-trade, NYC metro**.
- Trades launched in price-book PRD: locksmith + door + security + (garage door) with hvac/plumbing as adjacency.
- Geography in data: New York / Brooklyn / Queens → **NY is a two-party... no, NY is a ONE-party consent state for recording**, but multi-state expansion likely. → compliance flag.

### Format expectation (from prior deliverable)
- `deliverable/PRD.md` (price-book) is extremely detailed and section-numbered (§5.4.A.ix, §7.4.A.8 etc.), with UX increments tracked granularly. The phone PRD should match this depth and numbering discipline, and the dashboard code expects to cite "PRD §" anchors.

---

## STEP 2 — Research Synthesis
_(pending — research read via parallel agents)_

### Research file inventory
Present (8): Inbound AI Receptionists · Outbound AI/Dialers · Call Routing & Dispatch · AI Call Intelligence · Agent Performance & QA · Telephony Infrastructure & Compliance · Two-Way SMS · WhatsApp/Multi-Channel.
**MISSING vs. brief's expected set (3):** phone Voice-of-Customer (00), phone Competitor-Teardown (07), **CTM Vendor-Fit (10)**.
Noise (ignore): "Pilot Plan for Digital Mental Health…", "Product Management Transition Program Plan."

---

## STEP 2 — Research Synthesis (8 present reports; via 4 parallel reader agents, full reads confirmed)

### R01 Inbound AI Receptionist & Call Capture
- **Core problem = missed demand, not AI sophistication.** 27% of home-services calls unanswered (18% weekday / 41% weekend); 60% of customers prefer to call; speed-to-lead odds drop ~100x from 5→30 min.
- **Pattern that works = structured AI, not open-ended voice.** Answer → identify/intent → qualify urgency+fit → check hours/area/availability → book OR callback OR transfer → log transcript/summary/entities → expose for QA. Sits on KB + scheduling source-of-truth + CRM lookup.
- **Cheapest reliable win = missed-call recovery stack**: instant missed-call text-back, voicemail transcription/tagging, callback queue w/ summaries, direct-book only for simple rules-based jobs.
- **Biggest adoption risk = booking surviving into the field app** (sync failures, booking-not-populating are the #1 review complaints across ST/Workiz/HCP), NOT conversation quality.
- Handoff must be a STRUCTURED PACKET (transcript+summary+fields+urgency+accept/decline), not a blind bridge. Owner sentiment: "receptionist as backup, not default"; bilingual EN/ES is now standard.
- Pricing range: entry AI $49–$299/mo (Rosie/Goodcall/Smith.ai), FSM-native heavier ($449/mo Sameday; ST $2.75/call PAYG; Avoca custom). Human baselines $250–$1,725/mo.
- **Recommendation: build the FSM-specific decision layer yourself; integrate commodity voice. The moat is FSM-aware orchestration, not the voice.** Voice identity (name/greeting/disclosure/tone) must be configurable product data.

### R02 Telephony Infrastructure, Numbers & Compliance  ← BACKBONE REPORT
- **Headline: build your own embedded telephony control plane on top of a CPaaS.** Do NOT build carrier infra; do NOT anchor on white-label PBX/contact-center OEM (weakest margin/control over numbers/recording/E911/portability).
- **CPaaS verdict: Telnyx primary** (cheapest serious API-first; SIP ~$0.005 out/$0.0035 in +$0.002/min platform; numbers $1→$0.25/mo; STT $0.015/min; SMS $0.0045/seg; SIPREC 2024; dynamic E911; AI-native). Mitigate Telnyx ops risk (Reddit outage/support signals) with provider-adapter abstraction + fallback. **Twilio = safest/most expensive secondary** (best docs/branded calling/SMS trust; US voice $0.014 out/$0.0085 in; numbers $1.15; E911 $0.75/no.; branded calling $0.12/call; 99.95–99.99% SLA; can store recordings in your own S3). **Bandwidth = best number economics** ($0.30/no.; up to 4 track streams; strong E911). Plivo/SignalWire/Vonage cheaper-but-smaller; Infobip/quote-led disqualified for self-serve.
- **Provider adapters must exist from day one** (number search/order/port, call orchestration, recording lifecycle, SMS-registration state, E911/location state, reputation telemetry). No active-active at launch; add 2nd carrier later.
- **Recording: provider capture, customer-controlled canonical storage** — encrypt at rest in own cloud (KMS, tenant isolation), app DB stores metadata only, auto-delete provider copies, log every playback/export.
- **Numbers: porting (1–3 wk US) is table stakes.** Three distinct layers: CNAM (weak on mobile) → Verified caller ID (outbound) → Branded calling (Twilio best). 
- **Compliance baseline:** A2P 10DLC mandatory (brand ~$4–4.50, campaign review ~$15 + monthly); throughput fragmented by carrier; toll-free verification tightened 2026 (Telnyx new mandatory fields Feb 17 2026). Recording consent: federal one-party, minority all-party states → universal disclosure at call start, tenant-configurable, store consent evidence. STIR/SHAKEN + Robocall Mitigation DB filing. E911: Kari's Law (direct 911 + notify) + RAY BAUM'S (dispatchable location); softphone/mobile → dynamic location model.
- **CRITICAL GAP: this report does NOT mention CTM/CallTrackingMetrics at all.** The build-vs-buy frame is CPaaS (rec) vs white-label OEM (not rec) vs direct-carrier (overkill). CTM analysis must come from Emanuel's supplied report + Director analysis.

### R03 Outbound AI, Cold Calling & Sales Dialers
- **Highest-value outbound = monetize existing database first** (open estimates, recent inquiries, due tune-ups, expiring plans, post-job reviews) — NOT cold-prospect spray.
- **AI voice agents only for WARM/expected calls** (speed-to-lead callback, estimate follow-up, confirmations, on-the-way, renewals, dead-lead reactivation, review asks). Dialer fit: Preview (high-ticket/commercial) > Power/Progressive (SMB) > Predictive (call-centers only, high risk).
- **COMPLIANCE RED ZONE (FCC Feb 2024): AI-generated voice = "artificial voice" under TCPA → AI outbound = robocall.** Telemarketing to wireless OR residential artificial-voice needs **prior express WRITTEN consent**. Calling hours fed 8a–9p local (state overlays tighter). DNC scrub ≤31 days; predictive abandonment ≤3%; caller ID mandatory; revocation honored ≤10 business days. B2B not safe (FTC 2024 TSR; many "business" #s are personal cells).
- **Recommendation: ship outbound in 3 layers** — (1) safe revenue core = human preview/power dialer + AI-assisted notes/dispositioning; (2) tightly-bounded AI voice for warm/operational flows w/ consent captured at form submit; (3) high-risk (consumer AI cold-call, predictive, voicemail-drop, multi-state) behind hard admin/legal gates.
- **Build a CONSENT LEDGER** (who/when/how/which number/seller/channel/use-case + evidence: form HTML, URL, timestamp, IP, e-sign, disclosure language) and **campaign classification** (informational/operational/estimate/reactivation/renewal/review/telemarketing) — consent gate, hours, DNC, opt-out behavior all key off classification. + suppression engine + number-health telemetry + stable purpose-based number pools.

### R04 AI Call Intelligence
- **Trades want tight STRUCTURED capture, not "AI notes"** (locksmith: phone/address/job/time; plumbing: pipe location/type/size, cleanout). Core pain = missed leads + slow logging.
- STT engines: **Deepgram Nova-3/Flux** (dev-first, best real-time/voice-agent, self-host, ~$0.005–0.0058/min) | AssemblyAI (cheap batch $0.15–0.21/hr) | Whisper/gpt-4o-transcribe ($0.003–0.017/min) | Google STT (telephony 8kHz models) | Speechmatics (sub-1s real-time).
- **WER ≠ CRM-field accuracy** — a 2026 study found **44% avg error on spoken US street names**. → confidence-gated writes + address validation (not transcription alone). Phone audio adversarial (8kHz). Prefer preserving separate agent/customer channels over diarization inference.
- **Auto-log architecture: 6-stage pipeline** (ingress+recording notice → streaming STT draft → post-call canonical transcript → redaction+normalization → separate prompts for summary/extraction/disposition → CRM orchestration). **5 data families:** Customer&location / Problem&equipment / Commercial signal (price asked vs quoted) / Outcome&next-step / Evidence&confidence. **Confidence-gated:** high→auto-write (callback#, window, booked y/n), medium→suggestion, low (exact address, quote value, model, emotion)→review queue w/ evidence span.
- **Disposition taxonomy** (booked, quote requested, quote given not booked, reschedule, cancel, status check, billing, warranty, service-area mismatch, spam/vm, after-hours emergency, needs manager, follow-up).
- Compliance: one-party fed / ~11 all-party states (CA DE FL IL MD MA MI MT NH PA WA + CT special); PCI (no CVV in recordings → DTMF masking); **IL BIPA voiceprints high-risk → defer voice biometrics from MVP**; vendor data posture varies (retention/training opt-outs).
- **Phased: post-call transcript+extraction+summary+disposition → real-time upset/emergency alerts → rubric QA → defer voiceprints/autonomous hard-entity writes.**

### R05 Agent Performance & QA (Human + AI)
- **Shift from telephony stats → revenue-linked outcomes.** No sampled product unifies human+AI+marketing+job+revenue — **biggest opportunity.**
- **Human KPIs:** answer rate (human/AI/abandoned; SLA 80%/20s), missed-call recovery, lead rate (~37% of mktg calls), **booking rate** (show gross/eligible/capacity-adjusted — ST AI example 70% w/ capacity vs 90% without), **ask-for-the-appointment rate** (only 44% ask — high-leverage/under-tracked), AHT (balancing not hero), FCR (good 70–79%, world-class 80%+), revenue per booked call, QA coverage.
- **Manage AI like a named employee** with a roster card. AI metrics: eligible-call booking rate, containment, planned vs forced escalation, transfer success, repeat-contact, revenue per AI call + conversation-quality (intent accuracy, latency/silence, repeated-question, promise accuracy, tone). Voice agents fail across ASR/NLU/LLM/TTS chain → show WHERE it failed. **4-D AI scorecard: Outcomes/Experience/Handoffs/Governance.**
- Scorecards weight outcomes over script (SQM 85% delivery / 15% compliance). Listen/whisper/barge/takeover now baseline. **Review queues should order by EXPECTED LOST REVENUE** (no competitor does this).
- Build: unified interaction ledger (call→intent→booking→job→estimate→invoice→collected); eligibility-aware metric engine; historical score snapshots (CallRail "current-only" cautionary); preset scorecard templates; calibration/dispute flow.
- Caveat: buyer preference split (67% prefer human, yet 52% say AI improved experience) → comparisons must be intent/segment-aware. Punitive auto-QA destroys trust → must be disputable/explainable.

### R06 Call Routing & Dispatch Integration
- **Best FSM experience = a routing LAYER that knows caller→job/asset→owner→hours/priority→next action.** Baseline (no longer premium): caller-ID match, screen-pop, click-to-call, auto-log, book-while-live.
- **"Follow-the-tech" has 3 distinct meanings — keep separate in data model:** (1) masked outbound from tech's phone (shows business #); (2) proxy-based two-way temp masking (Twilio Proxy/Telnyx, expires after job); (3) routing ownership (next convo → tech vs dispatcher vs last-agent vs office, depends on JOB STAGE).
- **Routing fit ladder:** ring-all → sequential+overflow+simple IVR → IVR/queues → skills/territory/priority. Six rule families engine must support natively: hours-based, simultaneous/sequential ring, IVR/menu, queue distribution, ownership routing, emergency override.
- **Biggest market gap: job-aware routing** ("if caller has open job today → assigned dispatcher; if assigned tech on active job in callback window → masked callback; else office queue"). No FSM exposes this first-class.
- Build **call-context graph**: number normalize → client match → service-address → equipment/asset → open request/job/estimate → assigned dispatcher → assigned/last tech → membership/SLA → priority flags.
- **Emergency = structured dispatch object** (issue type, risk, vulnerable-occupant, water/freeze flags, SLA override), not "press 9." Triggers: gas/CO/no-heat/burst pipe/electrical/lockout.
- **Architecture: FSM-native context + CPaaS-backed execution.** Build web console first, then mobile subset (masked callback, accept/reject, voicemail, disposition).

### R07 Two-Way SMS / Texting
- **Customer texting = table stakes.** Value rank: confirm/reminders → on-my-way/arrival → two-way convo → quote follow-up + pay links → MMS/photos → reviews. Unified inbox tied to customer/contact/job is a core trait.
- **Dispatch-by-text = validated but UNDERSERVED.** Workiz is clearest proof (app-less subs: text carries job ID + client + contact + address + confirmation link; link page → accept job, log payment, close). **Recommended: structured SMS + secure link**, not free-form thread. Full state machine: sent→delivered→link-opened→acknowledged→accepted/declined→en route→arrived→completed→escalated. Channel hierarchy for W-2 techs: app push → SMS fallback → office-call escalation.
- Compliance: **A2P 10DLC mandatory** (TCR brand $4.50; campaign fees $1.50–$10/mo; vetting $41.50/$101.50; provisioning 3–5 wks). CTIA: opt-in before messaging, consent record, STOP keywords, one final opt-out confirm. Quiet hours 8a–9p apply to solicitations (operational texts firmer ground). One-to-one consent rule VACATED — don't hard-code per-seller checkbox.
- Build texting as **two coordinated products on one messaging layer**: customer-facing (consent-heavy) vs technician (operational). Separate senders/campaigns by function. Surface registration/opt-out/message-state in UI. MMS uneven → media abstraction w/ hosted-link fallback.

### R08 WhatsApp & Multi-Channel Messaging
- **US WhatsApp ~100M MAU (~1/3 adults) — important but NOT the centerpiece in North America** (it's one channel among SMS/web-chat/Meta-DMs). Much stronger abroad (Spain 94.6%, UK, UAE).
- Value rank: booking confirm/reminders/reschedule (utility, often free in-window) → on-the-way/ETA → photo/video + quote PDFs (remote triage) → reviews (marketing, opt-in) → reactivation (highest policy risk).
- **Everything centers on the 24-hour customer-service window** (resets on inbound msg); outside it → approved templates only. **Per-MESSAGE pricing now, NOT conversation-based** (Meta, Jul 2025; corrects the brief). NA rates: marketing $0.02875, utility/auth $0.00391; service free; utility free in-window → **route follow-ups into open window to cut spend.**
- **BSP: go DIRECT on Meta Cloud API + Embedded Signup** (customer-owned WABA reduces lock-in). If thin transport needed: **360dialog (no Meta markup, ~$59/mo). AVOID Twilio** for FSM's low-dollar utility volume (markup > the fee itself). Don't pick full-stack inbox (respond.io/Wati) unless reselling a workspace.
- **UNIFIED INBOX: canonical record = customer/contact, NOT channel identity.** Store channel IDs as child objects (wa_id, IG ID, Messenger PSID, Apple handle, SMS #, voicemail). One longitudinal timeline per customer, linked to job/estimate. Per-message normalized event but permission/identity/pricing/window/delivery stay channel-specific. **Route by operational ownership** (CSR/branch dispatcher/tech-on-job/estimator/after-hours), not "next available." Apple Messages gives no phone/email → identity resolution designed around that. Google Business Messages dead (Jul 2024).

### CROSS-REPORT CONVERGENCE (high confidence — appears in 3+ reports)
- **X1. FSM-native orchestration on top of CPaaS execution.** R02 (build control plane on CPaaS), R06 (FSM-native context + CPaaS execution), R01 (build decision layer, integrate voice), R08 (CRM owns identity/routing, transport via API). → The moat is the FSM-aware layer, not the carrier.
- **X2. Structured capture + confidence-gated auto-log, not "AI magic."** R01 (structured packet), R04 (confidence-gated writes + 5 data families), R06 (call-context graph). 
- **X3. Revenue-linked, job-aware everything.** R05 (interaction ledger call→job→invoice→revenue), R06 (job-aware routing gap), R04 (commercial-signal capture). 
- **X4. Compliance is a first-class product surface, not a footnote.** R02 (10DLC/recording/E911/STIR-SHAKEN), R03 (consent ledger + campaign classification + suppression), R04 (consent map + PCI + BIPA), R07/R08 (10DLC + WhatsApp opt-in/window). 
- **X5. Missed-call recovery + speed-to-lead is the cheapest highest-ROI win.** R01, R03, R05.
- **X6. Unified inbox keyed to customer/contact, channel-agnostic timeline, channel-specific semantics.** R07, R08, R06.

### CROSS-REPORT CONFLICTS / TENSIONS (need Emanuel or Director call)
- **T1. Backbone: research says CPaaS (Telnyx); Emanuel leans CTM.** R02 never mentions CTM and rates white-label OEM "not recommended." → RESOLVE in decisions-log after CTM report lands.
- **T2. WhatsApp priority: research says NOT centerpiece in NA; FSM gap exists but moderate penetration.** Emanuel did NOT select WhatsApp for Phase 1 → consistent. Keep WhatsApp as later phase.
- **T3. Outbound AI aggressiveness: research = warm-only, hard legal gates; Emanuel selected "Outbound AI dialer" for Phase 1.** → must scope outbound P1 to the SAFE layer (human preview/power dialer + AI-assist + warm-consented AI voice), not consumer cold AI. Confirm in interview.
- **T4. BSP for WhatsApp vs SMS: 360dialog/direct for WhatsApp, but CPaaS (Telnyx/Twilio) for SMS/voice — two transport stacks.** If CTM is chosen, where does SMS/WhatsApp live? CTM is voice/call-tracking-centric. → architecture reconciliation needed.

---

## STEP 3 SUPPLEMENT — CTM Vendor-Fit synthesized from WEB RESEARCH (2026-05-28)
_(The supplied "CTM report" file was actually a depression-RCT pilot plan — wrong document. Director ran live web research instead. All facts sourced; see PRD §13.5. Marked CONFIRMED vs UNCONFIRMED.)_

### CONFIRMED (public sources, May 2026)
- **Pricing model — NOT per-seat (corrects earlier draft assumption):** Four plans — Marketing Lite **$79/mo**, Marketing Pro **$179/mo**, Sales Engage **$329/mo**, Enterprise **$1,999/mo** — each **includes unlimited users** (no per-seat charge) **+ usage fees** (per-minute, per-number, transcription). Month-to-month, first month free, up to ~2 months free annual. → margin pressure is from *usage* at volume, not seats.
- **Multi-tenant substrate CONFIRMED (validates I1/I2):** Agency **sub-account** model. Marketing Pro bundles **25 sub-accounts**; agency tier scales to unlimited sub-accounts/users. **White-label**: own domain **$65/mo + $99 one-time**, or **free** on a `calltrackingapp.com` subdomain. Flexible billing (agency invoices clients, or clients pay direct). → one sub-account per tenant is real and supported.
- **API + webhooks (supports F1 contract):** REST API (public Postman workspace) + **bidirectional webhooks**, near-real-time. Webhook payload at call **start** = caller #, dialed #, source; at **end** = duration, **recording link**, answering agent, **transcription**, post-call scoring. Conditional triggers (source/number/tag/talk-time/total-time). Basic-auth headers. Weekly API office hours.
- **VoiceAI (native AI voice agent) — launched Sep 8, 2025 (MATERIAL):** **Inbound** (answer 24/7, FAQ, **appointment booking**, intent routing, **human handoff**) **and outbound** (triggered when a teammate is available; integrates with CTM "LeadReactor" outbound dialing + Call Analysis). Configurable via uploaded FAQs/scripts/webpages, custom voice/tone, prebuilt templates or custom flows. **Pricing: first 250 min/agent free, then $0.12/min.** **SOC2 + HIPAA + BAA.** → CTM is **no longer "thin" on AI voice** — this narrows the CPaaS escape-hatch rationale.
- **STT:** CTM **deployed Deepgram inside their AWS VPC** for transcription → aligns with our D6 (Deepgram primary).
- **Compliance (Trust Center):** A2P **10DLC** brand + campaign registration (**$15/campaign** vetting fee), **STIR/SHAKEN**, **CNAM** caller ID. Recordings included free on all accounts; speaker-organized transcription. → validates D9 (CTM handles 10DLC).
- **Number porting:** **2–4 weeks** US, no service disruption, **no fee to port away** → matches R02.
- **Outbound dialer:** "Smart Dialer" + click-to-call + dynamic scripts + SMS follow-up; "regulatory frameworks built-in to deter spam," DNC/compliance tooling. Softphone required for dialer; **mobile app cannot receive dialer calls.**

### UNCONFIRMED — residual verification items (carry into PRD §12)
- **VoiceAI Spanish / bilingual EN-ES** support: NOT disclosed. PRD requires EN+ES in P1 → if VoiceAI is EN-only, bilingual AI voice rides the **CPaaS adapter**.
- **Raw real-time bidirectional media-streaming API** for *custom/bespoke* AI agents: CTM exposes VoiceAI as a configured product, not a media primitive → custom/real-time agents = CPaaS (Telnyx) territory.
- **Recording retention period + ability to pull canonical copies to our own cloud:** not disclosed (we still architect our own canonical storage per D3 regardless).
- **E911 / Kari's Law / RAY BAUM'S dynamic-location** handling in CTM: not disclosed.
- **Full dialer taxonomy** (preview/power/**predictive** + abandonment ≤3% controls): CTM markets "smart dialer," does not clearly document predictive abandonment caps → advanced predictive likely CPaaS.
- **At-scale usage economics** vs Telnyx (~$9.3K/mo) / Twilio (~$21K/mo) at modeled volume: needs Alpha's actual minute/number/message volumes to compute.

### NET EFFECT ON THE BACKBONE DECISION
- §C hybrid **holds and is strengthened**: CTM genuinely covers P1 inbound + routing + recording + tracking + two-way SMS + 10DLC + a native AI voice agent + multi-tenant sub-accounts. The CPaaS escape-hatch rationale **narrows** to: bilingual AI voice (if VoiceAI lacks ES), custom real-time/bespoke agents + bidirectional media, advanced predictive dialing at scale, branded calling, and E911 sophistication.
- One **draft error corrected**: CTM is flat-plan + usage with **unlimited seats**, not per-seat.
