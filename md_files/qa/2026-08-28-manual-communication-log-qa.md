# QA scenarios — Manual Communication Log

**Spec:** `md_files/specs/communication/2026-08-27-manual-communication-log.md`
**Slices:** `md_files/issues/communication/01..09-*.md`
**Branch:** `feat/manual-communication-log` (worktree `/Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/manual-comm-log`)
**Target:** PART A → localhost `:3040` against the shared **staging** database · PART B → STAGING, after deploy
**Date written:** 2026-08-28
**Runner:** you are executing this, not designing it. Follow the steps literally and compare
against the quoted expected values. Where a step says "check this first", the check is the point —
skipping it turns a pass into a lie.

---

## 0. Read this first

You do not need to have read the spec, the slice files or any engineer report. Everything you need
is in this document.

### 0.1 What the feature is

A user with a new permission can record, **by hand**, a communication that already happened — a
call, a text, or an email — against a lead or a job. Think: a rep who called from their personal
mobile; an estimator who replied from Outlook; an admin typing up months of history during
onboarding.

The entry appears in that lead's / job's Communication timeline in chronological position among the
real communications, visibly marked as hand-entered, and it rolls up onto the customer's
Communication tab.

### 0.2 The central constraint — this is what the feature is really about

> **A manually logged entry appears in the lead, job and customer timelines, and NOWHERE in the
> Communication module** — not in the Calls list, not in the texts (threads) list, not in the emails
> list, not in agent performance metrics, not in call reports.

It is a record that *a conversation happened*. It is not a record of *a call the platform placed*.
Keeping those two things apart is the whole design. Most of PART A exists to test this one sentence,
per channel and per timeline.

### 0.3 THE NON-EMPTY RULE — read this before you assert any absence

Every scenario that asserts "the entry is NOT in list X" **must first confirm that list X is
non-empty**, and you must record the length you saw.

**Absence from an empty list proves nothing.** If `GET /api/communication/calls` returns `[]`
because the endpoint is broken, an auth token expired, or a filter went wrong, then "my entry is not
in it" is true and completely meaningless — and it will read in your report as a pass.

So: read the module list **first**, record its length, confirm it is greater than zero, and only
then check that your entry is absent. Check absence **two ways** — by entry `id` **and** by
searching the raw response body for your marker string. A leak that renamed the id field would still
carry your notes text.

Recorded baselines for the demo org (verified 2026-08-28 — re-measure, do not assume):

| Module list | Endpoint | Expected length |
| --- | --- | --- |
| Calls | `GET /api/communication/calls?limit=50` | **17** |
| Texts | `GET /api/communication/threads` | ~11 |
| Emails | `GET /api/communication/emails` | ~415 |
| Agents (feeds Performance / AHT) | `GET /api/communication/agents` | 3 agents |

If any of these comes back empty, **stop and report an environment failure**, not a feature pass.

### 0.4 Two things this QA pass CANNOT prove — read before you file anything

These are honest, known gaps. Do not invent steps that pretend otherwise, and do not report them as
failures.

**(1) Browser rendering has never been verified on any slice of this feature.**
Localhost login is closed on both of its routes: the `qa-session.mjs --inject` snippet needs a
JavaScript-execution browser tool that the permission classifier blocks, and the printed magic-link
fallback **redirects to production**. Consequently *every* UI claim on this feature — the button,
the drawer, the "Logged" chip, the hand-entered icon overlay, the attribution line, the suppressed
delivery pill, the roles-page checkbox — rests on component tests (vitest + jsdom), and **nobody has
ever looked at a rendered page**. Every scenario needing a rendered page is in **PART B
(STAGING-ONLY)** and says so.

**(2) Automation silence cannot be positively proven on localhost.**
The requirement is "logging fires no automations". On localhost we can only show a *negative
control*: the demo org runs a live workflow engine (30 workflows, 354 enrolments, 352 step runs, the
most recent hours before the last measurement), and a 100-entry burst added **zero** enrolments and
**zero** step runs. That is real evidence that the tables fill and did not move. **But it is not a
positive control:** none of the demo org's published workflows carries a trigger a manual log could
plausibly emit, and `AutomationTriggerType` has no manual-log member at all. So the same "nothing
fired" observation would hold *even if the dispatcher were wired in*. The positive control is
**QA-S16**, staging-only. (The *notification* half of the silence **is** meaningful on localhost —
`notifications` holds 2 631 real demo-org rows, so "no new row and an unmoved `max(created_at)`" is
an assertion against a table that demonstrably fills.)

### 0.5 One acceptance criterion is STRUCK — do not test it, do not report it

Slice 07's criterion **"the dashboard's needs-followup count drops for a lead once an outbound
communication is logged on it"** is **NOT APPLICABLE** (decision **D-1**, taken 2026-08-28).

The tile does not exist. It was deleted end-to-end in `e5a3d5bdd`
(*"chore(dashboard): remove the 'needs follow-up' tile (#1791)"*), which is an **ancestor of this
branch** — `dashboard.controller.ts` has zero occurrences of `contacted`, and
`need_followup_today` / `needsFollowup` appear nowhere in any `.ts` or `.tsx`. Rebuilding it inside
a communication-logging feature would reverse a deliberate product decision as a side effect.

**There is no scenario for it.** The underlying write — `Lead.contacted_at` — is built, tested and
correct, and is covered by **QA-A22 … QA-A26**. If a follow-up tile is ever reintroduced, it will
read a column that is now populated correctly.

---

## 1. Environment and access

### 1.1 Servers

| | |
| --- | --- |
| Backend (PART A) | `http://localhost:3040` |
| How to start it | the `preview_start` tool with `{"name": "mcl-backend"}` — **never** start a dev server with Bash |
| Frontend (not needed for PART A) | `http://localhost:5210`, launch config `mcl-frontend` |
| Database | the **shared staging Supabase** project `knriiqdqxgfoecsfarlx` — there is no local Postgres on this machine |
| Staging app (PART B) | `https://servwave-demo.vercel.app` |
| Staging API (PART B) | `https://alpha-crm-test-env.onrender.com` |

Both localhost servers serve the worktree
`/Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/manual-comm-log`. Confirm this before you trust any
result — see the build check in §3.

### 1.2 The bearer token — and the gotcha that will cost you an hour

A session file already exists at `<worktree>/.qa/session-staging.json` for `admin@alphacrm.com`
(ADMIN of the demo org).

```bash
cd /Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/manual-comm-log
TOKEN=$(node -e 'const s=require("./.qa/session-staging.json");process.stdout.write(s.access_token||s.session?.access_token||"")')
echo "token length: ${#TOKEN}"    # expect ~762
```

> **THE GOTCHA. The token is nested under `session.access_token`, not at the top level.**
> Drop the `|| s.session?.access_token` fallback and `$TOKEN` is the empty string. Every request
> then returns:
>
> ```json
> 401 {"error":"Missing or invalid authorization header"}
> ```
>
> which reads **exactly** like a broken auth guard on the feature under test. This has already
> caused one wrong diagnosis on this feature. **If you see a 401, check `${#TOKEN}` before you
> report anything.**

**Tokens expire in about an hour**, and an expired token presents as the *same* 401 (or
`401 Invalid or expired token`). Re-mint with:

```bash
node scripts/qa-session.mjs staging --session
```

**Minting a session for a different user OVERWRITES `.qa/session-staging.json`.** Several scenarios
need a second or third principal. Before minting one:

```bash
cp .qa/session-staging.json /tmp/mcl-qa-admin-session.json     # back up the ADMIN session
node scripts/qa-session.mjs staging sales@alphacrm.com --session
# ... run the scenario ...
cp /tmp/mcl-qa-admin-session.json .qa/session-staging.json     # restore
rm /tmp/mcl-qa-admin-session.json
```

**Never print, paste, log, commit or attach the token or the session file.** It carries a live
access token **and** a refresh token for a real user, so it grants that user's access until the
refresh token is revoked — outliving the access token's own expiry. Opaque JWTs in a JSON file do
not look like a key to gitleaks, so nothing downstream will catch the mistake. `.qa/` is gitignored.
Delete any working copies when you are done.

### 1.3 NEVER navigate a browser to the magic link

`qa-session.mjs` prints a magic link alongside the session file. **Do not open it.**

Staging's Supabase *Site URL* points at the production frontend and overrides any `redirectTo`, so
the printed link takes you to **`https://app.servwave.com` — PRODUCTION**. Following it would sign
you into the live product against live customer data. There is no scenario in this document that
requires you to open it.

### 1.4 Working rules

- **Work only in the demo org** `00000000-0000-0000-0000-000000000001` — "ServWave Test",
  `is_demo: true`, timezone **America/New_York**. All the arithmetic in this document assumes
  America/New_York; in late August that is EDT, **UTC−4**.
- **Prefix everything you create with your own marker**, e.g. `QA1-<unix-ts>`, `QA2-<unix-ts>`,
  `QA3-<unix-ts>` — one per runner, so three testers never collide. Put it at the start of `notes`
  (and of `subject`, where you set one). Record your marker in your results table.
- **Clean up after yourself.** Delete the entries you created, using the feature's own
  `DELETE /api/communication/manual-log/:id` where the scenario allows it, and confirm each
  re-`GET` returns 404.
- **Never delete or mutate a row you did not create.** In particular do not clear another runner's
  marker, and do not "tidy" the pre-existing fixture rows described in §1.6.
- **`contacted_at` is a side effect you cannot undo through the API.** Logging an *outbound* entry
  on a lead stamps that lead's contacted timestamp, and neither editing nor deleting the entry
  clears it. The contacted-at scenarios name dedicated leads for exactly this reason. **Record every
  lead whose `contacted_at` you moved**, with its before value, in your results table.
- **The `COMMUNICATION_LOGGED` activity events you create survive deletion by design** (see
  QA-A33). Do not try to remove them through the API; there is no door, and that is deliberate.

### 1.5 Do not run browser sessions in parallel

The three QA runners **must not** drive a browser at the same time. Parallel browser agents on this
machine share a single browser pane and will corrupt each other's sessions and screenshots. PART A
needs no browser at all. For PART B, coordinate so only one runner has the browser at a time.

Related: heavy `vitest` runs by other sessions on this machine starve unrelated tests. If you are
asked to run a suite and see a red file your change cannot reach, check `uptime` and
`ps aux | grep vitest` before believing it, and re-run the file alone.

### 1.6 The demo org already holds a pile of build-phase fixture rows

As at 2026-08-28 the demo org's `manual_communication_logs` table holds **109 rows**, spread across
**16 leads and 5 jobs**, left behind by the nine build slices and their verifiers. There are also
**75** `COMMUNICATION_LOGGED` rows in `timeline_events`.

They carry these markers at the start of `notes`:

`Smoke test from orchestrator`, `VERIFIER-SLICE1-1787871800`, `VERIFIER-SLICE1-CHRONO`,
`SLICE2-1787874465`, `VERIFIER-SLICE2-1787875583`, `SLICE3-A/B/C/D`,
`VERIFIER-SLICE3-1787879774`, `SLICE5-1787882976`, `VERIFIER-SLICE5-1787884334`, `SLICE6-`,
`VERIFIER-SLICE6`, `SLICE7-1787900000`, `VERIFIER-SLICE7-1787903000`, `SLICE9-1787912501`,
`VERIFIER-SLICE9-1787914557`.

**Do not be confused by them, and do not delete them.** They are why a lead timeline may return 50+
items when you expected 3. Always filter by *your own* marker. Clearing them is a separate,
deliberate cleanup task and is **not** part of this QA pass.

---

## 2. Fixtures

Verified against the staging database on 2026-08-28. **Re-check any fixture before you rely on it** —
this is a shared database and other work lands in it. If a fixture has moved, find an equivalent by
the stated property, use it, and say so in your report.

### 2.1 Principals (all demo org)

| Handle | Email | Role | User id |
| --- | --- | --- | --- |
| **ADMIN-1** | `admin@alphacrm.com` | ADMIN | `b3ce980d-2d9b-4492-9cb5-bc7ea422e35f` |
| **ADMIN-2** | `ranroffe@servwave.com` | ADMIN | `8563be21-08c2-46f4-b8b6-867c007c55e2` |
| **SALES** | `sales@alphacrm.com` | SALES | `922c44ab-6bee-4876-bf42-31bbaae0f43b` |
| **TECH** | `tech@alphacrm.com` | TECHNICIAN | `7928f4b3-e227-4154-bff6-f3433f31c4e5` |

The demo org has **21 active users** in total. There is **no DISPATCHER login**; the DISPATCHER
scenarios are driven through the roles API, not through a session.

### 2.2 Records

