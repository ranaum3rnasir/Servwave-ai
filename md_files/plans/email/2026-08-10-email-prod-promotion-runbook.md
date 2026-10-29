# Email programme: production promotion runbook

**Date:** 2026-08-10
**Supersedes:** `2026-08-09-email-programme-promotion-readiness.md` (three material errors in that
document are corrected below - read this one).
**Status:** staging is complete and verified. Production has NOT been touched. Nothing in this
document has been executed.

This is the whole cutover: what is true today, what the promotion changes, what can go wrong with
the data, what Ran runs, what Claude runs, what gets tested, and how to undo each step.

---

## 1. Corrections to the 2026-08-09 plan

These were wrong. They mattered, because two of them pointed at a cutover that would have broken
live customer email.

### 1.1 "`email_sending_enabled` does not exist in prod yet" - WRONG

It has existed in prod since `20260707140000_add_organization_email_sending_enabled`, which is in
the prod ledger. The column is there, `DEFAULT true`, and **the orgs already carry deliberate
per-org values**:

| Prod org | `email_sending_enabled` | Customers |
|---|---|---|
| Alpha Doors & Security | **false** | 9,441 |
| B&G Cabinet | true | 339 |
| Neon Services | true | 4 |
| Servwave Demo | **false** | 4 |
| Talon Septic | true | 2,583 |

The consequence of getting this wrong: the old plan said the promotion "switches sending on for
every existing prod org". It does not. `20260809031000` changes the **column default only**, which
Postgres applies to future INSERTs and never to stored rows. **No existing prod org changes state.**

### 1.2 "Promote with sending off, then enable per org" - WRONG, and it would have caused an outage

`email_sending_enabled = false` is not a gate on the new features. It is the kill switch on
**all business email** for that org - `dispatchEmail` returns `skipped/org_disabled` before
building the From header, and every estimate, invoice, receipt and automation send routes through
it. Only MFA codes and user invites bypass it.

B&G Cabinet, Neon Services and Talon Septic send customer email in production **today**. Setting
them to `false` as a cutover step would have silently stopped their estimates and invoices.

**The correct posture is to change nothing about these flags.** Leave every org exactly as it is.

### 1.3 "Staging and prod cannot both receive on `reply.servwave.com`" - WRONG conclusion

The premise was right (MX is DNS-global, one domain delivers to one place) but the conclusion did
not follow, because **Resend webhooks are account-wide, not domain-scoped or environment-scoped**.
One Resend account fans every event out to every configured endpoint.

Verified empirically rather than assumed: staging's `resend_events` holds 61 events, of which **26
reference `email_id`s that do not exist in staging's `emails` table**. Sampling one
(`db9c7e8c-...`) shows it was sent by `e2e-qa-2d0aa2b5` with `localhost:5173` links - a **local dev
e2e run**, whose delivery events were nonetheless delivered to the staging webhook. Cross-
environment fan-out is therefore already happening and already harmless.

It is harmless because both unmatched paths exit cleanly, which is in the code:

- delivery events - `tx.email.findUnique({where: {provider_message_id}})`, and `if (!email) return
  null`. Recorded in the ledger, no row touched, no suppression written.
- inbound - attribution is by opaque per-database reply token; an unresolvable one logs
  `could not be attributed to an org - recorded, dropped`.

**So `reply.staging.servwave.com` is not a blocker and is not required for this promotion.** Prod
and staging can share `reply.servwave.com`: each environment resolves its own tokens and drops the
other's. Splitting later is optional hygiene (less foreign noise in each ledger), not a gate.

This removes the entire "Phase A prod prep" from the old plan.

---

## 2. Verified state, 2026-08-10

**Environments**

| | Staging | Production |
|---|---|---|
| API | `alpha-crm-test-env.onrender.com` | **`api.servwave.com`** |
| Frontend | `servwave-demo.vercel.app` | `app.servwave.com` |
| Supabase | `knriiqdqxgfoecsfarlx` | `fvcjinnllchzqcupmrah` |
| Health | 200 `db:ok` | 200 `db:ok` |

