# QA plan - Specs A, B and C (notification ground rules, task automations, staff SMS)

Target environment: **STAGING**, demo organization only.
Written 2026-08-28 against the merged branch `feat/staff-sms`.
Covers PR #1913 (Spec A, issue #1850), PR #1914 (Spec B, #1851), PR #1915 (Spec C, #1852).

There is no pre-existing `docs/qa/` convention in this repo. The closest prior art is
`md_files/plans/notifications/qa-checklist.md` and `md_files/plans/testing/manual-ui-qa-guide.md`;
this document follows their voice (name the rule being tested, then the observable) and adds the
stable IDs, exact literals and pass/fail wording that three parallel agents need.

---

## 0. Character conventions - read this before you copy any string

This document uses **plain hyphens only**. It contains no em dash and no en dash anywhere.

A few strings **in the product** do contain an em dash (U+2014). Reproducing them here would put a
character in this file that the style rule forbids, and transliterating them to a hyphen would make
you search for a string that does not exist and report a false FAIL. So wherever a product string
contains an em dash, this document writes the token `[EM DASH]` in its place.

> When you see `[EM DASH]` inside a quoted product string, substitute one U+2014 character
> (with the surrounding spaces exactly as written) before you search for it.

Product strings that contain other non-ASCII characters are reproduced **as-is**, because those
characters are not forbidden here: the curly apostrophe `’` (U+2019), the ellipsis `…` (U+2026),
the middle dot `·` (U+00B7), the arrow `→` (U+2192). Copy those literally.

---

## 1. The single most important constraint

**Staff SMS cannot send on staging, and this plan is built around that rather than blocked by it.**

The demo org `ServWave Test` (`00000000-0000-0000-0000-000000000001`) is the only org the QA login
reaches. Measured 2026-08-28:

| field | value |
|---|---|
| `ctm_account_id` | set (telephony linked) |
| `ctm_sms_ready` | **false** |
| `sms_sending_enabled` | **false** |
| active users | 21 |
| active users with a phone number | **0** |
| total users (active + inactive) | 24, and **all 24** have `phone` NULL |

`runGates` in `backend/src/lib/ctm/sendSms.ts:109` requires both flags. Every staff text on this org
is therefore blocked before it reaches CTM. **No real text message can be sent by accident.**

That is good for QA, and this plan exploits it in four places:

1. The three organization-gate acceptance criteria of Spec C slice 6 become verifiable for real
   rather than only in unit tests (cases **S3-19** and **S3-20**).
2. "A recipient with no phone number is skipped with a readable reason" is the **default** outcome
   for all 21 active users, so it is free to observe (case **S3-19**).
3. 21 of 21 active users show the missing-phone badge, so slice 4's badge and filter have a perfect
   fixture, and the counts differ per status pill (21 active / 24 all / 3 inactive), which makes the
   composition test genuinely discriminating (cases **S3-01** to **S3-03**).
4. `capabilities.sms_available` is **false** for this org, so the "Send text" step is locked in the
   builder with its badge and tooltip, and the gallery hides its four SMS recipes. Both are real,
   observable behaviour here (cases **S3-16** and **S1-21**).

**There is no safe partial flip.** `smsAvailable()` (`backend/src/controllers/workflow.controller.ts:263`)
and `runGates` read the *same two flags*. You cannot unlock the builder without also unlocking real
sending. Anything that needs those flags on is in **Appendix A** and must not be run casually.

---

## 2. Known issues - do NOT file any of these as new bugs

Three agents will each meet these. State them in your report as "confirmed, known"; do not open an
issue, and do not spend budget re-deriving them.

1. **The staff compose/reply split.** An admin composing a text to a technician's mobile from
   Communication gets a Conversations thread; that technician's reply now lands in the **Team** lane,
   whose composer is disabled. So the admin can see the reply and cannot answer it. This is a
   **known open decision awaiting the repo owner**, written up in PR #1915 under "A known behaviour
   regression, and it is an OPEN DECISION rather than a settled cost". Confirm the behaviour, do not
   file it.
2. **An inbound staff reply bumps the SMS unread badge.** The unread aggregate does not filter by
   thread kind. Accepted decision, deliberately left alone.
3. **Staff messages carry neither `job_id` nor `job_label`,** so a staff thread is org-wide visible.
   Deliberate; it is the honest trade against a thread whose visibility flickers per viewer.
4. **Issue #1882** - `workflows.trigger_count` and `last_triggered_at` are written only when a step
   run resolves SENT, so a run whose every send is SKIPPED leaves the list counters untouched.
   **Already filed.** You will hit this constantly in this plan, because almost every run you
   trigger will skip. Assert on the **Activity tab / `workflow_step_runs`**, never on the list-level
   trigger counter.
5. **Follow-ups already recorded** (from `FOLLOWUPS.md`), all known, none a new finding:
   - **A-F1** `capabilities.sms_available` gallery gating lost its only component-level test when
     the unrouted v1 `WorkflowsHome` was deleted. The behaviour still works - cases **S1-03** and
     **S1-21** are now the manual check for it.
   - **A-F2** A legacy in-app step's node in the builder spine reads "Set up this step..." because
     `stepSentence` falls through to UNCONFIGURED. Cosmetic; expected in case **S1-22**.
   - **A-F3** Five files carry prose citations to `NotifyTeamForm.tsx` / `WorkflowsHome.tsx`, both
     deleted. Comments and story prose only.
   - **A-F4** `retired-in-app-step-references.test.ts` greps `.ts/.tsx/.prisma/.sql` only, not
     markdown.
   - **A-F5** Trigger-level config schemas still push raw zod copy, so an admin can see
     "Number must be less than or equal to 129600" for `trigger_config.offset_minutes`.
   - **B-F1** (major, deployment ordering) The date-anchor scan queries the full
     `DATE_ANCHORED_TRIGGERS` set; against a database whose enum lacks `TASK_DATE_ANCHORED` it throws
     22P02 every tick and stops job/lead/invoice/estimate reminders too. Staging **has** all five
     labels, so the window is closed here. Case **S2-21** is the standing check that it stayed closed.
   - **B-F2** `seedDefaultAutomationsForOrg` aborts the whole run on the first failure rather than
     isolating per entry.
   - **B-F3** `creator` is offered on `TASK_CREATED`, where under Rule 0 it is always the acting user,
     so an automation built on it always skips. Expected in case **S2-02**.
   - **B-F4** The catalog still serves the legacy entity-blind `actions[].recipients` alongside the
     per-entity `audiences` map the builder actually reads. Expected in case **S1-01**.
   - **B-F5** The trigger sentence reads "When task is created", dropping the indefinite article
     every other entity has. Cosmetic; expected in case **S2-01**.
6. **Spec A slice 6 AC2 is formally WAIVED and deliberately inverted.** The write DTO spans the
   storage enum on purpose, so a draft holding a retired in-app step still saves. Case **S1-09**
   asserts the **opposite** of what the slice file says. A 200 there is a PASS. See `DECISIONS.md`
   and the comment at `backend/src/controllers/workflow.controller.ts:66-70`.
7. **Spec C slice-file text for story 5 is stale.** "Text a technician when they are assigned a task"
   was recorded as deferred because tasks were not yet an automation entity. PR B landed that, so the
   story IS delivered. Do not report it as a gap.

---

## 3. Test evidence already established - cite, do not re-run

Do **not** run any test suite. These numbers are established and are the baseline for this pass:

- backend: **553 files, 9810 tests, passing**
- frontend: **620 files, 6632 tests, zero failures**
- backend `tsc --noEmit`: **exactly 4 pre-existing errors**, unchanged by all three branches, all in
  untouched test files
- frontend `tsc -b --force`: **clean**
- `npx prisma validate`: passes
- All three PRs merged with **full CI green**, including the Database job (migrations + RLS) on
  vanilla Postgres

Known noise, so nobody reports it as a regression: a full backend suite run on a loaded machine shows
one flaky failure per run, in a different unrelated file each time and never a file in these diffs,
always green in isolation. That is the `VITEST_MAX_WORKERS` load hazard, not a defect.

---

## 4. Environment, access, and how to log in

### 4.1 URLs

| | |
|---|---|
| Staging frontend | `https://servwave-demo.vercel.app` |
| Staging backend API | `https://alpha-crm-test-env.onrender.com` |
| Staging Supabase project ref | `knriiqdqxgfoecsfarlx` |

There is **no `/v2` URL prefix**. `v2Path()` (`frontend/src/pages/v2/uiV2.ts:66-68`) is a documented
no-op shim. Several docblocks still say `/v2/automations`; those comments are stale. The real paths
are bare: `/automations`, `/tasks`, `/settings/users`, `/communication/text`.

### 4.2 Confirm the deploy before you test anything

The reliable detector is the Sentry release banner, which carries the exact commit SHA. Do **not**
use a feature-string grep of the index bundle (the app is code-split, so feature strings live in
lazily loaded chunks). Do **not** use a 401-vs-404 probe on the staging backend, which runs auth
ahead of routing and returns 401 for routes that have never existed.

```bash
idx=$(curl -s https://servwave-demo.vercel.app/ \
  | grep -o '/assets/index-[A-Za-z0-9_-]*\.js' | head -1)
curl -s "https://servwave-demo.vercel.app$idx" \
  | grep -o 'SENTRY_RELEASE={id:"[a-f0-9]*"' | head -1
```

**Expected:** `2cc3126600d90af2e92ca6e3d0fc239f429bef08` - the merge commit of PR #1915
(`2cc312660 Merge pull request #1915 from ranro1/feat/staff-sms`). Any *later* SHA is also fine as
long as it is a descendant; check with `git merge-base --is-ancestor <sha> origin/staging`, never
string equality. If the SHA is an ancestor of `2cc312660` but not equal to it, **stop** - the
frontend has not deployed and every browser case below will fail for the wrong reason.

### 4.3 Log in (password-free, demo org only)

The script is **untracked** and lives only in the main checkout. It is absent from every worktree.

```bash
cd /Users/ranroffe/ALPHA_CRM/alpha_crm
node scripts/qa-session.mjs staging --session --inject
```

Rules that each cost somebody a wrong diagnosis before:

- Use plain `node` (resolves to `/opt/homebrew/bin/node`). A versioned Homebrew path such as
  `/opt/homebrew/opt/node@22/bin/node` contains an `@`, and the script picks its email argument with
  `argv.find(a => a.includes('@'))` - so the **node binary path** is passed as the email and it dies
  with `generate_link failed: Unable to validate email address: invalid format`, which reads like a
  bad user. **Node 22 or later is required** (`@supabase/supabase-js` needs a native WebSocket).
- Run it from the **main checkout**, not from a worktree.
- **Never follow the printed magic link.** Staging's Supabase Site URL points at the *production*
  frontend, and Supabase silently overrides any non-allowlisted `redirectTo`, so the link logs you
  into **production**. Use the `--inject` snippet instead.

The run writes `/Users/ranroffe/ALPHA_CRM/alpha_crm/.qa-session-staging.json` and prints a one-line
`localStorage.setItem(...)` snippet.

**Browser login:** run that snippet through the browser JavaScript tool while on
`https://servwave-demo.vercel.app`. The storage key is `sb-knriiqdqxgfoecsfarlx-auth-token` and the
value is plain JSON (no `base64-` prefix on auth-js 2.111). The snippet ends in `location.replace('/')`,
so the app picks the session up on load. Note: the JS tool is permitted in a main session context but
was refused inside a subagent on 2026-08-27 - if you are a subagent and it is refused, ask the parent
to inject, or fall back to the API path.

**API login:** the bearer token is `.session.access_token` in that file.

```bash
TOKEN=$(jq -r .session.access_token /Users/ranroffe/ALPHA_CRM/alpha_crm/.qa-session-staging.json)
curl -s -H "Authorization: Bearer $TOKEN" \
  https://alpha-crm-test-env.onrender.com/api/auth/me | jq
```

**Expected:** HTTP 200 with `org_is_demo: true`. If that field is not `true`, **stop immediately** -
you are not in the demo org and nothing in this plan is safe to run.

### 4.4 The session expires in one hour

The script prints `expires:` as an ISO timestamp. When a call starts returning 401, re-mint:

```bash
cd /Users/ranroffe/ALPHA_CRM/alpha_crm && node scripts/qa-session.mjs staging --session --inject
```

Re-minting **overwrites** `.qa-session-staging.json`, so re-read the file after any re-mint. Two
notes for three concurrent agents:

- Re-minting invalidates any **unconsumed magic link**, because GoTrue keeps a single live magiclink
  token per user. It does **not** invalidate an already-verified session, so a bearer token another
  agent copied earlier keeps working until its own expiry. Re-minting is therefore safe to do
  independently.
- Do not all re-mint at the same moment. Announce it, or let whichever agent hits a 401 first do it
  and tell the others to re-read the file.

The app also registers a service worker. If a build looks stale, unregister it and clear caches.

### 4.5 SQL access

Use the Supabase MCP tool `execute_sql` against project **`knriiqdqxgfoecsfarlx`**.

**Read-only by default.** The only writes this plan sanctions outside Appendix A are:
- workflows, workflow steps, tasks and task comments **created through the product API** by the
  stream that owns them, each name-prefixed (section 6.3);
- exactly one deliberate `UPDATE users SET phone = ...` fixture in case **S3-11**, with a mandated
  restore in the same case.

Never `DELETE` a user, never `purgeOrganization`, never touch the org row's `ctm_*` or
`sms_sending_enabled` columns outside Appendix A.

---

## 5. Fixtures verified to exist on staging (measured 2026-08-28)

Re-confirm each before you build steps on it. The verification query is given with each one.

### 5.1 The Team lane is already non-empty (Spec C's most valuable fixture)

The demo **seed** already writes one team thread. Nothing at runtime does, but the seed does, so
Spec C's new Team lane, its meta line, its info panel and its disabled composer are all QA-able
**without sending anything**.

```sql
select id, kind, campaign_type, title, customer_id, lead_id, vendor_id, user_id
from message_threads
where id = '5709527f-0b1b-46ba-baba-db44b7294ba4';
```

**Expected:** exactly one row - `kind='team'`, `campaign_type='tech_ops'`, `title='Dispatch desk'`,
`customer_id`/`lead_id`/`vendor_id` all NULL, `user_id` NULL, created 2026-06-01.

This also refutes a risk claim in the slice files: the team branches have been rendering against this
row since June, so they are not unexercised.

### 5.2 The legacy in-app step fixtures (Spec A)

```sql
select w.id, w.name, w.status::text, w.is_enabled, ws.position, ws.step_type::text
from workflow_steps ws join workflows w on w.id = ws.workflow_id
where w.organization_id = '00000000-0000-0000-0000-000000000001'
  and ws.step_type = 'NOTIFY_TEAM'
order by w.name;
```

**Expected:** three rows, all `position = 0`.

| workflow id | name | status | enabled |
|---|---|---|---|
| `98acb281-0217-4d06-a5f9-285b75f95d8d` | QA-negative: notify-team customer channel-narrow | DRAFT | false |
| `38ab9f92-41e8-44fc-8550-b55c7a797680` | QA: Job scheduled multi-recipient notify | DRAFT | false |
| `5de2013b-08b3-41c7-ab6e-b3f99dccc763` | Sub-status test: Awaiting Parts | **PUBLISHED** | **true** |

The third is the valuable one: it is a **published, enabled** workflow on trigger
`JOB_SUB_STATUS_ENTERED` with `trigger_config.sub_status_id = '307a9d7a-95f7-44a4-8688-14e67f9f94c0'`
("Awaiting Parts"), and its published version `b7a015e4-342d-43b9-b8e4-355f55d2f0cf` carries
`NOTIFY_TEAM` in its frozen definition. Moving a job into that sub-status fires a real run through a
real retired step.

**Do not edit or delete any of these three.** They are read-only fixtures. Cases **S1-06** to
**S1-09** build their own throwaway workflow instead.

There are also two step runs already on record:

```sql
select wsr.step_type::text, wsr.status::text, wsr.detail, wsr.created_at
from workflow_step_runs wsr join workflow_enrollments we on we.id = wsr.enrollment_id
where we.organization_id = '00000000-0000-0000-0000-000000000001'
  and wsr.step_type = 'NOTIFY_TEAM' order by wsr.created_at desc;
```