| Handle | What it is | Id |
| --- | --- | --- |
| **LEAD-A** | L00156. Carries **3 real platform emails** (non-empty control), **0** manual rows, `contacted_at` **NULL**, and converted into JOB-A. | `01ca5e2a-87d0-4f28-86d8-53c32878a9f1` |
| **JOB-A** | J00183. `lead_id` = LEAD-A, **same customer** as LEAD-A, **3 real emails**, **0** manual rows. | `995818b0-1356-49ab-adb5-01e29be5caf0` |
| **CUST-A** | The customer both LEAD-A and JOB-A hang off. | `dd9f2aef-2716-42f8-84ae-a6d815ae8605` |
| **JOB-B** | J00051. **10 real communications** (3 emails, 1 call, 3 messages) — the richest job timeline. Its lead is LEAD-B. | `3d482de9-15ad-49ce-95c3-06e97d054afe` |
| **LEAD-B** | L00132, the lead JOB-B converted from. `contacted_at` **NULL** — that is the point of QA-A26. | `6a805b34-ac12-4157-8f6a-d4b28e92c592` |
| **CLOCK-NULL-1** | L00131 — `contacted_at` NULL, 0 manual rows | `6ae3091c-678e-4bff-bce5-895bb762f8cd` |
| **CLOCK-NULL-2** | L00134 — `contacted_at` NULL, 0 manual rows | `2e9494cc-5acc-4da8-a578-695b4bac33b8` |
| **CLOCK-NULL-3** | L00106 — `contacted_at` NULL, 0 manual rows | `8d8905d4-902e-46b0-b01b-14742b58d11b` |
| **CLOCK-NULL-4** | L00136 — `contacted_at` NULL, 0 manual rows, 2 real emails | `9dc9f12d-be5e-41ce-abe2-ddcfc50edb97` |
| **CLOCK-SET-1** | L00004 — `contacted_at` = `2025-10-17 03:35:09.368`, 0 manual rows | `c276b7ae-6d77-41fb-8c1d-2551daa17223` |
| **CLOCK-SET-2** | L00005 — `contacted_at` = `2026-02-10 04:35:09.368`, 0 manual rows | `1816e7cb-a4ae-445c-aba9-463ef5ade0db` |

> **LEAD-A / JOB-A / CUST-A is the trio the timeline scenarios turn on.** It is a genuinely converted
> lead → job pair on one customer, where **both** sides already carry real platform communications.
> That gives you a non-empty control on every one of the three timelines *and* the conversion-truth
> case, from one fixture.

### 2.3 Cross-organisation fixtures (for the tenancy scenarios)

These are **real records in another organisation** (Alpha Doors & Security), not invented UUIDs.
That matters: an unknown id exercises a different code path from "exists, but not yours".

| Handle | What it is | Id |
| --- | --- | --- |
| **XORG-LEAD** | Alpha Doors lead L00712 | `dfdc500f-b26f-41df-93e6-e300d2ccc936` |
| **XORG-JOB** | Alpha Doors job | `bc0bd486-4d93-4e8f-8ac5-6c21f9afe5b9` |
| **XORG-USER** | Alpha Doors ADMIN, active | `e583e47b-a70e-480a-b3fe-f4319f21ab40` |

**Never write into these.** They are used only as identifiers the API must refuse.

### 2.4 The API surface

Base: `http://localhost:3040` (PART A). Every request needs `Authorization: Bearer $TOKEN`.