**Always address production as `api.servwave.com`.** Verified 2026-08-10: 200 `db:ok`, and the same
route baseline as the origin. It is Cloudflare-fronted; `alpha-crm-1.onrender.com` is the Render
origin behind it and is the name to click in the Render dashboard, not the one to put in a webhook,
a config value or a probe. `alpha-crm-api.onrender.com`, which older planning docs name as the prod
backend, is dead and 404s - ignore it wherever it appears.

**Prod route probes (pre-promotion baseline, unauthenticated)**

| Route | Now | Expected after |
|---|---|---|
| `POST /api/webhooks/resend` | 404 | 401 on an unsigned body |
| `PATCH /api/organization/email-sender` | 404 | 401 |
| `GET /api/communication/sending-identity` | 401 | 401 |
| `PATCH /api/organization/never-existed` | 404 | 404 |

Note `sending-identity` already answers 401: the communication router authenticates before method
matching, so 401 there proves the router is mounted, not that the endpoint exists. Do not use it as
the deploy discriminator. **`/api/webhooks/resend` moving 404 -> 401 is the discriminator.**

**Prod email data at risk:** `emails` holds 32 rows, oldest 2026-07-06, newest 2026-08-08,
**0 malformed `from`** - so the #1458 Sent-tab crash class cannot bite. `email_threads`,
`email_read_states`, `email_attachments`, `organization_domains` and `resend_events` do not exist
in prod yet. `emails` already has RLS enabled with 1 policy.

**Resend account:** one webhook, pointing at staging, subscribed to all 7 events. Domains:
`mail.servwave.com` (send only, no MX), `reply.servwave.com` (MX ->
`inbound-smtp.us-east-1.amazonaws.com`, receiving on), `servwave.com` (send only).

---

## 3. What the promotion actually carries

**14 pending migrations, and only 7 are the email programme.** Anyone reviewing this as "the email
promotion" will under-test it.

Email programme (7):

```
20260805100000_email_attachments
20260805130000_resend_webhooks_and_suppression
20260805140000_email_thread_and_read_state
20260805150000_organization_domains          <- creates the table
20260805160000_reply_tokens_and_inbound_match
20260807180000_org_email_sender_local_part
20260809030000_drop_organization_domains     <- drops it again
20260809031000_email_sending_off_by_default
```

`organization_domains` is created and then dropped inside the same deploy. That is fine and both
statements are idempotent, but expect the table to exist briefly mid-run.

Everything else riding along (6):

```
20260806120000_custom_roles
20260806130000_custom_fields_mvp
20260807120000_call_attribution
20260807140000_custom_field_definitions_rls
20260807160000_price_book_item_model_number
20260807160000_tenant_rls_coverage_gap
```

**`20260807160000_tenant_rls_coverage_gap` closes critical issue #1276.** Confirmed against prod
just now: `automation_rules`, `automation_runs`, `job_line_items` and `org_tax_rates` all sit at
`relrowsecurity = false` with **0 policies**. This migration enables and forces RLS with the
standard `tenant_isolation` policy on all four. It is inert until the app connects as a
non-BYPASSRLS role, so it changes no behaviour on the day - but it is the fix, and it should be
verified landed (section 7, step 6).

---

## 4. The one customer-visible change, and the limit on canarying it

Today every prod org sends as `"<Org Name>" <no-reply@mail.servwave.com>` (confirmed on a real
B&G Cabinet estimate, 2026-08-08). After promotion the local part is derived from the org name:

| Org | From today | From after |
|---|---|---|
| B&G Cabinet | `no-reply@mail.servwave.com` | `bgcabinet@mail.servwave.com` |
| Neon Services | `no-reply@mail.servwave.com` | `neonservices@mail.servwave.com` |
| Talon Septic | `no-reply@mail.servwave.com` | `talonseptic@mail.servwave.com` |
| Servwave Demo | (sending off) | `servwavedemo@mail.servwave.com` |
| Alpha Doors & Security | (sending off) | `alphadoorssecurity@mail.servwave.com` |