**Expected:** two rows -
one `SKIPPED` (2026-08-28) with detail `In-app notifications now come from the bell - this step no longer sends.`,
and one **historical** `SENT` (2026-08-05) with detail `Job J00229 entered sub-status: Awaiting Parts`.
The historical row is the fixture for case **S1-23**.

### 5.3 The five task trigger enum labels and the thread user column

```sql
select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
where t.typname = 'AutomationTriggerType' and e.enumlabel like 'TASK%'
order by e.enumsortorder;

select column_name, data_type, is_nullable from information_schema.columns
where table_name = 'message_threads' and column_name = 'user_id';
```

**Expected:** `TASK_CREATED`, `TASK_ASSIGNED`, `TASK_COMMENT_ADDED`, `TASK_DELETED`,
`TASK_DATE_ANCHORED`; and `user_id | uuid | YES`. All six migrations are applied.

### 5.4 The five seeded task defaults are NOT present

```sql
select builtin_key, trigger_type::text, is_enabled, status::text
from workflows
where organization_id = '00000000-0000-0000-0000-000000000001'
  and trigger_type::text like 'TASK%';
```

**Expected: zero rows.** `seedDefaultAutomationsForOrg` has exactly one non-test caller (an operator
script) and nothing calls it on deploy, so the five defaults exist in the **registry** and not in the
**database**. Case **S2-22** verifies the registry with a safe `--dry-run`; the row-level criteria
are in **Appendix A.2**.

### 5.5 Task and user population

```sql
select count(*) total, count(*) filter (where status::text not in ('DONE','CANCELLED')) open,
       count(*) filter (where status::text not in ('DONE','CANCELLED') and due_at is not null) open_with_due
from tasks where organization_id = '00000000-0000-0000-0000-000000000001';
```

**Expected:** 46 / 31 / 25. Every demo task has exactly **one** assignee and one or two watchers, and
**every due date is in the past**. So Spec B's multi-assignee and future-due cases need fixtures that
Stream 2 creates; do not expect to find them.

```sql
select count(*) filter (where is_active) active,
       count(*) filter (where is_active and phone is not null and phone <> '') active_with_phone,
       count(*) total
from users where organization_id = '00000000-0000-0000-0000-000000000001';
```

**Expected:** 21 / 0 / 24.

### 5.6 Users you must not touch

| user | id | why |
|---|---|---|
| `admin@alphacrm.com` (System Admin, ADMIN) | `b3ce980d-2d9b-4492-9cb5-bc7ea422e35f` | this is the QA login itself, and the **actor** for every Rule 0 case |
| `ranro3@gmail.com` (Ran Test, TECHNICIAN) | `f858c3b9-22d3-4b75-98c0-8108085a826c` | **real inbox** |
| `doca1sols@gmail.com` (Ran Privacy Test, TECHNICIAN) | `5e63942b-0199-49a3-830b-2f65cb27c172` | **real inbox** |

Everyone else is on a non-routable domain (`@emanuel-demo.local`, `@qa.servwave.test`,
`@alphacrm.com`, `@example.com`). **Address every fixture you create to a non-routable user.** The
recommended default recipient is **Mike Alvarez, `tech_mike@emanuel-demo.local`,
`0492f10b-5985-4045-ab81-a0cf48386b72`** (TECHNICIAN, active, no phone).

A send to a `.local` address may be rejected by the mail provider and record a `FAILED` step. That is
expected and is **not** the thing under test in any Spec B case; every expected result below is
written so a provider failure does not change the verdict.

---

## 6. How to split this into three streams

### 6.1 The streams

| Stream | Owns | Cases | Browser need |
|---|---|---|---|
| **Stream 1** | Spec A end to end, plus Spec C slice 1 (publish legality of a staff-addressed text step) | **S1-01 to S1-23** (23) | Moderate. Window 1. |
| **Stream 2** | Spec B end to end, plus Spec C slice 5 (thread model and API) | **S2-01 to S2-30** (30) | Light. Window 3. |
| **Stream 3** | Spec C slices 2, 3, 4, 6, 7, 8 (phone capture, inbox lanes, executor, builder) | **S3-01 to S3-26** (26) | Heavy. Window 2. |

79 test cases plus two shared preamble steps (**P-01**, **P-02**) that every stream runs first.

Spec C slice 1 goes to Stream 1 because it is a workflow-**validation** surface and Stream 1 already
owns validation. Spec C slice 5 goes to Stream 2 because it is a schema/SQL surface and Stream 2 is
the SQL-heavy stream. That keeps the three loads within three cases of each other.

### 6.2 The browser pane is a single shared resource

**Two QA agents launched together will fight over the one in-app browser pane.** A sibling agent can
knock your page out from under you mid-assertion, and the failure looks like a product bug. So the
browser is held by **exactly one stream at a time**, in this order:

```
Window 1   Stream 1 holds the browser.   Streams 2 and 3 do API/SQL work only.
Window 2   Stream 3 holds the browser.   Streams 1 and 2 do API/SQL work only.
Window 3   Stream 2 holds the browser.   Streams 1 and 3 do API/SQL work only.
```

Every browser case lives inside a block marked `[BROWSER WINDOW]`. Nothing outside such a block
touches the browser.

Streams 1 and 2 put **all of their API and SQL cases first** and their browser block last, so they
have useful work to do while another stream holds the pane.

**Stream 3 is deliberately the other way round** - its browser blocks come first (sections 10.1 to
10.3) and its API and SQL cases last (section 10.4). That is not an oversight: **S3-01** to **S3-03**
assert the missing-phone counts, and every later Stream 3 case writes a phone number, so the counting
cases must run before Stream 3 does anything else at all. Stream 3 therefore takes the **second**
window rather than the last, and has little API work it can usefully do before it. If the schedule
slips, give Stream 3 the browser ahead of Stream 2 rather than making it wait.

Handoff is explicit, not assumed. The holder announces `BROWSER RELEASED` when its block is finished
or when it has to stop; the next stream does not open a tab until it sees that. If a stream finishes
its API work before its window opens, it waits - it does **not** start browser work early.

If your harness genuinely gives each agent its own isolated browser, the windows are unnecessary and
all three can run in parallel. Confirm that before assuming it.

### 6.3 Non-overlapping records

Every artefact you create must be name-prefixed with your stream tag, so three agents never argue
about whose row a thing is:

| Stream | Prefix for every workflow, task and thread it creates |
|---|---|
| Stream 1 | `QA-A-` |
| Stream 2 | `QA-B-` |
| Stream 3 | `QA-C-` |

Exclusive ownership, to prevent cross-stream interference:

- **Users.** Only **Stream 3** writes a user row, and only these three:
  Mike Turner `873b8561-7e50-4163-8265-2d510fca9188` (`mike.turner@alphacrm.com`),
  Mike Rivera `7928f4b3-e227-4154-bff6-f3433f31c4e5` (`tech@alphacrm.com`),
  QA SALES `8cfd0dac-b890-468e-bc32-81c460121cad` (`qa.sales@qa.servwave.test`).
  Streams 1 and 2 must not change any user's phone, name, role or active flag. This matters: the
  missing-phone counts in **S3-01** to **S3-03** are only stable because nobody else writes a phone.
- **Tasks and task comments.** Only **Stream 2** creates, edits, comments on or deletes tasks.
- **Estimates and jobs.** Only **Stream 1** approves an estimate or moves a job's sub-status.
- **The three `NOTIFY_TEAM` fixture workflows** (section 5.2) are read-only for everyone.
- **The `Dispatch desk` thread** `5709527f-...` is read-only for everyone.
- **Existing seeded defaults** (`default-*` builtin keys) must not be toggled or edited by anyone,
  except where a case explicitly says so and restores it.

### 6.4 Ordering constraint inside Stream 3

**S3-01, S3-02 and S3-03 must run before any other Stream 3 case**, because they assert the
missing-phone counts (21 / 24 / 3) and every later Stream 3 case writes a phone number. Once a phone
is written the counts drift by one per user. Stream 3's own cleanup step **S3-26** restores all three
user rows to `phone = NULL`, `phone_ext = NULL`.

### 6.5 Cleanup

Each stream deletes the workflows and tasks it created, by its prefix, at the end of its run. Report
anything you could not clean up. Do not delete anything you did not create.

---

## 7. Preamble - every stream runs these two first

### P-01 - Confirm the staging deploy is the merged code
- **How:** shell
- **Steps:** run the two commands in section 4.2.
- **Expected:** the SHA is `2cc3126600d90af2e92ca6e3d0fc239f429bef08`, or a descendant of it
  (`git merge-base --is-ancestor 2cc312660 <sha>` from a checkout with `origin/staging` fetched).
- **PASS/FAIL:** FAIL and stop the whole run if the SHA is not that commit or a descendant.

### P-02 - Mint a session and confirm the demo-org scope guard
- **How:** shell + API
- **Steps:** run the commands in sections 4.3 and 4.4.
- **Expected:** `/api/auth/me` returns HTTP 200 and the body contains `org_is_demo: true` and
  organization id `00000000-0000-0000-0000-000000000001`.
- **PASS/FAIL:** FAIL and stop the whole run on any other organization id.

Throughout, `$TOKEN` means the bearer from P-02 and `$API` means
`https://alpha-crm-test-env.onrender.com`.

---

## 8. STREAM 1 - Spec A, plus Spec C slice 1

### 8.1 API and SQL cases (run these outside your browser window)

---

#### S1-01 - The catalog serves two actions and no in-app action
- **Traces to:** Spec A slice 5, AC3
- **How:** API
- **Preconditions:** P-01, P-02
- **Steps:**
  1. `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/catalog" | jq '.actions | keys'`
  2. `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/catalog" | jq '[.audiences | to_entries[] | .value | keys] | flatten | unique'`
- **Expected:**
  - Step 1 returns exactly `["SEND_EMAIL","SEND_SMS"]`. `NOTIFY_TEAM` is absent.
  - Step 2 returns exactly `["SEND_EMAIL","SEND_SMS"]` - no trigger carries an audience list keyed to
    the retired action.
  - `.actions.SEND_EMAIL.label` is `Send an email`; `.actions.SEND_SMS.label` is `Send a text message`.
- **PASS/FAIL:** FAIL if `NOTIFY_TEAM` appears as a key anywhere under `.actions` or `.audiences`.
- **Note:** `.actions.SEND_SMS.recipients` is still the legacy `["customer"]` and
  `.actions.SEND_EMAIL.recipients` still includes `customer`. That is **B-F4** and is **expected** -
  the builder reads `.audiences`, not `.actions[].recipients`. Do not file it.

---

#### S1-02 - `capabilities.sms_available` is false for this org
- **Traces to:** Spec A slice 5 (gallery gating, follow-up A-F1); precondition for S1-21 and S3-16
- **How:** API
- **Steps:** `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/catalog" | jq '.capabilities'`
- **Expected:** `{"sms_available": false}`
- **PASS/FAIL:** FAIL if `true`. If it is `true`, someone has flipped the org flags - **stop and
  escalate**, because real SMS is now possible and several cases in this plan become unsafe.

---

#### S1-03 - The gallery holds 14 templates, none installs an in-app step, and 4 are hidden here
- **Traces to:** Spec A slice 5, AC2; follow-up A-F1
- **How:** API (browser half is S1-16)
- **Steps:**
  1. `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/catalog" | jq '.templates | length'`
  2. `... | jq '[.templates[] | .action_type] | group_by(.) | map({(.[0]): length}) | add'`
  3. `... | jq '[.templates[] | select(.action_type=="SEND_SMS") | .key]'`
- **Expected:**
  1. `14`. **Not eleven.** The PR body's "eleven templates remain" counted the moment slice 5 landed;
     Spec B slice 7 then added three task recipes on the same branch line. 11 + 3 = 14.
  2. `{"SEND_EMAIL": 10, "SEND_SMS": 4}`. **No `NOTIFY_TEAM` key at all.**
  3. exactly `["reminder-24h","reminder-1h","job-rescheduled-notice","review-request"]`
- **PASS/FAIL:** FAIL if any template has `action_type` `NOTIFY_TEAM`, or if the total is not 14.
- **Note:** the three task recipes are `task-due-soon-reminder` ("Task due tomorrow"),
  `task-overdue-chase` ("Overdue task chase") and `task-comment-notice` ("Task comment notice"), all
  category `team`. Stream 2 checks their content in **S2-21**.

---

#### S1-04 - A workflow holding a legacy in-app step returns 200 with a validation issue, not a 500
- **Traces to:** Spec A slice 3, AC2
- **How:** API
- **Preconditions:** fixture 5.2 confirmed
- **Steps:**
  1. `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$API/api/workflows"`
  2. For each of the three fixture ids, `curl -s -w '\n%{http_code}\n' -H "Authorization: Bearer $TOKEN" "$API/api/workflows/<id>"`
- **Expected:** step 1 returns `200`. Each detail call returns `200` and its body carries an
  `issues` array containing an entry with `step_index: 0` and `path: "step_type"`.
- **PASS/FAIL:** FAIL on any `500`. FAIL if the detail body has no `issues` entry for the retired step.

---

#### S1-05 - The validation issue is product copy naming the step's position
- **Traces to:** Spec A slice 3, AC3; Spec A slice 5, AC4
- **How:** API
- **Steps:** `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/5de2013b-08b3-41c7-ab6e-b3f99dccc763" | jq -r '.issues[] | select(.path=="step_type") | .message'`
- **Expected, byte for byte** (the step sits at position 0, so it renders as Step **1**):

  `Step 1 no longer sends. In-app notifications now come from the bell, so remove this step to publish this automation.`

- **PASS/FAIL:** FAIL if the message names an internal type name, if it reads
  `This step is no longer supported. Remove it and choose a different action.` (that is
  `UNSUPPORTED_STEP_MESSAGE`, the generic copy, and the in-app rejection must win over it), or if the
  position is wrong.
- **Source:** `retiredInAppStepMessage()` at `backend/src/services/automations/workflowValidation.ts:328`,
  emitted at `:577` at the very top of `validateStep`, ahead of the schema lookup.

---

#### S1-06 - Validation continues past the unrecognised step
- **Traces to:** Spec A slice 3, AC4
- **How:** API
- **Steps:**
  1. Create a throwaway workflow with **three** steps: a `NOTIFY_TEAM` step at index 0, a
     deliberately invalid `SEND_EMAIL` at index 1 (empty `recipients`), and a valid `WAIT` at index 2.

     ```bash
     curl -s -X POST "$API/api/workflows" -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{
         "name":"QA-A-multi-issue","trigger_type":"JOB_SCHEDULED",
         "steps":[
           {"step_type":"NOTIFY_TEAM","config":{"recipients":["all_admins"],"body":"x"}},
           {"step_type":"SEND_EMAIL","config":{"recipients":[],"subject":"s","body":"b"}},
           {"step_type":"WAIT","config":{"offset_minutes":60}}
         ]}'
     ```
  2. `GET $API/api/workflows/<new id>` and read `.issues`.
- **Expected:** `issues` contains **both** an entry with `step_index: 0` carrying the retirement
  sentence from S1-05, **and** at least one entry with `step_index: 1`. Validation did not stop at
  the unrecognised step.
- **PASS/FAIL:** FAIL if only `step_index: 0` is reported.
- **Cleanup:** keep this workflow for S1-07, S1-08 and S1-09; delete it at the end.

---

#### S1-07 - Publishing a workflow with an in-app step returns 400 with the named position
- **Traces to:** Spec A slice 5, AC4 and AC5
- **How:** API
- **Preconditions:** S1-06's `QA-A-multi-issue` exists
- **Steps:**
  1. Create a clean two-step workflow: a valid `SEND_EMAIL` at index 0 and a `NOTIFY_TEAM` at index 1.

     ```bash
     curl -s -X POST "$API/api/workflows" -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{
         "name":"QA-A-publish-gate","trigger_type":"JOB_SCHEDULED",
         "steps":[
           {"step_type":"SEND_EMAIL","config":{"recipients":["all_admins"],"subject":"QA","body":"QA"}},
           {"step_type":"NOTIFY_TEAM","config":{"recipients":["all_admins"],"body":"QA"}}
         ]}'
     ```
  2. `curl -s -w '\n%{http_code}\n' -X POST "$API/api/workflows/<id>/publish" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'`
