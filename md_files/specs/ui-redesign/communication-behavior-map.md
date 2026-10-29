# Communication module - behaviour map (UI kit migration, Phase 1)

Status: mapping complete, 2026-07-29. Read-only documentation. No code was modified.
Module 12 in `md_files/plans/ui-redesign/UI_KIT_MIGRATION_PLAN.md` section 5.
Scope: `/communication/phone` (+ `/:tab`), `/communication/whatsapp`, `/communication/inbox`,
`/communication/text` (+ `/:tab`), plus `frontend/src/components/communication/**`.

Method: every statement below was read from the named file. Anything not determinable from source
is in section 12 (Open questions), not guessed. No live-site crawl was performed in this pass.

---

## 0. File inventory

### Pages

| File | Size | Route |
|---|---|---|
| `frontend/src/pages/communication/PhonePage.tsx` | 1,384 lines | `/communication/phone`, `/communication/phone/:tab` |
| `frontend/src/pages/communication/InboxPage.tsx` | 1,317 lines | `/communication/inbox` |
| `frontend/src/pages/communication/WhatsAppPage.tsx` | 393 lines | `/communication/whatsapp` |
| `frontend/src/pages/communication/TextPage.tsx` | 142 lines | `/communication/text`, `/communication/text/:tab` |

### Components under `frontend/src/components/communication/`

```
phone/    BlockedCallersView · CallFlows · CallGroups · CallMaskingView · CallsTable · CallsView
          Dialer · DispatchView · NumbersView · PerformanceView · SmsInboxView · Softphone
          TextingView · TrainingView · shared.tsx · useCallsPipeline.ts
          __tests__/dialer-search-dropdown.test.tsx · __tests__/phone-tokens.reskin.test.ts
          useCallsPipeline.test.tsx
inbox/    AiAssistMenu · ComposeWindow · InboxDirectory
shared/   atoms.tsx  (JobBadge, ChannelIcon, StateChip, channelLabel)
          CustomerCommunicationsTab.tsx · JobCommunicationsTab.tsx   <- cross-module, see 0.1
```

### Data seam

| File | Role |
|---|---|
| `frontend/src/lib/api/communication.ts` (191 lines) | the ONLY module the pages/components may import - all hooks, all re-exports |
| `frontend/src/lib/api/communication-shared/` (11 files) | types + label maps + pure helpers + a handful of hardcoded constants. Barrel `index.ts` re-exports all 10 leaf files |
| `frontend/src/lib/api/callJob.ts` | `useReassignCallJob` |
| `frontend/src/lib/api/jobCommunications.ts` | `useJobCommunications`, `useSendJobSms`, `useSendJobEmail` |

The seam is the only place allowed to reach into `lib/api/_mock` - it re-exports `techs`, `jobs`,
`TECH_ROLE_LABEL` and the `Tech` / `Job` types from `lib/api/_mock/inventory` so components never
touch `_mock` directly. Preserve that rule in v2.

### 0.1 Cross-module components (FLAGGED)

| Component | Path | Rendered by |
|---|---|---|
| `GlobalDialer` | `components/communication/phone/Dialer.tsx` | **`components/layout/Header.tsx:171`** - on EVERY authed page |
| `useUnreadCounts` | `lib/api/communication.ts:133` | **`Header.tsx:109`** - drives the three header badges on every page |
| `JobCommunicationsTab` | `components/communication/JobCommunicationsTab.tsx` | Jobs module (`/jobs/:id`) |
| `CustomerCommunicationsTab` | `components/communication/CustomerCommunicationsTab.tsx` | Customers module (`/customers/:id`) |
| `JobBadge`, `ChannelIcon`, `StateChip` | `components/communication/shared/atoms.tsx` | both tabs above + WhatsApp + Inbox + SmsInboxView |

**Consequence for the v2 build: the Communication module is NOT self-contained.** `GlobalDialer`
and `useUnreadCounts` are mounted by the global `Header`, so `useMessageThreads`,
`useWhatsAppChats`, `useEmails`, `useCalls`, `usePhoneCustomers`, `usePhoneAgents`,
`useInventoryJobs`, `usePurchaseOrders` and `useTechs` all fire on every page load of the entire
app for any user with `read Communication`. If module 12 restyles `Dialer.tsx` in place, it
restyles the header of every other v2 page too. Recommendation: build v2 copies under
`pages/v2/communication/` and leave `Dialer.tsx` alone unless the header is being rebuilt in the
same PR.

---

## 1. Routes and guards

`frontend/src/App.tsx:162-168`, inside the global gates:

```
<Route element={<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']} />}>  // 111
  <Route element={<AppLayout />}>                                                                // 112
    <Route path="/communication/phone"      element={<PhonePage />} />        // 163
    <Route path="/communication/phone/:tab" element={<PhonePage />} />        // 164
    <Route path="/communication/whatsapp"   element={<WhatsAppPage />} />     // 165
    <Route path="/communication/inbox"      element={<InboxPage />} />        // 166
    <Route path="/communication/text"       element={<TextPage />} />         // 167
    <Route path="/communication/text/:tab"  element={<TextPage />} />         // 168
```

All four are `React.lazy` (`App.tsx:65-68`) under the shared `<Suspense fallback={<PageLoader/>}>`.

**There is NO per-route sub-gate.** No `ProtectedRoute allowedRoles`, no `DemoOnlyRoute`, no
feature gate. Every authenticated user of any role can reach all six URLs. Gating is entirely
in-page (section 2).

### 1.1 The `:tab` param - and a real bug

Both `PhonePage` and `TextPage` read the tab the same way:

```ts
const params = useParams<{ tab?: string }>();
const [searchParams, setSearchParams] = useSearchParams();
const rawTab = params.tab ?? searchParams.get("tab") ?? <default>;
const section = KEYS.includes(rawTab) ? rawTab : <default>;
```

- PhonePage default `"calls"`, valid keys `calls | numbers | flows | masking | groups | training |
  blocked` (`MODULE_SECTION_KEYS`, line 133).
- TextPage default `"inbox"`, valid keys `inbox | settings` (`TAB_KEYS`, line 28).
- An unknown `:tab` silently falls back to the default - no 404, no redirect.

**But `goToTab` / `goToSection` only writes the SEARCH param** (`PhonePage.tsx:805-812`,
`TextPage.tsx:45-49`):

```ts
const sp = new URLSearchParams(searchParams);
sp.set("tab", next);
setSearchParams(sp);
```

So from `/communication/phone/numbers`, clicking "Call flows" navigates to
`/communication/phone/numbers?tab=flows`. `params.tab` still wins over the search param, so the
page stays on **numbers**. The path-param form of tab navigation is effectively broken once you
land on it; only `/communication/phone` (no path param) + `?tab=` works. The source comment at
`PhonePage.tsx:806-808` shows the author knew the path route was being wired separately and chose
to write the search param "to keep both forms in sync" - which is exactly what it does not do.
Recorded in Open questions; **the v2 page must reproduce this as-is** unless the fix is approved
separately.

### 1.2 Sidebar entry

`components/layout/nav-registry.ts:76-82` - one expandable group:

```
key 'communication', label 'Communication', icon MessagesSquare,
href '/communication/phone', action 'read', subject 'Communication',
home 'Page', comingSoon: true
children:
  comm-phone    Phone     /communication/phone      read Communication  comingSoon
  comm-whatsapp WhatsApp  /communication/whatsapp   read Communication  comingSoon
  comm-email    Email     /communication/inbox      read Communication  comingSoon
  comm-text     Text      /communication/text       read Communication  comingSoon
```

Also in `DEFAULT_LAYOUT_KEYS` (line 96), so it appears on a fresh sidebar.

`components/layout/Sidebar.tsx:153-155` filters children by
`ability.can(c.action, c.subject)`. With zero passing children the group-branch at line 156
(`childItems.length > 0 && !collapsed && !editing`) is skipped and it falls through to the flat-row
rendering below - so a user without `read Communication` still sees a **Communication row**, it
just does not expand. The group is NOT hidden.

`comingSoon: true` produces: a `Coming soon` caption under the group label in warning colour
(`Sidebar.tsx:194-198`), `title="Coming soon — backend integration pending"` on the group button,
`, coming soon` appended to its `aria-label`, and an amber clock badge on each child
(`renderComingSoonBadge()`, line 247). **`comingSoon` does NOT block navigation** - only
`demoOnly` does that (`locked` at line 148), and Communication is not `demoOnly`. Every child is a
live `NavLink`.

### 1.3 Header entry points

`components/layout/Header.tsx` - three `CommsButton` icon buttons on `lg+` (lines 149-167) and the
same three as `OverflowItem` rows in the kebab `Popover` below `lg` (lines 181-199):

| Button | `aria-label` | Badge count | Navigates to |
|---|---|---|---|
| `MessageSquare` | `Phone messages` | `unread.sms` | `/communication/phone` |
| `WhatsAppGlyph` (inline SVG, `text-[#25D366]`) | `WhatsApp` | `unread.whatsapp` | `/communication/whatsapp` |
| `Mail` | `Inbox` | `unread.email` | `/communication/inbox` |