Derivation is `name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,40)`, falling back to
`no-reply`. Nothing routes on the From - replies come back on the per-thread Reply-To token - so
the risk is deliverability and recipient-side filters and saved contacts, not mis-delivery.

### Ran's decision (2026-08-10): off in prod except Servwave Demo and B&G Cabinet

Target prod state at cutover:

| Org | Now | Target | Change |
|---|---|---|---|
| Servwave Demo | off | **on** | switch ON - the canary |
| B&G Cabinet | on | on | none |
| Neon Services | on | **off** | **switch OFF** |
| Talon Septic | on | **off** | **switch OFF** |
| Alpha Doors & Security | off | off | none |

**State the consequence plainly: Neon Services and Talon Septic stop sending customer email
entirely** - estimates, invoices, receipts, automations - from the moment those rows flip until
someone turns them back on. This is not a side effect of the promotion; it is a deliberate hold so
that no org's customers see a changed sender address before Ran has told them. Ran will notify
those orgs and re-enable them after the ship. MFA codes and user invites are unaffected: they
bypass the kill switch.

That decision also dissolves most of section 4's problem. With Neon and Talon held, **B&G Cabinet
is the only real org whose address moves**, from `no-reply@` to `bgcabinet@`, across 339 customers.

The unique-index limit still stands and is worth recording: the override column carries
`CREATE UNIQUE INDEX organizations_email_sender_local_part_key`, and NULLs do not collide, so every
org on the derived default is exempt - but **two orgs can never both be pinned to the literal
`no-reply`**. With only one real sender left, that ceases to bite: pinning B&G is available if its
address should hold still during the soak.

**Remaining micro-decision (not blocking):** let B&G move to `bgcabinet@` at cutover, or pin it to
`no-reply` for the soak and release it after. Recommendation: **let it move.** It is the intended
product change, B&G is the smallest real sender at 339 customers, and pinning then unpinning means
the address changes twice for the same recipients.

### What is canaried cleanly

The new machinery - threads, read state, attachments, delivery status, inbound replies, the Sender
Address setting - is inert for an org whose sending is off, and **Servwave Demo has 4 customers and
`is_demo = true`**. Switching it on after the deploy exercises the entire new path in production,
end to end, touching no real customer.

---

## 5. Data risk register

| # | Risk | Reality | Handling |
|---|---|---|---|
| 1 | Migration destroys prod data | All 14 are additive except `drop_organization_domains`, and that table does not exist in prod - `DROP TABLE IF EXISTS` is a no-op | Tag before deploy (step 1) |
| 2 | Existing orgs start/stop sending | The MIGRATION changes nothing - default-only, stored rows untouched. The three flag flips in step 5a are a deliberate, separate act | Verify after the deploy that the only changed rows are the three intended ones (step 5) |
| 3 | Address change surprises customers | Real and intended, and now limited to B&G Cabinet (339 customers) because Neon and Talon are held off | Section 4 decision |
| 3b | **Neon and Talon go silent without their staff realising** | A held org's sends return `skipped/org_disabled`. The app does not shout about it, and staff may keep hitting Send | Ran notifies both orgs. Re-enable promptly after the ship |
| 4 | Inbound replies land in the wrong environment | Impossible - 128-bit opaque per-DB tokens | Verified in code |
| 5 | Staging events pollute prod ledger | Will happen; both endpoints get everything | Harmless: unmatched ids exit before any write. Accept, or split reply domains later |
| 6 | Webhook secret missing -> silent inbound loss | **Fail closed: unset `RESEND_WEBHOOK_SECRET` 401s every request** | Set it BEFORE creating the endpoint (step 7) |
| 7 | Suppression list is global across orgs on the shared domain | By design - a hard bounce belongs to the address | Know it; a bounce in one org suppresses that address for all |
| 8 | Migrations apply before the code swap | Observed on staging today: migrations 20:11:09Z, new code live 20:12:29Z - an 80s window | No pending migration removes anything prod's live code reads, so the window is safe this time. Re-check on any future drop |
| 9 | Prod links point at the wrong host | A local e2e send in the Resend log carried `localhost:5173` | Confirm prod `FRONTEND_URL` (step 2) |