- **Expected:** HTTP **400**, body `error` is `This automation isn't ready to publish`, and `issues`
  contains exactly one entry with `step_index: 1`, `path: "step_type"`, message

  `Step 2 no longer sends. In-app notifications now come from the bell, so remove this step to publish this automation.`

- **PASS/FAIL:** FAIL on any 2xx. FAIL if the message says "Step 1" (the position must follow the
  step's real index). FAIL if the generic `UNSUPPORTED_STEP_MESSAGE` appears instead - the in-app
  rejection must win over both the generic message and any schema parse failure for the same step.

---

#### S1-08 - Deleting the in-app step publishes the same workflow with nothing else changed
- **Traces to:** Spec A slice 5, AC6
- **How:** API
- **Preconditions:** S1-07's `QA-A-publish-gate` exists and is refusing to publish
- **Steps:**
  1. `PATCH $API/api/workflows/<id>` with `{"steps":[{"step_type":"SEND_EMAIL","config":{"recipients":["all_admins"],"subject":"QA","body":"QA"}}]}` -
     the same email step, verbatim, with the in-app step removed and **nothing else touched**.
  2. `POST $API/api/workflows/<id>/publish` with `{}`.
- **Expected:** step 1 returns 200. Step 2 returns **200** and the workflow's `status` reads
  `PUBLISHED`.
- **PASS/FAIL:** FAIL if publish still 400s, or if it required any change beyond deleting the step.
- **Cleanup:** leave it published for now; delete at the end of the stream.

---

#### S1-09 - The draft write tier still ACCEPTS the retired label (WAIVED AC2, deliberately inverted)
- **Traces to:** Spec A slice 6, AC2 - **formally waived**, see `DECISIONS.md` and PR #1913
- **How:** API
- **Steps:**
  1. `POST $API/api/workflows` with a single `NOTIFY_TEAM` step (the body from S1-07 step 1 works).
  2. `PATCH` that workflow, re-sending the same `NOTIFY_TEAM` step verbatim, exactly as the builder's
     autosave does.
- **Expected:** **both return 2xx and the row persists.**
- **PASS/FAIL:** **A 400 here is a FAIL, not a pass.** The slice file asks for a 400; that criterion
  was waived because narrowing the write DTO broke editing on any workflow already holding a legacy
  step, and surfaced as a raw zod enum dump on a page the admin did not ask to change. Publish is the
  single enforcement door (S1-07). If you get a 400, report it as a **regression against the waiver**
  and cite `backend/src/controllers/workflow.controller.ts:66-70`.
- **Cleanup:** delete this workflow.

---

#### S1-10 - Rule 0 in the engine: approving your own estimate sends no creator email
- **Traces to:** Spec A slice 2, AC5
- **How:** API to act, SQL and browser (S1-19) to observe
- **Preconditions:** the seeded default `default-estimate-approved-notify-creator` is PUBLISHED and
  ENABLED on this org. Confirm:

  ```sql
  select builtin_key, status::text, is_enabled from workflows
  where organization_id='00000000-0000-0000-0000-000000000001'
    and builtin_key='default-estimate-approved-notify-creator';
  ```

  Expected: `PUBLISHED`, `is_enabled = true`. If it is not enabled, **do not enable it** - record this
  case as BLOCKED and move on.
- **Steps:**
  1. Find or create an estimate whose `created_by` is the QA admin
     `b3ce980d-2d9b-4492-9cb5-bc7ea422e35f`:
     `select id, estimate_number, status::text from estimates where organization_id='00000000-0000-0000-0000-000000000001' and created_by='b3ce980d-2d9b-4492-9cb5-bc7ea422e35f' order by created_at desc limit 5;`
     If none exists, create one through the product as the QA admin and name it `QA-A-rule0`.
  2. Approve it **as the QA admin** (the same user who created it).
  3. Wait for the poller, then read the run:

     ```sql
     select we.id, we.status::text, wsr.status::text, wsr.detail, wsr.recipient_summary
     from workflow_enrollments we
     join workflows w on w.id = we.workflow_id
     left join workflow_step_runs wsr on wsr.enrollment_id = we.id
     where w.builtin_key = 'default-estimate-approved-notify-creator'
       and we.organization_id = '00000000-0000-0000-0000-000000000001'
     order by we.created_at desc limit 5;
     ```
- **Expected:** an enrollment exists, and its step run is **`SKIPPED`** with a human-readable
  `detail` explaining that the audience resolved to nobody because the only person in it was the
  person who acted. The QA admin receives no email. The enrollment reaches a normal terminal state,
  not an error.
- **PASS/FAIL:** FAIL if the step run is `SENT`. FAIL if the detail is an internal string such as
  `Unknown action type undefined`. FAIL if the enrollment errored rather than completing.
- **Note:** the workflow's list-level `trigger_count` will **not** move, because the run's only send
  skipped. That is **issue #1882**, already filed. Do not report it.

---

#### S1-11 - Rule 0 positive companion: approving someone else's estimate still emails the creator
- **Traces to:** Spec A slice 2, AC5 (second half)
- **How:** API + SQL
- **Steps:**
  1. Find an estimate whose `created_by` is **not** the QA admin and which is approvable. Prefer one
     created by a non-routable user; **never** one created by `ranro3@gmail.com` or
     `doca1sols@gmail.com`.
  2. Approve it as the QA admin.
  3. Read the run with the query from S1-10.
- **Expected:** the step run is **`SENT`** (or `FAILED` if the creator's address is non-routable),
  and `recipient_summary` names the creator. The point is that the creator was **resolved and
  addressed**, not dropped.
- **PASS/FAIL:** FAIL if the step run is `SKIPPED` with an actor-drop reason. That would mean Rule 0
  is dropping the wrong person.
- **Note:** this case is what stops S1-10 passing vacuously. A resolver that returns nobody for
  everyone would pass S1-10 and fail here.

---

#### S1-12 - An enrollment reaching a legacy in-app step records SKIPPED and advances
- **Traces to:** Spec A slice 4, AC1, AC3, AC4
- **How:** browser to act (fold into your browser window), SQL to observe
- **Preconditions:** fixture `5de2013b-...` `Sub-status test: Awaiting Parts` is PUBLISHED and ENABLED
- **Steps:**
  1. Note the current newest step run:
     `select max(created_at) from workflow_step_runs wsr join workflow_enrollments we on we.id=wsr.enrollment_id where we.workflow_id='5de2013b-08b3-41c7-ab6e-b3f99dccc763';`
  2. Open any job in the demo org and move it into the sub-status **Awaiting Parts**
     (`307a9d7a-95f7-44a4-8688-14e67f9f94c0`).
  3. Wait for the poller, then re-run:

     ```sql
     select wsr.step_type::text, wsr.status::text, wsr.detail, we.status::text as enrollment_status
     from workflow_step_runs wsr join workflow_enrollments we on we.id = wsr.enrollment_id
     where we.workflow_id = '5de2013b-08b3-41c7-ab6e-b3f99dccc763'
     order by wsr.created_at desc limit 3;
     ```
- **Expected:** a **new** row, `step_type = NOTIFY_TEAM`, `status = SKIPPED`, and `detail` exactly:

  `In-app notifications now come from the bell - this step no longer sends.`

  (plain ASCII hyphen with a space either side). The enrollment reaches a normal terminal state.
- **PASS/FAIL:** FAIL if `detail` contains the string `Unknown action type`. FAIL if the detail reads
  `This step is no longer supported and did not send.` (that is `UNRUNNABLE_STEP_DETAIL`, the generic
  copy for an unknown type - the retired step must get its own sentence). FAIL if the enrollment
  errored or stalled.
- **Also assert:** the skip was **immediate**, not parked for the organization's send window -
  `MESSAGING_STEPS` deliberately excludes `NOTIFY_TEAM` (`enrollment.ts:83-86`). If the run sat
  pending past the send window, FAIL.
- **Also assert:** no in-app notification row was written for the skipped step.
- **Fallback:** if you cannot move a job's sub-status, the pre-existing `SKIPPED` row from 2026-08-28
  (section 5.2) already demonstrates the detail string. Record the case as PASS-BY-OBSERVATION and
  say so.

---

#### S1-13 - The Test dialog's in-app receipt still arrives (the `self` family exception in the engine)
- **Traces to:** Spec A slice 4, AC6; ADR 0005's explicit carve-out
- **How:** browser + SQL
- **Steps:**
  1. Open any published workflow in the builder, use **Test** with send-to-me.
  2. `select verb, created_at from notifications where organization_id='00000000-0000-0000-0000-000000000001' and user_id='b3ce980d-2d9b-4492-9cb5-bc7ea422e35f' order by created_at desc limit 5;`
- **Expected:** a row with verb `automation.message`, addressed to the QA admin - who is also the
  actor. This is the `self` family working as a mechanism: `automation.message` is classified `self`
  precisely because its sole recipient is the person who asked for the receipt.
- **PASS/FAIL:** FAIL if no `automation.message` row appears. ADR 0005 deliberately does **not** claim
  the Automation Center never writes to the bell; a workflow **run** cannot, the Test receipt can.

---

#### S1-14 - Spec C slice 1: a text step addressed to the assigned crew publishes and reads back
- **Traces to:** Spec C slice 1, AC1
- **How:** API
- **Steps:**
  1. Create and publish:

     ```bash
     curl -s -X POST "$API/api/workflows" -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{
         "name":"QA-A-staff-text-crew","trigger_type":"JOB_SCHEDULED",
         "steps":[{"step_type":"SEND_TEXT","config":{"recipients":["assigned_team"],"body":"QA staff text"}}]}'
     curl -s -w '\n%{http_code}\n' -X POST "$API/api/workflows/<id>/publish" \
       -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}'
     ```
  2. `GET $API/api/workflows/<id>` and read the step config back.
- **Expected:** publish returns **200**, and the read-back config carries
  `"recipients": ["assigned_team"]` intact.
- **PASS/FAIL:** FAIL on a 400. In particular FAIL if the error is
  `Recipient "assigned_team" is not available for this trigger` - that is the customer-only audience
  narrowing that slice 1 removed, still in place.
- **Note:** publish does **not** gate on `capabilities.sms_available`. The lock is authoring-UI only
  (`featureFlags.ts`), so this publish succeeds on an org that cannot text. That is by design; the
  run then skips at the gate, which Stream 3 verifies in **S3-20**.

---

#### S1-15 - A named team member on a text step requires the id, and ids require the audience
- **Traces to:** Spec C slice 1, AC2
- **How:** API
- **Steps:** attempt to publish three workflows, each with one `SEND_TEXT` step:
  1. `{"recipients":["specific_user"],"user_ids":["0492f10b-5985-4045-ab81-a0cf48386b72"],"body":"QA"}`
  2. `{"recipients":["specific_user"],"body":"QA"}`
  3. `{"recipients":["all_admins"],"user_ids":["0492f10b-5985-4045-ab81-a0cf48386b72"],"body":"QA"}`
- **Expected:**
  1. publishes, **200**
  2. **400**, with an issue whose `path` is `config.user_ids` and whose message is exactly
     `Pick the team member to notify`
  3. **400** - ids without the named-member recipient are rejected too
- **PASS/FAIL:** FAIL on any other combination of outcomes.

---

#### S1-16 - A text step cannot address custom email addresses
- **Traces to:** Spec C slice 1, AC3
- **How:** API
- **Steps:** attempt to publish two `SEND_TEXT` steps:
  1. `{"recipients":["custom"],"body":"QA"}`
  2. `{"recipients":["all_admins"],"custom_emails":["qa@example.com"],"body":"QA"}`
- **Expected:** both rejected with **400**.
  1. carries the message `That recipient isn’t available for text messages - pick another`
     (note: curly apostrophe U+2019 in `isn’t`, ASCII hyphen before `pick`)
  2. is refused by `.strict()` because `custom_emails` has no entry in `sendTextConfigSchema`
- **PASS/FAIL:** FAIL if either publishes. FAIL if the message for case 1 is zod's own English
  (`Invalid enum value. Expected 'customer' | ...`) - that raw copy landing on the automations list is
  the exact failure the schema's custom `message` exists to prevent.
- **Source:** `textRecipientKey` at `workflowValidation.ts:162`; the `custom_emails` refusal is the
  `.strict()` at `:211`.

---

#### S1-17 - An audience that does not exist for the trigger's entity is still rejected
- **Traces to:** Spec C slice 1, AC6
- **How:** API
- **Steps:** publish a workflow on an **invoice** trigger whose `SEND_TEXT` step addresses
  `dispatcher`:
  `{"name":"QA-A-bad-audience","trigger_type":"INVOICE_PAID","steps":[{"step_type":"SEND_TEXT","config":{"recipients":["dispatcher"],"body":"QA"}}]}`
- **Expected:** **400**, with the message `Recipient "dispatcher" is not available for this trigger`.
- **PASS/FAIL:** FAIL if it publishes. Widening the channel must not have widened the per-entity
  legality check.

---

#### S1-18 - Repo check: the ADR, CONTEXT.md and the notification catalogues agree with the code
- **Traces to:** Spec A slice 7, all ACs
- **How:** repository inspection in the worktree
  `/Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/notif-rules`
- **Steps:**
  1. Confirm `docs/adr/0005-the-bell-is-hardcoded-the-automation-center-owns-email-and-text.md`
     exists, `Status: accepted`, `Date: 2026-08-27`.
  2. Read its consequences section.
  3. `grep -rn "NOTIFY_TEAM\|in-app step" CONTEXT.md docs/adr/ md_files/specs/notifications/ md_files/plans/notifications/`
- **Expected:**
  - The ADR explicitly carves out the Test dialog's `automation.message` receipt and states that a
    workflow **run** cannot notify in-app. **No sentence claims the Automation Center never writes to
    the bell.**
  - It states why the number is 0005 rather than 0003, and does not renumber either `0004`.
  - It records that historical published versions keep the retired label and that no migration was
    added, so a code-only rollback is possible.
  - `CONTEXT.md`'s **Send** entry names only the step kinds that still exist, and defines
    **Notification family** and **Rule 0**.
  - `md_files/specs/ui-redesign/automations-behavior-map.md` keeps its five `NOTIFY_TEAM` references
    behind a **dated historical note** and is otherwise unchanged. That is correct, not a miss.
- **PASS/FAIL:** FAIL if any document under `CONTEXT.md`, `docs/adr/` or `md_files/**/notifications`
  still describes the in-app step type as a **live** way to notify.

---

#### S1-19 - Repo check: a support engineer can answer "why didn't I get that notification"
- **Traces to:** Spec A slice 7, final AC
- **How:** repository inspection
- **Steps:** using only `docs/adr/0005-*.md`,
  `md_files/specs/notifications/notification-scenarios-reference.md` and
  `md_files/plans/notifications/qa-checklist.md`, answer these three by naming a **family**:
  1. Why did the dispatcher who assigned the job not get the assignment toast?
  2. Why did the account holder still get the password-change alert even though they changed it?
  3. Why does a dispatcher who is on none of these jobs still get job completion notices?
- **Expected:** (1) Rule 0 dropped the actor on an `involvement` verb; (2) `self` is Rule 0's single
  named exception and the resolver reads the family; (3) the verb is `duty`, so the recipient set is
  a role rather than an attachment.
- **PASS/FAIL:** FAIL if any answer requires reading source code.

### 8.2 `[BROWSER WINDOW]` Stream 1 browser cases

---

#### S1-20 - The step picker offers four steps and no in-app option
- **Traces to:** Spec A slice 5, AC1
- **How:** browser
- **Steps:**
  1. Go to `https://servwave-demo.vercel.app/automations/new`.
  2. Pick any subject and trigger to reach the builder spine.
  3. Open the add-step control (accessible name `Add a step`, or `Add your first step` when the
     spine is empty).
- **Expected:** exactly four entries, with these labels and descriptions:

  | label | description |
  |---|---|
  | `Wait` | `Pause before the next step` |
  | `Send text` | `Text a customer or your team` |
  | `Send email` | `Branded email to the customer` |
  | `Stop if…` | `End the flow when a condition is met` |

  The popover header reads `Add a step` `[EM DASH]` `pick one`. There is **no** in-app or notify-team
  entry.
- **PASS/FAIL:** FAIL if a fifth entry appears, or if any entry mentions in-app notifications.
- **Note:** `Stop if…` ends in a single ellipsis character (U+2026), not three periods.
- **Note:** the `Send text` row will also carry the `Not connected` lock badge on this org. That is
  correct and is asserted separately by Stream 3 in **S3-16**.
- **Not verifiable here:** the same AC also covers "the unrouted v1 components". Those are not routed,
  so no URL reaches them. Covered by the frontend suite only.

---

#### S1-21 - The gallery shows 10 cards on this org and none installs an in-app step
- **Traces to:** Spec A slice 5, AC2; follow-up A-F1
- **How:** browser
- **Steps:**
  1. Go to `https://servwave-demo.vercel.app/automations`.
  2. Find the templates gallery section (there is **no separate gallery route** - it is a section of
     the list page).
  3. Count the cards and read the category headings.
- **Expected:** **10** cards, under headings `Customer communication`, `Getting paid` and
  `Team coordination`, in that order. The four SMS recipes
  (`reminder-24h`, `reminder-1h`, `job-rescheduled-notice`, `review-request`) are **hidden**, because
  `capabilities.sms_available` is false for this org. Installing any visible template produces a
  workflow that publishes.
- **PASS/FAIL:** FAIL if 14 cards appear (the `sms_available` gate is not filtering). FAIL if any card
  installs a step the builder then refuses to publish.
- **Note:** this is the **manual replacement** for follow-up **A-F1**, whose only component-level test
  was deleted with the unrouted v1 home. Record the result explicitly.

---

#### S1-22 - A legacy in-app step shows a read-only retired notice, and the rest of the workflow is editable
- **Traces to:** Spec A slice 5, AC7; follow-up A-F2
- **How:** browser
- **Preconditions:** fixture `5de2013b-...` exists
- **Steps:**
  1. Open `https://servwave-demo.vercel.app/automations` and confirm the list loads with the workflow
     `Sub-status test: Awaiting Parts` present and carrying a validation issue.
  2. Open `https://servwave-demo.vercel.app/automations/5de2013b-08b3-41c7-ab6e-b3f99dccc763`.
  3. Click the legacy step's node to open the config drawer.
  4. Without saving anything, open a **different** step in the same workflow and confirm its fields
     are editable.
- **Expected:**
  - The list page and the detail page both **load** (this is what makes the retirement a reported
    issue rather than an outage).
  - The drawer shows a read-only notice with headline `In-app notifications now come from the bell.`
    and body `This step no longer sends anything. Remove it to publish this automation.` and
    **no audience picker and no form controls**.
  - The other step remains editable.
- **PASS/FAIL:** FAIL on a 500 or a blank page. FAIL if the drawer shows an empty audience picker.
- **Expected cosmetic defect, do not file:** the step's node in the builder spine reads
  `Set up this step...`, because `stepSentence` falls through to UNCONFIGURED for any non-authorable
  type. That is follow-up **A-F2**.

---

#### S1-23 - A historical in-app step run still renders with its label and icon
- **Traces to:** Spec A slice 6, AC5
- **How:** browser
- **Preconditions:** the historical `SENT` `NOTIFY_TEAM` step run from 2026-08-05 (section 5.2)
- **Steps:** open the Activity tab for workflow `5de2013b-08b3-41c7-ab6e-b3f99dccc763` and scroll to
  the 2026-08-05 run.
- **Expected:** the historical row renders with a **label and an icon** for the retired step type, and
  its detail `Job J00229 entered sub-status: Awaiting Parts`. Rendering surfaces deliberately keep the
  full step-type union, because a historical run must still display.
- **PASS/FAIL:** FAIL if the row renders blank, as `undefined`, or throws.

**Stream 1 cleanup:** delete every workflow whose name starts with `QA-A-`. Leave the three
`NOTIFY_TEAM` fixtures and all `default-*` workflows untouched.

---

## 9. STREAM 2 - Spec B, plus Spec C slice 5

### 9.1 API and SQL cases

---

#### S2-01 - All five task triggers are served, with the right labels
- **Traces to:** Spec B slice 1, AC1
- **How:** API
- **Steps:** `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/catalog" | jq '[.triggers | to_entries[] | select(.key|startswith("TASK")) | {key, label: .value.label, entity: .value.entity, category: .value.category}]'`
- **Expected:** exactly five entries, each with `entity: "task"`:

  | key | label | category |
  |---|---|---|
  | `TASK_CREATED` | `Task is created` | `events` |
  | `TASK_ASSIGNED` | `Someone is added to a task` | `events` |
  | `TASK_COMMENT_ADDED` | `Someone comments on a task` | `events` |
  | `TASK_DELETED` | `Task is deleted` | `events` |
  | `TASK_DATE_ANCHORED` | `Before or after the task due date` | `date` |

- **PASS/FAIL:** FAIL if any is missing, mislabelled, or carries an entity other than `task`.
- **Expected cosmetic, do not file:** the plain-English trigger sentence reads "When task is created",
  dropping the indefinite article every other entity carries. That is **B-F5**.

---

#### S2-02 - `customer` is offered on NONE of the five task triggers
- **Traces to:** Spec B slice 1, "Notably NOT offered: customer"
- **How:** API
- **Steps:** `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/catalog" | jq '[.audiences | to_entries[] | select(.key|startswith("TASK")) | {trigger: .key, email: [.value.SEND_EMAIL[].key], sms: [.value.SEND_SMS[].key]}]'`
- **Expected:** `customer` appears in **neither** the `SEND_EMAIL` nor the `SEND_SMS` list of any of
  the five. The email lists are:

  - `TASK_CREATED`, `TASK_COMMENT_ADDED`, `TASK_DELETED`, `TASK_DATE_ANCHORED`:
    `assignees`, `watchers`, `creator`, `all_admins`, `all_dispatchers`, `specific_user`, `custom`
  - `TASK_ASSIGNED`: the same seven **plus** `assigned_user`

- **PASS/FAIL:** FAIL if `customer` appears anywhere under a `TASK_*` trigger. A task has no customer,
  so offering the key would produce an automation that always skips.
- **Expected, do not file:** `creator` **is** offered on `TASK_CREATED`, where under Rule 0 it is
  always the acting user - so an automation built on it always skips. That is exactly the property
  that got `customer` excluded, and it is recorded as **B-F3**.

---

#### S2-03 - `assigned_user` is offered on `TASK_ASSIGNED` and on no other task trigger
- **Traces to:** Spec B slice 2, AC4
- **How:** API
- **Steps:** `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/catalog" | jq '[.audiences | to_entries[] | select([.value.SEND_EMAIL[].key] | index("assigned_user")) | .key]'`
- **Expected:** exactly `["TECH_ASSIGNED","WALKTHROUGH_PERFORMER_ASSIGNED","TASK_ASSIGNED"]` (order may
  vary). No other `TASK_*` trigger appears.
- **PASS/FAIL:** FAIL if `assigned_user` appears on any other task trigger. `assignees` resolves the
  **live** roster, so a workflow built on it would re-email everyone on the task each time one more
  person joins - the exact bug `assigned_user` exists to prevent, and it throws nothing and logs
  nothing.

---

#### S2-04 - Audience labels read as real phrases
- **Traces to:** Spec B slice 1, AC12
- **How:** API
- **Steps:** `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/catalog" | jq '.audiences.TASK_ASSIGNED.SEND_EMAIL'`
- **Expected:** labels exactly - `assignees` -> `the assignees`; `watchers` -> `the watchers`;
  `creator` -> `the creator`; `all_admins` -> `all admins`; `all_dispatchers` -> `all dispatchers`;
  `specific_user` -> `a specific person`; `assigned_user` -> `the person just assigned`.
  `watchers` carries the hint `Skipped if nobody is watching the task.`; `creator` carries
  `Skipped if the record has no creator on file.`; `assignees` carries **no hint**.
- **PASS/FAIL:** FAIL if any label is a raw key, or if any renders as `the recipient`.

---

#### S2-05 - Text audiences equal email audiences minus `custom`, for every trigger
- **Traces to:** Spec C slice 1, AC4; Spec C slice 8, AC1
- **How:** API
- **Steps:**

  ```bash
  curl -s -H "Authorization: Bearer $TOKEN" "$API/api/workflows/catalog" \
    | jq '[.audiences | to_entries[]
           | {t: .key,
              ok: (([.value.SEND_EMAIL[].key] - ["custom"]) == [.value.SEND_SMS[].key])}
           ] | map(select(.ok == false))'
  ```
- **Expected:** an **empty array**. For every trigger in the catalog,
  `audiencesFor(t,'SEND_SMS')` is exactly `audiencesFor(t,'SEND_EMAIL')` minus `custom`.
- **PASS/FAIL:** FAIL if any trigger is listed.
- **Note:** this is the real equivalence assertion. It is **not** about
  `.actions.SEND_SMS.recipients`, which is the legacy six-member key set that nothing an admin can
  see reads (**B-F4**). Mirroring one is not evidence for the other.

---

#### S2-06 - The removed-member and assigned-member audiences are now offered on text
- **Traces to:** Spec C slice 1, AC5
- **How:** API
- **Steps:** for `TECH_ASSIGNED`, `TECH_UNASSIGNED`, `WALKTHROUGH_PERFORMER_ASSIGNED` and
  `WALKTHROUGH_PERFORMER_REMOVED`, list `.audiences.<t>.SEND_SMS[].key`.
- **Expected:** the two assigned triggers offer `assigned_user` on SEND_SMS; the two removed triggers
  offer `removed_user` on SEND_SMS.
- **PASS/FAIL:** FAIL if any of the four omits its key on the text action.

---

#### S2-07 - `TASK_CREATED` fires and emails the assignees, and the creator is excluded
- **Traces to:** Spec B slice 1, AC2 and AC3
- **How:** API + SQL
- **Steps:**
  1. Publish and enable a task-created workflow addressed to `assignees`:

     ```bash
     curl -s -X POST "$API/api/workflows" -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{
         "name":"QA-B-created","trigger_type":"TASK_CREATED",
         "steps":[{"step_type":"SEND_EMAIL","config":{
           "recipients":["assignees"],
           "subject":"QA-B {{task.number}}",
           "body":"{{task.number}} {{task.title}} due {{task.due_date}} status {{task.status}} priority {{task.priority}} people {{task.assignee_names}} link {{task.link}}"}}]}'
     ```
     then `POST /publish` with `{"enable": true}`.
  2. Create a task through the product **as the QA admin**, titled `QA-B-created-1`, assigned to
     Mike Alvarez `0492f10b-5985-4045-ab81-a0cf48386b72`, with a due date.
  3. Read the run:

     ```sql
     select we.entity_label, we.status::text, wsr.status::text, wsr.detail, wsr.recipient_summary
     from workflow_enrollments we
     join workflows w on w.id = we.workflow_id
     left join workflow_step_runs wsr on wsr.enrollment_id = we.id
     where w.name = 'QA-B-created' order by we.created_at desc limit 5;
     ```
- **Expected:** exactly **one** enrollment. Its step run addresses Mike Alvarez and **not** the QA
  admin, even though the QA admin created the task. The rendered body carries the task number, title,
  due date, status, priority, assignee names and a working link, with no literal `{{...}}` braces and
  no literal `null`.
- **PASS/FAIL:** FAIL if the QA admin appears in `recipient_summary` (Rule 0 broken). FAIL if any merge
  field renders as literal braces. A `FAILED` status from the non-routable `.local` address is **not**
  a fail for this case; judge on who was addressed and what was rendered.

---

#### S2-08 - A task created with assignees fires created **only**, not assigned
- **Traces to:** Spec B slice 2, AC1 - "the single most valuable test in the spec"
- **How:** API + SQL
- **Steps:**
  1. In addition to `QA-B-created`, publish and enable `QA-B-assigned` on `TASK_ASSIGNED` addressed to
     `assigned_user`.
  2. Create a task `QA-B-mutex-1` **with** assignees.
  3. Count enrollments by trigger:

     ```sql
     select w.name, w.trigger_type::text, count(*) from workflow_enrollments we
     join workflows w on w.id = we.workflow_id
     where w.name in ('QA-B-created','QA-B-assigned') and we.entity_label = 'QA-B-mutex-1'
     group by 1,2;
     ```
- **Expected:** exactly **one** row, for `QA-B-created`. `QA-B-assigned` produced **zero**
  enrollments.
- **PASS/FAIL:** FAIL if both fired. Both defaults ship enabled and both address the same people, so
  firing both would email every new task's assignees twice on day one.
- **Note:** this deliberately departs from two established behaviours - the **bell** fires
  `task.assigned` at create time for the whole initial roster, and a new lead with an owner fires both
  `LEAD_CREATED` and `LEAD_ASSIGNED`. The divergence is intended and written at all three sites.

---

#### S2-09 - Adding a person to an existing task emails that person only
- **Traces to:** Spec B slice 2, AC2 and AC3
- **How:** API + SQL
- **Preconditions:** `QA-B-assigned` published and enabled
- **Steps:**
  1. Create a task `QA-B-add-1` with **two** assignees (Mike Alvarez and Dre Patel
     `e3f0a678-bac4-4f3f-8b83-a54e5573e6f6`). Two, not one - with a one-person fixture `assignees`
     and `assigned_user` return the same row and the bug is invisible.
  2. Update the task to add a **third** person (Jose Ramirez
     `aab09dc8-ccf8-4103-adce-84e4bbe2b680`).
  3. Read the enrollment and its `recipient_summary`.
  4. In a **separate** update, add a fourth person (Alex Romero
     `4ccbafc9-c5e3-4623-bbca-68a418c27dec`).
  5. Re-send the **unchanged** assignee list once more.
- **Expected:**
  - After step 2: exactly one enrollment, addressing **only** Jose Ramirez. Mike and Dre receive
    nothing.
  - After step 4: a **second, separate** enrollment addressing only Alex Romero. It is not swallowed
    as a duplicate of the first.
  - After step 5: **no new enrollment.**
- **PASS/FAIL:** FAIL if the first enrollment addresses the whole roster - that is the
  `assignees`-instead-of-`assigned_user` defect, which throws nothing and logs nothing. FAIL if the
  second add is deduped away. FAIL if an unchanged list dispatches.

---

#### S2-10 - Adding a WATCHER dispatches no automation
- **Traces to:** Spec B slice 2, AC5
- **How:** API + SQL
- **Steps:**
  1. Take task `QA-B-add-1` and add a **watcher** (do not change assignees).
  2. Count new enrollments across all five task workflows for that task.
  3. Check the bell: `select verb from notifications where organization_id='00000000-0000-0000-0000-000000000001' order by created_at desc limit 10;`
- **Expected:** **zero** new enrollments, and a `task.watching` bell verb still fires. Watching is
  self-service following, not work being handed to someone; the controller computes an assignee delta
  and a watcher delta separately and only the assignee delta dispatches.
- **PASS/FAIL:** FAIL if any enrollment is created.

---

#### S2-11 - A comment reaches the people on the task, by bell and by email, and never the commenter
- **Traces to:** Spec B slice 3, AC1, AC2, AC3, AC6, AC7
- **How:** API + SQL
- **Steps:**
  1. Publish and enable `QA-B-comment` on `TASK_COMMENT_ADDED` addressed to `assignees` and
     `watchers`.
  2. `POST $API/api/tasks/<QA-B-add-1 id>/comments` **as the QA admin**, who is neither an assignee
     nor a watcher of that task.
  3. Read the enrollment and the notification rows.
- **Expected:**
  - One enrollment; its recipients are the task's assignees **and** watchers.
  - Bell rows with verb `task.commented` for those same people, at FEED priority (not INTERRUPT).
  - The QA admin (the commenter) receives **neither** the bell row nor the email.
  - A comment by someone not on the task still notifies the assignees and watchers - which is exactly
    what this case does.
- **PASS/FAIL:** FAIL if the commenter appears in either channel. FAIL if `task.commented` fires at
  INTERRUPT priority - a shared to-do list that interrupts is a to-do list people mute.

---

#### S2-12 - A second comment notifies again
- **Traces to:** Spec B slice 3, AC4
- **How:** API + SQL
- **Steps:** post a **second** comment on the same task and re-count enrollments.
- **Expected:** a **second** enrollment. It is not swallowed as a duplicate of the first.
- **PASS/FAIL:** FAIL if the count does not increase. `buildDedupeKey` throws when an
  occurrence-scoped trigger arrives with no occurrence and `createEnrollment` swallows the throw and
  returns null - so a missing occurrence is a **silently absent** enrollment, not an exception. That
  is what this case catches.

---

#### S2-13 - The commenter is still excluded after a wait
- **Traces to:** Spec B slice 3, AC5; Spec A slice 2, AC7
- **How:** API + SQL
- **Steps:**
  1. Publish and enable `QA-B-comment-wait` on `TASK_COMMENT_ADDED` with a `WAIT` step of the
     shortest permitted interval (5 minutes) **before** the email step, addressed to `assignees`.
  2. Comment as a user who **is** an assignee of the task (not the QA admin, so that the actor is
     inside the audience). Use the API with that user's bearer if available; otherwise add the QA
     admin as an assignee first and comment as the QA admin.
  3. Wait past the WAIT interval, then read the step run.
- **Expected:** when the send finally happens, the commenter is **still excluded**. The actor rides in
  `workflow_enrollments.event_payload` as `actorId`, so the exclusion survives the wait.
- **PASS/FAIL:** FAIL if the commenter is emailed after the wait. That would mean the actor drop is a
  dispatch-time exclusion rather than a persisted one, and story 16 fails.
- **Verify the mechanism directly:**
  `select event_payload from workflow_enrollments where id = '<enrollment id>';`
  **Expected:** the JSON carries an `actorId` key naming the commenter.
- **Known deploy-window gap, do not file:** any enrollment already parked on a WAIT **before** the
  deploy has no `actorId` and resumes with a null actor. The gap lasts exactly as long as the longest
  configured WAIT. Only judge enrollments created after 2026-08-28.

---

#### S2-14 - A deleted task can still say which task it was
- **Traces to:** Spec B slice 4, AC1, AC2, AC7
- **How:** API + SQL
- **Steps:**
  1. Publish and enable `QA-B-deleted` on `TASK_DELETED` addressed to `assignees` and `watchers`,
     with a body using **only** `{{task.number}}` and `{{task.title}}`.
  2. Create task `QA-B-del-1` with an assignee and a watcher.
  3. Delete it (`DELETE $API/api/tasks/<id>`).
  4. Read the enrollment and its step run.
- **Expected:** the enrollment **completes**. The rendered body names the task by number and title.
  The audience resolves from the **pre-delete snapshot roster**, reaching both the assignee and the
  watcher.
- **PASS/FAIL:** FAIL if the enrollment stops with `The task no longer exists`. That was the real
  pre-existing behaviour: `loadExecutionBundle` resolved the live row first and the caller treated
  null as fatal, so a deleted task enrolled, died on its first step, and sent nothing. A `FAILED`
  provider status is not a fail for this case.

---

#### S2-15 - A deleted-task body cannot reference an uncaptured merge field
- **Traces to:** Spec B slice 4, AC6
- **How:** API
- **Steps:** attempt to publish a `TASK_DELETED` workflow whose email body contains
  `{{task.due_date}}` or `{{task.status}}`.
- **Expected:** **400** at publish. Only `task.number` and `task.title` are legal on the deleted
  trigger (`TASK_SNAPSHOT_FIELDS`).
- **PASS/FAIL:** FAIL if it publishes. A deleted-task email must not offer a due date or a status,
  because there is no honest value and a field resolving to an empty string reads as a broken
  template.

---

#### S2-16 - A deleted task stops enrollments for every OTHER task trigger
- **Traces to:** Spec B slice 4, AC5
- **How:** API + SQL
- **Steps:**
  1. With `QA-B-comment` still enabled, create task `QA-B-del-2`, comment on it to create an
     enrollment, then **immediately delete the task** before the poller runs the send.
  2. Read that enrollment's terminal state.
- **Expected:** the **comment** enrollment stops with the existing "no longer exists" message. Only
  the enrollment whose pinned trigger is `TASK_DELETED` survives deletion.
- **PASS/FAIL:** FAIL if the comment enrollment also sends. A broad "a missing task is survivable"
  rule would make every task trigger outlive deletion, so a destroyed task would go on collecting its
  due-date reminders. The escape hatch is deliberately narrow and the narrowness is the point.

---

#### S2-17 - The date anchor fires, and cron parses the seeded anchor config shape
- **Traces to:** Spec B slice 5, AC1 and AC7; Spec B slice 7, AC3; corrections 3 and 5
- **How:** API + SQL
- **Steps:**
  1. Publish and enable `QA-B-reminder` on `TASK_DATE_ANCHORED` with **exactly the trigger_config the
     seeded default carries**, so this case exercises the same shape the seeder writes:

     ```json
     {"anchor":"task.due_at","direction":"before","offset_minutes":1440}
     ```
     addressed to `assignees`.
  2. Create task `QA-B-due-1` with an assignee and a `due_at` **about 24 hours in the future**, so it
     falls inside the sweep's window. (Remember: every pre-existing demo task has a **past** due date,
     so you must create this.)
  3. Wait for the poller, then read the enrollment.
- **Expected:** an enrollment is created for `QA-B-due-1` and the reminder sends in that window.
- **PASS/FAIL:** FAIL if no enrollment is ever created. Two silent failure modes make this the case
  worth running rather than assuming:
  - `dateAnchorSweep`'s switch ends in `default: return []`, so a missing task arm **compiles** and
    yields a workflow that publishes, enables, validates and reads back correctly in the builder
    while never firing.
  - `dateAnchorConfigOf` (`cron.ts:269`) returns null on a malformed config and logs
    `[automations] date-anchored workflow has an invalid trigger_config` `[EM DASH]` `skipping` -
    and nothing else goes red. This is the exact trap the seeder hit: `buildDefinition` hardcoded
    `trigger_config: null`, so a seeded reminder would publish, enable, validate, read back correctly
    and never fire for any org, ever.
- **Also assert:** `select entity_label from workflow_enrollments where ...` returns the task's
  **TITLE** (`QA-B-due-1`), not its number. Every other sweep arm writes a record number; task
  deliberately follows the task convention, because a task's number means nothing to the person being
  told about it. (Spec B slice 5, AC6.)

---

#### S2-18 - The after-direction chase works too, and BLOCKED is not suppressed
- **Traces to:** Spec B slice 5, AC2 and AC3; slice 6, AC3
- **How:** API + SQL
- **Steps:**
  1. Publish and enable `QA-B-chase` on `TASK_DATE_ANCHORED` with
     `{"anchor":"task.due_at","direction":"after","offset_minutes":1440}`.
  2. Create three tasks with **past** due dates inside the after-window: one `TODO`, one `DONE`, one
     `CANCELLED`. Then create a fourth in `BLOCKED`.
  3. Read which of the four enrolled.
- **Expected:** the `TODO` task and the **`BLOCKED`** task enrol. The `DONE` and `CANCELLED` tasks
  **never** enrol.
- **PASS/FAIL:** FAIL if a `DONE` or `CANCELLED` task enrols. FAIL if the `BLOCKED` task does **not** -
  blocked work is exactly the work a chase exists for, and that is pinned deliberately.
- **Note:** the after-window carries a fixed seven-day grace, so it reaches further back than the
  offset alone suggests. Choose due dates accordingly.
- **Note:** the terminal check is keyed off the **status pair** (`DONE`, `CANCELLED`) via the shared
  `lib/tasks/status` helper, never off `completed_at` - cancelling a task deliberately leaves that
  column null, so a timestamp check would make a cancelled task look unfinished for ever.

---

#### S2-19 - A task that finishes between enrollment and send stops chasing
- **Traces to:** Spec B slice 6, AC1, AC2, AC4, AC7
- **How:** API + SQL
- **Steps:**
  1. Using `QA-B-reminder` (which has no wait) and a second copy `QA-B-reminder-wait` (with a 5-minute
     WAIT before the send), enrol two tasks.
  2. Between enrollment and send, mark one task **DONE** and the other **CANCELLED**.
  3. Read the step runs.
- **Expected:** neither sends. The `detail` on the suppressed runs is exactly:
  - for the completed task: `The task was completed`
  - for the cancelled task: `The task was cancelled`

  The stopped run is recorded as **completed with a readable detail**, not as an error and not as a
  silently vanished run. The suppression applies at the **anchored-wait** guard as well as the
  per-step guard, so the workflow with the wait behaves the same as the one without.
- **PASS/FAIL:** FAIL if either sends. FAIL if the run errored, or vanished, or carries an internal
  string.

---

#### S2-20 - A moved due date does not send the reminder for the old date
- **Traces to:** Spec B slice 5, AC5; slice 6, AC5
- **How:** API + SQL
- **Steps:** enrol a task on `QA-B-reminder`, then move its `due_at` before the send. Then move it a
  second time.
- **Expected:** the run for the **old** date does not send; its detail reads
  `The task due date was changed - this run was replaced by an updated reminder`. A task whose due
  date moves twice can produce **two** reminders, one per date.
- **PASS/FAIL:** FAIL if the reminder for the superseded date sends.

---

#### S2-21 - The date-anchor scan still covers all five entities (standing guard for B-F1)
- **Traces to:** follow-up **B-F1**
- **How:** SQL
- **Steps:**
  1. Confirm all five labels exist (query in section 5.3).
  2. Confirm the four non-task date-anchored workflows in the demo org still enrol normally - the
     demo org has `QA: B8 date-anchored invoice reminder` on `INVOICE_DATE_ANCHORED`. Check that
     invoice/estimate/job/lead date-anchored enrollments are still being created across the org:

     ```sql
     select w.trigger_type::text, count(*), max(we.created_at)
     from workflow_enrollments we join workflows w on w.id = we.workflow_id
     where w.trigger_type::text like '%DATE_ANCHORED%'
     group by 1 order by 1;
     ```
- **Expected:** the scan is running. **No** Postgres `22P02` errors are visible in the backend logs.
- **PASS/FAIL:** FAIL if date-anchored enrollments stopped being created for **any** entity after the
  deploy. The blast radius of B-F1 is every reminder in the product, not just task, and the cause is
  hard to diagnose from the symptom. Staging has all five labels so this window should be closed; this
  case exists to prove it stayed closed.

---

#### S2-22 - The seeded defaults registry holds five task entries, correctly configured
- **Traces to:** Spec B slice 7, AC1, AC2, AC3, AC11
- **How:** shell, **`--dry-run` only** - this writes nothing
- **Steps:** from the backend package in the worktree:

  ```bash
  cd /Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/notif-rules/backend
  npm run automations:seed-defaults -- --org=00000000-0000-0000-0000-000000000001 --dry-run
  ```
- **Expected:** the dry run reports that these five `builtin_key`s **would be created** and writes
  nothing:

  | key | name | trigger | audience |
  |---|---|---|---|
  | `default-task-created` | `Task created` | `TASK_CREATED` | `assignees` |
  | `default-task-assigned` | `Added to a task` | `TASK_ASSIGNED` | **`assigned_user`** |
  | `default-task-comment-added` | `New comment on a task` | `TASK_COMMENT_ADDED` | `assignees`, `watchers` |
  | `default-task-deleted` | `Task deleted` | `TASK_DELETED` | `assignees`, `watchers` |
  | `default-task-due-reminder` | `Task due soon reminder` | `TASK_DATE_ANCHORED` | `assignees` |

  It also reports the **first-window blast radius** for the one clock-driven default, computed per org
  from the registry entry's own `trigger_config`.
- **PASS/FAIL:** FAIL if fewer than five task keys are reported. **FAIL if `default-task-assigned`
  targets `assignees` rather than `assigned_user`** - that would re-email the whole roster on every
  addition. FAIL if the run reports it wrote anything.
- **Also assert:** `default-task-due-reminder` carries a **real** `trigger_config`
  (`{anchor: 'task.due_at', direction: 'before', offset_minutes: 1440}`) and not `null`. The seeder
  needed a change for exactly this, contrary to the spec: seeded with a null config the reminder
  publishes, enables, validates and reads back correctly, then never fires for any org, ever.
- **Also assert:** the registry total is **18** (13 legacy + 5 task).
- **Record the reported first-window number.** Appendix A.2 will not be approved without it.

---

#### S2-23 - Spec C slice 5: the thread user column, its index and its FK behaviour
- **Traces to:** Spec C slice 5, AC1, AC2, AC3, AC4
- **How:** SQL
- **Steps:**

  ```sql
  select column_name, data_type, is_nullable, column_default
  from information_schema.columns
  where table_name='message_threads' and column_name='user_id';

  select indexname from pg_indexes
  where tablename='message_threads' and indexname='message_threads_user_id_idx';

  select con.conname, con.confdeltype
  from pg_constraint con join pg_class rel on rel.oid = con.conrelid
  where rel.relname='message_threads' and con.conname='message_threads_user_id_fkey';
  ```
- **Expected:**
  - `user_id | uuid | YES | null` - additive and nullable, with no default.
  - the index `message_threads_user_id_idx` exists.
  - the FK exists with `confdeltype = 'n'`, which is **ON DELETE SET NULL**. Deleting a user sets the
    thread's user id to null rather than deleting the thread or failing.
- **PASS/FAIL:** FAIL if the column is NOT NULL, if the index is missing, or if `confdeltype` is
  anything other than `n`.
- **Not verifiable here:** actually deleting a user, and actually purging an organization. Both are
  destructive on a shared environment. See section 11.

---

#### S2-24 - The threads API exposes the user id and leaves other counterparties byte-identical
- **Traces to:** Spec C slice 5, AC6 and AC7
- **How:** API
- **Steps:**
  1. `curl -s -H "Authorization: Bearer $TOKEN" "$API/api/comm/threads" | jq` (use whatever the
     threads list path is in `comm-threads.controller.ts` if this 404s).
  2. Locate the `Dispatch desk` thread `5709527f-0b1b-46ba-baba-db44b7294ba4` and a customer thread.
- **Expected:** the payload carries a user id field on a user-keyed thread. Customer, lead and vendor
  threads carry the same fields they carried before this branch, with no new required key and no
  empty-string `customerId` sentinel needed to represent a counterparty-less thread.
- **PASS/FAIL:** FAIL if a customer thread's payload shape changed.
- **Note:** `Dispatch desk` has `user_id` NULL, so it demonstrates the field's presence and its
  nullability, not a populated value. A populated `user_id` only appears once a staff text is sent or
  received, which is Appendix A.1.

---

#### S2-25 - The purge orphan already exists in live data
- **Traces to:** Spec C slice 5, AC5 (the part that is observable)
- **How:** SQL
- **Steps:**

  ```sql
  select id, kind, campaign_type, customer_id, lead_id, vendor_id, user_id
  from message_threads
  where organization_id='00000000-0000-0000-0000-000000000001'
    and customer_id is null and lead_id is null and vendor_id is null and user_id is null;
  ```
- **Expected:** several rows, including `92baf4e2-5292-47cf-812f-d30d2417ec54` (`kind='customer'`)
  and the `Dispatch desk` team thread.
- **PASS/FAIL:** informational. This confirms the slice's claim that the purge hole is a **live
  defect** and not only a new risk: a counterparty-less thread already exists, `purgeOrganization`
  reaches a thread only through a lead or a customer, and `MessageThread.organization` is a required
  relation with no `onDelete` - so a survivor makes `tx.organization.delete` throw and rolls the whole
  purge back. Record the row count.

### 9.2 `[BROWSER WINDOW]` Stream 2 browser cases

---

#### S2-26 - The builder shows five subject tiles including Tasks
- **Traces to:** Spec B slice 1, AC1
- **How:** browser
- **Steps:** go to `https://servwave-demo.vercel.app/automations/new` and look at the subject picker.
- **Expected:** exactly five tiles, labelled `Jobs`, `Estimates`, `Invoices`,
  `Leads & Walkthroughs`, `Tasks`. The **Tasks** tile subtitle reads `4 events` (only the four
  `category: 'events'` triggers are counted; the date-anchored one is not). Clicking Tasks lists the
  five task triggers from **S2-01**.
- **PASS/FAIL:** FAIL if the Tasks tile is absent. This is worth a browser check rather than a type
  check: `ENTITY_ORDER` is an array literal where a missing element is assignable to a wider element
  type, so the tile can silently never render with nothing going red anywhere.
- **Note:** the URL does **not** change when you pick a subject - it is component-local React state.
  Do not assert on the address bar.

---

#### S2-27 - Task merge fields appear under a Task group, not under Other
- **Traces to:** Spec B slice 1, AC11
- **How:** browser
- **Steps:** in a task workflow's email step, open the merge-field picker.
- **Expected:** a group headed **`Task`** containing exactly:
  `task.number`, `task.title`, `task.due_date`, `task.status`, `task.priority`,
  `task.assignee_names`, `task.link`, `task.linked_record` -
  labelled `Task number`, `Task title`, `Task due date`, `Task status`, `Task priority`,
  `Task assignee name(s)`, `Task link`, `Record the task is attached to`.
  Group order is Company, Customer, Recipient, Job, Estimate, Invoice, Lead & walkthrough, **Task**,
  Other.
- **PASS/FAIL:** FAIL if any task field lands in the trailing `Other` group.
- **Note:** the roster field is `task.assignee_names`, **not** `task.assignees`.

---

#### S2-28 - The plain-English sentences render the task audiences as real phrases
- **Traces to:** Spec B slice 1, AC12
- **How:** browser
- **Steps:** build a task workflow addressed to `assignees` and one addressed to `watchers`, and read
  both the workflow sentence on the list page and the step bubble in the spine.
- **Expected:** they read `the assignees` and `the watchers`. Neither ever renders the fallback
  `the recipient`.
- **PASS/FAIL:** FAIL on any `the recipient`. Three frontend label layers hold independent
  plain-string maps read with a `?? 'the recipient'` fallback, and none produces a compile error or a
  failing test when a key is missing.

---

#### S2-29 - The task recipes appear in the gallery under the Tasks subject
- **Traces to:** Spec B slice 7, AC9
- **How:** browser
- **Steps:** open the gallery at `https://servwave-demo.vercel.app/automations` and find the
  `Team coordination` section.
- **Expected:** three task cards: `Task due tomorrow`, `Overdue task chase`, `Task comment notice`.
  Installing any of them produces a workflow that publishes.
- **PASS/FAIL:** FAIL if the Tasks subject offers no recipes. That is story 2 failing on its own
  terms, and it was the pre-existing state before slice 7.

---

#### S2-30 - Tasks still offer no stop-if conditions
- **Traces to:** Spec B slice 6, AC8
- **How:** browser
- **Steps:** add a `Stop if…` step to a task workflow.
- **Expected:** no conditions are offered, and the existing empty-condition dead-end note is shown.
  `STOP_IF_CONDITIONS.task` stays empty, exactly as lead's already is.
- **PASS/FAIL:** FAIL if task-specific conditions appear. Done and cancelled are handled **inside the
  engine** (S2-19), not as a builder condition, so that no admin has to re-derive them.

**Stream 2 cleanup:** delete every workflow and task whose name starts with `QA-B-`.

---

## 10. STREAM 3 - Spec C slices 2, 3, 4, 6, 7, 8

> **Run S3-01, S3-02 and S3-03 first.** They assert user counts that every later case in this stream
> changes.

### 10.1 `[BROWSER WINDOW]` part 1 - the missing-phone surface (must come first)

---

#### S3-01 - Every user with no phone shows a labelled badge, not a bare dash
- **Traces to:** Spec C slice 4, AC1, AC2, AC5
- **How:** browser
- **Steps:** go to `https://servwave-demo.vercel.app/settings/users`.
- **Expected:** the `Phone` column shows a neutral badge reading exactly **`No phone`** on every row.
  All 21 active users show it, because 0 of 21 carry a number. No row shows a bare dash.
- **PASS/FAIL:** FAIL if any row shows a dash or an empty cell instead of the badge. A bare dash reads
  as "nothing to say here" rather than "this person cannot be texted", which is the whole point of
  the change.
- **Note:** the badge uses the same neutral idiom the Name cell already uses for its `No login` badge.
  Both will be visible on this page; do not confuse them.

---

#### S3-02 - The Missing phone switch composes with the status pills
- **Traces to:** Spec C slice 4, AC3
- **How:** browser
- **Preconditions:** S3-01 done; no phone has been written yet
- **Steps:** on `/settings/users`, exercise the four combinations and record the row count each time.
  The control is a **Switch** with the visible label `Missing phone`, sitting beside the status pills.
  The pills render as lowercase DOM text `all`, `active`, `inactive`, displayed capitalised by CSS -
  target them by their rendered accessible name.
- **Expected:**

  | status pill | Missing phone | rows |
  |---|---|---|
  | `active` | off | 21 |
  | `active` | **on** | **21** |
  | `all` | **on** | **24** |
  | `inactive` | **on** | **3** |

- **PASS/FAIL:** FAIL if `active` + `Missing phone` returns anything other than the 21 active users.
  **FAIL if it silently includes the 3 deactivated users** - the filter is a separate switch rather
  than a fourth pill precisely so that "missing phone" is not mutually exclusive with "active"; a
  fourth value would put deactivated leavers into an admin's chase list, and those can never be a text
  recipient anyway, since the audience resolver only ever returns active users.
- **Note:** the counts above are only stable while no phone exists. Once S3-04 onwards writes numbers,
  each written phone reduces the `Missing phone` counts by one.

---

#### S3-03 - Turning the switch off restores the list, and the pills work alone
- **Traces to:** Spec C slice 4, AC4, AC5
- **How:** browser
- **Steps:** turn `Missing phone` off and cycle the three pills. Watch the network panel.
- **Expected:** the previous list is restored; `all` / `active` / `inactive` behave exactly as they did
  before this branch; and toggling the switch fires **no new API call** - the filter is client-side
  over the already-loaded list.
- **PASS/FAIL:** FAIL if turning the switch off leaves the list filtered. FAIL if a new request is
  issued.

### 10.2 `[BROWSER WINDOW]` part 2 - phone capture on the three routed surfaces

---

#### S3-04 - The invite card stores a typed number in E.164
- **Traces to:** Spec C slice 2, AC1, AC10
- **How:** browser + SQL
- **Steps:**
  1. On `/settings/users`, click `+ Invite User`.
  2. Fill first name, last name, an address at the **non-routable** domain
     `qa.servwave.test` (for example `qa.phone1@qa.servwave.test`), phone `(555) 111-2222`, extension
     `123`.
  3. Submit, then read the row:
     `select email, phone, phone_ext from users where email='qa.phone1@qa.servwave.test';`
- **Expected:** `phone` is stored as **`+15551112222`** and `phone_ext` as `123`.
- **PASS/FAIL:** FAIL if the stored value carries formatting characters, or if the extension was
  dropped.
- **Note:** submitting an invite sends an invite email. The address above is non-routable, so nothing
  reaches a real person. Do not invite a real address.
- **Cleanup:** this row is Stream 3's to remove at the end if the product offers a way; otherwise
  leave it and report it.

---

#### S3-05 - An admin editing another user's number stores E.164
- **Traces to:** Spec C slice 2, AC2, AC8
- **How:** browser + SQL
- **Steps:**
  1. On `/settings/users`, open the edit dialog for **Mike Turner**
     (`873b8561-7e50-4163-8265-2d510fca9188`).
  2. Confirm the dialog title is `Edit details`. The phone input has **no label** - it is identified
     by its placeholder `Phone`; the extension input by `Extension`.
  3. Type `(555) 333-4444`, save.
  4. `select phone from users where id='873b8561-7e50-4163-8265-2d510fca9188';`
  5. Reopen the dialog.
- **Expected:** stored as `+15553334444`. Reopening shows the same number, **correctly formatted**
  (not truncated).
- **PASS/FAIL:** FAIL if the stored value is not E.164, or if the redisplay is wrong.

---

#### S3-06 - A user editing their own number stores E.164
- **Traces to:** Spec C slice 2, AC2, AC8
- **How:** browser + SQL
- **Steps:** go to `https://servwave-demo.vercel.app/settings/profile` (the QA admin's own profile),
  enter `555-777-8888`, save, then read
  `select phone from users where id='b3ce980d-2d9b-4492-9cb5-bc7ea422e35f';` and reopen the page.
- **Expected:** stored as `+15557778888`; the page redisplays it correctly formatted.
- **PASS/FAIL:** FAIL on any other stored form.
- **Cleanup:** this writes the QA login's own row. Restore it to NULL in **S3-26**.

---

#### S3-07 - An unusable number is refused client-side on all three routed surfaces
- **Traces to:** Spec C slice 2, AC4
- **How:** browser, with the network panel open
- **Steps:** on each of the three surfaces below, type the unusable value `12345` into the phone field
  and attempt to submit.

  | surface | route |
  |---|---|
  | Users & Teams - invite card | `/settings/users` |
  | Users & Teams - edit dialog | `/settings/users` |
  | My Profile | `/settings/profile` |
- **Expected:** each shows the inline message, byte for byte:

  `Enter a 10-digit US or Canadian phone number`

  and leaves submit **disabled**. **No request is sent to the server.**
- **PASS/FAIL:** FAIL if any surface issues a request. The client mirror is byte-identical to the
  server rule precisely so that nothing can be offered for submit that the API would 400.

---

#### S3-08 - THE ADMIN-EDIT LOCKOUT GUARD: editing only the NAME of a user with an unnormalizable stored phone succeeds
- **Traces to:** Spec C slice 2, AC7 - the highest-value case in this slice
- **How:** SQL fixture, browser, SQL restore
- **Why a fixture is needed:** every demo user has `phone` NULL, and the API now refuses an
  unnormalizable number, so this condition **cannot** be created through the product. It must be
  written directly, and restored.
- **Steps:**
  1. Create the legacy condition on **Mike Rivera** only:

     ```sql
     update users set phone = '5551112'
     where id = '7928f4b3-e227-4154-bff6-f3433f31c4e5'
       and organization_id = '00000000-0000-0000-0000-000000000001';
     ```
     (`5551112` is a 7-digit fragment: not normalizable, and exactly the shape the column predates
     normalization with.)
  2. On `/settings/users`, open Mike Rivera's edit dialog.
  3. Change **only the last name** (for example append ` QA`). Do not touch the phone field at all.
  4. Save.
  5. Restore, unconditionally, whether the case passed or failed:

     ```sql
     update users set phone = null, last_name = 'Rivera'
     where id = '7928f4b3-e227-4154-bff6-f3433f31c4e5';
     ```
- **Expected:** the save **succeeds**. The dialog sends `phone` only when it changed, so the
  unnormalizable stored value is never submitted and never validated.
- **PASS/FAIL:** **FAIL if the save is refused**, or if the admin is forced to fix a phone field they
  never touched. That is the regression this guard exists to prevent: the dialog used to send `phone`
  on every save, seeded from whatever was stored, so a normalize-or-reject gate would have made this
  user's own **name** unsavable.
- **Note:** the inline phone error is deliberately gated on the phone having **changed**, so no error
  should appear while you edit the name.
- **Report the restore.** If step 5 did not run, say so loudly - a live row is left in a broken state.

---

#### S3-09 - Blank stays optional everywhere, and the list renders a stored number with its extension
- **Traces to:** Spec C slice 2, AC6, AC9
- **How:** browser + SQL
- **Steps:**
  1. Invite a user leaving phone blank; edit an existing user clearing the phone; save your own
     profile with phone blank.
  2. Look at the Phone column for the user given a number and an extension in **S3-04**.
- **Expected:** all three saves succeed - the field is optional on every path. The users list renders
  the stored number in human-readable form with the extension appended.
- **PASS/FAIL:** FAIL if any path requires a phone.

---

#### S3-10 - The accept-invite page prefills, formats and gates the phone
- **Traces to:** Spec C slice 3, AC1 and the client half of AC6
- **How:** browser
- **Preconditions:** the invited user from **S3-04**, who has an admin-supplied number
- **Steps:**
  1. Fetch the invite token for `qa.phone1@qa.servwave.test` from the database (the invite table the
     product writes on invite).
  2. Open `https://servwave-demo.vercel.app/accept-invite?token=<token>` in a logged-out context.
  3. Read the phone field, then type the unusable value `12345`.
- **Expected:**
  - The field is labelled `Phone number`, placeholder `(555) 123-4567`, with the hint text
    `Optional. Used to text you about jobs you are assigned to.` directly under it.
  - It is **prefilled** with the admin-supplied number, formatted for reading.
  - Typing `12345` blocks submission and shows `Enter a 10-digit US or Canadian phone number`.
    **On this page the message appears in the page-level alert banner, not under the field** - the
    text under the field stays the hint above.
  - Both submit paths are present: a password button reading `Set password & sign in`
    (`Setting up…` while in flight) and a `Continue with Google` button.
- **PASS/FAIL:** FAIL if the field is empty when the admin supplied a number, or if an unusable value
  is accepted for submit.
- **STOP HERE. Do NOT press either submit button.** Completing acceptance creates a login and sets a
  password. That is **Appendix A.3** and requires the repo owner.

---

### 10.3 `[BROWSER WINDOW]` part 3 - the SMS inbox Team lane

---

#### S3-11 - The Team lane exists and is non-empty
- **Traces to:** Spec C slice 7, AC1
- **How:** browser
- **Preconditions:** fixture 5.1 confirmed
- **Steps:** go to `https://servwave-demo.vercel.app/communication/text/inbox`.
- **Expected:** three lane pills: `Conversations`, **`Team`**, `Archive`. The `Team` lane contains the
  thread `Dispatch desk`, whose meta line reads `Team · Internal` (a middle dot U+00B7 with a space
  either side; `Internal` is the fallback when the thread has no subtitle).
- **PASS/FAIL:** FAIL if the Team lane is absent, or if it is empty. An empty Team lane means either
  the lane filter is wrong or the seeded thread is gone - check fixture 5.1 before reporting.
- **Note:** the per-lane empty copy, if you ever see it, is `No team conversations.`

---

#### S3-12 - A staff thread shows the team information panel, no job pills, and no unrouted tray
- **Traces to:** Spec C slice 7, AC3
- **How:** browser
- **Steps:** open `Dispatch desk` in the Team lane and read the right-hand panel.
- **Expected:** the **team** information panel, not the customer-and-job context panel. It shows the
  thread title, the line `Internal team thread`, a `Channel` row reading `Internal · SMS`, and the
  explanatory line
  `Team conversations stay inside ServWave and aren't billed as customer SMS.`
  There are **no job pills** and the thread does **not** appear in the `Unrouted` tray.
- **PASS/FAIL:** FAIL if the customer context panel renders, if any job pill appears, or if the thread
  shows in the unrouted tray.
- **Note:** staff messages deliberately carry neither `job_id` nor `job_label`. Internal lanes never
  carry a job id; the job context lives in the message body via `{{job.number}}` instead. This is a
  known deliberate decision (section 2, item 3).

---

#### S3-13 - The reply composer is disabled on a team thread with NO staff counterparty
- **Traces to:** Spec C slice 7, AC4, as amended by the staff-SMS reply fix
- **How:** browser
- **Steps:** with `Dispatch desk` open, try to type in the reply composer and press Send.
- **Expected:** the input and the `Send` button are both **disabled**, and the composer area shows
  exactly:

  `This internal thread has no one to reply to.`

  Nothing you can do in the UI produces a request, so a 409 cannot be triggered.
- **PASS/FAIL:** FAIL if the composer accepts input or if Send is clickable. A reply typed there would
  **not** fail loudly: `Dispatch desk` carries `user_id` NULL, so it fails
  `isDeliverableThread` and the row would be recorded, never sent, and settled at `queued` for ever
  while rendering as a `Sending` bubble.
- **IMPORTANT - this test is about the ABSENCE of a counterparty, not about team threads in general.**
  `Dispatch desk` qualifies only because its `user_id` is NULL (S2-24's note records this). A team
  thread that DOES name a person is now a two-way conversation and its composer must be
  **enabled** - see S3-13b. Do not generalise this row to every team thread.
- **Note:** this explanation must win over the org-level banners. On this org you might otherwise
  expect `Texting activates once the A2P campaign is approved` `[EM DASH]`
  `check status in Settings → Phone & SMS.` - if you see **that** on a recipient-less team thread
  instead of the sentence above, it is a FAIL, because the no-recipient branch is checked first.

---

#### S3-13b - The reply composer is LIVE on a staff thread that names a person
- **Traces to:** the staff-SMS reply fix (reverses Spec C slice 7 AC4 for this case only)
- **How:** browser
- **Steps:** open a team thread whose `user_id` is set - one written by a staff-addressed automation
  text, or the thread created when a staff member's mobile replies inbound. Type a reply and Send.
- **Expected:** the input and `Send` are **enabled**, no `This internal thread has no one to reply to.`
  line appears, and the send resolves the person's `users.phone` and delivers. The request carries
  `threadId`, never `customerId` - a staff thread's `customerId` is the legacy `""` sentinel.
- **PASS/FAIL:** FAIL if the composer is disabled, if the bubble settles at `queued`/`Sending` and
  never resolves, or if the request 400s (which is what sending by `customerId` would produce).
- **Note:** a staff member with NO phone on file is a clean 409 `NO_SMS_NUMBER` with no row written -
  not a crash, and not a send addressed to null.

---

#### S3-14 - The lanes do not leak into each other
- **Traces to:** Spec C slice 7, AC2, AC7
- **How:** browser
- **Steps:** compare the three lanes.
- **Expected:**
  - `Dispatch desk` appears in **Team** and **not** in `Conversations`.
  - The demo org's customer threads (including the `Linda Allen` thread) appear in `Conversations`
    and **not** in `Team`.
  - `Archive` still shows archived threads of any kind - the demo org has exactly one archived
    thread, `92baf4e2-5292-47cf-812f-d30d2417ec54`.
- **PASS/FAIL:** FAIL on any leak in either direction.
- **Known, do not file:** an inbound staff reply **will** bump the SMS unread badge, because the
  unread aggregate does not filter by thread kind. You will not see this without a real inbound
  message, but if you do, it is the accepted decision from section 2, item 2.

---

#### S3-15 - REGRESSION: customer threads, job pills and the unrouted tray are unchanged
- **Traces to:** Spec C slice 7, AC7; slice 6, AC9
- **How:** browser
- **Steps:** open the `Linda Allen` customer thread (`485e2a66-4752-4bec-9065-0f9701cdf5ae`, which has
  three messages, all carrying a `job_id`).
- **Expected:** it renders exactly as it did before this branch - the customer-and-job context panel,
  its job pills, its campaign meta line in the `{campaign} · SMS` form, and its composer behaving as
  it did. The unrouted tray still lists the counterparty-less customer-lane threads it listed before.
- **PASS/FAIL:** FAIL on any visible change to a customer thread.

---

#### S3-16 - The text step is locked with the "Not connected" badge and tooltip
- **Traces to:** Spec C slice 8, AC8
- **How:** browser
- **Preconditions:** **S1-02** confirmed `sms_available: false`
- **Steps:** at `https://servwave-demo.vercel.app/automations/new`, open the add-step picker and hover
  the `Send text` row.
- **Expected:** the row carries a lock badge reading exactly **`Not connected`** and a tooltip reading
  exactly:

  `Connect a phone number in Communication settings to text a customer or your team from an automation.`

- **PASS/FAIL:** FAIL if the step is selectable on this org, or if the badge or tooltip text differs.
- **Note:** this is a **real** acceptance criterion satisfied by the demo org's own state, not a
  workaround. Spec B briefly locked SEND_TEXT per **subject** as well (a task had no customer to
  text); Spec C removed that clause, so the subject now has no say. If you find a task workflow where
  the text step is locked but a job workflow where it is not, that is a FAIL.

---

#### S3-17 - The routed text form offers the same audiences as email, minus custom

> **Retired field, 2026-09-15.** This plan was written and run while `{{recipient.first_name}}`
> was a legal merge field. Ran removed it outright on 2026-09-15 (see `BASE` in
> `backend/src/services/automations/catalog.ts`), so the `curl` below is now REFUSED with "The
> field {{recipient.first_name}} isn't available for this trigger" and the C/6 AC4 row in the
> traceability table is no longer a criterion. Substitute any field the trigger still offers -
> `{{job.number}}` works on `TECH_ASSIGNED` - to run this step today. The record of what was
> tested on 2026-08-29 is left as it was written.

- **Traces to:** Spec C slice 8, AC1, AC2, AC6, AC7
- **How:** API to seed, browser to observe
- **Why seeded:** the step picker locks `Send text` on this org (S3-16), so a new text step cannot be
  **added** through the UI. It can still be **opened** once it exists, because the lock lives only in
  the picker. Seeding one by API is the honest way to reach the form without flipping the org flags.
- **Steps:**
  1. Create a draft (do not publish) with one `SEND_TEXT` step on a `TECH_ASSIGNED` trigger:

     ```bash
     curl -s -X POST "$API/api/workflows" -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{
         "name":"QA-C-textform","trigger_type":"TECH_ASSIGNED",
         "steps":[{"step_type":"SEND_TEXT","config":{"recipients":["assigned_user"],"body":"Hi {{recipient.first_name}}"}}]}'
     ```
  2. Open `https://servwave-demo.vercel.app/automations/<id>` and click the text step.
- **Expected:**
  - A `Send to` label above a **RecipientMultiSelect**, not a static `Customer` badge.
  - Its options are the `SEND_SMS` audiences for `TECH_ASSIGNED` - the same set the email step offers
    **minus** the custom-email-address option.
  - `assigned_user` is preselected and the step bubble names that audience in plain English
    (`the assigned technician` on a job trigger), **not** `the recipient`.
  - The `Message` field shows a `0 / 320` character meter.
  - The amber honesty note reads exactly:

    `Every text is saved to the conversation of whoever it goes to, customer or team member. Anyone with no phone number on file is skipped, and the run history says who.`

    It no longer says messages are saved to the **customer's** conversation.
- **PASS/FAIL:** FAIL if the form shows a static Customer badge, if `custom` is offered, if the bubble
  reads `the recipient`, or if the honesty note still names the customer's conversation.

---

#### S3-18 - The step-picker description no longer claims the customer
- **Traces to:** Spec C slice 8, AC7
- **How:** browser
- **Steps:** read the `Send text` row's description in the picker.
- **Expected:** `Text a customer or your team`.
- **PASS/FAIL:** FAIL if it reads `Text the customer`.
- **Note:** the **unrouted v1 twin** at `frontend/src/components/workflows/AddStepButton.tsx:34` still
  reads `Text the customer`. That component is not routed, so no URL reaches it and it is out of scope
  here. Do not file it as a UI bug; if you want it recorded, note it as a documentation-level
  inconsistency in your report.

### 10.4 API and SQL cases (run these outside your browser window)

---

#### S3-19 - No phone number is a SKIP with a readable reason, not a failure
- **Traces to:** Spec C slice 6, AC3; the default outcome for all 21 users
- **How:** API + SQL
- **Steps:**
  1. Publish and enable a text workflow addressed to a staff audience whose members have no phone:

     ```bash
     curl -s -X POST "$API/api/workflows" -H "Authorization: Bearer $TOKEN" \
       -H 'Content-Type: application/json' -d '{
         "name":"QA-C-staff-skip","trigger_type":"TECH_ASSIGNED",
         "steps":[{"step_type":"SEND_TEXT","config":{"recipients":["assigned_user"],"body":"QA staff text"}}]}'
     ```
     then publish with `{"enable": true}`.
  2. Assign a job to a technician who has **no** phone (any of the 21 except the three Stream 3 owns).
  3. Read the step run:

     ```sql
     select wsr.status::text, wsr.detail, wsr.recipient_summary
     from workflow_step_runs wsr join workflow_enrollments we on we.id = wsr.enrollment_id
     join workflows w on w.id = we.workflow_id
     where w.name = 'QA-C-staff-skip' order by wsr.created_at desc limit 3;
     ```
- **Expected:** `status = SKIPPED`, and `detail` names the person, in the form
  `No phone number on file for <First Last>`. The run **advances to the next step** rather than
  failing.
- **PASS/FAIL:** FAIL if the status is `FAILED`. A missing phone number is a skip with a readable
  reason, not an error - that is one of the three positions the spec takes deliberately.
- **Also assert:** `recipient_summary` on a SKIPPED result is **absent** (the SKIPPED branch does not
  set it), and nothing anywhere in the run history contains a phone number. The run-history summary
  names **people**, never their mobile numbers, because the Activity feed shows it to anyone with read
  access to Automations.

---

#### S3-20 - The organization gate skips a staff text with the org-level reason
- **Traces to:** Spec C slice 6, AC10 - the criterion this environment makes free to verify
- **How:** API + SQL
- **Preconditions:** **one** staff recipient must have a phone, so the run gets past the no-phone skip
  and reaches `runGates`. Use Mike Turner, who was given `+15553334444` in **S3-05**.
- **Steps:**
  1. Publish and enable `QA-C-staff-gate` on `TECH_ASSIGNED`, `SEND_TEXT`, addressed to
     `specific_user` with `user_ids: ["873b8561-7e50-4163-8265-2d510fca9188"]`.
  2. Fire the trigger.
  3. Read the step run detail.
- **Expected:** `SKIPPED`, with the plain-English gate copy an admin actually reads. Given this org
  has `ctm_account_id` set, `ctm_sms_ready = false` and `sms_sending_enabled = false`, the expected
  reason is the `SMS_NOT_READY` copy, byte for byte:

  `Text messaging is not active yet` `[EM DASH]` `A2P registration is pending approval`

  The other two org-gate strings, either of which is also an acceptable PASS if the flags differ from
  the measurement, are:
  - `NOT_CONNECTED` -> `Text messaging is not connected for this organization`
  - `ORG_SMS_DISABLED` -> `Text messaging is turned off for this organization`
- **PASS/FAIL:** FAIL if the run reports `SENT`. **A `SENT` here means a real text left the building -
  stop everything and escalate immediately.** FAIL if the detail is a raw code such as
  `SMS_NOT_READY` rather than the plain-English copy.
- **Note:** `runGates` is keyed on org and destination E.164 and is counterparty-agnostic, so this is
  the same gate a customer text passes through. Organization gating was asserted rather than
  reimplemented.

---

#### S3-21 - A mixed audience reports both outcomes and does not short-circuit
- **Traces to:** Spec C slice 6, AC1
- **How:** API + SQL
- **Preconditions:** Mike Turner has a phone (S3-05); pick a second staff member who does **not**.
- **Steps:**
  1. Publish and enable `QA-C-staff-mixed` addressed to `specific_user` with **both** user ids.
  2. Fire the trigger and read the step result.
- **Expected:** **one** step result carrying the **mixed** outcome. It reports the gate reason for the
  person with a number **and** `No phone number on file for <name>` for the person without. It does
  **not** stop at the first missing number.
- **PASS/FAIL:** FAIL if only one of the two is reported. The loop must collect reasons rather than
  return early - the two customer conditions became collected reasons rather than early returns for
  exactly this.
- **Note:** on this org neither person actually receives a text, so the "delivers one message to that
  number" half of the AC is **Appendix A.1**. What is verifiable here, and is the part that used to
  be a short-circuit bug, is that both outcomes are reported in one result.

---

#### S3-22 - A staff-only text step on a record with no customer does not abort on the customer guard
- **Traces to:** Spec C slice 6, AC2
- **How:** API + SQL
- **Steps:** publish and enable a `SEND_TEXT` step addressed **only** to `all_admins` on a trigger
  whose record has no customer, and fire it.
- **Expected:** the step executes and produces a per-person result (skips, on this org). It does
  **not** abort with `This record has no customer to text`.
- **PASS/FAIL:** FAIL if the customer guard fires on a staff-only step. That string is reserved for a
  step that actually addresses the customer.

---

#### S3-23 - The server rejects an unusable number at every write door
- **Traces to:** Spec C slice 2, AC5; slice 3, server half of AC6
- **How:** API
- **Steps:** send `"phone": "12345"` to each of these and record the status and message:

  | door | request |
  |---|---|
  | invite | `POST $API/api/users/invite` (or the invite path in `user.routes.ts`) |
  | admin update | `PATCH $API/api/users/873b8561-7e50-4163-8265-2d510fca9188` |
  | self update | `PATCH $API/api/users/me` |
  | accept invite (password) | `POST $API/api/auth/accept-invite` |
  | accept invite (terms) | `POST $API/api/auth/accept-invite/terms` |

  For the two accept-invite calls, send a **deliberately invalid token** alongside the bad phone, so
  that even if validation somehow passed, nothing could complete.
- **Expected:** every one returns **400**, and the message names what is acceptable:

  `Enter a 10-digit US or Canadian phone number`

  Nothing is persisted, and the acceptance does not half-complete.
- **PASS/FAIL:** FAIL on any 2xx, or on a message that does not say what is acceptable.
- **Also assert:** sending `"phone": ""` and omitting `phone` entirely both succeed on the invite,
  admin-update and self-update doors - the field is optional throughout, and blank passes through
  untouched rather than being normalized or rejected.
- **Do NOT run:** a well-formed `POST /api/auth/accept-invite` with a valid token. That completes an
  acceptance, creates a login and sets a password - **Appendix A.3**.
- **Do NOT run:** `POST /api/users` with a valid body. It may provision a login - **Appendix A.4**.
  The `phone` normalization on that door is covered by the backend suite and by the shared
  `userPhoneField` it uses (`backend/src/controllers/user.controller.ts:72`).

---

#### S3-24 - REGRESSION: a customer text automation is unchanged end to end
- **Traces to:** Spec C slice 6, AC9; slice 8, AC5
- **How:** API + SQL
- **Steps:**
  1. Publish and enable `QA-C-customer-text` on `JOB_SCHEDULED` with a `SEND_TEXT` step addressed to
     `["customer"]` and a body containing `{{customer.first_name}}`.
  2. Fire it on a job whose customer has a phone.
  3. Read the resulting thread, message and step run.
- **Expected:** exactly the pre-existing customer behaviour - the same thread, `campaign_type`
  `customer_care` with **no** `kind`, the same message row, the same customer timeline event, and the
  same pre-delivery skip strings. The step result's `recipient_summary` for the customer branch stays
  the **phone number**, unchanged, while a staff branch summary names people.
- **PASS/FAIL:** FAIL on any change to the customer path. It is meant to be byte for byte unchanged,
  and the executor was a total rewrite, so this is the case that would catch it.
- **Also assert:** reopening `QA-C-customer-text` in the builder shows `customer` still selected, and
  republishing changes nothing about what it sends.

---

#### S3-25 - Billing counts a staff text exactly as a customer text
- **Traces to:** Spec C slice 6, AC12 - the observable half
- **How:** SQL
- **Steps:** confirm the usage meter's counting query has no thread, kind, direction or customer
  narrowing:

  ```sql
  select count(*) from messages m
  join message_threads t on t.id = m.thread_id
  where t.organization_id = '00000000-0000-0000-0000-000000000001';
  ```
  and compare against what the in-product usage meter reports for the current cycle.
- **Expected:** the meter counts `Message` rows per org and per cycle with **no** narrowing, so a
  staff message row counts automatically and nothing had to be built for it.
- **PASS/FAIL:** informational on this org, because no staff message row can be created here. Record
  the current count as the baseline. A `kind` filter added to that query later would silently make
  every staff text free, which is what the new test asserts against.
- **Not verifiable here:** the actual increment from a staff send. **Appendix A.1.**

---

#### S3-26 - Stream 3 cleanup and restore
- **How:** SQL + API
- **Steps:**
  1. Restore every user row Stream 3 wrote:

     ```sql
     update users set phone = null, phone_ext = null
     where id in (
       '873b8561-7e50-4163-8265-2d510fca9188',  -- Mike Turner
       '7928f4b3-e227-4154-bff6-f3433f31c4e5',  -- Mike Rivera
       '8cfd0dac-b890-468e-bc32-81c460121cad',  -- QA SALES
       'b3ce980d-2d9b-4492-9cb5-bc7ea422e35f'   -- the QA admin's own profile (S3-06)
     );
     select id, first_name, last_name, phone, phone_ext from users
     where id in ('873b8561-7e50-4163-8265-2d510fca9188','7928f4b3-e227-4154-bff6-f3433f31c4e5',
                  '8cfd0dac-b890-468e-bc32-81c460121cad','b3ce980d-2d9b-4492-9cb5-bc7ea422e35f');
     ```
  2. Confirm Mike Rivera's last name is back to `Rivera` (S3-08 step 5).
  3. Delete every workflow whose name starts with `QA-C-`.
  4. Re-run the count from section 5.5.
- **Expected:** 21 active / 0 with phone / 24 total - the org is back to the state this plan started
  from, except for the invited `qa.phone1@qa.servwave.test` row, which you should report.
- **PASS/FAIL:** FAIL the cleanup and say so loudly if any restore did not take.

---

## 11. Acceptance criteria that are NOT verifiable on staging

Listed rather than silently dropped. Each says why, and what covers it instead.

### 11.1 Compile-time criteria - not runtime behaviour at all

| Criterion | Spec |
|---|---|
| Removing a `VERB_RULES` entry makes `tsc -b` fail, naming the verb | A/1 AC1 |
| A 62nd registry verb without a rule, or a rule without a verb, fails `tsc -b` | A/1 AC2 |
| Re-adding the retired step type to any authoring surface fails `tsc -b` | A/6 AC1 |
| The authorable step types are exactly wait, text, email and stop-if | A/6 AC4 |
| `stepSchemas.ts` no longer exports the retired schema, enum or form-values type | A/6 AC6 |
| `migrateRules.ts` compiles unchanged with its lockstep comment | A/6 AC8 |
| Every deleted component's test is deleted with it | A/6 AC7 |
| `STEP_CONFIG_SCHEMAS` is declared `Partial<Record<...>>` | A/3 AC6 |

**Why:** these are properties of the compiler and the repository, not of a running app. **Covered by**
the CI evidence in section 3 and by direct repository inspection. Stream 1's **S1-18** and **S1-19**
cover the documentation half of the same family.

### 11.2 `VERB_RULES` contents and the bell's `self` exception

| Criterion | Spec |
|---|---|
| `VERB_RULES` holds the full verb set with the stated prefix distribution | A/1 AC3 |
| All four `security.*` verbs are `self`; `automation.message` is `self` with an exception string | A/1 AC4 |
| Only the two invoice sweep verbs carry timing `time`; the eleven actorless event verbs carry exceptions | A/1 AC5 |
| **Resolving a `security.*` verb with the account holder as actor still returns that user** | A/1 AC6 |
| With the actor seated everywhere no non-self verb returns anyone; with a different actor every non-self verb returns at least one | A/1 AC7 |
| The two invoice sweep verbs resolve with a null actor exactly as before | A/1 AC8 |
| `communication.email_inbound` falls back to the dispatcher/admin room when the thread assignee is the actor | A/1 AC9 |
| `task.completed` and `job.completed` drop the completer identically | A/1 AC10 |

**Why:** `VERB_RULES` is not served by any API, and no product surface exposes a verb's family. AC6
in particular would require triggering a real security event for the demo admin - a password change or
an MFA change - and the QA login is deliberately password-free, so an agent must not create or change
a password to manufacture one.

**Covered by** `templates.test.ts`, `security-notifications.test.ts` and the resolver's paired
negative-and-positive suites. **The engine-side half of Rule 0 IS verifiable** and is tested here as
**S1-10** (drop) and **S1-11** (positive companion), and the `self` exception is observable in the
engine at **S1-13** via the `automation.message` Test receipt.

### 11.3 The unrouted v1 components

| Criterion | Spec |
|---|---|
| The step picker offers no in-app option "in both the routed v2 builder and the unrouted v1 components" | A/5 AC1 |
| The v1-only component suites pass | A/5 AC10 |

**Why:** the v1 components are not routed, so no URL reaches them in a browser. **Covered by** the
frontend suite. Note that three existing frontend suites (`my-profile-page`, `users-teams-page`,
`users-teams-page-rbac-gate`) import the **dead** v1 forks under `pages/settings/`, so a test written
the obvious way there is green against a page nobody opens; the new suites import what
`settings.routes.tsx` actually mounts. That is why this plan gives explicit routed URLs everywhere.

### 11.4 Anything requiring a second organization

| Criterion | Spec |
|---|---|
| An organization without the automations entitlement produces no task enrollment and no partial rows | B/1 AC7 |
| An organization without the entitlement receives none of the five seeded defaults | B/7 AC7 |
| An organization with no tasks receives all five and they sit inert | B/7 AC8 |
| A single-admin organization stops emailing that admin when they acted | A/2, release note |

**Why:** the QA login reaches **only** the demo org, which is on plan `SCALE` with no feature
overrides, is entitled, and has 46 tasks. **Do not QA against the pilot org** - it mirrors
real production data, has `ctm_sms_ready = true`, and 3 of its 8 active users carry a real phone
number. **Covered by** the backend suites.

### 11.5 Anything destructive on a shared environment

| Criterion | Spec |
|---|---|
| Deleting a user sets the thread's user id to null rather than deleting the thread | C/5 AC4 |
| Purging an organization that owns a user-keyed thread completes | C/5 AC5 |
| Deactivating a user who holds tasks emails each fallback assignee | B/2 AC6 |
| Re-applying the migration is a no-op | C/5 AC1 |

**Why:** these delete users, delete an organization, or re-run a migration against a shared database.
**Partly covered here:** **S2-23** verifies the FK's `ON DELETE SET NULL` rule structurally from
`pg_constraint` rather than by deleting a user, and verifies the guarded index. The migration's
re-runnability is guaranteed by its `IF NOT EXISTS` guards and its `pg_constraint` check, which you
can read in `backend/prisma/migrations/20260828170000_message_thread_user_counterparty/migration.sql`.
The rest is **covered by** the backend purge suites.

### 11.6 The seeded task defaults as database rows

| Criterion | Spec |
|---|---|
| The seeder creates five task workflows, all enabled, all published | B/7 AC1 |
| Re-running the seeder creates and modifies nothing; an edited copy keeps its edits | B/7 AC4 |
| An admin can turn any of the five off and it stays off across a re-run | B/7 AC5 |
| An admin can edit the subject and body and the edited wording is what sends | B/7 AC6 |
| Every seeded default validates through the same validator a publish runs | B/7 AC10 |

**Why:** `seedDefaultAutomationsForOrg` has exactly one non-test caller (an operator script) and
nothing calls it on deploy, so **staging has zero task workflows** (fixture 5.4). Running the real
seeder creates five **enabled, net-new-email** automations in a shared org where two users have real
inboxes.

**Partly covered here:** **S2-22** verifies the registry, the five keys, the audiences, the
`trigger_config`, and the total of 18, using the safe `--dry-run`. **S2-17** exercises the exact
`trigger_config` shape the reminder default carries, through a QA-owned workflow, so the "seeded
config actually fires" property is proven without seeding. The row-level criteria are
**Appendix A.2**.

### 11.7 Staff SMS actually sending

| Criterion | Spec |
|---|---|
| A text step delivers one message to the number that has one | C/6 AC1 |
| `{{recipient.first_name}}` arrives at each staff handset with that person's own name | C/6 AC4 |
| A staff send creates one thread carrying that user's id, `kind` team, `campaign_type` tech_ops, titled with the person's name; a second text reuses it; two people get two threads | C/6 AC6 |
| A staff message row is outbound, queued, flagged automated, and carries neither `job_id` nor `job_label` | C/6 AC7 |
| A staff send writes no customer timeline event and normalizes a legacy stored number at the seam | C/6 AC8 |
| An opted-out staff member is skipped silently while an email step still reaches them | C/6 AC11 |
| A staff text increments the org's current-cycle usage | C/6 AC12 |
| A provider error records a FAILED step, not a skipped one, and does not stop the run | C/6 AC13 |
| An inbound staff text lands in that user's existing team thread | C/7 AC5 |
| An inbound unknown number still creates the same title-keyed thread it does today | C/7 AC6 |

**Why:** every one needs `ctm_sms_ready` and `sms_sending_enabled` **on**, which sends real SMS
through CTM, and **CTM webhooks fan out to production as well as staging**. **Appendix A.1.**

### 11.8 Builder criteria blocked by the same two flags

| Criterion | Spec |
|---|---|
| **A newly added text step starts with no recipient pre-selected** | C/8 AC4 |
| Selecting the assigned crew on a text step through the UI and publishing succeeds | C/8 AC2 |
| Selecting a named team member through the UI requires choosing that person | C/8 AC3 |

**Why:** `smsAvailable()` and `runGates` read the **same two flags**, so the builder's `Send text`
step cannot be unlocked without also enabling real sending. A text step therefore cannot be **added**
through the UI on this org.

**Partly covered here:** **S3-17** opens an API-seeded text step and verifies the recipient control,
its option set and its copy. **S1-14**, **S1-15** and **S1-16** verify the publish-side legality of
every one of these selections through the API. The pre-selection default itself
(`case 'SEND_TEXT': return { recipients: [], body: '' }` in
`frontend/src/components/workflows/useWorkflowDraft.ts:110`) is covered by the new frontend suite, and
its observable consequence - the server answering `Choose who this text message goes to` rather than
zod's `Required` - **is** verifiable: publish a text step with `"recipients": []` and check the message.

### 11.9 The accept-invite completion paths

| Criterion | Spec |
|---|---|
| A new hire accepting with a password and a phone ends up with that number, normalized | C/3 AC2 |
| A new hire accepting via the Google/terms path ends up with the same result | C/3 AC3 |
| **A blank submission leaves an admin-supplied number as it was** | C/3 AC4 |
| A hire with no admin-supplied number submitting blank ends up with no number, on both paths | C/3 AC5 |
| Acceptance still creates the login, records terms, and lands the user in the app | C/3 AC7 |

**Why:** completing an acceptance **creates an account and sets a password**. An agent must not do
either autonomously. **Appendix A.3.**

**Partly covered here:** **S3-10** verifies the prefill, the label, the hint and the client-side gate
without submitting; **S3-23** verifies that both endpoints reject an unusable number and that nothing
half-completes.

### 11.10 Criteria satisfied elsewhere, not on staging

- **A/3 AC1** - "the production count of legacy in-app steps is recorded in the PR description in both
  shapes". This is a PR-body criterion and is already satisfied (8 draft steps across 2 orgs in
  production, every containing workflow disabled, 0 published versions, 0 runs ever; 4 draft steps and
  1 published version on staging). Section 5.2 re-measures the staging half.
- **A/2 AC12** and **A/5 AC11** - "the release note enumerates / names ...". Document criteria; see
  `md_files/plans/automations/2026-08-27-rule-0-actor-exclusion-release-note.md`.
- **A/6 AC10** - "the PR description records that a code-only rollback is possible". Already in
  PR #1913. The one-command check is
  `git diff --name-only "$(git merge-base origin/main HEAD)..HEAD" -- backend/prisma/` on the Spec A
  branch, which must print nothing.

---

## APPENDIX A - DO NOT RUN ANY OF THIS WITHOUT WRITTEN APPROVAL FROM THE REPO OWNER

**Nothing in this appendix is part of the normal QA pass.** Each item changes shared state, sends
something outward, or creates a credential. Each needs Ran's explicit, in-writing say-so **for that
specific item**, obtained before the step is taken. Approval of one item is not approval of another.

If you are a QA agent: **read this appendix, do not execute it, and report which items you think are
worth asking for.**

### A.1 Enabling staff SMS on the demo org

**What it does:** flips `ctm_sms_ready` and `sms_sending_enabled` to `true` on
`00000000-0000-0000-0000-000000000001`.

**Why it is gated:**
- It sends **real text messages** through CTM to whatever numbers are on the addressed user rows.
- **CTM webhooks fan out to production as well as staging.** A test message written against staging
  can land in production data.
- It simultaneously flips `capabilities.sms_available` to `true`, which unlocks the builder's
  `Send text` step and un-hides four SMS gallery templates - so several assertions elsewhere in this
  plan (**S1-02**, **S1-21**, **S3-16**) start failing while it is on.

**Preconditions before asking:**
1. The repo owner has approved, in writing, for this specific run.
2. Exactly **one** phone number is on exactly **one** user row, and it is a number **the repo owner
   personally controls**. Nothing else.
3. A written revert plan with the exact restoring SQL, and a named point at which it runs.

**Unlocks:** every criterion in sections 11.7 and 11.8.

**Revert immediately afterwards:**

```sql
update organizations
set ctm_sms_ready = false, sms_sending_enabled = false
where id = '00000000-0000-0000-0000-000000000001';
```
then clear the phone from the fixture user row and re-run **S1-02** to confirm
`sms_available` is `false` again.

### A.2 Running the real seeder against the demo org

**What it does:**
`npm run automations:seed-defaults -- --org=00000000-0000-0000-0000-000000000001` creates the five
task defaults as **published and enabled** workflows.

**Why it is gated:** these five retire no hardcoded sender, so they are **net-new email**. Four are
event triggers and send nothing until somebody acts; the fifth is a clock-driven due-date reminder
whose first sweep is the only number here that is not zero on day one. Two demo users have **real
inboxes** (`ranro3@gmail.com`, `doca1sols@gmail.com`), and the demo org has 25 open tasks with due
dates.

**Preconditions before asking:**
1. **S2-22**'s `--dry-run` has been run and its reported first-window figure is in the request.
2. The repo owner has approved that specific number.
3. Whether the seeded rows are to be left in place or removed afterwards is decided **before** the
   run - the seeder skips existing rows outright, so a row created for the wrong org cannot be
   corrected by re-running it. That is the mistake to prevent, not one to clean up later.

**Unlocks:** section 11.6.

**Also note:** `seedDefaultAutomationsForOrg` aborts the whole run on the first failure rather than
isolating per entry (**B-F2**), so a partial failure abandons all 18 rather than skipping the 5 that
cannot apply.

### A.3 Completing an invite acceptance

**What it does:** submits `POST /api/auth/accept-invite` (or `.../terms`) with a valid token, which
**creates a login and sets a password**.

**Why it is gated:** creating accounts and entering passwords is not something a QA agent may do
autonomously, regardless of the environment or of how synthetic the address is. The repo owner must
drive the submit.

**Unlocks:** section 11.9 - in particular the criterion that a **blank** submission must leave an
admin-supplied number untouched, which is the one with real data-loss consequences:
`inviteUser` already persists the number the admin typed on the invite card, so nulling on a blank box
would destroy exactly the data this capture exists to collect.

**Suggested shape if approved:** two synthetic invitees at `@qa.servwave.test`, one taking the
password path and one the Google/terms path, each run twice - once submitting a typed number, once
submitting blank against an admin-supplied number - with the stored `phone` read after each.

### A.4 `POST /api/users`

**What it does:** creates a user row through the API door that has no frontend caller.

**Why it is gated:** it may provision a login. Until that is confirmed one way or the other, treat it
as account creation.

**Unlocks:** Spec C slice 2, AC3 (story 11, API layer only).

**Read-only alternative that needs no approval:** confirm in the repository that
`createUserSchema` uses the same shared `userPhoneField` as the other three doors
(`backend/src/controllers/user.controller.ts:69-72`), which is the whole of what the criterion asserts.

### A.5 Deactivating or deleting a user, and purging an organization

**Never on shared staging.** Deactivation changes the missing-phone counts and the audience resolver's
output for every other stream; deletion is destructive; purging deletes an organization. Section 11.5
records what covers these instead.

---

## APPENDIX B - Reporting

Report per test case, one line each:

```
<ID>  PASS | FAIL | BLOCKED | NOT-RUN   <one sentence>
```

For every **FAIL**, add: what you expected byte for byte, what you actually saw byte for byte, the URL
or the exact request, and the SQL you ran to confirm it. A screenshot alone is not a report.

For every **BLOCKED**, name the precondition that was missing.

Before filing anything as a new bug, check it against **section 2**. If it is listed there, it is
known: say "confirmed, known" and move on.

At the end of your stream, state:

1. Which artefacts you created and whether cleanup succeeded.
2. Whether any user row you wrote was restored (Stream 3 especially).
3. Whether you re-minted the session, and when.
4. Whether `capabilities.sms_available` was still `false` when you finished (**S1-02**). If it is
   `true`, say so at the top of your report, not the bottom.