| Verb & path | What it does | Success |
| --- | --- | --- |
| `POST /api/communication/manual-log` | create an entry | `201 {"entry":{…}}` |
| `GET /api/communication/manual-log/performers` | the capability-scoped roster the performer picker reads | `200 {"users":[{id,first_name,last_name}]}` |
| `GET /api/communication/manual-log/:id` | the whole stored entry (the editor's read) | `200 {"entry":{…}}` |
| `PUT /api/communication/manual-log/:id` | replace the entry in full | `200 {"entry":{…}}` |
| `DELETE /api/communication/manual-log/:id` | remove it | `204`, empty body |
| `GET /api/leads/:id/communications` | lead timeline | `200` array of `CommItem` |
| `GET /api/jobs/:id/communications` | job timeline | `200` |
| `GET /api/customers/:id/communications` | customer roll-up | `200` |
| `GET /api/communication/calls?limit=50` | **module** calls list — must never contain an entry | `200` |
| `GET /api/communication/threads` | **module** texts list — same | `200` |
| `GET /api/communication/emails` | **module** emails list — same | `200` |
| `GET /api/communication/agents` | agent metrics (feeds the Performance view) | `200` |
| `GET /api/leads/:id/timeline`, `GET /api/jobs/:id/timeline` | the **activity feed** (different from the Communication timeline) | `200` |
| `GET /api/roles/:role/permissions` | a role's view model | `200` |
| `PUT /api/roles/:role/permissions` | save a role's view model | `200 {"ok":true}` |

### 2.5 The create / update payload

```jsonc
{
  "lead_id": "<uuid>",          // EXACTLY ONE of lead_id or job_id
  "job_id":  "<uuid>",
  "channel": "call",            // "call" | "sms" | "email".
                                //   CREATE: optional, defaults to "call"
                                //   UPDATE: REQUIRED
  "direction": "out",           // "in" | "out" — required
  "occurred_at": "2026-08-26T16:00",  // ZONELESS wall clock. A zoned value is REFUSED.
  "notes": "…",                 // required, 1..10000 chars, trimmed
  "performed_by": "<uuid>",     // who HAD the conversation.
                                //   CREATE: optional, defaults to the caller
                                //   UPDATE: REQUIRED
  "duration_minutes": 12,       // optional, integer 0..1440, CALL channel only
  "outcome": "connected",       // optional, CALL only:
                                //   "connected" | "no_answer" | "voicemail" | "callback_requested"
  "subject": "…"                // optional, 1..500 chars, EMAIL channel only
}
```

There is **no `logged_by` field**, deliberately. The schema is `.strict()`, so a body naming it is
**refused with 400**, not silently ignored.

Response shape (`entry`):

```jsonc
{
  "id": "<uuid>",
  "channel": "call", "direction": "out",
  "occurredAt": "2026-08-26T20:00:00.000Z",   // the composed INSTANT
  "occurredAtLocal": "2026-08-26T16:00",      // the same instant in the ORG's wall clock
  "notes": "…",
  "durationMinutes": 12, "outcome": "connected", "subject": null,
  "leadId": "<uuid>", "jobId": null,
  "performedBy": "<uuid>", "loggedBy": "<uuid>",
  "manuallyLogged": true
}
```

---

## 3. Build check — DO THIS FIRST. IF IT FAILS, STOP.

This is the likeliest way to produce a pile of bogus failures: running the whole script against a
server that is not on this branch.

```bash
cd /Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/manual-comm-log
TOKEN=$(node -e 'const s=require("./.qa/session-staging.json");process.stdout.write(s.access_token||s.session?.access_token||"")')
echo "token length: ${#TOKEN}"
```

1. **Token length ≈ 762.** If it is `0`, re-read §1.2 — you dropped the nested fallback. If the
   token is expired, re-mint.
2. **The whole feature is mounted:**
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3040/api/communication/manual-log
   ```
   → **`401`**. A `404` means the router is not mounted; a `402` means it landed behind the phone
   entitlement. Either is a STOP.
3. **The slice-8 handlers exist** (this distinguishes a current build from an early one):
   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     http://localhost:3040/api/communication/manual-log/00000000-0000-0000-0000-0000000000ff
   ```
   → **`{"error":"Entry not found"}`**. If you get `{"error":"Not found"}` (the router's own
   catch-all terminator) then GET/PUT/DELETE are **not** built on the running server. **STOP** and
   report *"server is on an earlier build — QA invalid, not failed."*
4. **The slice-6 channel rules exist:**
   ```bash
   curl -s -X POST http://localhost:3040/api/communication/manual-log \
     -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"lead_id":"01ca5e2a-87d0-4f28-86d8-53c32878a9f1","channel":"sms","direction":"out",
          "occurred_at":"2026-08-26T16:00","notes":"buildcheck","duration_minutes":5}'
   ```
   → **`400`** with `{"field":"duration_minutes","message":"a duration belongs to a call"}`. This
   request writes nothing. A `201` means the running server predates slice 6 — **STOP**.
5. **The module lists are non-empty** — run all four reads in §0.3 and record their lengths. Any
   empty one is a STOP.

Record all five results before running a single scenario.

---

# PART A — LOCALHOST-VERIFIABLE

Thirty-nine scenarios, all through the HTTP API. No browser. Three runners can execute these in
parallel provided each uses **its own marker** and its own fixture leads where the scenario allows
a choice.

Throughout, `$TOKEN` is the ADMIN-1 bearer token unless a scenario says otherwise, and `$M` is your
own marker string.

---

### QA-A01 — Log a past call on a lead, and read it back

**Covers:** stories 1, 2, 8, 12, 16
**Preconditions:** LEAD-A. Build check passed.

**Steps**
1. `POST /api/communication/manual-log` with:
   ```json
   {"lead_id":"01ca5e2a-87d0-4f28-86d8-53c32878a9f1","direction":"out",
    "occurred_at":"2026-06-18T15:08","notes":"$M A call from my own mobile, three months ago."}
   ```
2. Record the returned `entry.id` as **E1**.
3. `GET /api/communication/manual-log/E1`.

**Expected**
- Step 1 returns **`201`**.
- `entry.channel` is `"call"` (the default), `entry.direction` is `"out"`,
  `entry.manuallyLogged` is `true`.
- `entry.notes` is your text, **verbatim and untruncated**.
- `entry.performedBy` **and** `entry.loggedBy` are both **ADMIN-1** (`b3ce980d-…`) — no performer was
  named, so the caller is credited with both.
- `entry.leadId` is LEAD-A; `entry.jobId` is `null`.
- Step 3 returns the same values.

**Fail if:** the notes come back truncated or altered; `manuallyLogged` is absent or false;
`loggedBy` differs from the authenticated caller.

---

### QA-A02 — The org clock on create: a zoneless wall clock in, the right instant out

**Covers:** stories 8, 9
**Preconditions:** LEAD-A. The org's timezone is **America/New_York** (EDT, UTC−4, in August).

This is the single most important correctness check on the write path. The user picks a wall clock;
the **organisation's** zone decides which instant that is — never the browser's, never the server's
UTC.

**Steps**
1. `POST` with `"occurred_at": "2026-08-26T16:00"` on LEAD-A, notes prefixed `$M org-clock`.
2. Read `entry.occurredAt` and `entry.occurredAtLocal`.

**Expected**
- `entry.occurredAt` is exactly **`"2026-08-26T20:00:00.000Z"`** — 16:00 EDT = 20:00 UTC.
- `entry.occurredAtLocal` is exactly **`"2026-08-26T16:00"`** — the same instant read back through
  the org's zone, which is what an edit form reopens on.

**Fail if:** `occurredAt` is `2026-08-26T16:00:00.000Z` (the server read the value as naive UTC), or
carries any other offset. Quote the value you saw.

> Note for the report: this proves the *server composes against the org clock*. It does **not**
> prove the behaviour for a user whose own browser zone differs from the organisation's — that
> requires a rendered picker and is **QA-S07** on staging. The API's refusal of a zoned instant
> (QA-A03) is what makes the client structurally unable to impose its own zone.

---

### QA-A03 — A zoned instant is refused

**Covers:** story 9
**Preconditions:** LEAD-A.

**Steps** — three `POST`s on LEAD-A, identical except `occurred_at`:
1. `"2026-08-26T16:00:00Z"`
2. `"2026-08-26T16:00:00+05:00"`
3. `"2026-08-26T16:00"` (the control)

**Expected**
- 1 and 2 → **`400`**, message **`must be a zoneless wall clock, e.g. 2026-08-26T16:00`**, and
  **nothing is written**.
- 3 → `201` (this is the control that proves the endpoint is reachable at all).
- Confirm nothing persisted: `GET /api/leads/<LEAD-A>/communications` contains **exactly one** new
  row of yours from this scenario, not three.

**Fail if:** a zoned value is accepted. That is the org-clock bug shipping.

---

### QA-A04 — The three required fields are required

**Covers:** story 12
**Preconditions:** LEAD-A.

**Steps** — `POST` on LEAD-A, one field wrong per request:

| # | Body change | Expected |
| --- | --- | --- |
| a | omit `notes` | 400 |
| b | `"notes": "   "` (whitespace only) | 400 — `String must contain at least 1 character(s)` |
| c | omit `direction` | 400 — `Required` |
| d | `"direction": "outbound"` | 400 — `Invalid enum value. Expected 'in' \| 'out'` |
| e | omit `occurred_at` | 400 — `Required` |

**Expected:** all five are `400`, and the lead timeline gains **no** row from any of them.

**Fail if:** any of these is accepted, or a `500` is returned (a 500 here would be a server fault for
a client's malformed request).

---

### QA-A05 — Direction: inbound and outbound both round-trip

**Covers:** stories 5, 7
**Preconditions:** LEAD-A.

**Steps**
1. `POST` `"direction": "out"`, notes `$M outbound`.
2. `POST` `"direction": "in"`, notes `$M inbound`.
3. `GET /api/leads/<LEAD-A>/communications`.

**Expected**
- Both `201`, `entry.direction` `"out"` and `"in"` respectively.
- On the timeline the two rows read **`Outbound call`** and **`Inbound call`** in `title`.

**Fail if:** direction is dropped or inverted, or both rows read the same.

---

### QA-A06 — Exactly one anchor: naming both is refused, naming neither is refused

**Covers:** story 18
**Preconditions:** LEAD-A, JOB-A.

**Steps** — three `POST`s:

| # | Anchors | Expected |
| --- | --- | --- |
| a | `lead_id` = LEAD-A **and** `job_id` = JOB-A | **400** |
| b | neither key present | **400** |
| c | `job_id` = JOB-A only (control) | **201** |

**Expected**
- a and b return `400` with
  `{"error":"Validation failed","details":[{"field":"lead_id","message":"exactly one of lead_id or job_id is required"}]}`
  and write nothing.
- c returns `201` with `entry.jobId` set and `entry.leadId` **null**. Keep this entry id as **E-JOB**
  for QA-A16.

**Fail if:** a or b is accepted. An entry naming both would be double-counted on two timelines; one
naming neither could never be read back at all.

---

### QA-A07 — The manual-log router is NOT behind the phone entitlement

**Covers:** stories 41, 42
**Preconditions:** the worktree checkout, for a source read.

The feature exists for organisations that never had ServWave Phone. If the router sat behind the
phone entitlement it would `402` exactly those organisations.

**Steps**
1. Read `backend/src/routes/comm-manual-log.routes.ts`. Find the line
   `router.use(MANUAL_LOG_PREFIXES, authenticate, attachAbility);`.
2. Confirm the file never **invokes** `requireFeature`:
   ```bash
   grep -cE 'requireFeature\(' backend/src/routes/comm-manual-log.routes.ts
   ```
3. Compare with a sibling: `grep -n "router.use" backend/src/routes/comm-calls.routes.ts`.
4. Confirm the mount order in `backend/src/app.ts`: the manual-log router is mounted **before**
   the phone routers.

**Expected**
- Step 2 prints **`0`**.
- Step 3 shows `router.use(authenticate, requireFeature('phone'), attachAbility)` — path-**un**scoped,
  which is why mount order matters.
- Step 4 shows `commManualLogRoutes` mounted ahead of `commCallsRoutes`.

**Fail if:** `requireFeature` is actually *invoked* in the manual-log router, or the router is
mounted after a phone router. A bare mention inside a comment is **not** a failure.

> **Corrected 2026-08-28.** Step 2 originally read `grep -c requireFeature …` and expected `0`. It
> prints **`1`** — a prose comment in that file explaining the deliberate absence. QA Runner 1 hit
> this and correctly judged the substance to pass. The grep now counts invocations rather than
> mentions, so the check means what it claims.

> **Why this is a source read and not a live request.** The demo org **has** the phone entitlement,
> and its plan must not be mutated to test this. The behavioural half — an org whose plan lacks
> `phone` gets `201` here while a sibling phone route `402`s — is covered by an automated backend
> test, and the rendered half is **QA-S02** on staging.

---

### QA-A08 — Channel: call, text and email — and the subject line on an email

**Covers:** stories 3, 4, 6, 15
**Preconditions:** LEAD-A.

**Steps** — four `POST`s on LEAD-A, all with your marker in `notes`:

| # | Body extras | Expected |
| --- | --- | --- |
| a | `"channel":"sms","direction":"out"` | 201 |
| b | `"channel":"email","direction":"out","subject":"$M Revised scope - two garage doors"` | 201 |
| c | `"channel":"email","direction":"in"` (no subject) | 201 |
| d | `"channel":"whatsapp"` | **400** |
| e | `"channel":"in_person"` | **400** |

Then `GET /api/leads/<LEAD-A>/communications` and find your three rows.

**Expected**
- a, b, c → `201`. `entry.channel` is `"sms"`, `"email"`, `"email"`. On c, `entry.subject` is
  **`null`** — an email with no subject is a complete entry.
- d and e → `400`,
  `Invalid enum value. Expected 'call' | 'sms' | 'email', received 'whatsapp'` / `'in_person'`.
- On the timeline the three rows read:
  - a → `title` **`Outbound text`** — **not** "Outbound call"
  - b → `title` **`Outbound email · $M Revised scope - two garage doors`**
  - c → `title` **`Inbound email`** — **not** `Inbound email · (no subject)`
- All three carry `manuallyLogged: true`.

**Fail if:** any of the three reads "call" in its title; b's subject is missing from the title; c
invents a `(no subject)` placeholder.

---

### QA-A09 — Duration: accepted for a call, validated, and the one-day ceiling

**Covers:** story 13
**Preconditions:** LEAD-A.

**Steps** — `POST`s on LEAD-A. Group 1 must all be accepted; group 2 must all be refused.

**Group 1 — accepted (`201`)**

| `duration_minutes` | Expected `title` on the timeline |
| --- | --- |
| omitted | `Outbound call` (no ` · Nm`) |
| `0` | `Outbound call · 0m` |
| `12` | `Outbound call · 12m` |
| `1440` | `Outbound call · 1440m` — the ceiling is **inclusive** |

**Group 2 — refused (`400`), nothing written**

| `duration_minutes` | Expected message |
| --- | --- |
| `-1` | `must not be negative` |
| `2.5` | `must be a whole number of minutes` |
| `"12"` (a string) | `must be a number of minutes` — a numeric **string** is refused, not coerced |
| `"abc"` | `must be a number of minutes` |
| `1441` | `must be at most 1440 minutes` |
| `2147483648` | `must be at most 1440 minutes` |

**Expected:** exactly as tabulated. After the run, `GET /api/leads/<LEAD-A>/communications` shows
**four** new rows of yours from this scenario, not ten.

**Fail if:** a numeric string is coerced and accepted; `1441` is accepted; the over-`int4` value
returns a `500`.

> The drawer deliberately does **not** restate the 1440 ceiling, so this server message is the
> *entire* user experience of that case. Quote it exactly in your report.

---

### QA-A10 — Outcome: the fixed set, and "no answer"/"voicemail" read as an ATTEMPT

**Covers:** story 14
**Preconditions:** LEAD-A.

**Steps**
1. Four `POST`s, one per value: `connected`, `no_answer`, `voicemail`, `callback_requested`
   (channel `call`, direction `out`).
2. Four refusal `POST`s: `"busy"`, `"NO_ANSWER"` (the DB spelling is not the wire spelling), `""`,
   `null`.
3. `GET /api/leads/<LEAD-A>/communications` and read `title` and `meta` for the four accepted rows.

**Expected**
- Step 1: all `201`.
- Step 2: all `400`,
  `Invalid enum value. Expected 'connected' | 'no_answer' | 'voicemail' | 'callback_requested', received …`.
- Step 3:

| outcome | `title` | `meta` |
| --- | --- | --- |
| `connected` | `Outbound call` | `Connected` |
| `no_answer` | **`Outbound call attempt`** | `No answer` |
| `voicemail` | **`Outbound call attempt`** | `Voicemail` |
| `callback_requested` | `Outbound call` | `Callback requested` |

**Fail if:** `no_answer` or `voicemail` reads `Outbound call` in the **title**. Somebody skimming a
timeline reads the title and moves on; a row titled "Outbound call" with "Voicemail" tucked at the
end of the meta line would let them believe the customer was spoken to.

> `callback_requested` is deliberately **not** an attempt: somebody asked to be called back, which
> means somebody was reached. Do not report that as a failure.

---

### QA-A11 — Performer vs logger: credit the colleague who had the conversation

**Covers:** stories 10, 11
**Preconditions:** LEAD-A. SALES (`922c44ab-…`) as the colleague. You are ADMIN-1.

**Steps**
1. `POST` on LEAD-A with `"performed_by": "922c44ab-6bee-4876-bf42-31bbaae0f43b"`, notes
   `$M on behalf of a colleague`.
2. `POST` on LEAD-A with **no** `performed_by`, notes `$M default performer`.
3. `GET /api/communication/manual-log/performers`.
4. `GET /api/leads/<LEAD-A>/communications` and find both rows.

**Expected**
- Step 1 → `201`, `performedBy` = `922c44ab-…` (SALES), `loggedBy` = `b3ce980d-…` (ADMIN-1).
  **The two differ.**
- Step 2 → `201`, `performedBy` **==** `loggedBy` **==** ADMIN-1.
- Step 3 → `200`, `users` is a non-empty array (**21** entries in the demo org), each row carrying
  **exactly** `id`, `first_name`, `last_name` — **no** email, phone, role, department or login
  state — and it includes the caller.
- Step 4 — on the timeline:
  - the step-1 row carries **`loggedByName`** *and* **`performedByName`**, and they are
    **different** names;
  - the step-2 row carries both fields holding **the same** name.

**Fail if:** the performer is ignored and the caller is credited; the roster returns email/phone/role
(a communication capability must not become a staff directory); the roster is empty.

---

### QA-A12 — The logger can never be named by the caller

**Covers:** story 11
**Preconditions:** LEAD-A.

**Steps**
1. `POST` on LEAD-A with `"logged_by": "922c44ab-6bee-4876-bf42-31bbaae0f43b"` added to an otherwise
   valid body.
2. `PUT` an existing entry of yours with `logged_by` added to the body.

**Expected**
- Both → **`400`**,
  `{"error":"Validation failed","details":[{"field":"","message":"Unrecognized key(s) in object: 'logged_by'"}]}`,
  and nothing is written or changed.

**Fail if:** the field is silently ignored and the request succeeds. Ignoring is not good enough —
the logger is what tells an eyewitness record from a second-hand one, so a caller able to name it
could disown their own entry.

---

### QA-A13 — A performer from another organisation is refused

**Covers:** stories 10, 46
**Preconditions:** LEAD-A. **XORG-USER** `e583e47b-a70e-480a-b3fe-f4319f21ab40` — a real, active
Alpha Doors user.

**Steps**
1. `POST` on LEAD-A with `"performed_by": "e583e47b-a70e-480a-b3fe-f4319f21ab40"`.
2. `POST` the same body with `"performed_by"` set to SALES (`922c44ab-…`) — the control.
3. `GET /api/communication/manual-log/performers` and search for the Alpha Doors id.

**Expected**
- 1 → **`404 {"error":"Performer not found"}`**, and **nothing is written**.
- 2 → `201` (proves the endpoint accepts a *named* performer at all, so the 404 is about tenancy and
  not about the field).
- 3 → the roster does **not** contain `e583e47b-…`.

**Fail if:** the cross-organisation user is accepted, or the roster offers them.

---

### QA-A14 — A lead or job from another organisation is refused as not-found

**Covers:** story 46
**Preconditions:** **XORG-LEAD** `dfdc500f-…`, **XORG-JOB** `bc0bd486-…`.

**Steps**
1. `POST` with `"lead_id": "dfdc500f-b26f-41df-93e6-e300d2ccc936"`.
2. `POST` with `"job_id": "bc0bd486-4d93-4e8f-8ac5-6c21f9afe5b9"`.
3. `POST` with `"lead_id"` set to a well-formed but nonexistent uuid, e.g.
   `"00000000-0000-0000-0000-0000000000ff"`.
4. `POST` with `"lead_id"` = LEAD-A — the control.

**Expected**
- 1 → **`404 {"error":"Lead not found"}`**
- 2 → **`404 {"error":"Job not found"}`**
- 3 → `404 {"error":"Lead not found"}` — a cross-tenant id is **indistinguishable** from a
  nonexistent one, which is the point: the caller learns nothing about another organisation's data.
- 4 → `201`
- Nothing is written for 1, 2 or 3.

**Fail if:** 1 or 2 returns `201`, or returns a `403` that reveals the record exists.

---

### QA-A15 — ★ THE PAIR (lead): present on the lead timeline, absent from the module's calls list

**Covers:** stories 2, 21, 24 (data half), 47
**Preconditions:** LEAD-A (3 real platform emails, so the timeline has a non-empty control).

**This is the feature's central constraint. Both halves must be checked in the same run.**

**Steps**
1. **FIRST**, before creating anything: `GET /api/communication/calls?limit=50`. Record the array
   length. **It must be greater than zero — expect 17.** If it is empty, STOP (see §0.3).
2. `POST` a call on LEAD-A, notes `$M the pair, lead side`. Record the id as **E-PAIR-L**.
3. `GET /api/leads/<LEAD-A>/communications`.
4. `GET /api/communication/calls?limit=50` again.

**Expected**
- Step 1: length **> 0**. Record it.
- Step 3: the response contains a row whose `id` is E-PAIR-L, with **`manuallyLogged: true`**, and it
  sits in **chronological position among the real platform emails** — not grouped at the top, not in
  a separate block. Check by sorting the returned items on `at` and confirming the ordering is
  monotonic with your row in its date's place.
- Step 3 also: the **real** email rows beside it have `manuallyLogged` **absent or false**. (This is
  the discriminating half — a marker rendered on everything would pass a one-sided check.)
- Step 4: the calls list still has the **same length** as step 1, does **not** contain E-PAIR-L, and
  the raw response body contains **zero** occurrences of your marker string `$M`.

**Fail if:** the entry appears in the calls list by id or by text; the calls list was empty in step 1
(that is an invalid run, not a pass); the real rows beside it are also marked `manuallyLogged`.

---

### QA-A16 — ★ THE PAIR (job)

**Covers:** stories 5, 17, 21
**Preconditions:** JOB-A (3 real emails) — or JOB-B for a richer timeline.

**Steps**
1. **FIRST:** `GET /api/communication/calls?limit=50`, record length, confirm > 0.
2. `POST` with `"job_id": "<JOB-A>"`, `"direction":"in"`, notes `$M the pair, job side`. Record as
   **E-PAIR-J**.
3. `GET /api/jobs/<JOB-A>/communications`.
4. `GET /api/communication/calls?limit=50`.

**Expected**
- Step 2 → `201`, `entry.jobId` set, `entry.leadId` **null**.
- Step 3 → contains E-PAIR-J with `manuallyLogged: true`, `jobLabel` set to the job number
  (e.g. `"J00183"`), and `who` resolved to the **customer's** name — resolved *through the job*, since
  the entry stores no counterparty of its own.
- Step 3 → the real rows beside it are unmarked.
- Step 4 → same length as step 1; E-PAIR-J absent by id and by marker text.

**Fail if:** `who` is empty (the job join is not resolving); `jobLabel` is missing; the entry reaches
the calls list.

---

### QA-A17 — ★ THE PAIR per channel: a logged text and a logged email

**Covers:** stories 3, 4, 21
**Preconditions:** LEAD-A. The `sms` and `email` entries from QA-A08, or create fresh ones.

The module has three lists, not one. A logged **text** must not appear alongside platform texts, and
a logged **email** must not appear alongside platform emails.

**Steps**
1. **FIRST:** `GET /api/communication/threads` and `GET /api/communication/emails`. Record both
   lengths and confirm **both are > 0** (expect roughly 11 and 415).
2. Ensure you have one `sms` and one `email` entry on LEAD-A with your marker.
3. `GET /api/leads/<LEAD-A>/communications` — confirm both are present.
4. `GET /api/communication/threads` again.
5. `GET /api/communication/emails` again.

**Expected**
- Step 1: both lists non-empty.
- Step 3: both entries present, `manuallyLogged: true`.
- Step 4: the threads list does not contain the sms entry's id, and the raw body carries **zero**
  occurrences of `$M`.
- Step 5: the emails list does not contain the email entry's id, and the raw body carries **zero**
  occurrences of `$M` — including your `subject` text, which is a second, independent way in.

**Fail if:** either list carries the entry, or either was empty in step 1.

---

### QA-A18 — ★ THE PAIR (customer roll-up): both anchors reach the same customer

**Covers:** stories 20, 21
**Preconditions:** LEAD-A, JOB-A and **CUST-A** — one customer, both anchors.

**Steps**
1. **FIRST:** `GET /api/communication/calls?limit=50`, record length, confirm > 0.
2. `GET /api/customers/<CUST-A>/communications` — record the baseline length.
3. `POST` an entry on **LEAD-A** (notes `$M rollup via lead`) and another on **JOB-A**
   (notes `$M rollup via job`).
4. `GET /api/customers/<CUST-A>/communications` again.
5. `GET /api/communication/calls?limit=50`.

**Expected**
- Step 4 contains **both** entries — the lead-anchored one (carrying `leadLabel`, no `jobLabel`) and
  the job-anchored one (carrying `jobLabel`, no `leadLabel`) — plus the pre-existing real rows.
- Both carry `manuallyLogged: true`.
- Step 5: unchanged length, neither id present, no marker text.

**Fail if:** only one of the two reaches the roll-up (a half-written disjunction would show exactly
this), or the roll-up is missing its pre-existing real rows (that would mean a filter clobbered the
customer scope, and is a **cross-tenant-shaped** defect — flag it prominently).

---

### QA-A19 — Conversion truth: a lead entry never appears on the job it became

**Covers:** story 19
**Preconditions:** LEAD-A → JOB-A (a genuinely converted pair: `JOB-A.lead_id == LEAD-A`).

**Steps**
1. `POST` an entry on **LEAD-A**, notes `$M stays on the lead`. Record as **E-CONV**.
2. `GET /api/leads/<LEAD-A>/communications`.
3. `GET /api/jobs/<JOB-A>/communications`.
4. `GET /api/customers/<CUST-A>/communications`.

**Expected**
- Step 2 → E-CONV **present**.
- Step 3 → E-CONV **ABSENT**. The job's timeline shows only its own entries and its own real
  communications.
- Step 4 → E-CONV **present** (it reaches the customer through the lead).

**Fail if:** the entry appears on the job. Entries stay where they were logged so the conversion
history reads truthfully; migrating them forward would rewrite the record.

---

### QA-A20 — Absent from agent performance metrics

**Covers:** stories 22, 23
**Preconditions:** LEAD-A.

**Steps**
1. `GET /api/communication/agents`. Record the full payload: the number of agents, and each agent's
   `calls` and `ahtSec`. **Confirm the array is non-empty** (expect 3 agents).
2. `POST` a call on LEAD-A with `"duration_minutes": 45`, notes `$M forty-five minutes`.
3. `GET /api/communication/agents` again.
4. `GET /api/communication/calls?limit=50` and read the array of `durationSec` values.

**Expected**
- Step 3: **byte-identical** to step 1 — same agent count, same `calls`, same `ahtSec`. Your 45
  minutes moved nothing.
- Step 3: the raw payload contains **zero** occurrences of `$M` and of the entry id.
- Step 4: `durationSec` contains neither `45` (the minutes) nor `2700` (those minutes as seconds).

**Fail if:** any `ahtSec` or `calls` figure moves, or the duration value appears in the calls
payload. A hand-typed duration reaching average-handle-time would corrupt a number a manager reports
upward.

---

### QA-A21 — Manual entries are stored apart from platform call records

**Covers:** story 47
**Preconditions:** the worktree checkout, for source reads, plus one live check.

The design decision is that manual entries live in **their own table**, so a future report that
forgets a filter cannot accidentally include them.

**Steps**
1. ```bash
   grep -rn "manualCommunicationLog" backend/src --include=*.ts | grep -v __tests__
   ```
2. ```bash
   grep -c "callSession" backend/src/controllers/report.controller.ts
   ```
3. Take any manual entry id of yours and call
   `GET /api/communication/calls/<that-id>`.

**Expected**
- Step 1 lists **only** these non-test files: `backend/src/lib/job-communications.ts` (the read),
  `backend/src/controllers/comm-manual-log.controller.ts` (the write), and `backend/src/lib/purge.ts`
  (tenant purge). **No** Communication-module controller, no Performance path, no report path.
- Step 2 prints **`0`** — the report controller does not read call records at all.
- Step 3 → **`404 {"error":"Call not found"}`** — a manual-log id resolves no call. Run a control
  with a **real** call id from `GET /api/communication/calls` and confirm that one returns `200`.

**Fail if:** step 1 shows a reader in the Communication module, Performance, or a report; step 3
returns `200` for a manual-log id.

---

### QA-A22 — `contacted_at`: an outbound entry fills an EMPTY clock with the ENTRY's instant

**Covers:** story 26
**Preconditions:** **CLOCK-NULL-1** (L00131, `contacted_at` NULL).
**Side effect warning:** this scenario permanently sets that lead's `contacted_at`. Record the
before value.

**Steps**
1. `GET /api/leads/<CLOCK-NULL-1>` and record `contacted_at`. **It must be `null`** — if it is not,
   pick another `CLOCK-NULL-*` lead.
2. `POST` on CLOCK-NULL-1: `"direction":"out"`, `"occurred_at":"2026-08-25T10:30"`, notes
   `$M outbound fills the clock`.
3. `GET /api/leads/<CLOCK-NULL-1>` again.

**Expected**
- Step 2 → `201`, `entry.occurredAt` = **`"2026-08-25T14:30:00.000Z"`** (10:30 EDT).
- Step 3 → `contacted_at` is now **`2026-08-25T14:30:00.000Z`** — **the entry's own instant, not
  "now"**.
- `contacted_set_by` is still `null` (that column marks a *hand correction*; an automatic stamp must
  leave it alone, which is what keeps the two distinguishable).

**Fail if:** `contacted_at` is set to the current time rather than the entry's instant — an admin
backfilling three months of history must stamp each lead with the day the conversation happened.

---

### QA-A23 — `contacted_at`: an outbound entry leaves a NON-EMPTY clock alone

**Covers:** story 27
**Preconditions:** **CLOCK-SET-1** (L00004, `contacted_at` = `2025-10-17 03:35:09.368`).

**Steps**
1. `GET /api/leads/<CLOCK-SET-1>` and record `contacted_at`. **It must be non-null.**
2. `POST` on CLOCK-SET-1: `"direction":"out"`, `"occurred_at":"2026-08-25T15:00"` — an instant
   **strictly later** than the stored value — notes `$M must not overwrite`.
3. `GET /api/leads/<CLOCK-SET-1>` again.

**Expected**
- Step 2 → `201`.
- Step 3 → `contacted_at` is **exactly what it was in step 1**, unchanged.

**Fail if:** the clock moves. First write wins: lead responsiveness is measured from the first touch.
The later instant makes "unchanged" a decision rather than a coincidence.

---

### QA-A24 — `contacted_at`: an inbound entry NEVER writes it

**Covers:** story 28
**Preconditions:** **CLOCK-NULL-2** (empty clock) and **CLOCK-SET-2** (clock already set).

**Steps**
1. Record `contacted_at` on both leads.
2. `POST` on CLOCK-NULL-2: `"direction":"in"`, notes `$M inbound, empty clock`.
3. `POST` on CLOCK-SET-2: `"direction":"in"`, notes `$M inbound, set clock`.
4. Re-read both leads.

**Expected**
- Both `POST`s → `201`.
- CLOCK-NULL-2's `contacted_at` is **still `null`**.
- CLOCK-SET-2's `contacted_at` is **unchanged**.

**Fail if:** either moves. A customer chasing us is not us doing our job.

---

### QA-A25 — `contacted_at`: a BACKDATED outbound does not move the clock backwards

**Covers:** story 27
**Preconditions:** **CLOCK-NULL-3** (empty clock).
**Side effect warning:** sets that lead's clock.

**Steps**
1. Confirm `contacted_at` is `null`.
2. `POST`: `"direction":"out"`, `"occurred_at":"2026-08-25T14:00"`, notes `$M first`.
3. Re-read the lead and record the new `contacted_at`.
4. `POST` a **second, earlier** entry: `"direction":"out"`,
   `"occurred_at":"2026-08-10T09:00"`, notes `$M earlier, logged later`.
5. Re-read the lead.

**Expected**
- After step 2 the clock is `2026-08-25T18:00:00.000Z` (14:00 EDT).
- After step 4 the clock is **still `2026-08-25T18:00:00.000Z`** — it did not move backwards, even
  though the second conversation happened earlier.

**Fail if:** the clock moves to the August 10 instant.

---

### QA-A26 — `contacted_at`: logging on a JOB touches no lead's clock

**Covers:** stories 17, 26 (the negative)
**Preconditions:** **JOB-B** `3d482de9-…`, whose lead is **LEAD-B** `6a805b34-…` with
`contacted_at` **NULL**.

This is the discriminating fixture: the job *does* have an originating lead, so a "reach through the
job to its lead" implementation would be caught.

**Steps**
1. `GET /api/leads/<LEAD-B>` and confirm `contacted_at` is `null`.
2. `POST` with `"job_id": "<JOB-B>"`, `"direction":"out"`, notes `$M job anchor, no lead clock`.
3. `GET /api/leads/<LEAD-B>` again.

**Expected**
- Step 2 → `201`, `entry.leadId` is **`null`**.
- Step 3 → `contacted_at` is **still `null`**.

**Fail if:** LEAD-B's clock is stamped. Only an entry that names a lead may stamp that lead.

---

### QA-A27 — Exactly ONE activity event on create, on the anchor it names

**Covers:** story 29
**Preconditions:** LEAD-A and JOB-A. Note: the *activity feed* (`/timeline`) is a different thing
from the *Communication timeline* (`/communications`).

**Steps**
1. `GET /api/leads/<LEAD-A>/timeline` — record the total event count and the count of events whose
   `event_type` is `COMMUNICATION_LOGGED`.
2. `GET /api/jobs/<JOB-A>/timeline` — same. **Confirm it is non-empty** (a job feed normally carries
   real events like `CREATED`, `COMPLETED`, `INVOICE_SENT` — that non-empty control is what makes
   "+1" meaningful rather than "landed in an empty list").
3. `POST` one entry on LEAD-A, notes `$M audit lead`.
4. `POST` one entry on JOB-A, notes `$M audit job`.
5. Re-read both feeds.

**Expected**
- The lead feed gains **exactly one** event; the job feed gains **exactly one**.
- The lead entry's event is on the **lead** feed only; the job entry's on the **job** feed only.
- Every other event on both feeds is unchanged.

**Fail if:** two events are written per entry, none is written, or the job-anchored entry's event
lands on a lead feed.

---

### QA-A28 — The event names the LOGGER and the CHANNEL

**Covers:** story 29
**Preconditions:** LEAD-A. SALES as the performer.

**Steps**
1. `POST` on LEAD-A with `"channel":"sms"`, `"direction":"in"`,
   `"performed_by":"922c44ab-6bee-4876-bf42-31bbaae0f43b"` (SALES), notes `$M who logged it`.
   You are authenticated as **ADMIN-1**.
2. `GET /api/leads/<LEAD-A>/timeline` and find the new event.
3. Repeat step 1 with each of the six channel × direction combinations and read each description.

**Expected**
- Step 2: `description` is exactly **`Inbound text logged`**.
- Step 2: `creator` is **ADMIN-1** (the person who typed the entry), **not** SALES (the person who
  had the conversation). The audit question is *who added this record*.
- Step 3: the six descriptions are exactly
  `Outbound call logged`, `Inbound call logged`,
  `Outbound text logged`, `Inbound text logged`,
  `Outbound email logged`, `Inbound email logged`.

**Fail if:** every description says "call" regardless of channel; the creator is the performer.

---

### QA-A29 — No notification is raised on create (asserted against a POPULATED table)

**Covers:** story 31
**Preconditions:** database read access (Supabase MCP or equivalent) for the demo org.

Unlike the automation half (QA-A30), this one *is* meaningful on localhost: the demo org holds
**2 631** real notification rows, so "no new row" is an assertion against a table that demonstrably
fills.

**Steps**
1. Record, for org `00000000-0000-0000-0000-000000000001`:
   - `SELECT count(*), max(created_at) FROM notifications WHERE organization_id = '…0001';`
   - `SELECT count(*) FROM notification_recipients …` for rows created in the last hour.
   - **Confirm the notifications count is in the thousands** — if it is 0, this scenario proves
     nothing and you must say so.
2. Create **20 entries** in sequence, alternating anchor (LEAD-A / JOB-A), cycling all three
   channels and both directions, dated across three months. All with your marker.
3. Re-run the queries from step 1.

**Expected**
- All 20 `POST`s return `201`.
- `notifications` count is **unchanged**, and `max(created_at)` is **unmoved**.
- Zero new `notification_recipients`.

**Fail if:** any notification row appears. An admin backfilling months of history must not alert
colleagues about conversations from three months ago.

> Keep these 20 entries — QA-A30 reads the same burst.

---

### QA-A30 — No automation on create — ⚠ NEGATIVE CONTROL ONLY

**Covers:** story 30 (partially — see the caveat)
**Preconditions:** the 20-entry burst from QA-A29.

**Read this before running it.** This scenario **cannot positively prove** the criterion on
localhost. Run it anyway — it is a real regression net — but report it with the caveat attached.

**Steps**
1. Before the burst, record for the demo org:
   - `SELECT count(*) FROM workflows WHERE organization_id = '…0001';` — expect **30**
   - `SELECT count(*) FROM workflow_enrollments we JOIN workflows w ON w.id = we.workflow_id
      WHERE w.organization_id = '…0001';` — expect **354**
   - the same for `workflow_step_runs` — expect **352**
   - `SELECT count(*), max(started_at) FROM automation_runs …`
2. Run the QA-A29 burst.
3. Re-run all four queries.
4. Search the backend server log for the string `[automations]` over the burst window.

**Expected**
- `workflow_enrollments` **+0**, `workflow_step_runs` **+0**, `automation_runs` **+0**.
- **Zero** `[automations]` lines in the log for the window.

**Fail if:** any of those counters moves. That would be a genuine, definite failure.

> **The caveat you must write into your report.** A pass here is a *negative control*, not a positive
> one. The demo org's 30 workflows carry estimate/invoice/job/walkthrough-shaped triggers, and
> `AutomationTriggerType` has **no manual-log member at all** — so this "nothing fired" result would
> hold **even if the dispatcher were wired in**. What the evidence does establish is that the
> workflow engine is live for this org (354 enrolments, 352 step runs, most recent hours before
> measurement) and that your burst moved nothing. The positive control is **QA-S16**, staging-only.
> Do not write "no automation fired, confirmed" without this paragraph.
>
> `automation_runs` deserves a separate warning: that table holds **0 rows across every organisation,
> ever**. Asserting absence against it is a pure placebo. Report the workflow-engine counters, not
> that one.

---

### QA-A31 — Edit: the logger corrects the entry, and the org clock holds on the way in

**Covers:** stories 9, 37
**Preconditions:** an entry **you** logged. Create one on LEAD-A as a `call`, `out`,
`duration_minutes: 12`, `outcome: "connected"`, notes `$M before the edit`. Record as **E-EDIT**.

Note the update contract: `PUT` is a **full replacement**, and two fields that are optional on
create are **required** on update — `channel` and `performed_by`. An optional field you omit is
stored as **NULL**, not silently retained.

**Steps**
1. `GET /api/communication/manual-log/E-EDIT` — record every field.
2. `PUT /api/communication/manual-log/E-EDIT` with a body changing **all eight** editable fields:
   ```json
   {"lead_id":"01ca5e2a-87d0-4f28-86d8-53c32878a9f1",
    "channel":"email","direction":"in","occurred_at":"2026-08-20T08:15",
    "performed_by":"922c44ab-6bee-4876-bf42-31bbaae0f43b",
    "notes":"$M after the edit - the whole record replaced",
    "subject":"$M Revised scope - two garage doors"}
   ```
   (`duration_minutes` and `outcome` are **omitted** on purpose.)
3. `GET /api/communication/manual-log/E-EDIT`.
4. `GET /api/leads/<LEAD-A>/communications` and read the row.

**Expected**
- Step 2 → **`200`**.
- `channel` `"email"`, `direction` `"in"`, `notes` and `subject` as sent.
- `occurredAt` = **`"2026-08-20T12:15:00.000Z"`** (08:15 EDT) and `occurredAtLocal` =
  **`"2026-08-20T08:15"`** — the org clock composes on edit exactly as on create.
- **`durationMinutes` is `null` and `outcome` is `null`** — the call-shaped answers were **cleared**,
  not retained.
- `performedBy` is now SALES.
- Step 4: the row reads **`Inbound email · $M Revised scope - two garage doors`**, with **no**
  `· 12m` and **no** `meta` line.
- Send a `PUT` with a **zoned** `occurred_at` (`"2026-08-20T08:15Z"`) → **`400`**, same message as
  QA-A03. The refusal survives on the edit path.

**Fail if:** the omitted duration/outcome survive the edit; the clock composes against UTC; a zoned
instant is accepted on the edit path.

---

### QA-A32 — Edit: the LOGGER never changes

**Covers:** stories 11, 37, 39
**Preconditions:** E-EDIT from QA-A31 (logged by ADMIN-1). Then an edit performed by **ADMIN-2**.

**Steps**
1. Note E-EDIT's `loggedBy` — it is ADMIN-1.
2. Back up the session file, mint a session for **ADMIN-2** (`ranroffe@servwave.com`), and `PUT`
   E-EDIT changing only `notes` (supplying `channel` and `performed_by` unchanged, since both are
   required).
3. `GET /api/communication/manual-log/E-EDIT`.
4. Restore the ADMIN-1 session.

**Expected**
- Step 2 → `200` (an admin may correct anyone's entry — see QA-A38).
- Step 3 → **`loggedBy` is still ADMIN-1**, though a different admin performed the edit.
- `performedBy` is whatever the body sent — it moved only because it was asked to.

**Fail if:** `loggedBy` becomes ADMIN-2. This is the silent re-attribution the whole logger/performer
split exists to prevent: an admin opening a colleague's entry to fix a typo must not quietly become
its author.

> **Related, and worth a tester's extra attention.** There is a sibling of this defect the server
> **structurally cannot catch**: a client that seeds the *performer* field from the editing user
> rather than from the entry would send a perfectly valid uuid — just the wrong person's. Only a
> rendered form can be checked for it. That is **QA-S15** on staging, and it is the highest-value
> staging check in this document.

---

### QA-A33 — Edit and delete write NO activity event and raise NO notification

**Covers:** stories 29 (boundary), 30, 31
**Preconditions:** database read access. An entry of yours.

**Steps**
1. Create one entry on LEAD-A (notes `$M silence probe`). Record the `COMMUNICATION_LOGGED` count on
   the lead's activity feed — it should have gone **up by exactly 1**.
2. Record `notifications` count and `max(created_at)`, and the workflow-engine counters.
3. `PUT` the entry **ten times** in a row, changing the notes each time. All should return `200`.
4. `DELETE` the entry → `204`.
5. Re-read the activity feed and all the counters.

**Expected**
- The lead's `COMMUNICATION_LOGGED` count is **unchanged** by the ten edits and by the delete — it
  stands at the +1 the *create* wrote and nothing more.
- `notifications` unchanged, `max(created_at)` unmoved.
- `workflow_enrollments` / `workflow_step_runs` **+0**.
- **The create's event SURVIVES the delete.** After step 4 the `COMMUNICATION_LOGGED` row is still
  on the feed for an entry that no longer exists.

**Fail if:** an edit or a delete writes an event; a notification appears.

> **The surviving event is a deliberate decision, not litter — do not report it as a bug.** The
> event's claim is "a human added a record here, and this is who", and that claim stays true after
> the record is removed. An audit trail that a deletion can erase is a weak audit trail. The
> consequence, stated so nobody is surprised: a lead's activity feed can read "Outbound call logged"
> for an entry that is no longer on the Communication tab, and **no** "deleted" event is written to
> say so.

---

### QA-A34 — Edit: re-point an entry between a lead and a job

**Covers:** story 37 (and the deliberate absence of an attach/move menu)
**Preconditions:** an entry of yours on LEAD-A. LEAD-A and JOB-A share CUST-A.

Moving an entry between a lead and a job is done **by editing it** — the shared timeline row's
attach/move/detach menu is deliberately not extended to manual entries (that menu drives a
call-record-specific endpoint).

**Steps**
1. Create an entry on LEAD-A, notes `$M repoint`. Confirm: on the lead timeline **yes**, on the job
   timeline **no**, on the customer roll-up **yes**.
2. `PUT` it with `job_id` = JOB-A and **no** `lead_id`.
3. Re-check all three timelines.
4. `PUT` it back with `lead_id` = LEAD-A and no `job_id`.
5. Re-check all three timelines.
6. `PUT` it naming **both** anchors → expect `400`. `PUT` naming **neither** → expect `400`.
7. `PUT` it with `lead_id` = **XORG-LEAD** → expect `404 {"error":"Lead not found"}`. Same with
   `job_id` = XORG-JOB → `404 {"error":"Job not found"}`.

**Expected**
- After step 2: `leadId` null, `jobId` set. On the lead timeline **no**, on the job timeline **yes**,
  on the customer roll-up **still yes**.
- After step 4: back to the original placement.
- Step 6: both `400`, with `exactly one of lead_id or job_id is required`.
- Step 7: both `404`, and the entry is **unchanged** — re-`GET` it and confirm.

**Fail if:** the old anchor is left set alongside the new one (the entry would then appear on two
timelines); a cross-organisation anchor is accepted.

---

### QA-A35 — Permissions: no capability → every verb is refused; ADMIN by default; off for the rest

**Covers:** stories 33, 34, 36
**Preconditions:** back up the session file first. **SALES** and **TECH** logins.

**Steps**
1. Confirm the starting state — no non-admin role holds the capability:
   ```sql
   SELECT count(*) FROM role_permissions
   WHERE organization_id = '00000000-0000-0000-0000-000000000001' AND action = 'log_past';
   ```
   → expect **`0`**.
2. `GET /api/roles/SALES/permissions` as ADMIN-1. Find `sensitive.logPastCommunications`.
   Repeat for `DISPATCHER` and `TECHNICIAN`.
3. Mint a **SALES** session. As SALES, call each of:
   - `POST /api/communication/manual-log` (valid body)
   - `GET /api/communication/manual-log/performers`
   - `GET /api/communication/manual-log/<some entry id>`
   - `PUT /api/communication/manual-log/<some entry id>`
   - `DELETE /api/communication/manual-log/<some entry id>`
4. Mint a **TECHNICIAN** session and repeat the `POST`.
5. Restore the ADMIN-1 session and `POST` — the control.

**Expected**
- Step 1 → `0`.
- Step 2 → `sensitive.logPastCommunications` is **`false`** for all three roles. Also confirm each
  role's `Communication` matrix still shows its usual `create` cell — the new capability is a
  separate switch and does not disturb it.
- Step 3 → **all five return `403 {"error":"Insufficient permissions"}`**, and nothing is written or
  changed.
- Step 4 → `403`.
- Step 5 → `201`. ADMIN holds the capability out of the box, through the manage-all short-circuit,
  with no configuration.

**Fail if:** any non-admin role reaches any verb; ADMIN is refused; a role's `create Communication`
grant has moved.

---

### QA-A36 — Permissions: granting the capability to a role makes it usable; revoking takes it away

**Covers:** stories 32, 35
**Preconditions:** ADMIN-1 and a SALES login. **You will change a role's grants — restore them
byte-for-byte at the end.**

**Steps**
1. As ADMIN-1: `GET /api/roles/SALES/permissions`. **Save the entire response body to a file** —
   this is your restore point.
2. As SALES: `POST /api/communication/manual-log` → expect `403`.
3. As ADMIN-1: take the saved view model, flip **only** `sensitive.logPastCommunications` to `true`,
   and `PUT` it back to `/api/roles/SALES/permissions`.
4. `GET` it again and diff against the saved copy.
5. As SALES: `POST /api/communication/manual-log` with a valid body on LEAD-A, notes
   `$M granted role`.
6. As SALES: `GET /api/communication/manual-log/performers`.
7. As ADMIN-1: `PUT` the **exact saved view model** back.
8. `GET` it and diff against the saved copy again.
9. As SALES: `POST` again.

**Expected**
- Step 2 → `403`.
- Step 4 → the **only** difference from the saved copy is
  `sensitive.logPastCommunications: false → true`. The matrix, the scope, the toggles and the other
  sensitive bundles are **byte-identical**. In particular `Communication.create` and `User.read` are
  unchanged.
- Step 5 → **`201`**, with `loggedBy` = the SALES user.
- Step 6 → `200`, a usable roster.
- Step 8 → the restored view model is **byte-identical** to the saved copy.
- Step 9 → **`403`** — unticking the switch genuinely revoked the grant.

**Cleanup:** delete the entry the SALES user created (as SALES, or as ADMIN-1). Re-verify
`SELECT count(*) … action='log_past'` is back to **`0`**.

**Fail if:** step 4 shows any other change; step 9 still returns `201` (the revoke did not take).

> Step 9 is the half most likely to break silently. Do not skip it.

---

### QA-A37 — Permissions: the capability-scoped roster exists, and `read User` is NOT widened

**Covers:** story 32 (the dependency that makes it usable)
**Preconditions:** the grant cycle from QA-A36. Run this **inside** that cycle, while SALES holds
the capability.

The performer picker cannot read `GET /api/users` — SALES does not hold `read User`, and granting it
alongside a *communication* capability would hand out every colleague's email, phone, login state
and role as a side effect. So the picker has its own narrow endpoint.

**Steps** — as **SALES**, holding `log_past`:
1. `GET /api/communication/manual-log/performers`
2. `GET /api/users?assignable=true`

**Expected**
- Step 1 → `200`, `users` non-empty (**21**), and each row has **exactly three keys**:
  `id`, `first_name`, `last_name`. It includes the caller themselves.
- Step 1 → the payload contains **no** `email`, `phone`, `is_active`, `role`, `department` or
  `custom_role`.
- Step 2 → **`403`**. `read User` was **not** widened. This control is the point of the scenario.

**Fail if:** step 1 leaks any extra field; step 2 returns `200` (the capability quietly became a
staff-directory grant); step 1 returns an empty roster (then the picker would offer nobody, and the
capability would be unusable for that role).

---

### QA-A38 — Edit and delete authorization: the logger, an org admin, and a third capability holder

**Covers:** stories 39, 40
**Preconditions:** you need **three** principals — ADMIN-1 (the logger), ADMIN-2 (a second org
admin who did **not** log it), and SALES **holding `log_past`** (a third capability holder who is
neither the logger nor an admin). Run the QA-A36 grant cycle first so SALES holds the capability, and
revoke it at the end.

This is the slice's real subject. The third principal is the one that matters: a user who holds the
capability but did not log the entry and is not an admin must be **refused**.

**Steps**
1. As **ADMIN-1**, create an entry on LEAD-A, notes `$M authz, logged by admin1`. Record as **E-AZ**.
2. As **SALES** (holding the capability), create their **own** entry, notes
   `$M authz, logged by sales`. Record as **E-SALES**.
3. Run this matrix. Every cell is a real request.

| Principal | Entry | `GET` | `PUT` | `DELETE` |
| --- | --- | --- | --- | --- |
| ADMIN-1 (the logger) | E-AZ | expect **200** | expect **200** | run last |
| SALES, **holds** `log_past`, not the logger, not an admin | E-AZ | expect **403** | expect **403** | expect **403** |
| SALES | **E-SALES** (their own) | expect **200** | expect **200** | — |
| ADMIN-2 (a second admin, not the logger) | E-SALES | expect **200** | expect **200** | expect **204** |
| Any principal | an entry id from another organisation, or a nonexistent uuid | expect **404 `Entry not found`** | **404** | **404** |

4. After the ADMIN-2 `PUT` of E-SALES, read the entry back.
5. Finally, as ADMIN-1, `DELETE` E-AZ → `204`. Re-`GET` → `404 {"error":"Entry not found"}`.
   `DELETE` it again → `404`.

**Expected**
- Exactly the matrix above.
- **Step 4 is the strongest single check in PART A:** after a *different admin* edits the SALES
  user's entry, the response carries `loggedBy` = **the SALES user** (unchanged) while `performedBy`
  is whatever the body sent. An admin can clean up after a colleague **without inheriting
  authorship**.
- Note the two different refusals and that both are correct: **404** means "no such entry in this
  organisation" (so a cross-tenant id reveals nothing); **403** means "it is in your organisation and
  you can already read it on the timeline, but you may not change it" — pretending it does not exist
  would be a lie the user could disprove by scrolling.

**Cleanup:** delete every entry created here, revoke the SALES grant, restore the session file.

**Fail if:** the third capability holder reaches any verb on someone else's entry; an admin's edit
moves `loggedBy`; a cross-organisation entry id returns anything but 404.

---

### QA-A39 — Delete: the entry disappears from the lead, job AND customer timelines

**Covers:** story 38
**Preconditions:** LEAD-A, JOB-A, CUST-A.

**Steps**
1. Create **two** entries: one on LEAD-A (notes `$M delete me`) and one on LEAD-A that you will
   **keep** (notes `$M the survivor`). Create a third on JOB-A (notes `$M delete me, job`).
2. Confirm all three are present on their timelines and on the CUST-A roll-up.
3. `DELETE` the lead one and the job one.
4. Re-read the lead timeline, the job timeline and the customer roll-up.
5. `GET /api/communication/calls?limit=50` — confirm non-empty and that **the survivor** is still
   absent from it.

**Expected**
- Both `DELETE`s → **`204`** with an empty body.
- The two deleted entries are gone from **all three** reads.
- **The survivor is still present on the lead timeline and on the customer roll-up.** This is what
  makes the two absences mean something rather than "the timelines broke".
- Step 5: the survivor is still absent from the module's calls list.

**Fail if:** the survivor also disappears; a deleted entry lingers on any of the three; `DELETE`
returns a body.

---

# PART B — STAGING-ONLY

**None of the scenarios below can be run on localhost.** They are the staging checklist. Each says
why it is here.

Run them at `https://servwave-demo.vercel.app` (API `https://alpha-crm-test-env.onrender.com`) after
this branch is deployed, signed in as a demo-org user through the normal login. **Only one runner may
drive the browser at a time** (§1.5). Take a screenshot for every scenario.

Before starting, repeat the §0.3 non-empty rule and the §3 build check against the staging API.

---

### QA-S01 — The "Log communication" button renders for a capability holder

**Why staging:** requires a rendered page; localhost login is closed.
**Covers:** stories 36, 44

**Steps:** as an ADMIN, open a lead detail page, go to the **Communication** tab. Repeat on a job.

**Expected:** a button labelled exactly **`Log communication`** is present on both.
**Fail if:** it is absent for a user who holds the capability.

---

### QA-S02 — It renders for an organisation WITHOUT the phone entitlement

**Why staging:** the demo org has the entitlement and its plan must not be mutated on the shared
database; this needs an organisation whose plan genuinely lacks `phone`.
**Covers:** stories 41, 42

**Steps:** sign in to an organisation whose plan does **not** include `phone` (or which has no phone
number configured), and open a lead's Communication tab.

**Expected:** the **`Log communication`** button is present, while **`Call customer`** and the
composer's **`Send`** are **absent**. The tab itself renders — it is not hidden for non-phone
organisations, and the feature depends on that being true.
**Fail if:** the button is missing, or the page returns a 402/entitlement error. This is the exact
population the feature was built for.

---

### QA-S03 — It renders on a lead with NO customer attached

**Why staging:** requires a rendered page. **And note the fixture problem:** the demo org currently
has **zero** leads with no customer, so this state must be created.
**Covers:** story 43

**Steps:** create a lead with no customer attached (or find one). Open its Communication tab.

**Expected:** the `Log communication` button renders, and the drawer opens and saves. The Log button
must inherit none of the composer's three conditions (phone entitlement, create ability, resolved
customer).
**Fail if:** the button disappears when the lead has no customer.

---

### QA-S04 — It sits beside "Call customer" where that exists

**Why staging:** a layout question a component test cannot settle.
**Covers:** story 44

**Steps:** on a lead **and** a job in a phone-enabled org with a customer who has a phone number,
look at the action row.

**Expected:** `Log communication` and `Call customer` sit **side by side** in the same row, both
equally reachable, neither wrapping awkwardly. Check at a narrow viewport too.
**Fail if:** the buttons stack in a way that hides one, or overflow the container.

---

### QA-S05 — A user WITHOUT the capability sees no button

**Why staging:** the button is the thing being asserted.
**Covers:** story 36

**Steps:** sign in as a SALES user who does **not** hold the capability. Open a lead's Communication
tab.

**Expected:** **no** `Log communication` button. The composer/`Call customer` are unaffected — the
user keeps everything they had. (The endpoint's refusal is already proven by QA-A35.)
**Fail if:** the button renders for a user who cannot use it.

---

### QA-S06 — The empty state names the capability

**Why staging:** rendered copy.
**Covers:** story 45

**Steps:** open the Communication tab of a lead **and** a job with no communications at all, as a
capability holder. Then repeat as a user without the capability.

**Expected:** for the capability holder, the empty state reads
**`Log a past call, text or email to record contact that happened outside ServWave.`**
For the user without it, that line is **absent**.
**Fail if:** the copy still says only "Log a past call" (the pre-slice-6 wording), or it shows to a
user who cannot log.

---

### QA-S07 — The drawer: the channel picker, the per-channel fields, and the date picker

**Why staging:** the drawer has **never been seen rendered**. Several specific things are unverified:
whether the four outcome pills wrap acceptably inside the sheet, how the `type="number"` duration
field behaves with a real browser spinner, and — importantly — the real-browser behaviour of typing
`abc` into a number input (the browser discards it and the value becomes `''`, which is a different
path from the one jsdom exercises).
**Covers:** stories 6, 7, 8, 12, 13, 14, 15

**Steps:** open the drawer and work through it.

**Expected**
- A **Channel** control offering exactly **Call, Text, Email** — and nothing else (no in-person, no
  voicemail-left, no letter, no walk-in, no WhatsApp).
- **Direction** (`Direction *`), **When did it happen?** (`*`), **Notes** (required,
  placeholder `What was discussed?`).
- With **Call** selected: **`How long did it last?`** (optional, hint `In minutes.`) and
  **`How did it go?`** with four pills — Connected, No answer, Voicemail, Callback requested. The
  outcome control is **deselectable** (that is what keeps it optional).
- With **Text** selected: duration and outcome are **gone**.
- With **Email** selected: duration and outcome gone, a **`Subject`** field present with placeholder
  `e.g. Revised scope - two garage doors`.
- **Type notes, then change the channel twice.** The notes and the direction **survive**. (A typed
  subject or duration is deliberately cleared when you leave its channel — that is correct.)
- Save is disabled until direction, occurred-at and notes are all supplied.

**Fail if:** a fourth channel is offered; duration/outcome/subject appear on the wrong channel; a
channel change wipes the notes.

---

### QA-S08 — The performer picker

**Why staging:** rendered control; and the roster behind it differs per role.
**Covers:** story 10

**Steps:** open the drawer as an ADMIN. Then repeat as a non-admin who has been **granted** the
capability.

**Expected**
- One person picker labelled **`Who had the conversation?`**, defaulting to **you** (your own name is
  shown, not the placeholder `Select a colleague…`).
- It lists the organisation's active users and is searchable.
- **There is exactly one person picker in the drawer** — the logger is never selectable.
- **For the granted non-admin the picker is populated, not empty.** This is the check that matters:
  the picker reads its own capability-scoped roster, not the staff directory, and a non-admin cannot
  reach the latter.

**Fail if:** the picker is empty for a granted non-admin; a second person picker appears.

---

### QA-S09 — The hand-entered treatment on a timeline row

**Why staging:** this is the safety-critical rendering of the whole feature and it has **never been
seen**.
**Covers:** stories 11, 24

**Steps:** on a lead timeline holding **both** a hand-logged entry and a real platform
communication, look at both rows. Repeat on a job and on the customer roll-up.

**Expected — on the hand-logged row**
- A muted **`Logged`** chip beside the existing lead/job chips. It is muted grey, **not** the sage
  green used for genuine business state (Approved/Paid) — sage would read as an endorsement.
- The **channel icon carries a small hand-entered overlay**, which has an accessible name (hover for
  a tooltip; check with a screen reader or the accessibility inspector). Per channel it reads
  `Hand-entered, not a recorded call` / `…not a platform text` / `…not a platform email`.
- The meta line reads **`· Logged by <Name>`**, and — only when the performer differs —
  **`· Logged by <A> on behalf of <B>`**. When performer and logger are the same person, the name is
  **not** repeated and `on behalf of` does not appear.

**Expected — on the platform row beside it:** none of the above. **Check this half.** A marker
rendered on everything would pass a one-sided look.

**Also check what a component test cannot:** the meta line can be long
(`Outbound · Doe HVAC · Voicemail · Logged by Firstname Lastname on behalf of Firstname Lastname`
plus chips) on a narrow lead-detail column, where only the first span truncates. **Look for overflow
or chips pushed off the row**, at a narrow viewport and at both light and dark themes. Also confirm
the small overlay badge is legible over each of the channel icons at both themes.

**Known wording defect to confirm rather than discover:** the `Logged` chip's own tooltip is
hardcoded to `Logged by hand - not a recorded call` on **every** channel, so a hand-logged **email**
gets a tooltip claiming it is "not a recorded call". The icon overlay's label is correct per channel;
only the chip's tooltip is not. **Report it if you see it, and mark it known.**

**Fail if:** the two rows are indistinguishable. That is the exact failure the whole design exists to
prevent — someone citing a typed note as though it were a recorded call.

---

### QA-S10 — Inline in chronology, not in a separate section

**Why staging:** a layout property.
**Covers:** story 25

**Steps:** find a lead whose timeline holds hand-logged entries **interleaved in time** with real
communications (create one dated between two real emails if necessary).

**Expected:** the hand-logged row sits in its **true chronological position among the real rows** —
not grouped at the top, not at the bottom, not under a "Logged manually" heading, not on a different
background colour. It belongs in the chronology; it simply must not be mistakable for a recorded
call.
**Fail if:** manual entries are grouped into their own block.

---

### QA-S11 — The Job Overview "Communication History" card marks hand-logged rows ⚠ HIGH ATTENTION

**Why staging:** requires a rendered page.
**Covers:** stories 24, 25

**This was a live defect found late.** The Job Overview page has a **second, direct** consumer of the
job communications endpoint — the *Customer & Contact → Communication History* card — which for two
slices rendered hand-logged entries as ordinary platform touches: no chip, no overlay, no
attribution. On one real job, all three rows the card showed were hand-logged and were
indistinguishable from recorded communications. It has been fixed; **this scenario confirms the fix
on a rendered page, which nobody has done.**

**Steps:** open a **job** whose three most recent communications include at least one hand-logged
entry **and** at least one real platform communication. Look at the Overview tab's *Communication
History* card (it shows the three most recent, with a "View All" link).

**Expected**
- The hand-logged row carries the **`Logged` chip** and the **hand-entered icon overlay** (with its
  accessible name).
- The platform row beside it carries **neither**.
- The card's channel icons are the shared ones — `h-4 w-4`, per-channel tint. They were previously
  smaller and uniformly muted; **look at whether the new size and tint sit well in this compact
  three-row card**, which nobody has checked.
- The card deliberately shows **no per-row attribution line** (it is a compact preview; the full
  timeline behind "View All" carries attribution). Do not report that as a failure.

**Also check, and report separately:** this card's data may be **stale**. Its React Query key is
`['job-communications-preview', jobId]`, which no mutation in the app invalidates, and it has no
refetch interval. **Log a communication on the job and see whether this card updates without a full
page reload.** If it does not, that is a real (pre-existing) freshness bug worth reporting — but it
is *not* a provenance failure.

**Fail if:** a hand-logged row on this card is indistinguishable from a platform row.

---

### QA-S12 — The negative behaviours: no attach menu, no call drawer, no SMS thread, no delivery pill

**Why staging:** all four are click/render behaviours.
**Covers:** the spec's "Not re-attributable" decision, and three defects fixed during the build

Four things must **not** happen. Check each on all three surfaces (lead tab, job tab, customer
roll-up), and in each case check the **platform row beside it still does** the thing — otherwise you
have only proved the surface is broken for everyone.

| # | On a hand-logged row | On the platform row beside it |
| --- | --- | --- |
| a | **No attach / move / detach menu.** The job control renders as a static pill, not a menu; no target list is fetched. | The menu **is** offered. |
| b | **Clicking a hand-logged CALL opens nothing.** No `EntityCallDrawer`, no "Couldn't load this call" dead end. | Clicking a platform call **does** open the call drawer. |
| c | **Clicking a hand-logged TEXT opens nothing.** It must not open the customer's real SMS thread — a thread that cannot contain the logged text. | Clicking a platform text **does** open the thread. |
| d | **A hand-logged outbound EMAIL shows no delivery-status pill** (Delivered / Bounced etc.). A delivery status is a claim about what the platform's mail transport did; a hand-typed record has never been through one. | A platform sent email **does** show its pill. |

**Additionally**, on an **estimate** and an **invoice** page for a customer who has a hand-logged
email: confirm the page's own delivery pill and hard-bounce banner are **not** driven by the
hand-logged email. Log an email whose subject begins with an estimate number (e.g. `Estimate E00042 …`)
and confirm the estimate page ignores it.

> Note: on the **lead and job** tabs, clicking a hand-logged row for which you have edit rights opens
> the **edit drawer** (QA-S15) — that is correct and expected. On the **customer roll-up** it opens
> nothing at all, which is also correct: the roll-up is a pure read-only aggregation and has never
> offered a Log button either.

**Fail if:** any of a–d fires on a hand-logged row, or the platform row beside it stops working.

---

### QA-S13 — The Communication module's rendered views carry nothing hand-logged

**Why staging:** PART A proves the API payloads. This proves the **screens a manager actually looks
at**.
**Covers:** stories 21, 22, 23

**Steps:** with hand-logged calls, texts and emails present in the org, open in turn:
the Communication module's **Calls** view, its **Texts/Threads** view, its **Emails** view, the
**Performance** view, and any **call report**.

**Expected**
- **First, confirm each view is showing real data** — count the rows. An empty view proves nothing
  (§0.3).
- None of them shows a hand-logged entry. Search each view for your marker text.
- Performance's answer rate, average handle time and containment figures are unmoved by a logged
  45-minute "call".

**Fail if:** a hand-logged entry surfaces on any of them.

---

### QA-S14 — The roles page: the sensitive-capability checkbox

**Why staging:** the rendered settings page.
**Covers:** stories 32, 35

**Steps:** as an ADMIN, open **Settings → Roles** and select a role.

**Expected**
- In the **Sensitive** section, alongside **See financial data** and **Record & refund payments**,
  there is a third switch labelled:
  **`Log past communications - hand-record calls, texts and emails that happened outside ServWave`**
- It is **not** a row in the ten-module create/read/update/delete grid, and there is **no**
  `Communication` row in that grid. (Adding one would expose the baseline `create Communication`
  grant as a tickable cell whose unticking would silently revoke click-to-call and outbound texts.)
- For SALES / DISPATCHER / TECHNICIAN the switch opens **unticked**.
- Tick it, **Save**, reload the page: it reads **ticked**. Untick it, Save, reload: **unticked**.
- Toggling it leaves the role's other grants alone — spot-check that `See financial data`,
  `Record & refund payments` and the CRUD grid are unchanged across a full on/off cycle.
- With it ticked, that role's users can log; with it unticked, they cannot. (QA-A36 proves this
  through the API; confirm here that the switch is genuinely wired to it.)

**Fail if:** the switch does not persist across a reload; another grant moves when you toggle it; a
`Communication` row appears in the grid.

---

### QA-S15 — The edit drawer, the delete confirmation, and ★ the performer seed

**Why staging:** rendered form. **This contains the single highest-value staging check in this
document.**
**Covers:** stories 37, 38, 39, 40

**Steps**
1. As the entry's **logger**, click one of your hand-logged rows on a lead or job timeline.
2. As an **org admin who is not the logger**, click somebody else's hand-logged row.
3. As a user who **holds the capability** but is neither the logger nor an admin, look at somebody
   else's hand-logged row.
4. In the editor, press **Delete**.

**Expected**
- 1 and 2 → the drawer opens titled **`Edit logged communication`**, seeded with the entry's stored
  values, the save button reading **`Save changes`**, and a **Delete** button placed at the opposite
  end of the footer from Cancel.
- The **date picker reopens on the organisation's wall clock**, not on a browser-derived reading.
  Check with a browser whose own timezone differs from America/New_York if you can — reopening an
  entry and saving it untouched must be a **no-op**, not a shift of its date.
- The drawer offers an **`Attached to`** picker that moves the entry between a lead and a job. It
  offers **no detach** option — an entry with no anchor is not a state it can be in.
- 3 → **no edit affordance at all** on that row, and clicking it opens nothing. (The API refuses it
  anyway — QA-A38 — so the cost of a bug here is an editor offered that then 403s on save.
  **The job tab's copy of this rule is the one with weaker automated coverage; check the job tab
  specifically.**)
- 4 → a confirmation dialog appears: title **`Delete this logged entry?`**, body
  *"The record of this conversation is removed from the timeline. This cannot be undone."*, a danger
  **Delete** and a cancel. **Declining writes nothing and leaves the editor open.** Confirming
  deletes and the timeline refreshes.

**★ THE PERFORMER SEED — do this one carefully.**
Open an entry whose **performer is somebody other than you** (log one as ADMIN-1 with
`performed_by` = the SALES user, then open it as ADMIN-1 or as ADMIN-2). In the editor, the
**`Who had the conversation?`** picker must show **the entry's performer**, not you. Change only the
notes, save, and re-read the entry: **`performedBy` must be unchanged.**

> **Why this deserves a paragraph.** This is the one attribution rule the **server structurally
> cannot enforce**. A client that seeded the performer from the editing user would send a
> syntactically valid uuid — just the wrong person's — and the API has no way to tell. The failure it
> produces is exactly the one the performer field exists to prevent: an admin opens a colleague's
> entry to fix a typo, and the conversation is silently re-credited to the admin. It is now covered
> by a frontend test, but that test is the *only* possible gate, and no one has ever watched it
> happen on a rendered form.

**Fail if:** the picker shows *you* instead of the entry's performer; saving an unrelated field moves
`performedBy`; delete fires without a confirmation; the third capability holder is offered an editor.

---

### QA-S16 — Automation silence: the POSITIVE control

**Why staging:** see §0.4(2). The demo org cannot supply this, and no amount of localhost work can.
**Covers:** story 30

**Steps**
1. Find or create an organisation that owns a **published workflow whose trigger a manual log could
   plausibly emit**, and confirm that workflow **does** enrol when its trigger fires by some other
   route (that is the positive half — prove the pipe works before asserting it stayed quiet).
2. Record `workflow_enrollments` and `workflow_step_runs` for that organisation.
3. Log **50–100** manual communications in a burst across leads and jobs in that organisation, mixing
   channels and directions.
4. Re-read both counters. Also re-read `notifications` and `notification_recipients`.

**Expected:** **+0 enrolments, +0 step runs, +0 notifications**, against an engine you have just
proved fires for other events.

**Fail if:** anything enrols. An admin backfilling months of history must not trigger a flood of
stale automated actions.

---

## 4. Explicitly out of scope — DO NOT test, DO NOT report as failures

- **The dashboard's needs-followup tile.** It does not exist; see §0.5 / decision D-1.
- **The CTM ingest path's own `contacted_at` behaviour.** The spec's claim that ingest does not write
  the field is **stale** — `lib/ctm/ingest.ts` already calls the shared writer, at two sites. There
  is no gap here and no follow-up issue is needed.
- **Editing or deleting an entry adjusting `contacted_at`.** Deliberately out of scope. An edit is a
  correction to the record of a conversation, not a new conversation, and a delete does not unhappen
  it. Consequences, stated so you are not surprised: an entry corrected from inbound to outbound will
  **not** stamp a never-contacted lead, and one corrected the other way leaves an existing stamp in
  place.
- **The `COMMUNICATION_LOGGED` event surviving a delete.** Deliberate; see QA-A33.
- **The activity event carrying no `metadata`.** Deliberate. Two entries on the same lead with the
  same channel and direction produce two identical descriptions with no link back to the rows. That
  is a known, accepted consequence of the immutable-audit decision.
- **Channels beyond call / text / email.** In-person, voicemail-left, letters and walk-ins are
  explicitly out of scope — they have no slot in the shared timeline-item contract.
- **Bulk or CSV import of historical communications**, and **attachments on an entry.**
- **Re-attributing an entry through the shared row's attach/move/detach menu.** It drives a
  call-record-specific endpoint and is deliberately not extended; moving an entry is done by editing
  it (QA-A34).
- **An edit affordance on the customer roll-up.** The roll-up is the pure read-only aggregation and
  has never offered a Log button either. Offering correction but not creation there would be the
  inconsistent choice.
- **Concurrency.** Two people editing the same entry at once is last-write-wins; there is no
  optimistic-concurrency token, by design and out of scope.
- **The pre-existing fixture rows** described in §1.6.
- **The `role-permission drift check` reporting `TECHNICIAN read Job`.** Pre-existing staging data
  drift, entirely unrelated to this branch.

---

## 5. Story coverage map

All 47 user stories from the spec, with the scenarios that cover them.

| # | Story (abbreviated) | Scenarios |
| --- | --- | --- |
| 1 | Record calls from before we adopted ServWave | A01, A02 |
| 2 | Log a call made from a personal mobile | A01, A15 |
| 3 | Log an email sent from Outlook | A08, A17 |
| 4 | Log a text sent from my own phone | A08, A17 |
| 5 | Log an inbound call on a job | A05, A16 |
| 6 | Choose the channel | A08 · **S07** |
| 7 | Inbound vs outbound | A05 |
| 8 | Backdate the entry | A01, A02 · **S07** |
| 9 | The date I pick means my organisation's date | A02, A03, A31 · **S07, S15** |
| 10 | Name the person who had the conversation | A11, A13 · **S08** |
| 11 | See who logged it as well as who had it | A11, A12, A32 · **S09** |
| 12 | Write freely what was discussed | A01, A04 |
| 13 | Optionally record duration | A09 · **S07** |
| 14 | Optionally record outcome | A10 · **S07** |
| 15 | Optionally record a subject line | A08 · **S07** |
| 16 | Log against a lead | A01, A15 |
| 17 | Log against a job | A16, A26 |
| 18 | Exactly one of lead or job | A06 |
| 19 | Lead entries stay on the lead after conversion | A19 |
| 20 | Appear in the customer roll-up | A18 |
| 21 | Excluded from the Calls view | A15, A16, A17, A18 · **S13** |
| 22 | Excluded from agent performance metrics | A20 · **S13** |
| 23 | Excluded from call reports | A20, A21 · **S13** |
| 24 | Hand-entered records are visually distinct | A15 (data half) · **S09, S11** |
| 25 | The marker is inline, not a separate section | **S10, S11** |
| 26 | An outbound log marks the lead contacted | A22, A26 |
| 27 | First contact wins; never overwritten | A23, A25 |
| 28 | An inbound entry does not mark contacted | A24 |
| 29 | An activity-feed entry is written | A27, A28, A33 |
| 30 | No automations fire | A30 (negative control) · **S16** (positive control) |
| 31 | No notifications are raised | A29, A33 |
| 32 | Control which roles may log | A36, A37 · **S14** |
| 33 | Granted to ADMIN out of the box | A35 |
| 34 | Off for sales, dispatch, technician by default | A35 |
| 35 | The toggle sits among the sensitive capabilities | A36 · **S14** |
| 36 | No capability → no button, and the endpoint refuses | A35 · **S05** |
| 37 | Edit a mistyped entry | A31, A32, A34, A38 · **S15** |
| 38 | Delete an entry logged on the wrong lead | A38, A39 · **S15** |
| 39 | An org admin can edit or delete any entry | A32, A38 · **S15** |
| 40 | I cannot edit entries logged by other people | A38 · **S15** |
| 41 | Works for an org without the Communication module | A07 · **S02** |
| 42 | Works for an org with no phone number configured | A07 · **S02** |
| 43 | Works on a lead with no customer attached | **S03** |
| 44 | The Log button sits alongside Call customer | **S04** |
| 45 | The empty state points at the capability | **S06** |
| 46 | Entries are scoped to my organisation | A13, A14, A38 |
| 47 | Stored apart from platform-recorded calls | A21, A15 |

**Stories with no localhost scenario at all — 43, 44, 45, and 25.** All four are purely about what
renders on a page, and localhost login is closed. They are covered on staging only, by **S03, S04,
S06 and S10** respectively.

**One acceptance criterion has no scenario by decision:** slice 07's "the dashboard's needs-followup
count drops". Struck under D-1 — see §0.5.

---

## 6. Results

For every FAIL, paste the literal response body or on-screen text you saw beside what this document
expected, plus a screenshot for PART B.

### PART A — EXECUTED 2026-08-28 · 41 executions of 39 scenarios · 41 PASS / 0 FAIL / 0 BLOCKED

Run against localhost (backend `:3040`) on commit `0bb1348b8`, by **three independent runners**
working concurrently in the demo org `00000000-0000-0000-0000-000000000001`:

| Runner | Marker | Scenarios | Result |
| --- | --- | --- | --- |
| 1 | `QA1-1787935572` | QA-A01 – QA-A14, plus QA-A15 | 15 PASS |
| 2 | `QA2-1787935579` | QA-A15 – QA-A26 | 12 PASS |
| 3 | `QA3-…` | QA-A27 – QA-A39, plus QA-A15 | 14 PASS |

**QA-A15 was run independently by all three runners as a cross-check**, and all three PASS — each
confirming the module calls list at **17 before and 17 after**. That is why 39 scenarios yield 41
executions.

**Build check (§3), consistent across all three runners:** token length **762** · POST
unauthenticated **401** · GET unknown id **`{"error":"Entry not found"}`** · sms+duration
**400 `a duration belongs to a call`** · module list lengths: calls **17** / threads **11** /
emails **415** / agents **3**. Every absence assertion below was made against a list confirmed
non-empty first.

**Cleanup:** all three runners deleted every row they created and the demo org was returned to its
exact pre-existing fixture count of **109** rows. Runner 3 restored the one role grant it changed
byte-identically, verified by `shasum` + `cmp` + diff.

**Note on `contacted_at`:** several demo-org leads now carry a `contacted_at` written by the feature
under QA-A22 and QA-A25. That is the behaviour under test, not test litter, and it is first-write-wins
so it does not move.

### PART A

| ID | What it proves | PASS / FAIL / SKIPPED / BLOCKED | Evidence |
| --- | --- | --- | --- |
| QA-A01 | create and read back a past call | **PASS** (R1) | 201; channel defaulted "call"; performedBy == loggedBy; re-GET identical |
| QA-A02 | org clock on create | **PASS** (R1) | occurredAt 2026-08-26T20:00:00.000Z from wall clock 16:00 (America/New_York) |
| QA-A03 | a zoned instant is refused | **PASS** (R1) | both zoned forms 400; control 201; exactly 1 row persisted |
| QA-A04 | the three required fields | **PASS** (R1) | all five omissions 400 with quoted messages; 0 rows added; no 500s |
| QA-A05 | inbound and outbound | **PASS** (R1) | titles "Outbound call" / "Inbound call" |
| QA-A06 | exactly one anchor | **PASS** (R1) | both-anchors and neither-anchor 400; job-only control 201 with leadId null |
| QA-A07 | not behind the phone entitlement | **PASS** (R1) | no requireFeature invocation; manual-log mounted app.ts:224, calls at :227 |
| QA-A08 | call / text / email, and the subject | **PASS** (R1) | Outbound text / Outbound email · <subject> / Inbound email; whatsapp+in_person 400 |
| QA-A09 | duration, validation, the 1440 ceiling | **PASS** (R1) | 0/12/1440 accepted; six refusals 400; 2147483648 -> 400 not 500 |
| QA-A10 | the outcome set, and the attempt wording | **PASS** (R1) | no_answer and voicemail both title "Outbound call attempt"; four refusals 400 |
| QA-A11 | performer vs logger, and the roster | **PASS** (R1) | performer != logger; roster 21 users, keys {id,first_name,last_name} only |
| QA-A12 | the logger cannot be named | **PASS** (R1) | POST and PUT both 400 Unrecognized key logged_by; entry unchanged |
| QA-A13 | cross-org performer refused | **PASS** (R1) | 404 Performer not found; 0 rows written; roster excludes the foreign user |
| QA-A14 | cross-org lead / job refused | **PASS** (R1) | 404 Lead not found / Job not found; no 403; nothing leaked |
| QA-A15 | ★ THE PAIR (lead) | **PASS** (R1+R2+R3) | ALL THREE PASS. calls 17 before and 17 after; entry interleaved between real emails; absent by id and marker |
| QA-A16 | ★ THE PAIR (job) | **PASS** (R2) | calls 17->17; jobLabel J00183; leadId null |
| QA-A17 | ★ THE PAIR per channel (text and email) | **PASS** (R2) | threads 11->11, emails 415->415; subject probe absent from both |
| QA-A18 | ★ THE PAIR (customer roll-up) | **PASS** (R2) | roll-up 13->15 with both anchors; calls 17->17; 3 real emails retained |
| QA-A19 | conversion truth | **PASS** (R2) | present on lead and customer; absent from the converted job's 4-item timeline |
| QA-A20 | absent from agent metrics | **PASS** (R2) | /agents byte-identical; durationSec contains neither 45 nor 2700 |
| QA-A21 | stored apart from call records | **PASS** (R2) | manual id -> 404, real call id -> 200; callSession references 0 |
| QA-A22 | contacted-at: outbound fills a null | **PASS** (R2) | L00131 null -> 2026-08-25 14:30:00 (the entry's own instant, not now()) |
| QA-A23 | contacted-at: non-null left alone | **PASS** (R2) | L00004 2025-10-17 03:35:09 unchanged |
| QA-A24 | contacted-at: inbound never writes | **PASS** (R2) | L00134 null -> null; L00005 unchanged |
| QA-A25 | contacted-at: no backwards move | **PASS** (R2) | L00106 -> 2026-08-25 18:00:00; did not rewind to Aug 10 |
| QA-A26 | contacted-at: a job touches no lead | **PASS** (R2) | L00132 null -> null |
| QA-A27 | exactly one activity event on create | **PASS** (R3) | lead feed 9->10, job feed 6->7; exactly +1 each, no cross-bleed |
| QA-A28 | the event names logger and channel | **PASS** (R3) | "Inbound text logged"; creator = ADMIN logger, not the SALES performer |
| QA-A29 | no notification on create | **PASS** (R3) | 20/20 201; notifications 2631->2631, max(created_at) unmoved |
| QA-A30 | no automation (⚠ negative control only) | **PASS** (R3) | NEGATIVE CONTROL ONLY - enrolments 354->354, step runs 352->352; see caveat in §0.5 |
| QA-A31 | edit: full replacement + org clock | **PASS** (R3) | occurredAt 2026-08-20T12:15:00.000Z; duration/outcome cleared; zoned PUT 400 |
| QA-A32 | edit: the logger never changes | **PASS** (R3) | ADMIN-2 edit 200; loggedBy stayed ADMIN-1 |
| QA-A33 | edit/delete write no event, no notification | **PASS** (R3) | 10 PUTs + DELETE wrote no event; the create's event survived the delete (C14) |
| QA-A34 | edit: re-point lead ↔ job | **PASS** (R3) | old anchor cleared on re-point; both/neither 400; cross-org 404 |
| QA-A35 | no capability → refused; ADMIN by default | **PASS** (R3) | all five verbs 403 for SALES, POST 403 for TECH, ADMIN 201; 0 refused writes landed |
| QA-A36 | grant → usable; revoke → refused | **PASS** (R3) | grant diff one line; restore sha256 identical; revoke took (403) |
| QA-A37 | the roster; `read User` not widened | **PASS** (R3) | roster keys {id,first_name,last_name} only; /api/users 403 |
| QA-A38 | logger / admin / third holder, all verbs | **PASS** (R3) | after ADMIN-2 edited SALES's entry, loggedBy stayed SALES |
| QA-A39 | delete disappears from all three timelines | **PASS** (R3) | 204 with 0-byte body; gone from all three timelines; survivor intact |

### PART B (staging)

| ID | What it proves | PASS / FAIL / SKIPPED / BLOCKED | Evidence + screenshot |
| --- | --- | --- | --- |
| QA-S01 | the Log button renders | | |
| QA-S02 | renders without the phone entitlement | | |
| QA-S03 | renders on a lead with no customer | | |
| QA-S04 | sits beside Call customer | | |
| QA-S05 | no capability → no button | | |
| QA-S06 | the empty-state copy | | |
| QA-S07 | the drawer and the channel picker | | |
| QA-S08 | the performer picker | | |
| QA-S09 | the hand-entered treatment on a row | | |
| QA-S10 | inline in chronology | | |
| QA-S11 | ⚠ the Job Overview card marks hand-logged rows | | |
| QA-S12 | the four negative behaviours | | |
| QA-S13 | the module's rendered views are clean | | |
| QA-S14 | the roles page checkbox | | |
| QA-S15 | ★ the editor, delete confirm, performer seed | | |
| QA-S16 | automation silence, positive control | | |

### Records you created or changed

| Marker | Entries created | Entries deleted | Left behind (ids) |
| --- | --- | --- | --- |
| | | | |

| Lead whose `contacted_at` you moved | Before | After |
| --- | --- | --- |
| | | |

| Role grant you changed | Before | Restored byte-identical? |
| --- | --- | --- |
| | | |