---

## 6. Pre-flight - Ran (before any PR)

**A. Env vars on the prod Render service - DONE, confirmed by Ran 2026-08-10.**

| Var | Required | State |
|---|---|---|
| `RESEND_API_KEY` | set | set |
| `EMAIL_FROM_BUSINESS` | `no-reply@mail.servwave.com` | **confirmed exactly** |
| `EMAIL_REPLY_DOMAIN` | `reply.servwave.com` (or unset) | **set explicitly to `reply.servwave.com`** |
| `FRONTEND_URL` | `https://app.servwave.com` | set correctly |

Because `EMAIL_FROM_BUSINESS` is confirmed, section 4's address table is exact rather than
predicted. `RESEND_WEBHOOK_SECRET` is still absent by design - it is set in step 7.

**B. Sender-address decision - DONE** (section 4). One micro-decision remains: whether B&G Cabinet
moves to `bgcabinet@` at cutover or is pinned for the soak. Recommendation: let it move.

**C. Confirm the promotion window.** Render applies migrations in the build and then swaps. Pick a
low-traffic hour; Talon Septic is `America/Denver`, everyone else `America/New_York`.

**D. Decide WHEN Neon and Talon are switched off.** Two options, and they differ in what customers
see, not in effort:

- **At cutover (step 5a) - recommended.** Their email keeps working right up to the deploy, and
  they never send from the new address.
- **Now, ahead of the deploy.** Only worth it if Ran wants them silent before he has notified them.

Either way it is three single-row updates and Claude will not run them without being told which.

---

## 7. The runbook

Each step says who runs it, and every step is followed by its own verification. Do not batch.

### Step 1 - rollback tag (Claude, on request)

```bash
git fetch origin && git tag pre-email-promotion-main-2026-08-10 origin/main && git push origin pre-email-promotion-main-2026-08-10
```

Verify: `git rev-parse pre-email-promotion-main-2026-08-10` resolves and matches `origin/main`.

### Step 2 - pre-flight snapshot (Claude)

Record, so "unchanged" can be proved rather than assumed:

```sql
select id, name, email_sending_enabled, email_sender_local_part from organizations order by name;
select count(*) from emails;
select relname, relrowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public' and relname in
    ('emails','automation_rules','automation_runs','job_line_items','org_tax_rates');
```

### Step 3 - hold Neon and Talon, if holding early (Claude, only on Ran's word - see pre-flight D)

The default is to do this at step 5a instead, so their email works until the deploy.

```sql
update organizations set email_sending_enabled = false
 where id in ('8474791a-33c6-4de0-8f1a-c6e9f2f125f5',   -- Neon Services
              'ea95206c-3e40-4ab5-b428-df2c2b46adf3');  -- Talon Septic
```

Verify exactly 2 rows updated, and that B&G, Servwave Demo and Alpha Doors are untouched. Reversible
with the same statement and `true`.

### Step 4 - the promotion PR (Claude, on explicit instruction)

The gate, run fresh at the time, not trusted from this document:

```bash
git merge-base --is-ancestor origin/main origin/staging; echo "exit=$?"
```