Every navigation goes through `requestLeave(() => navigate(...))` from
`stores/settingsGuard.store` - the unsaved-changes guard (#113). Badge renders only when
`count > 0`, and shows `99+` above 99. **These buttons are NOT ability-gated** - a technician with
no `read Communication` still sees all three, and clicking one lands on a page that renders the
"You don't have access" message.

`GlobalDialer` (line 171) sits between the comms cluster and the kebab, on every page.

---

## 2. Entitlement gating - what actually exists

The brief states that the `phone` entitlement is the master switch for the entire Communication
module, `minPlan` PRO, OFF by default for every new org, with `requireFeature` / `useFeature`
middleware not yet deployed to prod. Here is what is verifiably in this checkout of `main`:

| Claim | Verified state in the repo |
|---|---|
| `useFeature` hook on the frontend | **Does not exist.** `grep -rn "useFeature\|requireFeature" frontend/ backend/src/` returns zero hits. |
| `requireFeature` middleware on the backend | **Does not exist.** `backend/src/middleware/` contains `attachAbility, auditAccessDenied, authenticate, authorize, canGuard, errorHandler, originVerify, rate-limit, requestLogger, unscopedRequest, validate, withOrgContext` - no feature gate. |
| `backend/src/lib/entitlements/ops-sql.ts` | **Does not exist.** There is no `backend/src/lib/entitlements/` directory. `grep -rn "entitlement\|feature_overrides" backend/src` returns zero hits. |
| `feature_overrides` JSONB / org plan column | **Not in `backend/prisma/schema.prisma`.** No `feature_overrides`, no `OrgPlan` enum, no `STARTER`/`PRO`/`SCALE`. |
| Frontend reads any plan or feature flag | **No.** `frontend/src/lib/api/organization.ts` exposes no `plan` and no `feature_overrides` field. |

**Conclusion: on `main` today the `phone` entitlement gates nothing in code.** The only gate that
actually runs is CASL on the `Communication` subject, on both the frontend and the backend
(section 3). Everything the CLAUDE.md entitlements section describes is either applied out-of-band
via Supabase MCP against the database, or lives on a branch that is not `main`.

**What this means for the v2 build:** do not add any entitlement check to a v2 page. There is
nothing to call. If gating lands later it will land in the shared seam or in the router, not in the
presentation layer. Reproduce exactly the CASL gate described below and nothing more.

**What a user without the entitlement sees today:** the entitlement is invisible to the UI, so
they see exactly what their CASL ability gives them - which for a PRO org that has
`feature_overrides: {"phone": false}` recorded in the database is still the full, working module.
That is the real behavioural gap, and it is worth flagging to the owner before the v2 pages ship,
because a v2 page will look just as ungated.

---

## 3. Permission gating that DOES run

### 3.1 Role defaults (`backend/src/lib/permissions/defaultGrants.ts`)

| Role | Communication grants |
|---|---|
| ADMIN | via `manage all` - everything |
| SALES | `read` only (line 64) |
| DISPATCHER | `read`, `create`, `update`, `delete` (lines 132-135) |
| TECHNICIAN | **none** |

Catalog entries: `read | create | update | delete` on subject `Communication`
(`lib/permissions/catalog.ts:131-135`). There is no `manage Communication` catalog row, so
`ability.can('manage','Communication')` is true only for ADMIN (through `manage all`). Two views
gate on exactly that (section 5.5, 5.7).

### 3.2 Backend enforcement

Five routers all mounted at `/api/communication` (`backend/src/app.ts:170-175`):
`comm-calls`, `comm-threads`, `comm-agents`, `comm-config`, `comm-whatsapp-email`. Each begins
`router.use(authenticate, attachAbility)` and every endpoint carries
`canDo('<action>', 'Communication')`. So a technician gets a 403 on every single Communication
endpoint.

Note the brief mentions "9 backend comm-* route groups". This checkout has **5** route files.
Recorded in Open questions.

### 3.3 Frontend page gates

| Page | Gate | Render when denied |
|---|---|---|
| `PhonePage` | `ability.can("read","Communication")` (line 779) | full-page `You don't have access to the Phone module.` (lines 941-947), returned BEFORE any JSX |
| `TextPage` | same (line 32) | `You don't have access to the Text module.` (lines 60-66) |
| `InboxPage` | same (line 135) | **NOT a page-level return.** The page renders in full - header, folder rail, team directory, groups, forwarding, Compose button. Only the message-list column swaps to `You don't have access to the inbox.` (lines 733-736). The file comment at line 132 says "0 functional gates in this view". |
| `WhatsAppPage` | **none at all** | The page renders unconditionally. It does not import `useAppAbility`. |

All four still fire their queries regardless - the hooks run above the gate, so a denied user
generates a burst of 403s. Reproduce as-is.

Two in-component gates use the stricter verb:
- `NumbersView` - `ability.can('manage','Communication')` hides the `Get a number` button.
- `CallFlowsView` - same, gates `Create Call Flow`, the per-row delete button and `Save flow`.
- `CallGroups.tsx` - same, decides whether the signed-in owner appears in the member roster.

---

## 4. Data seam - every hook, endpoint and query key

All queries use the axios instance and the `['communication', ...]` key prefix. No `staleTime`
override, no `refetchInterval`, no `refetchOnWindowFocus` override - they inherit the app defaults
(`App.tsx:74-82`: `retry: 1`, `staleTime: 5 min`, `refetchOnWindowFocus: false`).

| Hook | Method + path | Query key | Response shape |
|---|---|---|---|
| `useCalls` | GET `/api/communication/calls` | `['communication','calls']` | `data.calls` |
| `usePhoneCustomers` | GET `/api/communication/contacts` | `['communication','customers']` | `data.contacts` |
| `usePhoneAgents` | GET `/api/communication/agents` | `['communication','agents']` | `data.agents` |
| `useMessageThreads` | GET `/api/communication/threads` | `['communication','threads']` | `data.threads` |
| `useTextTemplates` | GET `/templates` | `['communication','templates']` | `data.templates` |
| `useTextAutomations` | GET `/automations` | `['communication','automations']` | `data.automations` |
| `useBlockedNumbers` | GET `/blocked` | `['communication','blocked']` | `data.blocked` |
| `useTrainingScenarios` | GET `/training/scenarios` | `['communication','training-scenarios']` | `data.scenarios` |
| `useTrainingSessions` | GET `/training/sessions` | `['communication','training-sessions']` | `data.sessions` |
| `useCallFlows` | GET `/call-flows` | `['communication','call-flows']` | `data.callFlows` |
| `useCallGroups` | GET `/call-groups` | `['communication','call-groups']` | `data.callGroups` |
| `useWhatsAppChats` | GET `/whatsapp` | `['communication','whatsapp']` | `data.chats` |
| `useEmails` | GET `/emails` | `['communication','emails']` | `data.emails` |
| `useEmailGroups` | GET `/email-groups` | `['communication','email-groups']` | `data.groups` |
| `useForwardRules` | GET `/forward-rules` | `['communication','forward-rules']` | `data.rules` |
| `useTeamMembers` | GET `/team-members` | `['communication','team-members']` | `data.members` |
| `useCustomerJobs(id)` | GET `/api/customers/{id}` | `['communication','customer-jobs',id]`, `enabled: Boolean(id)` | maps `customer.jobs`; `open = status !== 'CANCELLED'` |

Mutations - all built by `useCommMutation` (POST, `onSuccess` invalidates the whole
`['communication']` prefix):

`usePlaceCall` `/calls` · `useScreenPop` `/screen-pop` · `useSendSms` `/sms` ·
`useSaveTemplate` `/templates` · `useSaveAutomation` `/automations` · `useBlockNumber` `/blocked` ·
`useUnblockNumber` `/blocked/unblock` · `useBuyNumber` `/numbers/buy` ·
`useSaveCallFlow` `/call-flows` · `useSaveCallGroup` `/call-groups` ·
`useSendWhatsApp` `/whatsapp` · `useSendEmail` `/emails` · `useSaveDraft` `/emails/draft` ·
`useAiAssist` `/ai-assist` · `useStartTrainingSession` `/training/sessions`.

Plus two hand-written PATCH mutations:

| Hook | Call | Invalidates |
|---|---|---|
| `useReassignSmsJob` (`communication.ts:173`) | PATCH `/api/communication/sms/:messageId/job` `{job_id}` | `['communication']`, `['job-communications']` (prefix), `['customer-communications']` (prefix); also `['communication']` on error |
| `useReassignCallJob` (`lib/api/callJob.ts`) | PATCH `/api/communication/calls/:callId/job` `{job_id}` | same three |

`useUnreadCounts` (`communication.ts:133`) is a derived selector, not a query: it composes
`useMessageThreads` + `useWhatsAppChats` + `useEmails` and sums
`threads.unread`, `chats.unread`, and inbox emails where `folder === 'inbox' && unread`.

**Five endpoints have no backend route and 404 today** (documented at `communication.ts:144-146`,
issue #229): `screen-pop`, `numbers/buy`, `emails/draft`, `ai-assist`, POST `training/sessions`.
The UI ignores the failure in every case because the mutations are fired and never awaited.

### 4.1 Real-time / polling / websockets

**There is none, anywhere in this module.** No `refetchInterval`, no `setInterval` polling of an
API, no `EventSource`, no Supabase realtime channel. Every "live" behaviour is a local `setTimeout`
or `setInterval` simulating latency (full list in section 11).

`supabase.realtime.setAuth(token)` in `lib/auth-listener.ts` is for the notification bell, not for
Communication.

### 4.2 Hardcoded constants that read as live data

`communication-shared` exports types + label maps + pure helpers, plus these baked-in values that
the UI presents as real:

- `ACCOUNTS = [{id:'gmail', provider:'Gmail', address:'emanuel@alphasecurityus.com', dot:'bg-red-500'},
  {id:'system', provider:'System', address:'no-reply@servwave.app', dot:'bg-slate-400'}]`,
  `PRIMARY_ACCOUNT = ACCOUNTS[0]`. Rendered as the connected mailbox on InboxPage.
- `BUSINESS_NUMBER = "(551) 282-7064"`, `WA_BUSINESS_NUMBER = "(551) 282-7064"`,
  `MASKING_NUMBER = "(646) 718-4893"`, `NUMBER_PRICE = 2`.
- `PLAN_USAGE = { cycleLabel: "May 1 – 31", calling: {used:820, limit:1000, unit:"min"},
  texting: {used:1480, limit:2000, unit:"texts"} }` - drives the whole PlanUsage panel.
- `NOW = new Date("2026-05-30T23:59:59")` in `phone/shared.tsx` - the anchored "now" that every
  date-range preset is computed against. **Not `Date.now()`.**
- Label maps: `DISPOSITION_LABELS` (13), `CAMPAIGN_LABELS` (3), `BLOCK_REASON_LABELS/TONE`,
  `MERGE_FIELDS` (24), `TEXT_TRIGGERS` (7), `TIMING_OPTIONS` (7), `SMS_COMPLIANCE` (5),
  `OPT_OUT_FOOTER`, `SMS_LEGAL_DISCLAIMER`, `TRAINING_ROLES` (4), `TRAINING_OUTCOME_LABELS`,
  `SCRIPT_ATTENTION_THRESHOLD = 85`, `TRAINING_PASS_THRESHOLD = 85`.

The `emanuel@alphasecurityus.com` address and the `Emanuel Dahan` owner-name fallbacks
(`InboxPage.tsx:139`, `inbox/AiAssistMenu.tsx` `OWNER_NAME`) are prototype leftovers still visible
to users. Worth raising, not fixing in a presentation-only port.

---

## 5. `/communication/phone` - PhonePage

### 5.1 Shell state

The page is a **shell that lifts state on behalf of its sub-views**. Seven seam queries seed seven
local `useState` arrays, each hydrated by its own `useEffect` guarded on `seed.length` (lines
826-862), so the local copy owns all in-session mutations:

```
useCalls()          -> calls        (setCalls passed to DispatchView)
useMessageThreads() -> threads      (only used for the unread KPI)
useCallFlows()      -> callFlows    (setCallFlows -> CallFlowsView)
useCallGroups()     -> callGroups   (setCallGroups -> CallGroupsView)
useBlockedNumbers() -> blocked      (blockNumber / unblockNumber)
usePhoneCustomers() -> customers    (simulateIncoming pool)
usePhoneAgents()    -> phoneAgents  (Performance tab count)
numbers             -> seeded from SEED_NUMBERS exported by NumbersView (NOT from a query)
```

Because the hydration effects are `if (seed.length) set...`, an empty API response never clears a
locally mutated list, and a refetch replaces local edits wholesale. Reproduce as-is.

Module-level handlers defined in the shell:
- `blockNumber({number, name, reason, note})` - dedupes on digits-only comparison, toasts
  `{number} is already blocked` when duplicate, otherwise prepends
  `{id: 'blk_'+Date.now(), blockedAt: ISO, blockedBy: userName}` and toasts
  `🚫 Blocked {name · }{number}`.
- `unblockNumber(id)` - filters and toasts `✓ Number unblocked`.
- `assignFlowToNumbers(flowId, numberIds)` - sets `flowId` on the selected numbers and clears it
  from any number that previously held it (`number.flowId` is the single source of truth linking
  the Numbers tab and the Call flows tab).
- `simulateIncoming()` - flattens every customer contact channel of `kind === 'phone'`, picks one
  at random, sets `dialerOpen = true` + `incomingNumber`, toasts `📞 Incoming call from {fmtPhone}`.

### 5.2 Component tree

```
div.flex.h-full.flex-col.overflow-hidden
├─ header (border-b, bg-white, px-6 pt-4)
│  ├─ h1 "ServWave Phone"
│  ├─ business-number pill (tabIndex=0) + hover/focus tooltip [role="tooltip"]
│  │     "Your main ServWave Phone number / Clients can call and text you at this number."
│  ├─ <PlanUsage onToast userEmail branch="ServWave" />        -- hidden below lg
│  ├─ button aria-label="Open dialer" title="Open dialer — call a number"  label "Dialer"
│  └─ 7 <ModuleTab> (overflow-x-auto): Calls · Phone numbers · Call flows · Call masking ·
│        Call groups · Training · Blocked callers
└─ section === ?
   ├─ "training"  -> <TrainingView onToast onSimulateIncoming={simulateIncoming} />
   ├─ "numbers"   -> <NumbersView numbers setNumbers callFlows onToast />
   ├─ "flows"     -> <CallFlowsView flows setFlows numbers groupOptions={groupTargetOptions(callGroups)}
   │                    onAssignNumbers={assignFlowToNumbers} onToast />
   ├─ "groups"    -> <CallGroupsView groups setGroups onToast />
   ├─ "masking"   -> <CallMaskingView onToast />
   ├─ "blocked"   -> <BlockedCallersView blocked onBlock={blockNumber} onUnblock={unblockNumber} />
   ├─ (unreachable) -> <ModulePlaceholder section onToast />
   └─ "calls"     -> KPI strip + 3 sub-tabs + tab content
└─ {dialerOpen && fixed z-[70] overlay -> <DialerWorkspace calls onToast incomingNumber
        onConsumedIncoming />}
```

`ModulePlaceholder` and `SECTION_META` (lines 136-175, 1300-1344) are **dead code**: the branch at
line 1057 is `section !== "calls"`, but every non-calls section already has its own branch above
it. `SECTION_META` still carries the copy for numbers / flows / masking / groups / blocked and the
`{action} — coming soon` toasts. A v2 port can drop it, but note it in the PR.

### 5.3 `PlanUsage` (header, `lg`+ only) - lines 276-548

Trigger button `aria-label="Phone plan usage and upgrade options"`, `aria-expanded`, showing two
`PlanUsageMeter`s (Calling, Texting) split by a divider plus a rotating `ChevronDown`.

`PlanUsageMeter` computes `pct = min(100, round(used/limit*100))` and tones it:
`>=90` rose, `>=75` amber, else emerald. Renders label, percent, a progress bar, and
`{used} / {limit} {unit}`.

Opening sets `open=true` and renders a full-screen transparent backdrop button
(`aria-label="Close plan usage panel"`) plus a `w-[340px]` panel. **Escape closes it** (window
`keydown` listener, lines 339-344). Panel contents:

- Header: `Phone plan usage` · `{plan.name} · {plan.price} · {usage.cycleLabel}` · a status pill
  when `worst >= 100` (`Limit reached`, rose) or `>= 75` (`Approaching limit`, amber).
- Status banner (same thresholds) with `AlertTriangle` and the matching copy.
- Both meters again, full width.
- `Choose your upgrade` - two `UPGRADE_PLANS` cards, `picked` defaults to `"scale"`:
  - `scale` - Scale, `$549/mo`, 3,000 min / 5,000 texts, `selfServe: true`, `recommended: true`
  - `enterprise` - Enterprise, `Custom`, Unlimited/Unlimited, `callingLimit/textingLimit: null`,
    `selfServe: false`
- Primary button, label branches: `Contact sales for {name}` (non-selfServe) /
  `Upgrade to {name} — {price}{per}` / `Upgrade plan`. `disabled={!picked}`.
  `applyUpgrade()`: non-selfServe or null limits -> toast
  `✓ Request sent to sales about the {name} plan — we'll reach out shortly.` and close.
  Otherwise re-bases `plan` and both `usage` limits locally and toasts
  `✓ Upgraded to {name} — plan active. New limits: {calling} · {texting}.` **No API call. Nothing
  persists. This is entirely local state.**
- `Reach sales` button -> closes the panel, opens `ReachSalesModal`.
- Footer `Sales: sales@alphasecurityus.com`.

`ReachSalesModal` (lines 553-769) - fixed `z-[70]`, backdrop button `aria-label="Close"`, X button
`aria-label="Close"`, Escape closes. Fields: `To` (fixed text `sales@alphasecurityus.com`),
`From` `input#sales-replyto` `type=email` prefilled with `user.email`, `Subject`
`input#sales-subject` prefilled `Phone plan question — {planName} (ServWave)`, five preset topic
pills (`Upgrade my plan`, `Add phone numbers`, `Port a number`, `Raise call/text limits`,
`Billing question`) that overwrite subject + message, and `textarea#sales-message` (`autoFocus`,
rows 5). Footer `Cancel` and `Send to sales` with
**`disabled={!message.trim() || !replyTo.trim()}`**. `send()` toasts
`✓ Email sent to sales — we'll reply to {replyTo} shortly.` and closes. **No API call.**

### 5.4 Calls section (the default)

Four `KPITile` buttons (`aria-pressed={active}`), tones indigo/amber/sky/rose:

| Tile | Value | onClick |
|---|---|---|
| `Calls today` | `calls.length` | `activeKpi='calls'`, `callsFocus='all'`, `tab='calls'` |
| `Missed Calls` | `missed.length` (status `missed`\|`voicemail`) | `activeKpi='callback'`, `callsFocus='callback'`, `tab='calls'` |
| `Unread messages` | `threads.reduce(unread)` | **`navigate('/communication/text')`** - cross-page jump |
| `Needs Attention` | `needsAttention.length` (`callNeedsAttention`) | `activeKpi='attention'`, `callsFocus='attention'`, `tab='calls'` |

Three `TabButton`s with counts: `Calls` (`calls.length`), `Dispatch & Calls` (`calls.length`),
`Performance & QA` (`phoneAgents.length`). When `tab === 'calls'` a `DateRangeControl` is pinned
right (`ml-auto`). `Tab` type in `shared.tsx` also lists `'inbox'`, which is now unreachable here -
texting moved to TextPage.

Date range: `datePreset` default `"30d"`, `computeRange(preset, start, end)` from `shared.tsx`,
anchored on the hardcoded `NOW`.

`callNeedsAttention(c)` = disposition `after_hours_emergency` or `needs_manager`, OR sentiment
`negative`, OR any `reviewFlag`.

### 5.5 Sub-views (contracts + behaviour)

Full per-file inventory follows. Nothing below has a `data-testid` - see section 9.

**`CallsView`** `{calls, range, focus, onClearFocus, onBlock, onToast}`
- Focus banner when `focus !== 'all'`: `Showing {Missed Calls|Needs Attention} · {count}` +
  `Clear filter`.
- `CallFilterBar` - trigger `Filter results` / `{n} filter(s) applied`, opens an inline absolute
  panel (not a portal), backdrop `aria-label="Close filters"`. Nine facet columns: Direction, Call
  flow, Source, Status, Duration, User, Customer, Job, Tags. Each option carries `title={label}`.
  Active chips get `aria-label={"Remove " + label}`. `Clear all` resets to `EMPTY_FILTERS`. An
  empty facet column renders `—`.
- Eight `StatCard` buttons with `aria-pressed`: `Missed calls`, `Calls`, `New customers`,
  `Existing customers`, `Repeat callers`, `Active Calls`, `Avg call time`, `Revenue`. Toggling one
  scopes the table and shows `Table scoped to {STAT_LABELS[key]}` + `Clear`.
- Search input `placeholder="Search calls…"`. Page-size `Select` with
  `SelectTrigger aria-label="Rows per page"` (10/25/50). `Export` button -> toast
  `⬇️ Exporting {n} calls to CSV…` (no download).
- Row click -> `CallDetailDrawer`. Per-row quick actions (stopPropagation): `Call Back` -> toast
  `📞 Calling back {name|number}…`; `Block` -> `onBlock({number, name, reason: cust?'customer':'spam'})`
  and adds the id to `dismissed`; `Dismiss` (missed/voicemail only) -> `dismissed` + toast
  `✓ Call dismissed`.
- Footer: `Showing {n} of {m} calls` / `Workiz / CTM-backed call log`.

**`CallDetailDrawer`** `{call, onClose, onToast}` - fixed overlay, right `max-w-md` panel, backdrop
`aria-label="Close call detail"`.
- `CallJobMenu` (shadcn `DropdownMenu`, `align="start"`, `w-60`): the customer's open jobs as
  `{number} · {location}`, a disabled `No open jobs` item when empty, separator, `No job`.
  Picking sets an optimistic `jobOverride`, then `useReassignCallJob().mutate({callId, jobId})`.
  Success -> toast `Attached to {number}` / `Job link removed`. Error -> rolls the override back and
  toasts `Couldn't update the job link — try again`. Attached badge `title="Attached to {label} — click to reassign"`.
- Three round buttons: `aria-label="Add to call"` -> `ConferencePicker`;
  `aria-label="Message"` -> `MessagePanel`; `aria-label="Call back"` -> `ActiveCallPopup`.
- `RecordingPlayer` (only when `call.hasRecording`): speed cycle `1x/1.5x/2x`,
  `aria-label="Back 15 seconds"`, `aria-label={playing?"Pause":"Play"}` (toasts `⏸ Paused` /
  `▶️ Playing recording…`), `aria-label="Forward 15 seconds"`,
  `aria-label="Download recording"` (toast `⬇️ Downloading recording…`). **There is no audio
  element and no timer** - position only moves by the ±15s buttons.
- Linked job row is a real navigation only when the id matches `/^[0-9a-f-]{36}$/`; then
  `/leads/{id}` for kind `lead`, else `/jobs/{id}`.
- Empty strings: `No recording for this call`, `The call was missed before it connected.`,
  `This call was not recorded.`, `No tags`, `Transcript is still being generated.`, `Not scored`.

**`CallsTable`** `{calls, onRowClick?, empty? = 'No calls match your search.'}` - headers
`Status, From, To, Time, Call Flow, Ad Source, Tags, Insights, Answered By, Jobs & Leads, Revenue`,
column ids `status,from,to,time,callFlow,adSource,tags,insights,answeredBy,jobs,revenue`. Sorting
via `SortHeader`; numeric keys (`time`, `revenue`) start `desc`, text keys `asc`.

**`useCallsPipeline`** - the whole filter chain, in order:
`visible` (drop `dismissed`) -> `ranged` (inclusive date window) -> `focused` -> `dated` (facets)
-> `repeatNumbers` (party numbers appearing >=2x) -> `statScoped` -> `filtered` (free text over
customer name, both formatted numbers, callFlow, jobLabel, trackingSource, disposition label, tags)
-> `sorted`. Duration buckets `u30 <30`, `u1 <60`, `o1 >=60`, `u3 <180`, `o3 >=180`, `o5 >=300`.
`userLabel` fallbacks: ai -> `AI receptionist`, csr -> `CSR`, voicemail -> `Voicemail`, else
`No answer`. It has its own test at `phone/useCallsPipeline.test.tsx` - **that test must keep
passing untouched.**

**`DispatchView`** `{calls, setCalls, onToast}` - callback queue = status `missed`|`voicemail`
sorted by revenue desc. Row `title="Open call details"` -> `CallDetailDrawer`. `Resolve` button
sets `status:'completed'` and `disposition: c.disposition ?? 'follow_up'` in the shell's array,
toast `✓ Removed from callback queue`. Empty queue -> `Queue clear — nice.` Recent-calls table
headers `Dir, Caller, Answered by, Disposition, Source, Time`.

**`PerformanceView`** `{calls, onToast}` - agent cards and a scorecard table
(`Agent, Type, Calls, Booking, Sentiment, Script, Revenue`), both `title="Open {name}'s performance"`.
`AgentDetailDrawer` backdrop `aria-label="Close agent detail"`; handled-call rows
`title="Open call details"` hand off to `CallDetailDrawer`; `Send coaching note` -> toast
`📋 Coaching note drafted for {name}`. `ScriptScore` shows a `Needs attention` chip below
`SCRIPT_ATTENTION_THRESHOLD` (85). Empty: `No calls in this period.`

**`NumbersView`** `{numbers, setNumbers, callFlows, onToast}`, also exports `SEED_NUMBERS` and the
`OwnedNumber` type.
- `Get a number` gated on `can('manage','Communication')` -> right slide-over `GetNumberDialog`.
- Search `placeholder="Search numbers…"`.
- Per row: `AdGroupSelect` (`aria-label="Assign ad group for {number}"`, `aria-expanded`) - a
  **`createPortal`-to-body** fixed menu with flip-up measurement, backdrop
  `aria-label="Close ad group menu"`, first row `Assign An Ad Group` (clear), inline
  `Create new ad group` with `placeholder="New ad group name"` + `Add` (`disabled={!draft.trim()}`,
  Enter submits, Escape cancels) -> toast `Ad group "{label}" created`. Selecting -> toast
  `{number} → {group} ad group` or `Ad group cleared from {number}`.
- `FlowSelect` (`aria-label="Assign flow for {number}"`) - non-portaled absolute menu, backdrop
  `aria-label="Close flow menu"`, groups `Flows` / `Forwarding` / `People` (+ `My flows`).
  Toast `{number} → {flow label}` or `Flow removed from {number}`.
- Status cell: static `No flow` pill when unassigned; otherwise a
  `title="Toggle active / paused"` button flipping `active`<->`paused` (no toast).
- Release `aria-label="Release {number}"` `title="Release this number"` -> toast `Released {number}`.
- `GetNumberDialog` form: Country `CleanSelect aria-label="Select country"` (US/Canada), type
  toggle `Local`/`Toll-free`, `placeholder="Area code"` `inputMode=numeric` **disabled for
  Toll-free**, `placeholder="Contains (optional)"`, optional
  `FlowSelect aria-label="Assign flow for new number"`. `Refresh` and `Search` both run the same
  local generator (3 mock numbers). Picking one opens a `Confirm purchase` overlay
  (Number / Type / Assigned flow / Total due, `Cancel` / `Buy · ${price}`) ->
  `useBuyNumber().mutate({number, type, flowId, price: NUMBER_PRICE})` (**404s today**) + toast
  `Charged {money} for {num}`, then the parent prepends the row and toasts
  `✓ Purchased {number} · {money} charged`. No required-field validation.
- Empty: `No numbers match "{query}".`

**`CallFlows.tsx` / `CallFlowsView`** `{flows, setFlows, numbers, groupOptions = [],
onAssignNumbers, onToast}` - a full node-graph builder that **replaces the list in place** (not a
modal).
- `Create Call Flow` (manage-gated) -> `StructureChoiceModal` (`z-[80]`, backdrop and X both
  `aria-label="Close"`, `<h2>Choose Your Call Flow Structure</h2>`), cards `Basic` and
  `Voice Menu`.
- Row click -> builder. Per-row `aria-label="Edit {name}"` / `aria-label="Delete {name}"`; delete
  also calls `onAssignNumbers('flow:{id}', [])` and toasts `Call flow deleted`.
- Builder: `← Back to call flows` / `Cancel`. Node canvas; `InsertDot aria-label="Add a step"`
  opens a mini menu (backdrop `aria-label="Close add menu"`) offering `Greeting` / `Forward`.
- `NodeEditorPanel` (close `aria-label="Close editor"`): greeting textarea
  `placeholder="What the caller hears…"`; voicemail textarea
  `placeholder="Message played before the beep…"`; forward -> `TargetEditor` under
  `Connect the call to`; menu -> `Menu prompt` + option rows (digit chip,
  `placeholder="Option label"`, `aria-label="Remove option"`, nested `TargetEditor`), `Add option`
  while `< 9`. `Remove this step` at the bottom.
- `TargetEditor`: pills `Person` / `Group` / `Number` / `Voicemail`; group with no options renders
  `No call groups yet — create one on the Call groups tab.`; number -> `placeholder="(555) 123-4567"`;
  voicemail -> `The caller is sent to voicemail.`
- `BasicInfoPanel`: `Flow name` (`placeholder="e.g. Main line"`), hours toggle
  `Always open` / `On a schedule`, assigned-numbers checkboxes (`No numbers to assign.`),
  `Record & save calls in this flow` toggle.
- Save: name falls back to `Untitled flow`, `status = assigned.length ? 'active' : 'draft'`,
  `updatedAt = now`, upsert, `onAssignNumbers('flow:{id}', ids)`, toast `✓ Saved "{name}"`.
  **No validation, no disabled submit, and no mutation is fired** - persistence is the shell's
  `setFlows` only.
- Empty: `No call flows yet` / `Create your first call flow to start automating how calls are answered.`
- Table headers `Flow, Structure, Assigned numbers, Recording, Status, Updated, Action`.

**`CallGroups.tsx` / `CallGroupsView`** `{groups, setGroups, onToast}` - `Create group` /
row-click -> `GroupModal` (`<h2>` = `Create group` or `Edit group`, backdrop + X both
`aria-label="Close"`). Fields: `placeholder="Group name"`, ring-strategy toggle `all` /
`round_robin` (labels via `ringLabel`, helper copy switches between "ring all selected
users/devices at once" and "ring members one at a time until answered"), and per-person
`DeviceToggle` buttons `Cell` / `Softphone` with `aria-pressed`, keyed `${personId}|${device}`.
Footer `{n} device(s) selected`, `Cancel`, `Save`. No validation; name falls back to
`Untitled group`; new ids are `grp_{base36}{seq}`; toast `✓ Saved "{name}"`. Row delete
`aria-label="Delete {name}"` -> toast `Call group deleted`. Roster = signed-in owner (only when
`can('manage','Communication')`, subtitle `Owner`) + human phone agents + `useTeamMembers()`,
de-duped by id. Empty: `No call groups yet` / `Create a group so a call flow can ring several
people at once.` Headers `Group, Ring, Members, Updated, Action`. **No mutation is fired.**
Quirk: `const modalGroup = creating || editing ? editing : null;`

**`CallMaskingView`** `{onToast}` - five accordion steps, entirely local state, zero mutations.
`Save masking rules` -> toast `✓ Masking settings saved` and nothing else.
1. Who gets masked - `Toggle aria-label="Auto-mask everyone in the company"` (toasts
   `All users masked — new users auto-join` / `Auto-mask off — add users manually`),
   `Check all` / `Uncheck all`, a checkbox per tech from `useTechs()`.
2. Record calls - radio group `name="record"`; when on: `CleanSelect aria-label="Consent style"`
   (One-party / All-party), `Draft with AI` -> fills from `DISCLAIMER_TEMPLATES[consent]` + toast
   `✨ AI drafted a recording disclaimer`, `Try it out` -> `speechSynthesis.cancel()` then
   `speak(...)` + toast `▶️ Playing the disclaimer preview`.
3. Caller ID - link -> toast `Opening number provisioning…`;
   `CleanSelect aria-label="Caller ID number"` with 3 hardcoded options; smart-callback checkbox.
4. Masking number - `Show me how it works` / `Hide` reveals a 4-step list; leads checkbox.
5. AI guardrails - three `Toggle`s, `ariaLabel` = the card title: `Off-platform leak guard`,
   `Call summary + transcript`, `Sentiment & escalation alerts`.
Also exports `SECTION_META` (a second, different one from PhonePage's).

**`BlockedCallersView`** `{blocked, onBlock, onUnblock}` - `Block a number` -> `BlockNumberModal`
(`z-[70]`, backdrop `aria-label="Close"`, Escape closes). Fields: phone `autoFocus`
`placeholder="(212) 555-0123"` (Enter submits), `SelectTrigger aria-label="Block reason"` with
`spam` (default) / `not_spam` / `customer` / `other`, and
`placeholder="Why are you blocking this number?"` rows 2.
**Validation: `canBlock = number.trim().length >= 7`** - `Block number` is `disabled={!canBlock}`
and `submit()` early-returns. Row `Unblock` -> `onUnblock(id)` (the toast comes from the shell).
Empty: `No blocked numbers` + `Press "Block a number" or block a caller from the Calls log.`

**`TrainingView`** `{onToast, onSimulateIncoming}` - see section 11 for its timer inventory.
- Run tab: `Simulate incoming call` -> `onSimulateIncoming()`. Role cards from `TRAINING_ROLES`,
  then scenario cards, then `View full script` / `Hide script` and `Start simulation call` ->
  `SimulationModal`.
- History tab: four `TrainStat` buttons (`aria-pressed`) - `Sessions`, `People trained`,
  `Avg score`, `Pass rate` - open a breakdown panel (close `aria-label="Close breakdown"`). Three
  Selects `aria-label="Filter by trainee" | "Filter by role" | "Filter by result"`, search
  `placeholder="Search training…"`, `Clear`. Sortable headers
  `Trainee, Scenario, Trainer, Score, Result, When, Length` (+ `Recording`). Row -> session drawer
  (backdrop `aria-label="Close session detail"`, Escape closes). `Play` -> toast
  `▶️ Playing {trainee}'s recording — {scenario}`.
- `SimulationModal` phases `ringing -> incall -> done` (backdrop `aria-label="Close simulation"`):
  `Decline` / `Accept`; in-call `Tap to talk` / `Listening — tap to stop` driving Web Speech
  `SpeechRecognition` (`lang 'en-US'`, `interimResults true`, `continuous false`;
  `Mic not available — type below` when unsupported), `Use model line`
  (`title="Auto-answer with the model line"`), a `<form>` with
  `placeholder="…or type what you'd say"` and a submit `disabled={!typed.trim()}`,
  `Voice on`/`Voice off` toggling `speechSynthesis`, `Finish` and `End`. `endCall()` computes
  `Math.round(85 + Math.random()*13)` and fires `useStartTrainingSession().mutate(...)`
  (**404s today**). Done screen: score ring, coaching note branching on `score >= 90`,
  `Run again` / `Done`.
- Empty: `No training sessions match these filters.` / `No data for the current filters.`

**`shared.tsx`** exports `Tab`, `CallsFocus`, `RangePreset`, `DateRange`, `NOW`, `RANGE_PRESETS`
(`Today, Last 7 days, Last 30 days, This month, Last 90 days, All time`), the helpers listed in
4.2, and components `DirIcon`, `AnsweredBy`, `Stat`, `InfoRow`,
**`Toggle({on, onChange, ariaLabel})` -> `<button type="button" role="switch" aria-checked>`**, and
`DateRangeControl` (backdrop `aria-label="Close date picker"`, six preset buttons, two
`<input type="date">` with `max={customEnd}` / `min={customStart}`).

### 5.6 The Softphone (`phone/Softphone.tsx`)

Rendered only inside `Dialer.tsx` - by `DialerWorkspace` (the page's Dialer overlay and the header
`GlobalDialer`) and by `ActiveCallPopup` (from `CallDetailDrawer`'s `Call back` button). It is the
single softphone surface; the standalone Dispatch dock was removed.

Props: `incomingNumber?`, `onConsumedIncoming?`, `prefillNumber?`, `onConsumedPrefill?`,
`autoCallNumber?`, `onConsumedAutoCall?`, `onConference?`, `onEnded?`.

States `idle | dialing | ringing_in | active`; header pill `Ready` / `Calling…` / `Ringing` /
`On call`.

| Capability | Behaviour |
|---|---|
| Screen-pop | `matchByNumber(customers, e164)` over `usePhoneCustomers()` contact channels. Match -> customer name, contact name·role, site, membership tier. No match -> `Unknown caller · no match — will create a provisional contact` |
| Outbound call | `Call` `disabled={!dial.trim()}`, normalises to `+1`+digits, state `dialing`, then **`setTimeout(3500)` auto-answers** into `active`. Same for `autoCallNumber` |
| Inbound ring | `incomingNumber` prop -> `ringing_in` + screen-pop, then `onConsumedIncoming()` |
| Answer | `Answer` (ringing_in) / `Answer now` (dialing) - clears the auto-answer timeout, `muted=false`, `active` |
| Hang up / Decline | clears timeout, `speechSynthesis.cancel()`, resets everything, `onEnded?.()` |
| Mute | `Mute` / `Muted` - local state only |
| **Hold** | **not implemented** |
| **Transfer** | **not implemented** |
| Conference | `Conference / Add person` shown during `active` only when `onConference` is supplied |
| Keypad | 12 buttons `1-9 * 0 #`, **idle only**; real DTMF pairs via Web Audio; dial string capped at 18 chars. `aria-label="Delete last digit"`, `disabled={!dial}` |
| Keyboard | window `keydown`: `[0-9*#+]` and Backspace edit the dial while idle (skipped when focus is in an input/textarea/select/contentEditable); Enter answers a ringing call or places the call |
| Audio | live-call `setInterval(1000)` MM:SS counter; outbound ringback 440+480 Hz 1200 on / 1400 off; inbound ringtone 480+620 Hz 1100 on / 900 off; 600+900 Hz 160 ms connect beep; on outbound connect `setTimeout(450)` then `speechSynthesis` says "Hello, this is ServWave Phone. How can I help you?" |
| Cleanup | unmount clears the auto-answer timeout, stops the ring, cancels speech |

Selector surface: `aria-label="Delete last digit"` only. Everything else is text: `Call`, `Answer`,
`Answer now`, `Decline`, `Hang up`, `Mute`/`Muted`, `Conference / Add person`, `Softphone`.

### 5.7 `Dialer.tsx` surfaces

- `GlobalDialer()` - header button `aria-label="Open dialer"` `title="Dialer — call a number"` ->
  fixed `z-[80]` modal; backdrop `aria-label="Close dialer"`; X `aria-label="Close"`. Its own
  toast is a fixed bottom-right div auto-dismissed by **`setTimeout(3200)`**.
- `DialerWorkspace({calls, onToast, incomingNumber, onConsumedIncoming})` - desktop-only search
  `placeholder="Search a job #, PO #, or customer…"` over a memoised index of jobs -> POs ->
  customers (max 6 results). Picking one prefills the number and toasts
  `☎️ {fmtPhone} ready — press Call`. No match -> `No job, PO, or customer matches "{query}".`
  Dropdown closes on outside `mousedown` or Escape. Right pane shows `JobHistoryPanel` or
  `Search a job or PO` / `Pick a result to load the customer's number…`. Mobile:
  `Job search & call history are available on desktop.`
  Job-number navigation goes through `requestLeave(() => navigate('/jobs/{id}'))` (settings guard)
  and only when the id is a UUID.
- `ActiveCallPopup({number, customerName, onClose, onConference})` - fixed `z-[75]`, backdrop
  `aria-label="Close call"`, X `aria-label="Close"`, embeds `<Softphone autoCallNumber ... />`.
- `MessagePanel({customer, number, onClose, onConference, onToast})` - docked bottom-right
  `z-[72]`. Conference `title="Conference call — add the office"`, close
  `aria-label="Close conversation"`. Input `placeholder="Type an SMS…"` (Enter sends), send button
  `aria-label="Send"` `disabled={!draft.trim()}`. `send()` appends a local message
  (`id: m_{Date.now()}`, direction `out`, status `sent`) and toasts
  `✉️ Text sent to {name|number}` - **local only, no mutation.** Empty:
  `No messages yet — start the conversation.`
- `ConferencePicker({onClose, onToast})` - fixed `z-[80]`, backdrop
  `aria-label="Close conference picker"`. Groups `Office staff` (human phone agents) and
  `Field technicians` (techs via `TECH_ROLE_LABEL`). `Add` -> toast
  `➕ {name} added to the call`, button becomes disabled `Added`. Manual number input
  `placeholder="Enter a number"` `inputMode="tel"` (Enter submits), `Call`
  `disabled={!num.trim()}` -> normalises to `+1`+digits, toast
  `📞 Adding {fmtPhone} to the call…`. Footer `{n} on the call` / `No one added yet` and `Done`.

`Dialer.tsx` has a committed test: `phone/__tests__/dialer-search-dropdown.test.tsx`.

---

## 6. `/communication/text` - TextPage

142 lines - a thin shell.

- CASL gate at the top; denied -> `You don't have access to the Text module.`
- `useToast()` -> `onToast = (m) => toast({description: m})` (the global ALPHA toaster).
- Reads `useMessageThreads()` into a local `threads` state via the same `if (seed.length)` effect.
- Header `<h1>Text</h1>` and two `TabButton`s: `Inbox` (`InboxIcon`) and `Settings`
  (`Settings` icon). Same URL-tab mechanism and same path-param bug as PhonePage (section 1.1).
- `inbox` -> `<SmsInboxView threads setThreads onToast />` filling the pane.
- `settings` -> `<TextingView onToast />` inside `flex-1 overflow-y-auto bg-background-light h-full`.

### 6.1 `SmsInboxView` `{threads, setThreads, onToast}`

Three-pane SMS messenger.

- Four directory tab pills with unread counts: `Conversations`, `Team`, `Group`, `Archive` ->
  `pickFilter(f)` also reselects the first thread in that bucket.
- `New` button (Plus) -> `NewMessageDialog` (fixed `z-[80]`, backdrop
  `aria-label="Close new message"`, X `aria-label="Close"`).
- Thread row -> `openThread(id)` (select + zero `unread`). A directory "person" row with no thread
  -> `startTeamThread(member)` (creates a local `kind:'team'` thread, toast
  `Conversation opened with {name}`) or `startCustomerThread(customerId, "")`.
- Per-message job pill wrapped in `JobAssignMenu` (open jobs, disabled `No open jobs`, separator,
  `No job`), trigger `title` = `Tagged to {label} — click to reassign` or
  `No job — click to assign`. **Rendered only when `threadKind(open) === 'customer'`.**
  `reassignMessage` commits only on mutation success: `useReassignSmsJob().mutate({messageId,
  jobId})` -> success patches local state + toast `Tagged to {number}` / `Job tag removed`; error
  -> toast `Couldn't update the job tag — try again`, no local change.
- Reply composer: `placeholder="Type an SMS reply…"`, **Enter sends**, `Send`
  `disabled={!draft.trim()}` -> appends locally, `useSendSms().mutate({customerId, body})`, toast
  `✉️ Message sent`.
- Right rail `ContextPanel`: job buttons `title="Open {number}"` -> `navigate('/jobs/{id}')`; an
  **Unrouted tray** of inbound messages with no `jobId`, each with an `Assign` button wrapped in
  `JobAssignMenu`; and a `+ Quick book a job` button **with no `onClick` - it is inert**.
- Deep link: `?customerId=...` selects that customer's thread once, guarded by a `deepLinked` ref.
- `NewMessageDialog`: left rail `Team` / `Customers` / `By job`; search
  (`Search a job # or customer…` / `Search team members…` / `Search customers…`, `autoFocus`);
  compose pane with `To: {name}`, a `Change` button, a textarea
  `placeholder="Write a message to {name}…"` `autoFocus`, `Cancel`, and a submit labelled `Send`
  when the body is non-empty else `Open conversation`, with
  **`disabled={selected.kind === 'team' && !body.trim()}`**. `sendIt()` routes to
  `onSendToCustomer(customerId, body)` when the recipient has a `customerId`, otherwise requires a
  non-empty body and only toasts `✉️ Message sent to {name}`.
- Empty states: `No {archived|team|group|conversations} conversations.` ·
  `No conversation selected` · `No matches.` · `Select a conversation.` · `No open jobs`.
- Text anchors: `Inbox`, `New`, `Unrouted`, `Jobs · navigation`, `+ Quick book a job`,
  `Internal team thread`.

### 6.2 `TextingView` `{onToast}`

Three sub-tabs: `Templates & settings` (count = templates), `Automations` (count = automations),
`Compliance & legal`.

**Templates tab** - Caller ID input (default `"ServWave"`); a dynamic list of forward-number inputs
(`placeholder="(555) 555-5555"`) with `Add number` and a per-row `aria-label="Remove number"`
(only when more than one); `Enable Job Closing` checkbox; `New template` (CASL-gated).
`TemplateCard`: a textarea bound to the template body (rows = line count + 1), merge-field chips
(`title="Insert {{token}}"`) inserting at the caret with a `requestAnimationFrame` selection
restore, `Reset to default` for preset templates (toast `↺ Template reset to default`) or `Delete`
for custom ones (toast `Template deleted`), an optional
`Notify me when tech sends this message` checkbox, and an extra hint for `tpl_job`. `InfoDot`
carries `title={tpl.info}`.

`NewTemplateModal` - `Template name` (`placeholder="e.g. Quote follow-up"`, `autoFocus`),
`Sends to` `CleanSelect aria-label="Template audience"` (Customer / Team-dispatch), `Message`
textarea + merge chips. Submit `Add template` **`disabled={!(name.trim() && body.trim())}`** ->
mints `tpl_custom_{Date.now()}_{seq}` with `kind:'custom'` and `fields = all MERGE_FIELDS`,
`useSaveTemplate().mutate(t)`, toast `✓ Template "{name}" added`. Escape closes; backdrop
`aria-label="Close"`.

**Automations tab** - `New automation` (CASL-gated). Per row: a `Toggle`
(`role="switch"`, `aria-label="Toggle {name}"`) that flips enablement **locally with no mutation
and no toast**; `Edit`; delete `aria-label="Delete automation"` -> toast `Automation deleted`.
Empty: `No automations yet` / `Create one to text customers automatically at the right moment.`

`AutomationModal` - `Automation name` (`placeholder="e.g. 1-hour reminder"`, autoFocus);
`When this happens` `CleanSelect aria-label="Trigger"` (from `TEXT_TRIGGERS`, with the trigger's
`desc` below); mode toggle `Use a template` / `Write from scratch`; either
`CleanSelect aria-label="Template"` or a compose textarea + the first 14 merge chips;
`CleanSelect aria-label="Timing"`; `CleanSelect aria-label="Audience"`; a `Toggle`
`aria-label="Enabled"` labelled `Active`/`Paused`. Submit `Save automation` / `Create automation`,
**`disabled={!(name.trim() && (mode==='template' ? !!templateId : !!composed.trim()))}`**. In
compose mode it first mints a `tpl_custom_...` template and `useSaveTemplate().mutate`s it, links
it, then `useSaveAutomation().mutate(linked)`. Toast `✓ Automation saved` (edit) or
`✓ Automation "{name}" created`.

**Compliance tab** - an A2P verified banner; `Auto opt-out footer` `Toggle`
(`aria-label="Opt-out footer"`) revealing an editable footer input; `Respect quiet hours
(8 AM–9 PM local)` `Toggle` (`aria-label="Quiet hours"`); a numbered `SMS_COMPLIANCE` list and the
`SMS_LEGAL_DISCLAIMER` warning.

Sticky bottom bar: `Save Settings` -> toast `✓ Texting settings saved`. **Caller ID, forwards and
the compliance toggles are never persisted.**

Seeding is one-shot per list via `templatesSeeded` / `automationsSeeded` refs. No loading or error
UI anywhere in the file.

---

## 7. `/communication/whatsapp` - WhatsAppPage

393 lines, two panes. **No ability gate at all** (does not import `useAppAbility`).

State: `chats` (seeded from `useWhatsAppChats()` exactly once via a `hydrated` ref, which also sets
`activeId` to the first chat), `activeId`, `query`, `draft`, `toast`, `scrollRef`.

Component tree:

```
div.flex.h-full.flex-col
├─ header
│  ├─ h1  [#25D366 square + inline WhatsApp brand SVG] "WhatsApp"
│  ├─ pill  Phone icon + WA_BUSINESS_NUMBER
│  ├─ pill  emerald dot + "Business · Connected"
│  ├─ {totalUnread > 0 && "#25D366 pill  {n} unread"}
│  └─ p "Two-way WhatsApp Business messaging with customers — synced to the same contacts as
│        your ServWave Phone line."
└─ two-pane
   ├─ w-80 list
   │  ├─ search "Search chats"
   │  └─ rows: avatar (hash-tinted initials) · name · lastAt · "You: "+last.text · unread pill
   └─ thread  (bg-[#EFEAE2])
      ├─ header: avatar · name · "{org} · {phone}" · button aria-label="Call {name}"
      ├─ messages: pinned "Messages are end-to-end encrypted" chip, bubbles
      │     (#D9FDD3 mine / white theirs), time + StatusTicks, and a JobBadge under EVERY bubble
      └─ composer: aria-label="Emoji" (inert) · aria-label="Attach" (inert) ·
            input "Type a message" (Enter sends, Shift+Enter newline) ·
            aria-label="Send"  disabled={!draft.trim()}
```

Behaviour:

| Element | Effect |
|---|---|
| Chat row | `openChat(id)` - selects and zeroes that chat's `unread` |
| Search | filters on `name`, `org`, `phone` (substring, lowercased). Empty result -> `No chats match "{query}".` |
| Send | appends a local `WAMessage` (`id: m_{Date.now()}`, `from:'us'`, `status:'sent'`), fires `useSendWhatsApp().mutate({chat_id, text})`, clears the draft, then **`setTimeout(700)` -> status `delivered`** and **`setTimeout(1800)` -> status `read`** |
| Call button | `setToast("📞 Calling {name}…")` then `setTimeout(2600)` clears it. **Local toast div, NOT the global toaster** |
| Auto-scroll | `useEffect` on `[activeId, active?.messages.length]` sets `scrollTop = scrollHeight` |

`StatusTicks`: `read` -> `CheckCheck` sky-500, `delivered` -> `CheckCheck` muted, anything else ->
single `Check` muted.

Brand colours are hardcoded hex on purpose - `#25D366`, `#D9FDD3`, `#1ebe5d`, `#EFEAE2` - and the
file comment says they ARE the WhatsApp identity. This **violates the CLAUDE.md tokens-only rule**;
a v2 port needs a decision (a `--wa-*` token in `tokens.css` is the obvious answer).

Emoji and Attach buttons have `aria-label`s but **no handlers**.

---

## 8. `/communication/inbox` - InboxPage

1,317 lines. Gmail-style three-pane client.

### 8.1 Data + state

```
useEmails()       -> emails    (useEffect resets on EVERY seed change, not guarded on length)
useEmailGroups()  -> groups
useForwardRules() -> forwards
useTeamMembers()  -> members   (used directly, not lifted)
useSendEmail(), useSaveDraft()
```

Local UI state: `folder` (`inbox`), `query`, `openId`, `toast`, `compose: ComposeState|null`,
`reply: ReplyDraft|null`, `manageTab: null|'members'|'groups'|'forwarding'`, `railOpen` (true).

`ownerName` = signed-in user's full name, falling back to the literal `"Emanuel Dahan"`.
`defaultAccount: AccountId = "gmail"`.

Threading: `threadKey(e) = e.threadId ?? e.id`. `visible` (lines 179-206) filters by folder
(`starred` matches `e.starred` instead of the folder), drops snoozed mail from `inbox`, applies the
search over subject / snippet / from.name / from.email, then keeps the LATEST message per thread
and attaches a total-count across all folders. `countFor(folder)` returns the unread count for
`inbox` and the total for every other folder.

`flash(msg)` is a local toast: `setToast` + `setTimeout(2600)`. It renders as a fixed
`bg-slate-900` pill at the bottom - **not** the global toaster.

### 8.2 Component tree

```
div.flex.h-full.flex-col
├─ header: h1 [primary square + Mail] "Inbox" · PRIMARY_ACCOUNT.provider pill ·
│          "Connected" pill · Compose button · subtitle
└─ three-pane
   ├─ folder rail (w-52) when railOpen, else a w-11 strip with aria-label="Open menu"
   │  ├─ "Menu" + aria-label="Collapse menu"
   │  ├─ FOLDERS: Inbox · Starred · Sent · Drafts · Archive  (icon + count badge)
   │  ├─ Team      + "Directory" link -> setManageTab('members')
   │  │     per member: avatar (online dot) · name · role · title="Email {email}" -> emailMember
   │  ├─ Groups    + "Manage" -> setManageTab('groups')
   │  │     per group: Users icon · name · member count · title="Email {name}" -> emailGroup
   │  ├─ Connected account block (PRIMARY_ACCOUNT + "Live" pill)
   │  └─ Forwarding + "Manage" -> setManageTab('forwarding')   (read-only list, "off" pill)
   ├─ list  (flex-1, or hidden w-96 lg:flex when a message is open)
   │  ├─ search "Search mail"
   │  └─ rows -> openEmail(id).  Star is a nested span[role=button][tabIndex=0]
   │        aria-label={starred?"Unstar":"Star"} with stopPropagation + Enter/Space handling
   └─ reading pane  (hidden lg:flex, only when a message is open)
├─ mobile overlay: the SAME <ReadingPane> again, fixed inset-0 z-40 lg:hidden
├─ {compose && <ComposeWindow .../>}
├─ {manageTab && <ManageDirectoryModal .../>}
└─ {toast && fixed bottom pill}
```

`ReadingPane` is rendered **twice** with identical props (desktop column + mobile overlay). Each
instance has its own `expanded` / `snoozeOpen` / `moreOpen` state.

### 8.3 Actions

| Action | Effect |
|---|---|
| `openEmail(id)` | sets `openId`, clears `reply`, **`setRailOpen(false)`**, marks every message in that thread read |
| `toggleStar(id)` | local flip |
| `archive(id)` | `folder:'archive'`, closes the reader, `flash("Conversation archived")` |
| `startCompose()` | `{mode:'new', account:'gmail', to:'', subject:'', body:''}` |
| `emailMember(m)` | compose to `m.email` + `flash("✉️ New email to {name}")` |
| `emailGroup(g)` | compose to the comma-joined member emails + `flash("✉️ New group email to {name} ({n})")` |
| `startReply(email)` | inline `ReplyDraft`, subject prefixed `Re: ` unless already, body EMPTY |
| `startForward(email)` | inline draft, subject prefixed `Fwd: `, `to` empty |
| `sendReply()` | empty `to` -> `flash("Add a recipient first")`. Else builds a `folder:'sent'` Email whose body is the typed text + `quoted(orig)`, prepends it, fires `useSendEmail().mutate({account, from, to, subject, body, thread_id})`, clears the draft, `flash("✓ Email sent to {to}")` |
| `discardReply()` | non-empty body -> builds a `folder:'drafts'` Email, prepends, `useSaveDraft().mutate({to, subject, body})`, `flash("Draft saved")`. Empty -> just closes |
| `popOutReply()` | moves the inline draft into the floating `ComposeWindow` with the quote appended |
| `sendCompose()` | same as `sendReply` but from the compose window; toast appends ` with {n} attachment(s)` |
| `closeCompose()` | any of to/subject/body non-empty -> save a draft + `flash("Draft saved")`; else close |

`quoted(email)` = `\n\n\n———\nOn {at}, {from.name} <{from.email}> wrote:\n{body.join('\n')}`.
`bodyToParas(text)` splits on `\n{2,}` and falls back to `["(no content)"]`.
`nextTs()` = `max(existing ts) + 1`. `nowLabel()` = `toLocaleTimeString` hour+minute.

### 8.4 `ReadingPane`

Renders the whole conversation oldest -> newest. The last message is always expanded; older ones
collapse to a one-line summary and are clickable to expand (`m.id !== lastId && toggleMessage`).

Action bar, all `IconBtn` (which sets **both `aria-label` and `title` to its `label`**):
`Back` (lg:hidden, `aria-label="Back"`) · `Archive` · `Report spam` · `Delete` · separator ·
`Mark as unread` · `Snooze` · `Add to tasks` · then right-aligned `Reply` · `Forward` · separator ·
`Star`/`Unstar` · `More`.

| Menu action | Effect |
|---|---|
| `Snooze` | popover `Snooze until` with `Later today`, `Tomorrow`, `This weekend`, `Next week` -> `snoozedUntil`, toast `Snoozed — {when}`, then `onBack()` |
| `Mark as unread` | `unread:true`, toast `Marked as unread`, `onBack()` |
| `Report spam` | `folder:'archive'`, toast `Reported spam & removed from inbox`, `onBack()` |
| `Delete` | filters the email out entirely, toast `Moved to Trash` |
| `Add to tasks` | toast `✓ Added to tasks` only |
| More > `Mark as important` / `not important` | `important` flip + toast |
| More > `Add star` / `Remove star` | `onStar()` |
| More > `Create event` | toast `📅 Event created from this email` only |
| More > `Mute` | `folder:'archive'`, toast `Muted — moved out of inbox`, `onBack()` |

Both popovers use a `fixed inset-0 z-10` invisible backdrop button (`aria-hidden`, `tabIndex={-1}`)
and are mutually exclusive.

Content area: subject `<h2>`, label pills (`LABEL_TONE` for `Customer`/`Vendor`/`Lead`/`Billing`/
`Reviews`), a `JobBadge` when `email.jobLabel`, `{n} messages in this conversation` when > 1, then
the chain. Each expanded message shows `to {m.to} · via {provider}` and its attachments, defaulting
to a fake `invoice.pdf · 84 KB` chip when `hasAttachment` is true but `attachments` is missing.
**Every message header carries an unconditional `JobBadge`** (which renders a muted `no job` pill
when untagged) - the list rows deliberately do NOT, and the source comment at lines 804-808 records
that as an accepted deviation.

Below the chain: `Reply` / `Forward` pill buttons when idle, or the `InlineComposer` when active.

### 8.5 `inbox/ComposeWindow.tsx`

Exports `filesToAttachments`, `AccountChip`, `AttachmentChips`, `IconBtn`, `ComposerToolbar`,
`ComposeWindow`, `InlineComposer`.

- `filesToAttachments(FileList|null)` -> `{name, size}` with size formatted `n B` / `n KB` (0dp) /
  `n.n MB` (1dp).
- `AttachmentChips` returns `null` when empty; each remove button is
  `aria-label="Remove {filename}"`.
- `IconBtn({label, onClick, children})` -> `<button type="button" aria-label={label} title={label}>`.
- `ComposerToolbar({onAddFiles, onInsert, onToast})` - a hidden `<input type="file" multiple>`,
  then `IconBtn`s: `Formatting` (toast `Rich formatting coming soon`), `Attach files` (opens the
  picker), `Insert link` (`onInsert(" https://")` + toast `Link inserted — edit the URL`), `Emoji`
  (a 6-col popover `🙂 👍 🙏 ✅ 🎉 🚀 💡 ⚠️ 📅 📞 💬 🔧`, backdrop
  `aria-label="Close emoji picker"`), `Insert image` (same picker).
- `ComposeWindow({state, onChange, onSend, onClose, onDiscard, onToast})` - `fixed bottom-0
  right-6 z-50 w-[540px] max-h-[80vh]`. **Hand-rolled: no `role="dialog"`, no focus trap, no
  Escape handler.** Title from `state.mode`: `Reply` / `Forward` / `New message`. `From` is
  read-only `PRIMARY_ACCOUNT.address`. Fields `placeholder="Recipients"`, `"Subject"`,
  `"Write your message…"` - **no `<form>`, no validation, `Send` is NEVER disabled** (the empty-`to`
  guard lives in the page's `sendCompose`). Close `aria-label="Close"`, discard
  `aria-label="Discard draft"` `title="Discard draft"`. Also hosts `AiAssistMenu` with
  `original={null}` and `draftLabel` `Draft an email` / `Draft a reply`.
- `InlineComposer({reply, original, onChange, onSend, onDiscard, onPopOut, onToast})` - header
  `Reply`/`Forward`, pop-out `aria-label="Pop out into a window"` `title="Pop out"`, an
  `AccountChip` per `ACCOUNTS` entry, `placeholder="Recipients"`, an `autoFocus` textarea
  (`Add a message…` for forward, `Reply to {name}…` otherwise), a quote toggle
  `aria-label="Show quoted text"` with visible text `···`, `AttachmentChips`, `Send` (never
  disabled), `AiAssistMenu` with the real `original`, `ComposerToolbar`, and discard
  `aria-label="Discard"` `title="Discard"`.
  **Fragile:** `ACCOUNTS.find(a => a.id === reply.account)!` - a non-null assertion that throws if
  `reply.account` is ever anything but `gmail` or `system`.

### 8.6 `inbox/AiAssistMenu.tsx`

`{body, original, draftLabel, onResult, onToast}`. Trigger = `Sparkles` + text `AI` +
`ChevronDown`; opens a `w-64` popover (absolute, not a portal) over a
`aria-hidden tabIndex={-1}` backdrop. Draft button label is `Regenerate draft` when the body is
non-empty, else `draftLabel`; result toast `✨ AI drafted your message`. Then heading
`Refine your text` and six buttons, each `disabled={!hasText}` and each toasting `✨ {label}`:
`Polish — professional`, `Make it friendlier`, `Shorten it`, `Elaborate`,
`More bold & bombastic`, `Fix spelling & grammar`. When there is no text:
`Write a few words first to refine them.`

**The "AI" is entirely local deterministic string manipulation.** `useAiAssist` exists in the seam
but is not called from here; the file comment says production would swap it in.

### 8.7 `inbox/InboxDirectory.tsx` - `ManageDirectoryModal`

Props `{initialTab, members, groups, setGroups, forwards, setForwards, onClose, onEmailMember,
onEmailGroup, flash}`. `fixed inset-0 z-[60]`, backdrop `aria-label="Close"`, **Escape closes**
(window keydown), no `role="dialog"`. Header `<h2>Team & groups</h2>`. Tabs `Members` / `Groups` /
`Forwarding` - `tab` is initialised from `initialTab` and **not resynced** if the prop changes.

- **Members**: copy `Everyone on your account. Click Email to start a message. The roster itself is
  managed in Settings → Users.` Each row has an `Email` button -> `onEmailMember(m)`.
- **Groups**: `New group` -> `{id: 'g_'+Date.now(), name:'New group', memberIds:[]}` +
  `flash("Group created — add members and rename it")` (the only `flash` in the file). Inline name
  `<input>` renames on every keystroke with no blank guard. `Email` -> `onEmailGroup(g)`. Delete
  `aria-label="Delete group"` also clears `toGroupId` on any forward rule pointing at it. Member
  chips toggle membership with a `Check` icon when selected. Header `Members ({n})`.
- **Forwarding**: copy `Route incoming mail to the right person or team so nothing gets missed.`
  `New rule` -> `{id:'f_'+Date.now(), from:'', toGroupId: groups[0]?.id, enabled:true}`. Empty ->
  `No forwarding rules yet.` Per rule: `placeholder="Incoming mail (address or label)"`, an
  `On`/`Off` pill, delete `aria-label="Delete rule"`, and a shadcn `Select` with
  `SelectTrigger aria-label="Forward to"`, `SelectValue placeholder="Select…"`, values
  `g:{groupId}` / `m:{memberId}` grouped under `Groups` and `People`.
- Footer `Done` -> `onClose`.

**Nothing in this modal is persisted to the server.** Every edit is a local `setGroups` /
`setForwards` on the page's optimistic state, and the page re-seeds from the queries on every
resolve.

---

## 9. Selector surface

**There is not a single `data-testid` anywhere under `frontend/src/pages/communication/` or
`frontend/src/components/communication/`.** Verified by grep across both trees.

There is also **no Playwright spec for this module** - `frontend/e2e/specs/` contains no
communication spec, and grep for `communication` under `e2e/` returns only helper files.

Committed unit tests that DO cover it and must keep passing:

| Test | Covers |
|---|---|
| `components/communication/phone/useCallsPipeline.test.tsx` | the whole filter/sort pipeline |
| `components/communication/phone/__tests__/dialer-search-dropdown.test.tsx` | the DialerWorkspace search dropdown |
| `components/communication/phone/__tests__/phone-tokens.reskin.test.ts` | **asserts the token re-skin.** Read this one before touching any class name in `phone/*` |

Everything a selector could hook onto today is an `aria-label`, a `title`, a `role`, a placeholder,
or literal text. The complete `aria-label` inventory across the module:

```
Phone messages · WhatsApp · Inbox · More                          (Header)
Open dialer · Close dialer · Close                                (GlobalDialer)
Phone plan usage and upgrade options · Close plan usage panel     (PlanUsage)
Close filters · Remove {label} · Rows per page                    (CallsView)
Close call detail · Add to call · Message · Call back
Back 15 seconds · Play · Pause · Forward 15 seconds · Download recording
Close agent detail                                                (PerformanceView)
Select country · Close menu · Assign call flow · Close flow menu
Assign an ad group · Close ad group menu
Assign ad group for {number} · Assign flow for {number}
Assign flow for new number · Release {number}                     (NumbersView)
Block reason                                                      (BlockedCallersView)
Edit {name} · Delete {name} · Add a step · Close add menu · Close editor
Remove option                                                     (CallFlows)
Delete {name}                                                     (CallGroups)
Auto-mask everyone in the company · Consent style · Caller ID number
Off-platform leak guard · Call summary + transcript
Sentiment & escalation alerts                                     (CallMaskingView)
Filter by trainee · Filter by role · Filter by result
Close breakdown · Close session detail · Close simulation          (TrainingView)
Delete last digit                                                 (Softphone)
Close call · Close conversation · Send · Close conference picker   (Dialer)
Close new message                                                 (SmsInboxView)
Template audience · Trigger · Template · Timing · Audience · Enabled
Opt-out footer · Quiet hours · Remove number · Delete automation   (TextingView)
Close date picker                                                 (shared DateRangeControl)
Call {name} · Emoji · Attach · Send                                (WhatsAppPage)
Collapse menu · Open menu · Star · Unstar                          (InboxPage)
Archive · Report spam · Delete · Mark as unread · Snooze
Add to tasks · Reply · Forward · Star · More · Back                (IconBtn - aria-label AND title)
Remove {filename} · Close emoji picker · Discard draft
Pop out into a window · Show quoted text · Discard                 (ComposeWindow)
Close · Delete group · Delete rule · Forward to                    (InboxDirectory)
```

Roles: `role="switch"` + `aria-checked` on every `shared.tsx` `Toggle` (used by TextingView and
CallMaskingView); `role="listbox"` on the portaled `CleanSelect` menus; `role="tooltip"` on the
PhonePage business-number tooltip; `role="button"` + `tabIndex={0}` on the InboxPage star.
`aria-pressed` on `KPITile`, `StatCard`, `TrainStat`, `DeviceToggle` and the JobCommunicationsTab
channel toggle. `aria-expanded` on `PlanUsage`, `AdGroupSelect`, `FlowSelect`.

**Recommendation for the v2 build: add `data-testid` from the start.** The kit swap will churn
class names and DOM shape, and there is no e2e safety net here at all - the module is one large
untested surface hanging off a re-skin test that only checks tokens.

---

## 10. Loading / empty / error states

**There is no loading state anywhere in this module.** Not one skeleton, spinner, or `isLoading`
branch in any of the four pages or the 19 components. Every hook is destructured
`const { data: x = [] } = useHook()`, so an in-flight query renders as an empty list and the page
looks "loaded but empty".

**There is no error state anywhere either.** No `isError`, no `error` render branch. A 403 from
every endpoint (a technician) produces the same silent empty page as a slow network. The only
error surfaces in the whole module are the two reassign mutations' `onError` toasts
(`Couldn't update the job link — try again`, `Couldn't update the job tag — try again`).

The exceptions are the two cross-module tabs, which DO have full states:
`CustomerCommunicationsTab` (4 skeleton rows / `Failed to load communications.` /
`No communication with this customer yet.`) and `JobCommunicationsTab` (2 skeletons /
`extractApiError(error, 'Failed to load communication')` / `No communication on this job yet…`).

Every empty string in the module, for reference:

```
No calls match your search.                          No chats match "{query}".
Queue clear — nice.                                  No numbers match "{query}".
No calls in this period.                             No blocked numbers
No call flows yet                                    No call groups yet
No training sessions match these filters.            No data for the current filters.
No {archived|team|group|conversations} conversations. No conversation selected
No matches.                                          Select a conversation.
No open jobs                                         No automations yet
No forwarding rules yet.                             Nothing here.               (InboxPage list)
You don't have access to the inbox.                  No messages yet — start the conversation.
No job, PO, or customer matches "{query}".           No call history yet.
No recording for this call                           No tags
Transcript is still being generated.                 Not scored
No numbers to assign.                                No call groups yet — create one on the Call groups tab.
```

---

## 11. Timers, audio and browser APIs (complete inventory)

Nothing here is a network subscription. Every one of these is a local simulation and must be
carried over verbatim.

| Where | Timer / API |
|---|---|
| `Softphone` | `setTimeout(3500)` auto-answer on outbound; `setInterval(1000)` MM:SS call timer while active; nested `setTimeout` ring cadences (outbound 1200/1400 ms, inbound 1100/900 ms); Web Audio DTMF pairs + 160 ms connect beep; `setTimeout(450)` then `speechSynthesis` greeting; window `keydown` dial capture |
| `GlobalDialer` | `setTimeout(3200)` toast auto-dismiss |
| `DialerWorkspace` | document `mousedown` + `keydown` (Escape) while the results dropdown is open |
| `WhatsAppPage` | `setTimeout(700)` -> `delivered`; `setTimeout(1800)` -> `read`; `setTimeout(2600)` toast dismiss; auto-scroll effect |
| `InboxPage` | `setTimeout(2600)` `flash` dismiss |
| `TrainingView` / `SimulationModal` | `setTimeout(300)` first customer turn; `setTimeout(550)` between turns; `setTimeout(700)` TTS fallback; `setInterval(1000)` elapsed counter while `incall`; Web Speech `SpeechRecognition` (`en-US`, interim, non-continuous); `speechSynthesis`; auto-scroll on transcript change |
| `CallMaskingView` | `speechSynthesis.cancel()` + `speak()` for the disclaimer preview; Escape keydown + capture-phase `scroll`/`resize` while a `CleanSelect` is open |
| `TextingView` | Escape keydown; capture `scroll`/`resize` for `CleanSelect` placement; `requestAnimationFrame` to restore the caret after a merge-chip insert |
| `NumbersView` | Escape keydown; capture `scroll`/`resize` for the portaled ad-group menu placement |
| `PlanUsage` / `ReachSalesModal` / `BlockNumberModal` / `ManageDirectoryModal` / `StructureChoiceModal` | window `keydown` Escape-to-close |
| `PhonePage` | none of its own beyond `PlanUsage`'s |

---

## 12. Open questions

1. **`:tab` path-param navigation is broken** (section 1.1). `goToSection`/`goToTab` write only the
   search param while `params.tab` takes precedence, so tab clicks from a `/phone/:tab` URL are
   no-ops. Deliberate half-migration or a bug? Not fixing it in a presentation-only port.
2. **The `phone` entitlement gates nothing in this checkout** (section 2). No `useFeature`, no
   `requireFeature`, no `feature_overrides` column, no `backend/src/lib/entitlements/`. Is the
   entitlement enforced purely out-of-band via Supabase MCP today, or is the machinery on a branch
   that has not reached `main`? This changes what "a user without the entitlement sees" from
   "a locked module" to "the full working module".
3. **The brief says 9 backend `comm-*` route groups; this repo has 5** (`comm-calls`,
   `comm-threads`, `comm-agents`, `comm-config`, `comm-whatsapp-email`). Were the other four never
   built, or merged into these five?
4. **`WhatsAppPage` has no ability gate at all** and `InboxPage`'s gate only swaps the message list
   while leaving the team directory, groups and forwarding rules visible. Both leak org data to a
   user the backend 403s. Security question, not a UI question - raise before the v2 PR.
5. **Five seam endpoints 404 today** (`screen-pop`, `numbers/buy`, `emails/draft`, `ai-assist`,
   POST `training/sessions`, issue #229). The UI fires and ignores them, so `Buy · $2` and
   `Purchased` toast on a failed request. Reproduce or flag?
6. **Nothing in Call flows, Call groups, Call masking, or the Inbox directory persists.** Those
   views mutate parent state and toast `✓ Saved`. `useSaveCallFlow` and `useSaveCallGroup` exist in
   the seam and are never called. Same for the TextingView `Save Settings` bar and the whole
   `PlanUsage` upgrade flow. Is this known prototype scope?
7. **Hardcoded prototype identity is user-visible**: `emanuel@alphasecurityus.com` as the connected
   mailbox, `Emanuel Dahan` as the owner fallback, `(551) 282-7064` as both the phone and WhatsApp
   business number, and `PLAN_USAGE` with a `May 1 – 31` cycle. Ship as-is in v2?
8. **`phone/shared.tsx` `NOW` is hardcoded to `2026-05-30T23:59:59`**, so every date-range preset
   is anchored to a fixed past date rather than the real clock. All Calls filtering depends on it.
9. **WhatsApp brand hex is hardcoded** (`#25D366`, `#D9FDD3`, `#1ebe5d`, `#EFEAE2`), which breaks
   the CLAUDE.md tokens-only boundary. Needs a token decision before the v2 page is written.
10. **`+ Quick book a job`** in `SmsInboxView`'s ContextPanel, and the `Emoji` / `Attach` buttons on
    WhatsAppPage, have no handlers. Keep the dead affordances or drop them?
11. **`ModulePlaceholder` + `SECTION_META` in `PhonePage.tsx` are unreachable dead code**
    (section 5.2). Port or drop?
12. **No live-site crawl.** Everything above is from source. Behaviour that only shows up against
    the deployed app - real API payload shapes, whether `/api/communication/*` returns seeded rows
    in staging, actual unread counts - is unverified.

---

## 13. Risks for the v2 build

| Risk | Why it matters |
|---|---|
| **The module is not self-contained** | `GlobalDialer` + `useUnreadCounts` are mounted by `components/layout/Header.tsx` on every page. Restyling `Dialer.tsx` restyles every v2 page's header, and its queries already fire app-wide. Build v2 copies; do not edit `Dialer.tsx` in module 12. |
| **Zero e2e coverage, zero testids** | No Playwright spec touches these routes. The kit swap has no safety net beyond `phone-tokens.reskin.test.ts` (which only checks tokens) and two component tests. A v2 page could be visibly broken and every gate would still be green. |
| **`phone-tokens.reskin.test.ts` asserts class names** | Read it before changing anything in `phone/*`. It is the one test that will fail loudly on a re-skin, and it must keep passing on the OLD pages. |
| **PhonePage is a 1,384-line stateful shell** | Seven lifted arrays, four handlers and eleven sub-views wired by prop drilling. The presentation swap has to preserve every `setX` identity or the sub-views stop mutating the shared state (numbers <-> flows, blocked <-> calls). |
| **InboxPage is 1,317 lines with `ReadingPane` rendered twice** | Desktop column and mobile overlay both mount it with independent local state. A kit `Sheet`/`Drawer` swap must keep both instances or lose the mobile path. |
| **No loading and no error states at all** | If the v2 kit components assume `isLoading`/`isError` props, a builder will be tempted to add them. That is a behaviour change, not a re-skin. Flag it, do not add it. |
| **Local `setTimeout`-driven "realtime"** | WhatsApp tick progression, softphone auto-answer, training turn pacing. Any kit component that remounts on prop change will restart or orphan these timers. |
| **Two local toast systems** | WhatsAppPage and InboxPage render their own fixed toast divs; PhonePage and TextPage use the global `useToast()`. Unifying them would be a behaviour change. |
| **Hand-rolled overlays everywhere** | `ComposeWindow`, `ManageDirectoryModal`, `ReachSalesModal`, `BlockNumberModal`, `StructureChoiceModal`, the Dialer overlay, `ConferencePicker`, `MessagePanel` - none is a shadcn `Dialog`. No `role="dialog"`, no focus trap, inconsistent Escape handling, z-indices hand-picked from `z-[60]` to `z-[80]`. Migrating them to kit dialogs would be a genuine a11y win but is a behavioural change that needs sign-off. |
| **`createPortal` + measured placement** in `NumbersView`'s `AdGroupSelect` and the `CleanSelect`s | Capture-phase `scroll`/`resize` listeners and manual flip-up logic. Swapping in a kit `Popover` changes the DOM position and will break the measurement code. |
| **`ACCOUNTS.find(...)!` non-null assertions** in `InlineComposer`, `sendReply`, `discardReply`, `sendCompose` | Any change to `AccountId` or to how `reply.account` is set throws at runtime with no error boundary in the page. |
| **Entitlement ambiguity** | If the `phone` gate lands between mapping and build, the v2 pages will need a gate the v1 pages never had - which breaks the "presentation only" contract. Confirm the answer to Open question 2 before Phase 2 starts. |
