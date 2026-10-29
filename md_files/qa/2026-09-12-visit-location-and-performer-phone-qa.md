# QA — Visit location and performer phone (staging)

**Feature:** a visit now carries its own location — the parent's service address (the default), one
of the organisation's own locations, or a one-off address — rendered into automation email through
`{{lead.walkthrough_location}}` / `{{job.visit_location}}`; the people coming are reachable through
`{{lead.performer_phones}}` / `{{technician.phones}}`; a referenced location is archived rather than
deleted; and every surface that reads a visit says where it is.

**Spec:** `md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md` (D1–D11, 16
user stories). **Slices:** `md_files/issues/scheduling/01-…` through `06-…`.

**Under test:** `origin/staging` at or after `3267b32c6`. The six merges are `1d83c151b`,
`289ef90b2`, `65442e233`, `042738657`, `c0654a358`, `3267b32c6`, plus `46fcc6d73` (automation
validation copy).

**Target:** staging only. App `https://servwave-demo.vercel.app`, API
`https://alpha-crm-test-env.onrender.com`.

**47 scenarios, S01–S47.** Report each as `S07 PASS` / `S12 FAIL` with the evidence line.

---

## 0. Before you start

### 0.1 Get a session

From `/Users/ranroffe/ALPHA_CRM/alpha_crm` (the main checkout, not a worktree):

```
/opt/homebrew/bin/node scripts/qa-session.mjs staging --session
```

That exact node path. A node path containing `@` breaks the script.

It writes `.qa/session-staging.json`. The bearer token is at `.session.access_token`, falling back
to `.access_token`:

```
TOKEN=$(python3 -c "import json;d=json.load(open('.qa/session-staging.json'));s=d.get('session') or d;print(s['access_token'])")
```

**Never print the token.** Not into the transcript, not into a scenario report, not into a file you
leave behind. Use it only as `-H "Authorization: Bearer $TOKEN"`. If you need to show a command,
show it with `$TOKEN` unexpanded. Tokens last one hour — re-mint when a call starts returning 401.