**It returned exit 1 today**, and has never returned 0 - `main` and `staging` still do not share a
merge base because every promotion so far was squash-merged (#1259, #1294). So the branch is cut
**from `staging`**, and the PR is `staging -> main`, exactly like #1259: cut at staging, then

```bash
git merge -s ours origin/main
```

so `main` takes staging's tree wholesale with zero conflict hunks. A `main`-based branch would show
thousands of phantom files (#1148, #1289).

**Do not merge until CI is green on that PR**, including the Database job, which is the only place
the 14 migrations run against vanilla Postgres from an empty ledger before they touch prod.

### Step 5 - deploy and verify (Ran merges; Claude verifies)

Render auto-deploys `main` and runs `prisma migrate deploy` in the build.

Verify, in order:

1. `_prisma_migrations`: all 14 present, `finished_at` set, `rolled_back_at` null, and the total
   moves 169 -> 183.
2. `/health` returns 200 `db:ok`.
3. **The discriminator:** `POST /api/webhooks/resend` moves 404 -> **401** (unsigned body). Until
   it does, the old code is still serving.
4. `PATCH /api/organization/email-sender` -> 401, and `PATCH /api/organization/never-existed` ->
   404 as the control.
5. **`email_sending_enabled` unchanged for all five orgs** against the step-2 snapshot - the
   migration must not have moved a single row. This is what proves 1.1 and 1.2 held. The intended
   flips happen next, as a separate and deliberate act.
6. **#1276:** all four tables now `relrowsecurity = true` with 1 policy each.
7. New tables exist: `email_threads`, `email_read_states`, `email_attachments`, `resend_events`,
   each RLS-enabled with a policy. `organization_domains` does **not** exist.

**Step 5a - apply the target flag state** (Claude, immediately after 1-7 pass, before anyone sends):

```sql
update organizations set email_sending_enabled = false
 where id in ('8474791a-33c6-4de0-8f1a-c6e9f2f125f5',   -- Neon Services
              'ea95206c-3e40-4ab5-b428-df2c2b46adf3');  -- Talon Septic
update organizations set email_sending_enabled = true
 where id = '00000000-0000-0000-0000-000000000001';     -- Servwave Demo
```

Skip the first statement if step 3 already ran it. Then re-read all five rows and confirm the table
matches section 4's target exactly: Demo on, B&G on, Neon off, Talon off, Alpha Doors off.

If B&G is being pinned after all (the micro-decision), this is where it happens - the column does
not exist until the migrations run:

```sql
update organizations set email_sender_local_part = 'no-reply'
 where id = '00000000-0000-0000-0000-0000bcab0001';     -- B&G Cabinet
```

### Step 6 - first real send, unchanged orgs (Ran)

Send one estimate or invoice from **B&G Cabinet** to an address you control.

Confirm on the wire: the From is `bgcabinet@mail.servwave.com` (or `no-reply@` if B&G was the org
pinned), the display name is right, links point at `app.servwave.com`, and the mail is not in spam.
Then in `emails`, confirm the row carries a `provider_message_id`.

**If the address is wrong, stop here.** Everything after this is additive; this is the last step
whose blast radius is real customers.

### Step 7 - the prod webhook (Ran, both halves)

Order matters, because the endpoint fails closed.

1. In Resend, create a webhook -> `https://api.servwave.com/api/webhooks/resend`, all 7 events
   (`email.sent`, `email.delivered`, `email.delivery_delayed`, `email.complained`, `email.bounced`,
   `email.failed`, `email.received`). Use the `api.servwave.com` name, not the Render origin.
2. Copy its signing secret into `RESEND_WEBHOOK_SECRET` on the prod Render service and let it
   redeploy.

Claude cannot do either - both handle a secret. Paste the secret into Render only, never into chat.

Verify: send one more mail from B&G and watch its row's `delivery_status` reach `DELIVERED`, and
`resend_events` gain rows. Staging keeps working throughout; expect foreign events in both ledgers
(risk 5).

### Step 8 - the demo-org canary (Ran tests)

Servwave Demo was switched on in step 5a. In prod, as a Servwave Demo admin, walk the full surface:

| # | Test | Expect |
|---|---|---|
| 1 | Settings -> Sender Address | Shows `servwavedemo` with the fixed `@mail.servwave.com` suffix |
| 2 | Change it to something else, save | 200, and the field reads back the new value |
| 3 | Send an estimate to an address you control | From is the value from test 2 |
| 4 | Inbox -> Sent | The message is listed, with a delivery state, and **the tab does not crash** (#1458) |
| 5 | **Reply to that email from your own mail client** | Within ~a minute the reply appears in the Inbox, threaded under the original |
| 6 | Open the thread | Read state marks per user; assignment works |
| 7 | Reply with an attachment | Attachment stored and downloadable |
| 8 | Send to a known-bad address (`bounce@simulator.amazonses.com`) | Row reaches `BOUNCED`; the address is suppressed for later sends |
| 9 | Inbox unread counts | Non-zero, and clear on read |

Test 5 is the one that has never run in production. It is the whole reason for the canary.

### Step 9 - release (Ran)

Only after the canary is clean:

- **Notify Neon Services and Talon Septic**, then re-enable them one at a time:
  ```sql
  update organizations set email_sending_enabled = true where id = '<org id>';
  ```
  Each will then send as `neonservices@` / `talonseptic@`. Confirm one real send per org on the
  wire before doing the next. **Until this happens those two orgs send no customer email at all** -
  this step is the deal, not an optional tidy-up.
- If B&G was pinned, `set email_sender_local_part = null` and confirm its next send is `bgcabinet@`.
- Decide whether Alpha Doors & Security (9,441 customers, currently off) gets switched on. That is
  a business decision, not a cutover step, and it is the largest single blast radius on the system.
- Leave `Servwave Demo` on or return it to `false`, as preferred.

---

## 8. Rollback

| Failure | Undo |
|---|---|
| Migration fails mid-deploy | Render marks the deploy failed and keeps the old instance serving; fix forward. `prisma migrate deploy` is transactional per migration |
| Code is bad after swap | Redeploy `pre-email-promotion-main-2026-08-10` in Render. **The migrations do not roll back**, but all 14 are additive to the old code's world, so the old image runs against the new schema |
| Address change is wrong | Pin that org: `update organizations set email_sender_local_part = 'no-reply'` (one org only - the index is unique), or revert the whole surface by redeploying the tag |
| Inbound floods or misbehaves | Disable the prod webhook in Resend. Sending continues; only delivery states and inbound stop |
| Demo canary misbehaves | `set email_sending_enabled = false` on Servwave Demo. Nothing else is affected |
| A held org needs its email back immediately | `set email_sending_enabled = true` on that org. Takes effect on the next send, no deploy |

There is no step here that deletes or rewrites prod rows. The only writes to existing data are the
`organizations` flag flips in step 5a and any pin, each a single-row change reversible in one
statement.

---

## 9. Open decisions

1. ~~**Sender address**~~ - DECIDED 2026-08-10: off in prod except Servwave Demo and B&G Cabinet;
   Ran notifies Neon and Talon and they are re-enabled after the ship (section 4). Only the B&G
   pin-or-move micro-decision is open, and the recommendation is to let it move.
1b. **When Neon and Talon are held** - at cutover (recommended) or now (pre-flight D).
2. **Alpha Doors & Security:** it has 9,441 customers and email off. Does the promotion change
   anything for it? Recommendation: no, not on the same day.
3. **Reply-domain split:** not required (1.3). Do it later only if foreign events in the ledgers
   become annoying.
4. **Customer communication:** whether anyone is told the address changed.

---

## 10. Deferred, not blocking

- Two comments still name the deleted `organization-email-domain.controller.ts`
  (`backend/src/__tests__/setup.ts:203`, `backend/src/lib/email.ts:19`). Fold into the next email PR.
- #1445 - the impeccable hook flags `overused-font` on backend email templates, where webfonts do
  not apply.
- Two seeded automation subjects carry em dashes (`backend/src/services/automations/
  defaultAutomations.ts:137`), against the repo's own output-style rule. Customer-facing, and
  existing rows already hold the old text, so changing it needs a backfill decision.