The session is an ADMIN of the **demo org** `00000000-0000-0000-0000-000000000001` ("ServWave
Test"). The minter's scope guard refuses any org not flagged demo.

Helper used throughout this document:

```
API=https://alpha-crm-test-env.onrender.com
api() { curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }
```

### 0.2 Read the database

The staging connection string is in `backend/.env` in the main checkout. Read it into a variable and
never echo it:

```
DB=$(grep -E '^DIRECT_URL=' backend/.env | cut -d= -f2- | tr -d '"')
psql "$DB" -At -c "select 1"
```

`psql` is at `/opt/homebrew/bin/psql`.

**Reads only**, with two named exceptions that this document calls out explicitly at the step
(S14 writes one row through raw SQL to prove a CHECK constraint fires; nothing else does).

### 0.3 What must never be touched

- **No `prisma migrate`**, of any flavour, ever. The migrations are already applied on staging.
- **No org other than `00000000-0000-0000-0000-000000000001`.** S42 *reads* one location id from
  another organisation in order to send it at the demo org's own doors. That read is the only
  contact any scenario has with another tenant. Never write to one, never book at one, never log
  in as one.
- **No production.** Nothing in this document runs against `app.servwave.com` or the production API.
- **Do not edit the demo org's seed data.** The one exception is S28, which sets the organisation's
  main phone line and restores it in the same scenario, and S46, which archives the seed location
  `Hoboken Store` and restores it in the same scenario. Both carry a mandatory restore step and
  both are run by a single agent, alone.
- **Do not delete the seed location `Hoboken Store`** (`0a6b99fb-1362-4fd6-871a-337ee4000c04`).

### 0.4 The staging demo org has exactly ONE location

Measured 2026-09-12:

| | |
|---|---|
| Locations | exactly one — `Hoboken Store`, `0a6b99fb-1362-4fd6-871a-337ee4000c04`, `1001 Willow Ave, Hoboken, NJ`, active |
| `organizations.phone` | **empty string** — the org has no main line on file |
| Users with a phone number | **zero** of 25 active |
| Visits carrying a location | **zero** — this feature has never been exercised here |

Consequences you must design around, not discover:

- **Every archive, picker and multi-location scenario provisions its own locations.** There is no
  second location to borrow, and archiving the one there is would change the picker for every other
  agent. Only S46 touches `Hoboken Store`, and it is exclusive.
- **Every phone scenario provisions its own user phone numbers** by PATCHing a fixture user, and
  puts them back.
- **The org main line is empty**, so `formatPerformerPhones`' last resort — the literal phrase
  `our office` — is the state you reach by default. The main-line branch (S28) has to be
  provisioned and restored.

### 0.5 Email is routable here. SMS is not.

Automation email from this org **really sends**. Two of the active users sit on real, deliverable
personal inboxes; everybody else is on a non-routable internal domain. Both belong to the project
owner, so nothing leaks to a third party — but an enabled automation addressing staff will mail a
real person, repeatedly, for the whole time your probe is live.

**CORRECTED 2026-09-12, after Lane C proved the original rule wrong.** `@example.com` is **not**
accepted by the provider — it is rejected outright:

```
delivery to <addr>@example.com failed: Invalid `to` field. Please use our testing
email address instead of domains like `example.com`.
```

The step run lands **`FAILED`**, `detail` carries **that error instead of the rendered subject**, and
**no `emails` row is written at all**. Thirteen such failures were observed on staging in six hours.
So an `@example.com` fixture makes every render assertion in this document **undecidable**, not
merely unsent.

**The corrected rule: every automation you publish addresses `recipients: ["customer"]`, and every
fixture customer you create is on `@qa.servwave.test`.** That is a reserved TLD, it cannot reach a
human, and three seed users already sit on it — and unlike `example.com` the provider accepts it, so
the evidence rows you assert on actually get written. Verify before you rely on it: book one probe,
wait two minutes, and confirm your step run is `SENT` rather than `FAILED`.

**Never** address a step to `all_admins`, `assigned_user`, `dispatcher`, `custom`, or a specific
user — those reach the two real inboxes.

**A hazard this document originally missed.** `Walkthrough performer assigned` and `Technician
assigned` are **pre-existing, enabled seed workflows** that mail the named person directly. The
"address only the customer" rule gives you no protection against them, because *naming a performer
or an assignee* is what fires them. **Two active users are on `gmail.com` — real inboxes.** Before
you name anyone as a performer or crew member, check the domain:

```sql
select id, email from users where organization_id = '00000000-0000-0000-0000-000000000001'
  and is_active and email not like '%@gmail.com' order by email;
```

**SMS cannot be tested end to end and no scenario asks you to.** Two org flags (`ctm_sms_ready`,
`sms_sending_enabled`) are both false and no user has a number, so every text is gated before it
leaves. A scenario that needed a delivered SMS would be undecidable here; there is none. The two
phone merge fields are email-side fields and are tested through email.

### 0.6 Screenshots are impossible in this environment

The in-app browser pane cannot composite. **Do not attempt a screenshot and do not report one.**
Every browser scenario below is decided through `read_page`, `get_page_text`, `find`, `form_input`
and `javascript_tool`. The four scenarios that genuinely need a person to look at a screen are
flagged **HUMAN EYE** and are listed together in §5; keep them to exactly those.

### 0.7 Fixture naming

**Every row any scenario creates is named with the prefix `QA0912-<GROUP>-`.** No exceptions —
cleanup in §6 is a prefix sweep and an unprefixed fixture will survive it.

| Kind | Pattern | Example |
|---|---|---|
| Location | `QA0912-<G>-<Word>` | `QA0912-A-Showroom` |
| Customer | `QA0912-<G>-<Word>` as company name, email `qa0912-<g>-<word>@qa.servwave.test` | `QA0912-A-Alder` |
| Lead / Job | inherits the customer; `service_request` / `scope_notes` starts `QA0912-<G>` | |
| Automation | `QA0912-<G> <purpose>` | `QA0912-B walkthrough probe` |
| One-off address | street line starts `QA0912` | `QA0912 One-Off 400 Harbor St` |

Invented phone numbers are **always in the 555 range** — `+15550100142`, `+15550100143`,
`+15550100144`. Never a real number.

No real company, customer or partner name appears anywhere — not in a fixture, not in a note, not in
a report. Neutral placeholders only.

### 0.8 What a pass condition is

A pass condition names the artefact and the exact value. `psql shows visits.location_id =
<QA0912-A-Showroom's id> and all five location_address_* columns NULL` is a pass condition. `the
location shows correctly` is not. If a step below ever reads as the second kind, treat the scenario
as FAIL-blocked and say so rather than exercising judgement.

### 0.9 The strings this build ships, verbatim

Assert against these. Note the **curly apostrophes** in the validation copy.

| Thing | Exact value |
|---|---|
| Refusal for a bad / foreign / archived location id | HTTP **400**, body `{"error":"Location not found"}` |
| No service address anywhere | `the address we have on file for you` |
| No crew number and no org main line | `our office` |
| Merge-field labels | `Walkthrough location`, `Job visit location`, `Walkthrough team phone(s)`, `Technician phone(s)` |
| Sample values | `Showroom, 12 Harbor St, Asheville, NC` · `North Yard, 40 Depot Rd, Richmond, VA` · `(555) 204-7791` · `(555) 204-7794 ext. 12` |
| Picker groups | `Lead & walkthrough` (prefix `lead.`) · `Job` (prefixes `job.`, `technician.`) |
| Picker options | `Service address` · `<location name>` · `<location name> (archived)` · `Other` |
| Visit location line | `<p>` containing `<span data-testid="visit-location">`, preceded by an sr-only `Location: ` |
| Illegal merge field at publish | `The field {{job.visit_location}} isn’t available for this trigger, so this automation can’t be published. Open this step and remove the field, or pick a replacement from the Insert a field list` |
| Delete refusal | `Cannot delete: this location has N visits booked at it. Archive it instead - it stops appearing when anyone books, and everything already pointing at it keeps reading correctly.` |

### 0.10 The doors

| Door | Purpose | Location field |
|---|---|---|
| `POST /api/leads/:id/walkthrough/schedule` | book / rebook the lead's active walkthrough | `location` |
| `POST /api/leads/:id/visits` | book an additional lead visit | `location` |
| `POST /api/jobs/:id/visits` | book a job visit | `location` |
| `PATCH /api/jobs/:id/visits/:visitId` | reschedule a job visit | `location` |
| `POST /api/jobs/:id/assign` | first-book through the job window | **none, by design** |

`location` is three-state on every door: **omitted** leaves the stored location alone, **`null`**
clears it back to the service address, **a value** sets it. A value is either
`{"location_id":"<uuid>"}` or `{"address_line1":…,"city":…,"state":…}` with optional
`address_line2` / `zip` — never both shapes at once.

Locations CRUD: `GET/POST /api/locations`, `PATCH /api/locations/:id`,
`POST /api/locations/:id/archive`, `POST /api/locations/:id/unarchive`, `DELETE /api/locations/:id`.

Automations: `GET /api/workflows/catalog`, `POST /api/workflows`, `POST /api/workflows/:id/publish`,
`POST /api/workflows/:id/toggle`, `POST /api/workflows/:id/test`, `DELETE /api/workflows/:id`.

### 0.11 How an automation's rendered output becomes evidence

The automation poller ticks **once a minute** on the API host. An enabled workflow with no leading
WAIT step therefore sends within about two minutes of the booking that enrolled it.

Two evidence artefacts, both read with `psql`:

1. **`workflow_step_runs.detail`** — for a step whose status is `SENT` with no skip reasons, this is
   the **rendered subject**. So: put the merge fields you are asserting on **in the subject**, as a
   machine-readable line, and the rendered answer lands in one column. **Check the status first:**
   on a `FAILED` run this same column holds the provider's error instead, which reads nothing like a
   render and will waste your time if you assume otherwise.
2. **`emails`** — the Communication mirror. `emails.subject` is the rendered subject and
   `emails.body->>0` is the rendered plain body. Written **only when the provider accepted the
   address** — so not for `@example.com` (see §0.5), and absence here is a delivery fact, never
   evidence about the render.

For the **job side only** there is a third, better artefact that needs no send at all:
**`workflow_enrollments.event_payload -> 'mergeFields'`**, written at dispatch time by
`visitMergeFields`. It carries `job.scheduled_date`, `job.visit_location` and `technician.phones`
for the one trip the occurrence is about. A job-side probe automation whose **first step is a
7-day WAIT** produces this payload and sends nothing. Use that shape wherever the assertion is
job-side (S31 depends on it).

The lead side has no such override — `lead.*` fields resolve at execution time against the lead's
*current* visit — so lead-side render assertions must come from an actual send.

Probe automation shapes used below:

```
# Lead-side probe (SENDS — subject carries the fields)
POST /api/workflows
{ "name":"QA0912-B walkthrough probe", "trigger_type":"WALKTHROUGH_SCHEDULED",
  "send_window":"ANYTIME",
  "steps":[{"step_type":"SEND_EMAIL","config":{
    "recipients":["customer"],
    "subject":"QA0912-B loc=[{{lead.walkthrough_location}}] phones=[{{lead.performer_phones}}] addr=[{{lead.address}}]",
    "body":"QA0912-B body loc=[{{lead.walkthrough_location}}]"}}]}
POST /api/workflows/<id>/publish  { "enable": true }

# Job-side probe (SENDS NOTHING — 7-day WAIT first, payload read off the enrollment)
POST /api/workflows
{ "name":"QA0912-B job probe", "trigger_type":"JOB_SCHEDULED", "send_window":"ANYTIME",
  "steps":[{"step_type":"WAIT","config":{"duration_minutes":10080}},
           {"step_type":"SEND_EMAIL","config":{
             "recipients":["customer"],
             "subject":"QA0912-B job loc=[{{job.visit_location}}] date=[{{job.scheduled_date}}] phones=[{{technician.phones}}]",
             "body":"QA0912-B job body"}}]}
POST /api/workflows/<id>/publish  { "enable": true }
```

Three things about enabled probes you must know before you start:

- An enrollment is only created for an **enabled** workflow. These probes must be enabled, which is
  a deliberate departure from the usual "publish QA automations disabled" rule. It is safe only
  because every recipient is `customer` and every fixture customer is on `@example.com`.
- While Group B's probes are live, **every** walkthrough and job visit booked anywhere in the demo
  org — including other groups' fixtures — enrols them and produces one accepted-and-bounced send.
  That is expected noise. Every Group B assertion is keyed on `workflow_enrollments.entity_id` or on
  the `QA0912-B` marker, never on "the most recent row".
- **Group B and Group E are the only groups permitted to create an enabled automation.** Any other
  group that needs one is out of scope.

### 0.12 Making a booking that actually enrols

- `POST /leads/:id/walkthrough/schedule` dispatches `WALKTHROUGH_SCHEDULED` only when the booking
  names **at least one performer** and the body **omits `notify_customer` entirely**. Sending
  `notify_customer: false` sets `notifyDeclined` and suppresses the event; sending `true` sends the
  hard-coded customer email instead. **Omit the key.**
- `POST /leads/:id/visits` **dispatches no automation event at all.** It is a pure booking door.
  Lead-side merge-field assertions therefore always go through `/walkthrough/schedule`.
- `POST /jobs/:id/visits` dispatches `JOB_SCHEDULED` with the per-visit override when the body omits
  `notify.notify_customer`. `PATCH /jobs/:id/visits/:visitId` dispatches `JOB_RESCHEDULED` the same
  way.

---

## 1. Groups and parallelism

| Lane | Group | Scenarios | Surface | Independent of |
|---|---|---|---|---|
| 1 | **A — write doors and stored columns** | S01–S14 | API + DB | B, C, and the browser lane |
| 2 | **B — merge fields, D7 fallbacks, phones, the multi-visit trap** | S15–S32 | API + DB | A, C, and the browser lane |
| 3 | **C — archive, restore, delete refusal, cross-tenant** | S33–S39 | API + DB | A, B, and the browser lane |
| 4 | **D — read surfaces (API then DOM)** | S40–S42 | API + browser | A, B, C |
| 4 | **E — field picker and end-to-end authoring** | S43–S44 | API + browser | A, B, C |
| 4 | **F — mobile at 375px** | S45 | browser | A, B, C |
| 5 | **Z — exclusive** | S46–S47 | browser + API | **nothing** |

**Lanes 1, 2 and 3 run fully in parallel** with each other and with lane 4. Each owns a disjoint
location prefix (`QA0912-A-*`, `QA0912-B-*`, `QA0912-C-*`) and disjoint customers, leads and jobs.
No group reads another group's fixtures.

**Lane 4 is a single serial lane: D → E → F.** The in-app browser pane is shared, and two agents
driving it at once fight over one page. One agent runs all of D, then all of E, then all of F. It
may run concurrently with lanes 1–3 because its fixtures are its own.

**Lane 5 is exclusive.** S46 archives the org's only seed location and S47 sets the org's main
phone line. Both change what every other group sees. Run lane 5 **after lanes 1–4 have reported**,
with a single agent, and run its restore steps before releasing the environment.

Cross-lane rule while lane 2 is live: other lanes' bookings will enrol B's probes and produce
bouncing sends to `@example.com`. Harmless. Do not "clean up" another lane's enrollments.

---

## 2. Fixtures each group builds first

### 2.A Group A setup

```
# Two locations
POST /api/locations {"name":"QA0912-A-Showroom","address_line1":"400 Harbor St","city":"Asheville","state":"NC","postal_code":"28801"}
POST /api/locations {"name":"QA0912-A-Yard","address_line1":"90 Depot Rd","city":"Asheville","state":"NC","postal_code":"28801"}

# A lead WITH a service address.
# NOTE the address goes INSIDE new_customer, not at the top level. On the new_customer path the
# controller reads new_customer.location and SILENTLY IGNORES a top-level new_location, so the
# obvious-looking form returns 201 with service_location_id = NULL. Corrected 2026-09-12 after
# Lane A hit it.
POST /api/leads {"new_customer":{"company_name":"QA0912-A-Alder","email":"qa0912-a-alder@qa.servwave.test",
                                 "location":{"address_line1":"11 Cedar Lane","city":"Asheville","state":"NC","zip":"28801"}},
                 "service_request":"QA0912-A walkthrough door"}

# A job WITH a service address. Same rule, and here it is not silent: the top-level form is
# rejected outright with 400 {"field":"new_customer.location","message":"Required"}.
POST /api/jobs  {"new_customer":{"company_name":"QA0912-A-Birch","email":"qa0912-a-birch@qa.servwave.test",
                                 "location":{"address_line1":"22 Cedar Lane","city":"Asheville","state":"NC","zip":"28801"}},
                 "scope_notes":"QA0912-A job doors"}
```

**Verify the fixture before trusting a scenario that depends on it.** Any scenario asserting a
fallback *to* the parent's service address (S21, S22a, S27, S30) fails for a fixture reason, not a
product reason, if this came back NULL:

```sql
select service_location_id is not null as has_address from leads where id = '<LEAD_ID>';
```

A visit can also be PATCHed onto a service location afterwards with a top-level `new_location` —
the update door does honour that key, which is how a mis-created fixture is repaired rather than
rebuilt.

Record: `LOC_A_SHOWROOM`, `LOC_A_YARD`, `LEAD_A`, `JOB_A`, and one active user id `USER_A` to use as
a performer (any active user from `GET /api/users`; you will not modify it).

### 2.B Group B setup

```
POST /api/locations {"name":"QA0912-B-Showroom","address_line1":"12 Harbor St","city":"Asheville","state":"NC","postal_code":"28801"}   -> LOC_B_SHOWROOM
POST /api/locations {"name":"QA0912-B-Nameonly"}   # a NAME and NO address at all               -> LOC_B_NAMEONLY
POST /api/leads  … company_name QA0912-B-Cedar,   address INSIDE new_customer.location (see §2.A) -> LEAD_B
POST /api/leads  … company_name QA0912-B-Dogwood, NO new_location and NO service_address_*      -> LEAD_B_NOADDR
POST /api/jobs   … company_name QA0912-B-Elm,     address INSIDE new_customer.location          -> JOB_B
```

Fixture users come from `GET /api/users` — pick three **active** ones.

Confirm `LEAD_B_NOADDR` really has none:
`psql "$DB" -At -c "select service_location_id, service_address_line1 from leads where id='<LEAD_B_NOADDR>'"`
must return `|`. If the create path back-filled one, PATCH it to null before using it.

Two fixture users for the phone scenarios. Pick three active users, **record their original `phone`
and `phone_ext` before touching anything** (all three are null today), and set two of them through
`PATCH /api/users/:id` (body `{"phone":"…","phone_ext":"…"}`):

| | phone sent | phone_ext | stored as | renders as |
|---|---|---|---|---|
| `USER_B1` | `+15550100142` | `214` | `+15550100142` | `(555) 010-0142 ext. 214` |
| `USER_B2` | `+15550100143` | *(null)* | `+15550100143` | `(555) 010-0143` |
| `USER_B3` | *(leave null — this is the crew member with no number)* | | | |

The column stores E.164; `formatPhoneDisplay` is what turns it into the parenthesised form the
customer reads. The assertions below are always on the **display** form — an E.164 string in a
rendered subject is a leak of the column, not a phone number.

Then publish the two probes from §0.11.

### 2.C Group C setup

```
POST /api/locations {"name":"QA0912-C-Branch","address_line1":"7 Mill St","city":"Asheville","state":"NC"}
POST /api/locations {"name":"QA0912-C-Unused","address_line1":"8 Mill St","city":"Asheville","state":"NC"}
POST /api/leads  … company_name QA0912-C-Fir  -> LEAD_C
POST /api/jobs   … company_name QA0912-C-Gum  -> JOB_C
```

### 2.D/E/F Browser-lane setup

```
POST /api/locations {"name":"QA0912-D-Studio","address_line1":"31 Harbor St","city":"Asheville","state":"NC"}  -> LOC_D_STUDIO
POST /api/leads  … company_name QA0912-D-Hazel, address INSIDE new_customer.location (see §2.A) -> LEAD_D
POST /api/jobs   … company_name QA0912-D-Iris,  address INSIDE new_customer.location            -> JOB_D
```

Group E additionally needs one reachable performer of its **own** — never Group B's. Pick an active
user, record its original `phone` / `phone_ext` (both null today), and
`PATCH /api/users/<id> {"phone":"+15550100144","phone_ext":"307"}` → `USER_E1`, which renders as
`(555) 010-0144 ext. 307`. Restore it in §6.

Log the browser in by injecting the staging session into `localStorage` with the JS tool (the
`--inject` snippet from `qa-session.mjs`). **Never navigate to the magic link** — staging's
configured site URL points at the production frontend and the link lands there.

---

## GROUP A — the write doors and what they store
*Lane 1. API + DB only. Proves slice 1, 3 and 4's storage half, D3, D8, and the three states.*

Each scenario's pass condition is read with one query. Define it once:

```
cols() { psql "$DB" -At -c "select coalesce(location_id::text,'NULL')||' | '||coalesce(location_address_line1,'NULL')||' | '||coalesce(location_address_line2,'NULL')||' | '||coalesce(location_city,'NULL')||' | '||coalesce(location_state,'NULL')||' | '||coalesce(location_zip,'NULL') from visits where id='$1'"; }
```

### S01 — Walkthrough booked at a company location
**Proves** stories 1 and 3, D1, D2. Slice 1 acceptance line 1's storage half.
**Setup** Group A.
**Steps**
1. `POST /api/leads/<LEAD_A>/walkthrough/schedule` with
   `{"walkthrough_scheduled_at":"<now+10d, ISO Z>","walkthrough_duration_minutes":60,"performer_ids":["<USER_A>"],"location":{"location_id":"<LOC_A_SHOWROOM>"}}`
2. Find the visit: `psql "$DB" -At -c "select id from visits where lead_id='<LEAD_A>' order by created_at desc limit 1"` → `VISIT_A1`.
3. `cols VISIT_A1`.
**Pass** HTTP 200, and `cols` prints `<LOC_A_SHOWROOM> | NULL | NULL | NULL | NULL | NULL`.
**Cleanup** none (fixtures swept in §6).

### S02 — Walkthrough booked at a one-off address, parsed into five columns
**Proves** story 4, D4. Slice 1 acceptance lines 2 and 3.
**Steps**
1. Same door on `LEAD_A`, `"location":{"address_line1":"QA0912 One-Off 400 Harbor St","address_line2":"Suite 4","city":"Asheville","state":"NC","zip":"28801"}`.
2. `cols VISIT_A1` (the same visit — this door upserts the active walkthrough).
**Pass** HTTP 200, and `cols` prints
`NULL | QA0912 One-Off 400 Harbor St | Suite 4 | Asheville | NC | 28801`.
The address is in five columns, **not** one blob in line 1, and `location_id` is NULL — picking a
one-off clears the previous company location rather than leaving both set.

### S03 — Walkthrough booked with no location at all
**Proves** story 2, D3's third state. Slice 1 acceptance line 5.
**Steps**
1. Same door on `LEAD_A` with `"location": null`.
2. `cols VISIT_A1`.
**Pass** HTTP 200 and `cols` prints `NULL | NULL | NULL | NULL | NULL | NULL`. All six columns null
is the service address, which is exactly what every visit written before this feature means.

### S04 — Omitting `location` on the walkthrough door leaves it alone
**Proves** slice 1 acceptance line 7 — "rescheduling the time only leaves the location alone".
**Steps**
1. Put the visit back at the showroom (repeat S01's call).
2. Re-post the **same** door with a **new time** and **no `location` key in the body at all**:
   `{"walkthrough_scheduled_at":"<now+11d>","walkthrough_duration_minutes":60,"performer_ids":["<USER_A>"]}`
3. `cols VISIT_A1`; also read `scheduled_at`.
**Pass** `scheduled_at` moved to the new time **and** `location_id` is still `<LOC_A_SHOWROOM>` with
all five one-off columns NULL. A relocated visit here is a FAIL even if everything else is right.

### S05 — The additional-visit door books at its own location
**Proves** stories 1, 3, 5; slice 3 acceptance lines 1 and 5.
**Steps**
1. `POST /api/leads/<LEAD_A>/visits` with
   `{"scheduled_at":"<now+20d>","duration_minutes":60,"assignee_ids":["<USER_A>"],"force":true,"location":{"location_id":"<LOC_A_YARD>"}}` → `VISIT_A2`.
2. `POST /api/leads/<LEAD_A>/visits` again, `<now+21d>`, **no `location` key** → `VISIT_A3`.
3. `cols` on `VISIT_A1`, `VISIT_A2`, `VISIT_A3`.
**Pass** `VISIT_A2` = `<LOC_A_YARD> | NULL×5`; `VISIT_A3` = all six NULL; **and `VISIT_A1` is
unchanged from S04** — `<LOC_A_SHOWROOM>`. Neither write disturbed the other.

### S06 — The job-visit create door, all three states
**Proves** slice 4's create door.
**Steps** Three calls to `POST /api/jobs/<JOB_A>/visits`, each
`{"scheduled_start":"<t>","scheduled_end":"<t+2h>","assignee_ids":[]}` plus, respectively:
`"location":{"location_id":"<LOC_A_SHOWROOM>"}` → `JV1`; `"location":{"address_line1":"QA0912 One-Off 55 Mill St","city":"Asheville","state":"NC"}` → `JV2`; no `location` key → `JV3`.
**Pass** `JV1` = `<LOC_A_SHOWROOM> | NULL×5`. `JV2` = `NULL | QA0912 One-Off 55 Mill St | NULL | Asheville | NC | NULL`
— note `address_line2` and `zip` are NULL, not `''`. `JV3` = all six NULL.

### S07 — The job PATCH door can set a location
**Proves** story 5 on the job side.
**Steps** `PATCH /api/jobs/<JOB_A>/visits/<JV3>` with `{"location":{"location_id":"<LOC_A_YARD>"}}`.
**Pass** 200 and `cols JV3` = `<LOC_A_YARD> | NULL×5`. Then
`PATCH … {"location":null}` → `cols JV3` = all six NULL.

### S08 — **Omitted means unchanged on the job PATCH door**
**Proves** slice 4 acceptance line 2, and the single most-hit regression surface: dragging a card on
the board sends a window and nothing else.
**Setup** `PATCH /api/jobs/<JOB_A>/visits/<JV3>` with `{"location":{"location_id":"<LOC_A_YARD>"}}`
so the trip stands at the yard.
**Steps**
1. `PATCH /api/jobs/<JOB_A>/visits/<JV3>` with **only** `{"scheduled_start":"<t+1h>","scheduled_end":"<t+3h>"}`.
   No `location` key anywhere in the body.
2. `cols JV3`; also read `scheduled_at`.
**Pass** `scheduled_at` moved by one hour **and** `location_id` is still `<LOC_A_YARD>`. A move that
relocates the trip is the defect this scenario exists to catch: anything other than `<LOC_A_YARD>`
here is FAIL, and a `NULL` specifically means the crew was silently sent to the customer's address.
**Repeat once more** with a body carrying only `{"assignee_ids":["<USER_A>"]}` — re-crewing must
also leave the location alone.

### S09 — Both shapes in one body are refused by the schema, on all four doors
**Proves** slice 1 acceptance line 8, slice 3 line 4, slice 4 line 6. D3's "not both" is enforced at
the wire, not discovered when the database CHECK fires.
**Steps** Send `"location":{"location_id":"<LOC_A_SHOWROOM>","address_line1":"QA0912 X","city":"Asheville","state":"NC"}`
to each of: `POST /leads/<LEAD_A>/walkthrough/schedule`, `POST /leads/<LEAD_A>/visits`,
`POST /jobs/<JOB_A>/visits`, `PATCH /jobs/<JOB_A>/visits/<JV3>`.
**Pass** All four return **400**. None returns 500, and none returns 200. The response must not be
a database error string — `visits_location_not_both` appearing in any response body is a FAIL
(it means the schema let it through and Postgres caught it).
**Also** `cols JV3` is unchanged after the PATCH attempt.

### S10 — A half-typed one-off address is refused
**Proves** slice 1 acceptance line 4; D4's "line 1, city and state required together".
**Steps** Four calls to `POST /api/leads/<LEAD_A>/visits` (valid time, `force:true`), varying only
`location`:
(a) `{"address_line1":"QA0912 X","state":"NC"}` — no city
(b) `{"address_line1":"QA0912 X","city":"Asheville"}` — no state
(c) `{"city":"Asheville","state":"NC"}` — no line 1
(d) `{"address_line1":"   ","city":"Asheville","state":"NC"}` — blank-after-trim line 1
**Pass** All four return **400**. Count the lead's visits before and after: unchanged.

### S11 — Blank optional parts collapse to NULL, never to an empty string
**Proves** the slice-3 fix in `optionalAddressPart`: of the six columns, `zip` and `address_line2`
were the ones where "nothing" could be stored as `''`.
**Steps** `POST /api/leads/<LEAD_A>/visits` with
`"location":{"address_line1":"  QA0912 One-Off 77 Mill St  ","address_line2":"   ","city":"  Asheville  ","state":" NC ","zip":"   "}`
**Pass** 200, and `cols` on the new visit prints exactly
`NULL | QA0912 One-Off 77 Mill St | NULL | Asheville | NC | NULL`.
Three separate claims, all required: the required fields are stored **trimmed**; `address_line2` and
`zip` are **NULL, not `''`**; and nothing is stored as whitespace. Confirm the NULLs are real:
`psql "$DB" -At -c "select location_zip is null, location_address_line2 is null from visits where id='<id>'"` → `t|t`.

### S12 — A two-character state cap
**Proves** the deliberate `max(2)` on `state`, matching the field that enters it.
**Steps** `POST /api/leads/<LEAD_A>/visits` with `"location":{"address_line1":"QA0912 X","city":"Asheville","state":"North Carolina"}`.
**Pass** 400.

### S13 — `POST /jobs/:id/assign` first-booking is unchanged
**Proves** slice 4 acceptance line 3, and the spec's "a fifth path creates visits and deliberately
gets no change".
**Setup** A fresh job with no visits: create `JOB_A2` the same way as `JOB_A`
(customer `QA0912-A-Cedar`).
**Steps**
1. `POST /api/jobs/<JOB_A2>/assign` with the body the board sends — a window and a crew:
   `{"scheduled_start":"<now+5d>","scheduled_end":"<now+5d +2h>","assignee_ids":["<USER_A>"]}`.
   Do **not** send a `location` key; the schema does not have one.
2. `psql "$DB" -At -c "select id from visits where job_id='<JOB_A2>'"` → exactly one visit.
3. `cols` that visit.
**Pass** One visit, all six columns NULL. That derives to the service address, which is exactly
today's behaviour. If `/assign` grew a `location` key in the schema, that is also a FAIL — send
`"location":{"location_id":"<LOC_A_SHOWROOM>"}` and confirm the response is 400 (unknown key) or
that the stored columns stay NULL.

### S14 — The database CHECK is still the backstop
**Proves** D3's CHECK `visits_location_not_both` exists and fires. **This is the one scenario in the
document that writes raw SQL, and it writes to one fixture visit created by Group A.**
**Steps**
```
psql "$DB" -c "update visits set location_id='<LOC_A_SHOWROOM>', location_address_line1='QA0912 both' where id='<JV2>'"
```
**Pass** The statement **fails** with `new row for relation "visits" violates check constraint
"visits_location_not_both"`. Then confirm the constraint and the FK are both present:
```
psql "$DB" -At -c "select conname from pg_constraint where conname in ('visits_location_not_both','visits_location_id_fkey') order by 1"
```
prints both names. And `cols JV2` is unchanged (the failed update rolled back).

---

## GROUP B — merge fields, the D7 fallbacks, phones, and the multi-visit trap
*Lane 2. API + DB. Proves stories 8–13, D5, D6, D7, and slice 5 in full.*

### S15 — The four fields are in the catalog with a label and a sample
**Proves** stories 8 and 9; D6; slice 1/4/5's catalog lines.
**Steps** `GET /api/workflows/catalog`, then for each of
`lead.walkthrough_location`, `lead.performer_phones`, `job.visit_location`, `technician.phones`:
read `merge_field_labels[<field>]` and `sample_context[<field>]`.
**Pass** All four keys present in **both** maps. Labels exactly `Walkthrough location`,
`Walkthrough team phone(s)`, `Job visit location`, `Technician phone(s)`. Samples exactly
`Showroom, 12 Harbor St, Asheville, NC`, `(555) 204-7791`,
`North Yard, 40 Depot Rd, Richmond, VA`, `(555) 204-7794 ext. 12`. An empty string in either map is
a FAIL.

### S16 — The four labels are distinct from each other and from their neighbours
**Proves** D5 — "naming follows the surface, not a generic word", and that the picker does not show
two chips a person cannot tell apart.
**Steps** From the same catalog response, collect the labels of
`lead.address`, `job.address`, `lead.walkthrough_location`, `job.visit_location`,
`lead.performer_names`, `lead.performer_phones`, `technician.names`, `technician.phones`.
**Pass** `lead.address` and `job.address` are **both** `Service address` (unchanged — they genuinely
mean the same thing). The two new location labels are **different from each other** and **different
from `Service address`**. The two new phone labels are different from each other and from the two
name labels. Any duplicate among the four new labels is a FAIL.

### S17 — The four fields carry the load-bearing prefixes
**Proves** the spec's "frontend grouping is automatic … the prefixes are load-bearing"; slice 1
acceptance line 11 and slice 4 line 5, at the API layer. The DOM half is S43.
**Steps** From the catalog, read `triggers.WALKTHROUGH_SCHEDULED.mergeFields` and
`triggers.JOB_SCHEDULED.mergeFields`.
**Pass** `WALKTHROUGH_SCHEDULED` contains `lead.walkthrough_location` and `lead.performer_phones`
and does **not** contain `job.visit_location` or `technician.phones`. `JOB_SCHEDULED` contains
`job.visit_location` and `technician.phones` and does **not** contain either `lead.` field. Every
one of the four names starts with a prefix in the known set (`lead.`, `job.`, `technician.`) — a
name with any other prefix would fall into "Other" in the picker.

### S18 — A job field in a walkthrough automation blocks publish, with the remedy
**Proves** the field list is enforcement and not advertisement, and pins `46fcc6d73`'s copy.
**Steps**
1. `POST /api/workflows` with `trigger_type:"WALKTHROUGH_SCHEDULED"` and a SEND_EMAIL step whose
   body contains `{{job.visit_location}}`.
2. `POST /api/workflows/<id>/publish {"enable":false}`.
**Pass** The response reports an issue at `path: "config.body"` whose `message` is **exactly**
`The field {{job.visit_location}} isn’t available for this trigger, so this automation can’t be published. Open this step and remove the field, or pick a replacement from the Insert a field list`
— including both curly apostrophes. The workflow does not become published/enabled.
**Cleanup** `DELETE /api/workflows/<id>`.

### S19 — A walkthrough at a company location renders that location, not the customer's
**Proves** stories 1, 8, 11; slice 1 acceptance line 1 end to end. This is the tracer bullet.
**Setup** Group B's lead probe is published and enabled.
**Steps**
1. `POST /api/leads/<LEAD_B>/walkthrough/schedule` with a future time, `performer_ids:["<USER_B1>"]`,
   `"location":{"location_id":"<LOC_B_SHOWROOM>"}`, and **no `notify_customer` key**.
2. Wait for the poller — poll every 20s for up to 4 minutes:
```
psql "$DB" -At -c "select r.status, r.detail from workflow_step_runs r join workflow_enrollments e on e.id=r.enrollment_id where e.entity_id='<LEAD_B>' order by r.created_at desc limit 1"
```
**Pass** status `SENT`, and `detail` contains the literal substring
`loc=[QA0912-B-Showroom, 12 Harbor St, Asheville, NC]`.
Three claims in one: the location's **name leads**, then line 1, city, state, comma-separated; it is
**not** the customer's `11 Cedar Lane`; and the token was resolved, not printed.
Cross-check the mirror: `psql "$DB" -At -c "select subject from emails where organization_id='00000000-0000-0000-0000-000000000001' and subject like 'QA0912-B loc=%' order by ts desc limit 1"` shows the same string.

### S20 — A one-off address renders in the same format a service address renders in
**Proves** slice 1 acceptance line 2 — "same field order, same separators".
**Steps**
1. Rebook `LEAD_B`'s walkthrough with
   `"location":{"address_line1":"QA0912 One-Off 400 Harbor St","address_line2":"Suite 4","city":"Asheville","state":"NC","zip":"28801"}`.
2. Read the newest step run for `LEAD_B` as in S19.
**Pass** `detail` contains `loc=[QA0912 One-Off 400 Harbor St, Asheville, NC]` and, in the same
string, `addr=[11 Cedar Lane, Asheville, NC]`. The two are **indistinguishable in shape**: line 1,
city, state, joined by `, `. Neither `address_line2` nor `zip` appears in the rendered location —
that is correct and matches how the service address renders.

### S21 — No location falls back to the parent's service address, byte for byte
**Proves** story 10, D7's primary branch; slice 1 acceptance line 5.
**Steps** Rebook `LEAD_B`'s walkthrough with `"location": null`; read the newest step run.
**Pass** `detail` contains `loc=[11 Cedar Lane, Asheville, NC]` **and** `addr=[11 Cedar Lane, Asheville, NC]`,
and the two bracketed strings are **character-identical**. They must be the same string, not two
similar ones — the fallback is the same value `{{lead.address}}` renders in that very email.

### S22 — **Never an empty string and never a raw token**, in every degenerate state
**Proves** D7 in full; slice 1's "this is the part that would ship a broken customer email".
**Setup** `LEAD_B_NOADDR` (no service location, no legacy service address) and `QA0912-B-Nameonly`
(a location with a name and no address at all).
**Steps** Book `LEAD_B_NOADDR`'s walkthrough three times, reading the step run after each:
(a) `"location": null` — no visit location **and** no service address
(b) `"location":{"location_id":"<LOC_B_NAMEONLY>"}` — a location whose only text is its name
(c) `"location":{"address_line1":"QA0912 One-Off 9 Pine","city":"Asheville","state":"NC"}`
**Pass**
- (a) `loc=[the address we have on file for you]` — the exact phrase. **Not** `loc=[]`, **not**
  `loc=[{{lead.walkthrough_location}}]`, **not** `loc=[.]`, **not** `loc=[ ]`.
- (b) `loc=[QA0912-B-Nameonly]` — just the name, which is non-empty and honest.
- (c) `loc=[QA0912 One-Off 9 Pine, Asheville, NC]` — a one-off still renders even with no service
  address behind it.
In none of the three does the rendered subject contain `{{` or `[]` or `[ ]`. Grep the whole
`detail` for `{{` — any hit anywhere is a FAIL.

### S23 — The performer's own number reaches the customer
**Proves** story 12; slice 5 acceptance lines 1 and 2.
**Steps** Book `LEAD_B`'s walkthrough with `performer_ids:["<USER_B1>"]` (phone `+15550100142`,
ext `214`) and `"location": null`. Read the step run.
**Pass** `detail` contains `phones=[(555) 010-0142 ext. 214]`.
Two claims: the number is rendered **for display**, not as the stored E.164 `+15550100142` — a `+1`
prefix in the subject is a FAIL (it is a leak of the column, not a phone number); and the extension
is attached to its number as **one** contact, not as a second comma-separated value.

### S24 — **A mixed crew renders the numbers that exist, not the main line**
**Proves** slice 5 acceptance line 4 — "the fallback is for nobody having a number, not for anybody
lacking one". This is the branch most likely to be written backwards.
**Steps** Book `LEAD_B`'s walkthrough with `performer_ids:["<USER_B1>","<USER_B3>"]` — one person
with a number, one without. Read the step run.
**Pass** `detail` contains `phones=[(555) 010-0142 ext. 214]` — exactly the one number that exists.
It must **not** be `our office`, must **not** be the org main line, and must **not** contain a
trailing or leading comma from the missing person.
**Then** add `USER_B2` (`+15550100143`, no extension) and rebook with all three. The rendered value
contains **both** contacts, comma-separated — `(555) 010-0142 ext. 214` and `(555) 010-0143` — with
the extensionless one carrying no `ext.`. Do not assert their order: the crew array's order is not
the order `performer_ids` was sent in, and pinning it would make this scenario fail for the wrong
reason.

### S25 — Nobody has a number, and the organisation has no main line
**Proves** story 13's floor, and D7's last resort. This is the state staging is in today.
**Setup** Confirm the org line is still empty:
`psql "$DB" -At -c "select coalesce('['||phone||']','NULL') from organizations where id='00000000-0000-0000-0000-000000000001'"` → `[]`.
**Steps** Book `LEAD_B`'s walkthrough with `performer_ids:["<USER_B3>"]` only. Read the step run.
**Pass** `detail` contains `phones=[our office]` — the exact lower-case phrase, which reads mid
sentence. Not `[]`, not `[{{lead.performer_phones}}]`, not `[.]`.

### S26 — Nobody has a number, and the organisation *does* have a main line
**Proves** story 13 as written; slice 5 acceptance line 3. **Mutates org settings — restores in the
same scenario.** If you would rather not touch the org row, run this in lane 5 instead (S47 does).
**Steps**
1. Record the current value (it is `''`). `PATCH /api/organization {"phone":"(555) 010-0199"}`.
2. Book `LEAD_B`'s walkthrough with `performer_ids:["<USER_B3>"]`. Read the step run.
3. **Restore**: `PATCH /api/organization {"phone":""}`.
**Pass** `detail` contains `phones=[(555) 010-0199]` — the organisation's main line, the same value
`{{org.phone}}` renders. Step 3 must be executed even if step 2 failed; re-read the column to
confirm it is `''` again.

### S27 — The job side's location field, and its fallback
**Proves** stories 9 and 11; slice 4 acceptance lines 1 and 4.
**Steps**
1. `POST /api/jobs/<JOB_B>/visits` with `"location":{"location_id":"<LOC_B_SHOWROOM>"}` and no
   `notify` key. Read the enrollment payload:
```
psql "$DB" -At -c "select event_payload->'mergeFields'->>'job.visit_location' from workflow_enrollments where entity_id='<JOB_B>' order by started_at desc limit 1"
```
2. Book a second visit at a later date with **no `location` key**. Read the newest payload again.
**Pass** (1) prints `QA0912-B-Showroom, 12 Harbor St, Asheville, NC`. (2) prints the job's own
service address string — the same one `{{job.address}}` renders — and **not** empty, **not** the
token, **not** the showroom.

### S28 — `technician.phones` on the job side
**Proves** story 12 on the job half; slice 5 acceptance line 7's job side.
**Steps** `POST /api/jobs/<JOB_B>/visits` with `assignee_ids:["<USER_B1>","<USER_B3>"]`. Read
`event_payload->'mergeFields'->>'technician.phones'` for the newest enrollment on `JOB_B`.
**Pass** `(555) 010-0142 ext. 214` — the one reachable crew member, not `our office`.

### S29 — A reschedule that re-crews nobody still renders the crew's numbers
**Proves** the one crew read in this feature the compiler does not hold (the PATCH pre-read's
`select`). A regression here renders the main line for a crew who are perfectly reachable.
**Steps**
1. Take the visit from S28 (crewed with `USER_B1` + `USER_B3`).
2. `PATCH /api/jobs/<JOB_B>/visits/<that visit>` with **only** a new `scheduled_start` /
   `scheduled_end`. No `assignee_ids`, no `location`.
3. Read the newest enrollment for `JOB_B` — it will be a `JOB_RESCHEDULED` one — and pull
   `event_payload->'mergeFields'->>'technician.phones'`.
**Pass** `(555) 010-0142 ext. 214`. `our office` here is the exact silent degradation this
scenario exists to catch.

### S30 — **The multi-visit trap**
**Proves** the most serious defect this build found: a reachable email reading *"your visit is on
<date A> … meet us at <place A>"* for a trip that is on date B at place B. Spec D18 / slice 4's
`visitLocationForOccurrence`.
**Setup** A job with **no** visits: create `JOB_B2` (customer `QA0912-B-Fir`) with a service
address. The job probe (7-day WAIT, sends nothing) is enabled.
**Steps**
1. Book **visit 1**: `POST /api/jobs/<JOB_B2>/visits`, start `<now+10d>`,
   `"location":{"location_id":"<LOC_B_SHOWROOM>"}`, no `notify`.
2. Book **visit 2**: same door, start `<now+30d>`, **no `location` key** (so it sits at the
   customer's service address), no `notify`.
3. Read both enrollments in order:
```
psql "$DB" -At -c "select started_at, event_payload->'mergeFields'->>'job.scheduled_date', event_payload->'mergeFields'->>'job.visit_location' from workflow_enrollments where entity_id='<JOB_B2>' order by started_at asc"
```
**Pass** Exactly two rows.
- Row 1: date = the **now+10d** date, location = `QA0912-B-Showroom, 12 Harbor St, Asheville, NC`.
- Row 2: date = the **now+30d** date, location = the **job's service address string**.

The failure this catches is row 2 carrying row 1's date and/or row 1's location, because the job's
per-entity resolution answers with the job's *next upcoming* visit. **Row 2 naming the showroom, or
naming the now+10d date, is FAIL — and it is the FAIL that matters most in this document.**
**Also assert the pairing**: within each row the date and the location describe the **same trip**.
A row with visit 2's date beside visit 1's address is the exact customer-facing defect, and it is
worse than either being wrong alone.
**Then repeat for a move.** `PATCH /api/jobs/<JOB_B2>/visits/<visit 1>` to a new window with no
`location` key; the `JOB_RESCHEDULED` enrollment's payload must carry **visit 1's** new date beside
**visit 1's** showroom — not visit 2's anything.

### S31 — Two visits on one lead at two different places
**Proves** slice 3 acceptance line 2, and the spec's constraint that walkthrough fields resolve
against the lead's *current* visit. This is documented behaviour, not a bug — the scenario pins it
so a change is noticed rather than found in an inbox.
**Setup** `LEAD_B` with its active walkthrough at `QA0912-B-Showroom` on `<now+10d>`.
**Steps**
1. `POST /api/leads/<LEAD_B>/visits` with `<now+5d>` (i.e. **earlier** than the active one) and
   `"location":{"address_line1":"QA0912 One-Off 9 Pine","city":"Asheville","state":"NC"}`, `force:true`.
2. Confirm both visits exist with different locations:
   `psql "$DB" -At -c "select id, scheduled_at, coalesce(location_id::text, location_address_line1) from visits where lead_id='<LEAD_B>' order by scheduled_at"`.
3. `GET /api/leads/<LEAD_B>` and read `walkthrough_location_label` and `walkthrough_scheduled_at`.
4. Rebook the active walkthrough (any no-op change through `/walkthrough/schedule` with the same
   time and location) to enrol the probe, and read the step run's `loc=[…]` and the catalog-rendered
   `{{lead.walkthrough_date}}`.
**Pass** The **same visit** answers all three questions: whichever visit `walkthrough_scheduled_at`
points at is the visit whose location appears in `walkthrough_location_label`, and is the visit
whose location appears in the rendered `loc=[…]`. Do **not** assert a hard-coded winner — assert the
**agreement**. A rendered location belonging to a visit other than the one the rendered date belongs
to is FAIL.

---

### S32 — **Pointer, not copy: correcting the address in Settings changes an unsent reminder**
**Proves** story 6, **D2**, and slice 1 acceptance line 6 — the single reason `location_id` is a
foreign key instead of a snapshot taken at booking time.
**Setup** `LEAD_B`'s active walkthrough standing at `QA0912-B-Showroom`
(`12 Harbor St, Asheville, NC`), with the lead probe enabled.
**Steps**
1. Book it and let the probe render once. Record the `loc=[…]` value → `BEFORE`.
2. Record the visit row's own columns and its `updated_at`:
```
psql "$DB" -At -c "select updated_at, location_id, coalesce(location_address_line1,'NULL'), coalesce(location_city,'NULL') from visits where id='<the visit>'"
```
3. Correct the location **in Settings**, not on the visit:
   `PATCH /api/locations/<LOC_B_SHOWROOM> {"address_line1":"14 Harbor St"}`
4. Re-enrol the probe **without touching the location**: re-post `/walkthrough/schedule` with the
   same time, the same performers, and `"location":{"location_id":"<LOC_B_SHOWROOM>"}` — or simply
   read the label the card now renders (`GET /api/leads/<LEAD_B>` →
   `walkthrough_location_label`), which is resolved through the same formatter.
5. Read the new `loc=[…]` → `AFTER`, and re-read the visit row from step 2.
**Pass**
- `BEFORE` contains `12 Harbor St`; `AFTER` contains `14 Harbor St`. The correction reached the
  reminder.
- The visit's own **six location columns are unchanged** — `location_id` is the same uuid and all
  five one-off columns are still NULL. The visit stores a pointer; it stores no copy of the street.
- `walkthrough_location_label` from `GET /api/leads/<LEAD_B>` also says `14 Harbor St`, resolved on
  the read rather than from anything stored on the visit.
- The job-side read shape carries no copy either: `GET /api/jobs/<JOB_B>/visits` returns
  `location_label` (a resolved string) and `visit_location` (the pointer), and **no `location`
  object**. A response carrying the Settings row's address fields is a FAIL — a client rendering
  from that copy keeps showing yesterday's address after an admin fixes the typo, which is exactly
  what D2 exists to prevent.
**Contrast — the one-off is frozen, deliberately.** Repeat steps 1–5 against a visit booked at a
one-off address instead. There is no Settings row to correct, and `BEFORE` and `AFTER` must be
identical. An ad-hoc address has nothing behind it to stay in step with, and that asymmetry is the
decision, not a gap.
**Cleanup** `PATCH /api/locations/<LOC_B_SHOWROOM> {"address_line1":"12 Harbor St"}` so later reads
of this fixture match the setup section.

---

## GROUP C — archive, restore, the delete refusal, and tenancy
*Lane 3. API + DB. Proves stories 7 and 16, D8, D9, and slice 2 in full.*

### S33 — Deleting a referenced location is refused with a 409 that names the count and the way out
**Proves** story 7; slice 1 acceptance line 10; slice 2 acceptance line 5.
**Steps**
1. Book a visit at `QA0912-C-Branch`: `POST /api/leads/<LEAD_C>/visits` with
   `"location":{"location_id":"<LOC_C_BRANCH>"}`, `force:true`.
2. `DELETE /api/locations/<LOC_C_BRANCH>`.
**Pass** HTTP **409**, not 500 and not 204. The `error` string contains `1 visit booked at it` (the
singular noun) **and** the sentence `Archive it instead`. A 500 here means the restricting foreign
key reached the caller raw. A 204 means a booked visit just lost its location.
**Then** book a **job** visit at the same location and delete again: the count becomes `2 visits
booked at it` — slice 4 acceptance line 7, the guard counts both sides.

### S34 — A location nothing references still deletes outright
**Proves** slice 2 acceptance line 4 — "forcing an admin to archive a typo would be worse".
**Steps** `DELETE /api/locations/<LOC_C_UNUSED>` (nothing points at it).
**Pass** HTTP **204**, and
`psql "$DB" -At -c "select count(*) from locations where id='<LOC_C_UNUSED>'"` → `0`.

### S35 — Archiving refuses a **new** booking at the API, not merely in the dropdown
**Proves** story 16; slice 2 acceptance line 1's real enforcement. Hiding an option is a courtesy; a
crafted body never opened a dropdown.
**Steps**
1. `POST /api/locations/<LOC_C_BRANCH>/archive`.
2. Confirm the row is still live and marked:
   `psql "$DB" -At -c "select is_active, archived_at is not null from locations where id='<LOC_C_BRANCH>'"` → `f|t`.
3. Attempt a **new** booking at it on each of the four doors:
   `POST /leads/<LEAD_C>/walkthrough/schedule`, `POST /leads/<LEAD_C>/visits`,
   `POST /jobs/<JOB_C>/visits`, and `PATCH /jobs/<JOB_C>/visits/<a visit standing elsewhere>` —
   each with `"location":{"location_id":"<LOC_C_BRANCH>"}`.
**Pass** All four return **400** with body exactly `{"error":"Location not found"}`. Not 403, not
409, not a message naming archiving — the refusal must be indistinguishable from "no such location"
(see S39). And `GET /api/locations` **still returns the row**, with `is_active:false` — the list is
deliberately unfiltered so Settings can offer the way back.

### S36 — A visit already standing at an archived location still resolves everywhere
**Proves** slice 2 acceptance line 2 — "no gap and no fallback to the service address". The visit
booked in S33 is still pointing at the now-archived `QA0912-C-Branch`.
**Steps**
1. `GET /api/leads/<LEAD_C>` → read `walkthrough_history[]` for that visit's `location_label`, and
   `walkthrough_location_label` if it is the current visit.
2. `GET /api/jobs/<JOB_C>/visits` → read the job visit's `location_label`.
3. Render it into an email: book/rebook through `/walkthrough/schedule` while standing at the
   archived location (S37 proves that is allowed) and read the probe's `loc=[…]`.
**Pass** All three carry `QA0912-C-Branch, 7 Mill St, Asheville, NC`. **None** of them is `null`,
empty, or the customer's own service address. A visit whose location vanished from its own card the
moment the branch closed is the exact failure D9 exists to prevent.
**Extra claim — the customer was already told.** Confirm this visit's `customer_email_sent_at` is
set (book it once with `notify_customer:true` beforehand if it is not), then re-run the three reads.
The location must survive the archive on a visit the customer has already been sent to.

### S37 — A visit standing at an archived location can still be rescheduled
**Proves** D9's own note: "a visit's own location stays editable for the life of the visit". This is
the `currentLocationId` exception, and getting it wrong 400s the one caller with no way through.
**Steps**
1. Take the **job** visit booked at `QA0912-C-Branch` in S33 (now archived).
2. `PATCH /api/jobs/<JOB_C>/visits/<that visit>` with a new window **and** the archived location
   restated: `{"scheduled_start":…,"scheduled_end":…,"location":{"location_id":"<LOC_C_BRANCH>"}}`
   — this is exactly what the booking form posts, because it states a location on every save.
3. `PATCH` again with a new window and **no** `location` key.
4. `PATCH` again attempting to move a **different** visit onto `QA0912-C-Branch`.
**Pass** (2) returns **200** and the visit keeps `location_id = <LOC_C_BRANCH>` at the new time.
(3) returns **200**, location unchanged. (4) returns **400** `{"error":"Location not found"}` — the
visit standing there may stay; nothing new may move onto it.

### S38 — Restore puts it back, and archiving is audited
**Proves** slice 2 acceptance lines 3 and 6.
**Steps**
1. `POST /api/locations/<LOC_C_BRANCH>/unarchive`.
2. `psql "$DB" -At -c "select is_active, archived_at from locations where id='<LOC_C_BRANCH>'"`.
3. Re-attempt a **new** booking at it (any door).
4. `POST /api/locations/<LOC_C_BRANCH>/archive` **twice in a row**.
5. Read the audit trail:
```
psql "$DB" -At -c "select action, created_at from audit_logs where org_id='00000000-0000-0000-0000-000000000001' and resource_id='<LOC_C_BRANCH>' order by created_at"
```
**Pass**
- (2) `t|` — active again and `archived_at` **cleared**, not left standing.
- (3) **200** — it is bookable again.
- (4) the first archive returns 200; the **second returns 404**, `archived_at` is **not**
  re-stamped, and no second pair of audit rows is written. A repeat archive that re-stamps the
  column destroys the only thing the column is for.
- (5) the trail contains `location.archived` and `location.unarchived` entries, the way
  `location.deleted` already appears.
**Cleanup** Leave `QA0912-C-Branch` archived or active — §6 deletes it either way (after its visits
go).

### S39 — **Cross-tenant refusal reveals nothing**
**Proves** D8; slice 1 acceptance line 9; slice 3 line 3; slice 4 line 6.
**Setup** Read — and only read — one location id belonging to another organisation:
```
psql "$DB" -At -c "select id from locations where organization_id <> '00000000-0000-0000-0000-000000000001' limit 1"
```
Call it `FOREIGN_LOC`. **Do not write to that organisation, book at it, or name it anywhere.**
Also mint a random uuid that exists nowhere: `RANDOM_UUID=$(uuidgen | tr 'A-Z' 'a-z')`.
**Steps** For each of the four write doors, send three bodies in turn:
(a) `"location":{"location_id":"<FOREIGN_LOC>"}`
(b) `"location":{"location_id":"<RANDOM_UUID>"}`
(c) `"location":{"location_id":"<LOC_C_BRANCH archived>"}`
Capture the full HTTP status, the response body, and (roughly) the response time for each.
**Pass** All twelve responses are **HTTP 400** with a body that is **byte-identical**:
`{"error":"Location not found"}`. Diff them programmatically — `sort -u` over the twelve bodies must
produce exactly one line. A 404, a different message for any one of the three cases, a body naming
the id, or a body saying "archived" is a FAIL: any of those makes the door an oracle for whether a
row exists in somebody else's organisation.
**Also** confirm nothing was written: no visit anywhere carries `FOREIGN_LOC`
(`psql "$DB" -At -c "select count(*) from visits where location_id='<FOREIGN_LOC>'"` → `0`).

---

## GROUP D — the surfaces that read a visit
*Lane 4, first. API assertions then DOM. Proves stories 14 and 15, and slice 6.*

### S40 — The three read shapes carry a resolved label
**Proves** slice 6's "wire it through the read shape once" at the API layer.
**Setup** On `LEAD_D`: the active walkthrough at `QA0912-D-Studio`, plus one earlier visit at a
one-off address, plus one at the service address. On `JOB_D`: one visit at `QA0912-D-Studio`, one at
the service address.
**Steps**
1. `GET /api/leads/<LEAD_D>` → `walkthrough_location_label`, and each `walkthrough_history[i].location_label`.
2. `GET /api/jobs/<JOB_D>/visits` → each `visits[i].location_label` and `visits[i].visit_location`.
3. `GET /api/jobs?…` (the board list that includes `visits`) → `jobs[…].visits[i].location_label`.
**Pass**
- The company-location visit's label is `QA0912-D-Studio, 31 Harbor St, Asheville, NC` on **all
  three** shapes.
- The one-off visit's label is `QA0912 One-Off …, Asheville, NC`.
- The service-address visit's label is **`null`** — present as a key, valued null. Not `""`, not the
  customer's address. `null` is the claim "this trip is at the service address", which is what makes
  the card read exactly as it did before.
- `visit_location` (the booking-form seed) is `null` for the service-address visit, and for the
  company-location visit is `{"location_id":"<LOC_D_STUDIO>","address_line1":null,…}` — the pointer,
  never a copied address.

### S41 — **The card and the email agree about where the same visit is**
**Proves** slice 6 acceptance line 4 — asserted as an agreement, not as two isolated checks. A second
resolution is a second chance for the card and the email to disagree, and that disagreement is
invisible until somebody drives.
**Steps** For each of three visits on `LEAD_D` — company location, one-off, service address — read
**both**:
- `CARD` = `walkthrough_location_label` from `GET /api/leads/<LEAD_D>` (with that visit current)
- `EMAIL` = the `loc=[…]` substring from the probe's rendered subject for that same visit
**Pass** For each visit, **one** of these holds, and the right one:
- `CARD` is non-null → `EMAIL` is **character-identical to `CARD`**.
- `CARD` is `null` → `EMAIL` is **character-identical to the `addr=[…]` value in the same subject**
  (the string `{{lead.address}}` renders), or to `the address we have on file for you` when the
  parent has no address at all.
Any pair where both are non-null and differ is FAIL, however plausible each looks alone.
**Repeat once on the job side** with `location_label` from `GET /api/jobs/<JOB_D>/visits` against
`event_payload->'mergeFields'->>'job.visit_location'`.

### S42 — The line appears on the three surfaces, and stays absent on the common case
**Proves** stories 14 and 15; slice 6 acceptance lines 1 and 3. **Browser. Carries HUMAN EYE item
H2 — see §5.**
**Steps**
1. Navigate to `/leads/<LEAD_D>`, open the walkthrough tab. `find` for `visit-location`; then
   `get_page_text`.
2. Navigate to `/jobs/<JOB_D>`, find the Visits card.
3. Navigate to the schedule, open the visit detail dialog for the `QA0912-D-Studio` trip.
4. On each surface, run in the JS tool:
   `[...document.querySelectorAll('[data-testid="visit-location"]')].map(e=>e.textContent)`
**Pass**
- Lead walkthrough tab: the array contains `QA0912-D-Studio, 31 Harbor St, Asheville, NC` (the
  current visit's line) and, in the history list, the one-off visit's string.
- Job visits card: the array contains the studio string for the studio trip.
- Schedule detail: the array contains the studio string.
- **The service-address visit contributes no element at all** — on every one of the three surfaces.
  Count the rendered visit rows and count the `visit-location` elements: there must be **strictly
  fewer** location elements than visit rows, and the missing ones must be exactly the
  service-address trips. An element present but empty (`textContent === ''`) is FAIL — that is the
  "empty marked line" the formatter's blank-check exists to prevent.
- The element's parent carries an `sr-only` `Location: ` prefix (assert
  `el.parentElement.textContent.startsWith('Location: ')`).

---

## GROUP E — the picker, and an automation authored end to end
*Lane 4, second. Browser + API.*

### S43 — The four chips land in the right groups, never in "Other"
**Proves** stories 8 and 9 at the surface; slice 1 acceptance line 11; slice 4 line 5; slice 5
line 7. **Browser. Carries HUMAN EYE item H4 — see §5.**
**Steps**
1. Open the Automation Center, create a new automation on trigger **Walkthrough scheduled**, add a
   Send email step, and open the step so the "Insert a field" picker renders.
2. `read_page` the picker region. Each group header is a button whose `aria-label` is
   `<group> (<count>)`; each chip is a button whose `title` is `{{<field>}}` and whose visible text
   is the label.
3. Expand every group. Collect, for each chip, `(group header text, title, visible label)`.
4. Repeat on a new automation with trigger **Job scheduled**.
**Pass**
- On the walkthrough trigger: a chip with `title="{{lead.walkthrough_location}}"` and text
  `Walkthrough location`, and a chip with `title="{{lead.performer_phones}}"` and text
  `Walkthrough team phone(s)`, **both under the group header `Lead & walkthrough`**.
- On the job trigger: `{{job.visit_location}}` / `Job visit location` and `{{technician.phones}}` /
  `Technician phone(s)`, **both under the group header `Job`**.
- **No group labelled `Other` exists on either trigger.** If an `Other` group is present at all,
  read its chips and report them — a load-bearing prefix has been lost.
- The four labels are pairwise distinct, and distinct from the `Service address` chip sitting beside
  them in the same group.

### S44 — An automation authored end to end, chip to inbox
**Proves** the journey the whole feature exists to serve: stories 1, 8, 11, and D4's "a one-off
address maps like any other address". **Browser + API + DB. Carries HUMAN EYE item H3 — see §5.**
**Steps**
1. In the builder (still on **Walkthrough scheduled**), name the automation `QA0912-E showroom
   confirmation`. In the Send email step set recipients to **Customer only**, type a subject
   `QA0912-E your visit`, and in the body type
   `Please meet us at ` then **click the `Walkthrough location` chip** (do not type the token) then
   `. Questions? Call ` then **click the `Walkthrough team phone(s)` chip** then `.`
2. Assert from the DOM that the body field now contains the literal
   `{{lead.walkthrough_location}}` and `{{lead.performer_phones}}`, and that both chips now read as
   in use (`aria-pressed="true"`).
3. Publish and enable it.
4. Through the **app's own booking dialog** on `/leads/<LEAD_D>`: open the walkthrough scheduling
   form and set a future date/time and `USER_E1` as the performer.
   **4a — the picker's three states and the map.** Read `#v2-wt-picker`'s options. The **first** is
   `Service address`, the **last** is `Other`, and `QA0912-D-Studio` and
   `Hoboken Store` are both among the middle entries, name-sorted. Do not assert an exact option
   count — other lanes' fixture locations are live in the same organisation while you run. Do
   assert that **no option carries the `(archived)` suffix**: an archived location may only appear
   here when this very visit is standing at it, which it is not. Select `Other`
   and confirm the four extra fields appear with ids `v2-wt-oneoff-address_line1`,
   `-address_line2`, `-city`, `-state`, `-zip`. Type `31 Harbor St` / `Asheville` / `NC` into line
   1, city and state, then assert a map image rendered:
   `document.querySelector('img[src*="Harbor"]') !== null` — or, more robustly, that some `<img>`
   inside the form has a `src` containing the typed street and city. **Whether that tile depicts the
   right place is H3 and needs an eye.**
   **4b** Switch the picker back to `QA0912-D-Studio`, leave the customer-notify tick **off**, and
   save.
5. Wait for the poller (up to 4 minutes), then read:
```
psql "$DB" -At -c "select subject, body->>0 from emails where organization_id='00000000-0000-0000-0000-000000000001' and subject='QA0912-E your visit' order by ts desc limit 1"
```
**Pass** The stored body is exactly
`Please meet us at QA0912-D-Studio, 31 Harbor St, Asheville, NC. Questions? Call (555) 010-0144 ext. 307.`
No `{{`, no `at .`, no `Call .`, no `+1`. The corresponding `workflow_step_runs` row is `SENT`.
This is the only scenario in the document that drives the whole journey through the product's own
surfaces — chip to stored body — rather than through the API.
**Cleanup** `POST /api/workflows/<id>/toggle {"is_enabled":false}` immediately, then
`DELETE /api/workflows/<id>` in §6.

---

## GROUP F — mobile
*Lane 4, third. Browser.*

### S45 — 375px on the three surfaces that gained a line
**Proves** slice 6 acceptance line 5. **Partly HUMAN EYE — see §5.**
**Steps**
1. `resize_window` to `preset: "mobile"` (375×812). Reload.
2. On `/leads/<LEAD_D>`, `/jobs/<JOB_D>` and the schedule visit detail, run in the JS tool:
```
({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
   lines: [...document.querySelectorAll('[data-testid="visit-location"]')].map(e => ({
     text: e.textContent, w: e.getBoundingClientRect().width,
     right: Math.round(e.getBoundingClientRect().right), vw: window.innerWidth })) })
```
3. Reset with `resize_window` `preset: "desktop"` when finished.
**Pass (decidable half)** On all three surfaces: `overflow <= 0` (no horizontal page scroll); every
location line is present with the same text it had at desktop width; every line's `right` is
`<= vw`; every line's width is `> 0`.
**Pass (human half)** See §5 — whether the truncation reads acceptably and the line does not collide
with its neighbours is a judgement no assertion here makes.

---

## LANE 5 — exclusive scenarios
*Run last, alone, one agent. Both mutate org-wide state and both restore it.*

### S46 — An organisation with zero locations
**Proves** the spec's "an organisation with zero locations sees a picker offering only the service
address and the one-off — that is honest and needs no special-casing". Nothing else in the product
can produce this state, which is why it is exclusive. **Browser + API.**
**Steps**
1. Confirm every other lane has reported and no other agent is booking.
2. List every active location: `GET /api/locations` → note every `id` with `is_active !== false`.
   **Record the full list** — you are restoring all of them.
3. Archive **every** one of them, including the seed `Hoboken Store`
   (`0a6b99fb-1362-4fd6-871a-337ee4000c04`).
4. Open `/leads/<LEAD_D>`'s walkthrough scheduling form and read the picker's options:
   `[...document.querySelector('#v2-wt-picker').closest('[role],div').querySelectorAll('[role="option"]')].map(o=>o.textContent)`
   — or open the select and `read_page` it.
5. Open the job visit dialog on `/jobs/<JOB_D>` and read `#job-visit-location-picker` the same way.
6. **Restore**: unarchive every id recorded in step 2. Re-read `GET /api/locations` and confirm each
   one's `is_active` is `true` and `archived_at` is `null`.
**Pass** In steps 4 and 5 the picker offers **exactly two** options, in order: `Service address` and
`Other`. No third option, no empty option, no error state, no blank page. Step 6
restores every location — verify by count and by id, and report the verification line. **A run that
ends without step 6 completed is a FAIL of this scenario regardless of what step 4 showed.**

### S47 — The organisation's main line, set and restored
**Proves** story 13's main-line branch, with the org row mutated once and put back. Run this instead
of S26 if lane 2 chose not to touch the org row; run both and they agree.
**Steps**
1. Record: `psql "$DB" -At -c "select coalesce('['||phone||']','NULL') from organizations where id='00000000-0000-0000-0000-000000000001'"` → expect `[]`.
2. `PATCH /api/organization {"phone":"(555) 010-0199"}`.
3. Book a walkthrough on a lane-5 fixture lead with a performer who has **no** phone number, through
   an enabled probe. Read the step run's `phones=[…]`.
4. **Restore**: `PATCH /api/organization {"phone":""}` and re-read the column.
**Pass** (3) renders `phones=[(555) 010-0199]`. (4) leaves the column `''` again, verified by the
same query as (1). **Step 4 is mandatory** — the demo org's main line being left populated changes
what S25 measures for every future run.

---

## 5. Scenarios that need a human to look at a screen

Four, and only four. Everything else in this document is decided by an assertion.

| # | What needs an eye | Why no assertion covers it |
|---|---|---|
| **H1** (in S45) | At 375px, whether the location line's truncation reads acceptably and does not visually collide with the crew line or the timestamp beneath it. | The DOM gives presence, width and overflow. It does not give "looks wrong". Screenshots are impossible in this environment. |
| **H2** (in S42) | Whether the map-pin marker and the line's visual weight make a non-service-address trip noticeable to a dispatcher **scanning** a day, rather than only to somebody reading it. | Slice 6's requirement is "marked clearly enough that a dispatcher notices without reading". That is a perceptual claim. |
| **H3** (in S44 step 4a) | Whether the static map rendered under a typed one-off address actually shows that place, rather than an error tile, a blank frame or a default view. | The map is an `<img>` whose existence and `src` are decidable, and S44 asserts both. What the tile *depicts* is not readable from the DOM, and this environment cannot screenshot it. |
| **H4** (in S43) | Whether the four new chips read as distinct **at a glance** in a picker alongside `Service address`, rather than only being distinct as strings. | S43 proves the labels differ; it cannot prove they are distinguishable in use. |

For each, report what the assertion covered and state plainly that the perceptual half is unverified
in this environment. Do not claim a screenshot.

---

## 5A. Corrections found by executing this document (2026-09-12)

Lanes A and C ran first and found four defects **in this document**, not in the product. Later lanes
and any re-run must apply these; each one would otherwise produce a false FAIL.

1. **`@example.com` is rejected by the provider** — see the corrected §0.5. Render assertions on an
   `@example.com` fixture are undecidable, not merely unsent.
2. **The §2 fixture recipe does not give a lead or a job a service address** — the address belongs
   inside `new_customer.location`. On a lead the top-level `new_location` is silently ignored (201
   with `service_location_id = NULL`); on a job it is a hard 400. Every "falls back to the parent's
   service address" assertion depends on this, so verify the fixture before trusting a failure:
   `select service_location_id is not null from leads where id = '<LEAD_ID>';`
3. **S35's walkthrough-door step contradicts S37.** As written it books at a lead whose active
   walkthrough already stands at the location being archived — which is exactly S37's permitted
   "already standing there" exception, so a 200 is correct behaviour, not a failure. Run S35's
   walkthrough door against a **fresh lead with no walkthrough**.
4. **S36 step 3 is not executable as written.** A rebook through `/walkthrough/schedule` dispatches
   `WALKTHROUGH_RESCHEDULED`, so a `WALKTHROUGH_SCHEDULED` probe never enrols — and the lead-side
   reschedule payload carries no `mergeFields` at all. Book a **fresh** walkthrough while the
   location is still active, then archive inside the poller window and prove ordering by comparing
   `workflow_step_runs.created_at` against `locations.archived_at`.

Two smaller corrections: S38 step 3 returns **201**, not 200 (it creates), and §0.9's delete-refusal
string is a template — the handler pluralises, so both `1 visit` and `2 visits` are correct.

## 6. Cleanup checklist

Run after every lane has reported. Verify each line, do not assume.

**1 — Disable and delete every automation this document created.**
```
GET /api/workflows            # every name starting QA0912-
POST /api/workflows/<id>/toggle {"is_enabled":false}
DELETE /api/workflows/<id>    # cascades its enrollments and step runs
```
Verify: `psql "$DB" -At -c "select count(*) from workflows where organization_id='00000000-0000-0000-0000-000000000001' and name like 'QA0912-%'"` → `0`.
And `select count(*) from workflow_enrollments e join workflows w on w.id=e.workflow_id where w.name like 'QA0912-%'` → `0`.

**2 — Restore every user phone number this run set.** `PATCH /api/users/<id> {"phone":null,"phone_ext":null}`
for `USER_B1`, `USER_B2` and `USER_E1` — or back to whatever you recorded, if any of them was
non-null to begin with.
Verify: `psql "$DB" -At -c "select count(*) from users where organization_id='00000000-0000-0000-0000-000000000001' and phone is not null and phone<>''"` → **`0`**, which is the state measured at the top of this document.

**3 — Restore the organisation's main line.**
`select coalesce('['||phone||']','NULL') from organizations where id='00000000-0000-0000-0000-000000000001'` → `[]`.

**4 — Restore every location's active state, then delete the fixture locations.**
First unarchive anything lane 5 archived. Then, for each `QA0912-%` location: its visits must go
before it can (the foreign key restricts), so delete the fixture leads/jobs first (step 5), then
`DELETE /api/locations/<id>` and expect **204** on each.
Verify: `psql "$DB" -At -c "select id, name, is_active from locations where organization_id='00000000-0000-0000-0000-000000000001' order by name"`
returns **exactly one row**: `0a6b99fb-1362-4fd6-871a-337ee4000c04 | Hoboken Store | t`.

**5 — Delete the fixture leads, jobs and customers.** Everything whose name, company name or
service request carries `QA0912`. Their visits go with them.
Verify: `psql "$DB" -At -c "select count(*) from visits v left join leads l on l.id=v.lead_id left join jobs j on j.id=v.job_id where v.organization_id='00000000-0000-0000-0000-000000000001' and (v.location_id is not null or v.location_address_line1 is not null)"` → **`0`**, restoring the "zero visits carry a location" state this environment started in.
And `select count(*) from customers where organization_id='00000000-0000-0000-0000-000000000001' and (company_name like 'QA0912%' or email like 'qa0912-%')` → `0`.

**6 — Delete the session file.** `rm -f .qa/session-staging.json`. It carries a live refresh token
that outlives the access token's own expiry. Never commit it, never paste it.

**7 — Reset the browser viewport** if lane 4 ran: `resize_window` `preset: "desktop"`.

**8 — Assert nothing else moved.**
- `select count(*) from organizations where is_demo = false and updated_at > '<run start>'` → `0`.
- No location, visit, lead, job, customer or workflow outside the demo org was created, updated or
  deleted at any point.
- `Hoboken Store` is active, un-renamed, and still at `1001 Willow Ave, Hoboken, NJ`.

---

## 7. What this document does not decide

Stated plainly rather than covered by a scenario that would pass on a broken build.

1. **Whether an email actually arrives in a human inbox.** Every send here goes to `@example.com`,
   which is accepted by the provider and delivered nowhere. The evidence is the rendered string in
   `workflow_step_runs.detail` and `emails.body`, which is what the recipient would have read — but
   deliverability itself is not exercised, deliberately, because the only routable inboxes on this
   org belong to a person who should not be mailed by a QA run.
2. **SMS.** Two org flags block every text before it leaves and no user has a number. A scenario
   asserting a delivered SMS would be undecidable here; there is none.
3. **The one-off address's autocomplete suggestion path.** The scenarios type into the five
   structured fields directly. Whether *selecting a suggestion* fans out into all five fields
   (rather than landing as one blob in line 1) is driven by the third-party address widget the rest
   of the product already uses, and it cannot be exercised deterministically from the DOM. S10/S11
   prove the API rejects a half-typed address and that the columns store five parsed parts; the
   suggestion-to-fields hop is untested here, and slice 1's acceptance line 3 is therefore only
   half-covered.
4. **A location in a different timezone.** The spec puts this out of scope and the product renders
   visit times in the organisation's zone regardless. Nothing asserts it, and nothing should — the
   behaviour is known and accepted, not a defect to find.
5. **The 25-user, 16-stage concurrency behaviour of the poller.** Scenarios read "the newest row for
   this entity" and tolerate other lanes' traffic; they do not prove the poller's ordering under
   load.

---

*Written 2026-09-12 against `origin/staging` `3267b32c6`. Every exact string in §0.9 was read out of
the merged code, not out of the spec — where the two differ, the code is what ships.*

---

## 8. Run results — 2026-09-13, against staging

**45 of 47 pass. Zero defects attributable to the six slices.** Both failures are pre-existing
defects in code this feature did not touch, and neither is a regression from it.

| Lane | Scenarios | Result |
|---|---|---|
| A — write doors | S01–S14 | 14 pass |
| B — merge fields, phones, multi-visit | S15–S32 | 17 pass, S22 fail |
| C — archive, tenancy | S33–S39 | 7 pass |
| D/E/F — read surfaces, picker, mobile | S40–S45 | 5 pass, S45 fail |
| Z — exclusive | S46–S47 | 2 pass (S47 via S26) |

### The two failures

**S22 — pre-existing, out of this feature's scope.** The four fields under test render correctly;
the scenario fails on its own "no `[]` anywhere" clause because *seven neighbouring* fields render
empty on a lead with no service address. Captured subject: `Please meet us at . Job type: . Call .`
Affected: `org.phone`, `customer.first_name`, `customer.last_name`, `customer.full_name` (on a
company customer — not a degenerate row), `lead.address`, `lead.job_type`, and `lead.name` which
ships its separator without a left operand. Tracked separately.

**S45 — pre-existing, not a regression.** The job Visits card's `min-w-0 flex-1` content column
measures **zero width at 375px**. Proven pre-existing by measuring a job whose visits carry **no
location at all**: the visit number, date and crew name — all predating this feature — measure zero
too, while the `shrink-0` action buttons keep their space. Tracked separately.

### One correction to this document's own results

**S44's map assertion was a FALSE NEGATIVE.** Re-run by hand, the static map renders:
`https://maps.googleapis.com/maps/api/staticmap?center=31%20Harbor%20St%2C%20Asheville…`
It appears as soon as line 1, city and state are committed. The lane's fill set `.value` directly,
which React ignores — **the address fields must be driven with the native value setter plus a
dispatched `input` event**, or through `computer type` after focusing:

```js
const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
set.call(el, v); el.dispatchEvent(new Event('input', {bubbles:true}));
```

Independently confirmed that `ServiceLocationMap` works on staging at all — the job detail page
renders a live Google static map — so a missing map is a product question, never a missing key.

### Executor notes for the next run

- **Finish CSS animations before measuring dialog geometry.** This pane never advances them, so a
  Radix dialog sits frozen at its enter keyframe and `getBoundingClientRect()` reads about half a
  viewport too far right. `document.getAnimations().forEach(a => a.finish())` first.
- **`WALKTHROUGH_RESCHEDULED` carries `lead.walkthrough_location` and `lead.performer_phones`.**
  Publish a probe on it as well as on `WALKTHROUGH_SCHEDULED`, or lead-side re-renders look
  unobtainable.
- `leads.service_location_id` / `jobs.service_location_id` reference **`service_locations`**, not
  `locations`. A fixture check joining to `locations` returns NULL and looks like a bad fixture.
- S41's job-side half cannot be a byte comparison — the enrollment payload carries no `job.address`
  render to compare against. It is a weaker claim than the lead side's.
- Rows created in `emails` are **not** covered by the §6 cleanup checklist. Three lanes left
  QA-subject rows behind rather than delete communication history on their own judgement.
