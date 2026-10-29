# Plan - Web-form lead intake (Forminator first, one adapter per form vendor)

**Date:** 2026-09-18
**Module:** communication (leads intake)
**Status:** SLICES 1 AND 2 SHIPPED. staging `5eebe633a` (#2192), prod `0b009bfc0` (#2193),
both migrations applied to prod 2026-09-18 15:05 UTC. The cabinet org's integration row is provisioned
(`default_lead_source` = `Website`, which matches an existing `Organization.source_options` entry, so R6's
one-vocabulary rule holds on the automated path). Endpoint verified live in prod: the save-time probe
answers 200, stamps `last_event_at`, and creates nothing. **Outstanding: the agency has not yet pasted the
URL into the form plugin, so no real submission has ever been received.** Slice 3 (notification + status
pill) deliberately not built. Vendor behaviour verified against plugin source v1.57.3 (§2a).

**Target:** production (the cabinet org `00000000-0000-0000-0000-0000bcab0001` is live on prod)
**Related:** `2026-09-10-external-call-tracking-webhook-receiver.md` - the same shape for the other half
of the funnel, and deliberately reusing its route family, token gate and ack posture.
`2026-08-19-number-source-synced-to-lead-sources.md` - read §2 of it before writing any source field.

---

## 1. The problem

The customer whose calls we now receive also takes leads through website forms. Today those go nowhere
near ServWave: the site emails a notification to the office, a human reads it and retypes it. Nothing is
attributed, nothing is timed, and the lead exists only once somebody types it.

The agency sent the plugin's **email notification template**, which names the fields:

| Label in the template | Template macro | Webhook key (see §2a) |
|---|---|---|
| First Name | `{name-1}` | `name_1` |
| Last Name | `{name-2}` | `name_2` |
| Phone Number | `{phone-1}` | `phone_1` |
| Email Address | `{email-1}` | `email_1` |
| Text Response | `{text-1}` | `text_1` |
| Selected Option | `{select-1}` | `select_1` |
| Message | `{textarea-1}` | `textarea_1` |
| Submission Page | `{embed_url}` | `current_url` |
| Referring Page | `{refer_url}` | `referer_url` |

`text-1` and `select-1` carry the plugin's DEFAULT labels, so what they actually ask is unknown. That is
a question for the agency (§4), not a guess.

## 2. Decision

**A webhook receiver, not an email parser.** Ran, 2026-09-18. Reasons in order of weight:

1. **A parser is pinned to HTML the agency owns.** They can restyle the notification without telling us
   and the first symptom is missing leads.
2. **The notification's subject line carries the customer's real company name.** Matching on it would put
   that name in the repo, which the CLAUDE.md boundary forbids. A webhook has no subject, so the problem
   disappears rather than needing a workaround.
3. **Email is a lossy transport for structured data** - deliverability, threading, quoting and
   `resolveInboundMessage`'s token matching all sit between the submission and the lead.

### 2a. Vendor behaviour - VERIFIED, not assumed

Read from the plugin distribution v1.57.3 (`addons/pro/webhook/`), 2026-09-18. There is no published
spec; WPMU DEV support has said so outright. The source is the specification. Everything below is
confirmed in code unless marked otherwise.

| Fact | Consequence for us |
|---|---|
| Webhook integration is **native and in the FREE plugin** (since v1.18). Path: Integrations -> Webhook -> activate, then the **form's own** Integrations tab | No licence blocker. §7's email-parser fallback is now dead - delete it from consideration |
| **POST, `application/json`, flat object, no wrapper.** Not configurable | Accept JSON only. Drop the form-encoded branch an earlier draft of this plan carried |
| **Field slugs arrive with dashes rewritten to underscores**: `name-1` -> `name_1` | The slug map keys on UNDERSCORES. Getting this wrong silently maps nothing |
| `form_title` and `entry_time` are always appended | Free form identification without asking |
| **No authentication of any kind** - no secret, no HMAC, no bearer, no custom headers. The UI has two inputs: name and URL | **The URL token is the ONLY gate.** Treat the URL as a credential, exactly as the WhatConverts branch already does |
| **No retries. No auto-disable. A failed delivery is silently lost forever** | A non-2xx is not a deferred lead, it is a destroyed one. The early-200 ack stops being good practice and becomes the whole design |
| **5-second timeout, fired inline with the visitor's form submission** | Ack immediately, process async. A slow receiver makes a customer watch a spinner |
| **Saving the connection fires a TEST POST carrying `X-Hook-Test: true`.** A non-2xx means the agency literally cannot save the integration | §5: our endpoint must be live and answering 200 BEFORE they configure anything |
| The test request's values are **field labels, not user input** | Must be recognised and dropped - see §3d. Otherwise the agency's first Save creates a junk lead named "First Name" |
| **No entry/submission id in the payload by default** | §3f. A Hidden field with Default Value "Submission ID" adds one; that is an ask in §4 |
| Real submissions also carry `referer_url`, `current_url`, `page_id`, `form_type`, `render_id` *(source-derived, not yet observed on the wire)* | Our landing-page/referrer source. Confirm on the first live submission before trusting |
| Hidden field + Default Value **"Query Parameter"** pre-fills from `$_REQUEST[key]` at render | This is how URL tracking values get captured, one hidden field per parameter (§4) |
| File uploads arrive **null**; spam and draft submissions never fire; password fields stripped | Do not design around attachments |
| URL must be a public host on port 80/443/8080/8443 | `api.servwave.com` over 443 qualifies |

## 3. Design

### 3a. Storage: one integration row per (org, provider)

New table `web_form_integrations` (model `WebFormIntegration`), near-copy of
`call_tracking_integrations`:

| column | type | notes |
|---|---|---|
| id | uuid | |
| organization_id | uuid | FK |
| provider | enum `WebFormProvider` (`forminator`) | one value today; the enum exists so vendor two is a migration, not a redesign |
| url_token | text, unique | 32 random bytes hex, same generator as the call-tracking token |
| enabled | boolean | |
| field_map | jsonb, nullable | slug -> normalised key overrides, §3c |
| default_lead_source | text, nullable | what the source falls back to when the payload names no campaign |
| last_event_at | timestamptz, nullable | "is it firing" |
| created_at / updated_at | | |

`@@unique([organization_id, provider])`.

**No `signing_key` column.** The call-tracking table has one because CallRail signs; this vendor offers
no signature at all (§2a) and a nullable column nothing can ever fill is an invitation to assume a gate
exists. If a future vendor signs, that is the migration that adds it.

**Why `field_map` is a column, not a constant:** `select_1` and `text_1` are positional. A second form,
or the agency reordering fields on this one, changes what `text_1` means without changing its name. A
per-org map turns that from a deploy into an UPDATE.

### 3b. Route and auth

`POST /api/webhooks/web-form/:provider/:urlToken`, mounted in `webhook.routes.ts` beside the
call-tracking route with `express.raw({ type: '*/*' })`, inheriting `unscopedRequest`.

Gates, in order, fail-closed, copied from `call-tracking-webhook.controller.ts`:

1. `:provider` in the known set, else `404`.
2. `:urlToken` (<=128 chars) resolves an `enabled` row, else `404`. Identical response for unknown,
   disabled and wrong-provider, so the URL leaks nothing.
3. Body parses as JSON. Otherwise `202` and a logged warning.
4. **`X-Hook-Test: true` -> `200` and stop.** Record `last_event_at`, create nothing. This is the
   agency pressing Save, and it is also our cheapest possible smoke test.
5. Otherwise the payload must yield at least one usable contact handle (phone or email); if not, `202`
   and drop.

Respond `200` immediately after the gates, then process fire-and-forget with its own try/catch.

**Never return a 4xx/5xx to a real submission.** There are no retries: the lead is gone. Every
rejection path above is a `200`/`202` with a log line, and the log line is the only alarm we get.

### 3c. The adapter and the normalised shape

`backend/src/lib/web-form/adapters/forminator.ts`, the only place slugs live:

```ts
export interface WebFormSubmission {
  provider: WebFormProvider;
  vendorSubmissionId: string | null;  // only if the Submission ID hidden field exists (§4)
  formTitle: string | null;           // `form_title`, always present
  firstName: string | null;
  lastName: string | null;
  phone: string | null;               // through normalizeNAPhone, like every other intake
  email: string | null;
  message: string | null;             // textarea_1, falling back to text_1
  selection: string | null;           // select_1
  landingPageUrl: string | null;      // current_url
  referringUrl: string | null;        // referer_url
  trackingParams: Record<string, string>;  // whatever the hidden URL-capture fields carry (§4)
  submittedAt: Date;                  // `entry_time`, site-local with NO timezone - see below
  extras: Record<string, string>;     // every unmapped key, verbatim
}
```

Default map, overridable per org: `name_1`->firstName, `name_2`->lastName, `phone_1`->phone,
`email_1`->email, `textarea_1`->message, `text_1`->message (fallback), `select_1`->selection,
`current_url`->landingPageUrl, `referer_url`->referringUrl.

**`entry_time` has no timezone** (`Y-m-d H:i:s`, site-local). Do not parse it as UTC. Prefer our own
receive time as the authoritative timestamp and keep `entry_time` in `extras` for reconciliation.

**`extras` is not decoration.** The first time the agency adds a field we would otherwise discover it by
its absence. Keeping the leftovers means the data is already there when someone asks. Log a warning
whenever a payload carries keys the map does not know - that is the drift alarm.

### 3d. What a submission becomes

Ran's decision 2026-09-18: **a Customer and a Lead**, the treatment an inbound call ought to get.

0. **Drop test requests first** (§3b gate 4). The save-time probe carries field *labels* as values; a
   lead called "First Name / Email Address" is how the agency loses confidence on day one.
1. **Match the customer** within the org: normalised phone first, then lowercased email. Phone first
   because it is what the office searches on and what the call path already keys on.
2. **No match -> create** from the submitted name, phone and email.
3. **Create the Lead**: `status = NEW`, `created_by_source = CLIENT` (the enum has the value and it is
   literally true), `service_request` from `message`, falling back to `selection`, falling back to a
   fixed neutral string.
4. **Every submission opens a Lead.** No attach-to-existing-open-lead rule: the agency's own system
   behaves that way and the office is used to it. Two submissions from one person make two leads,
   hanging off one matched customer, and merging them stays a human decision made against both records
   rather than a rule that silently hides the second.

**Where the source value lands - read `2026-09-18-source-is-a-first-touch-customer-attribute.md`
first.** Source is a **customer** attribute, written **once, at customer creation**, and never
automatically overwritten. So:

- **New customer (step 2):** set `Customer.ad_source` from the submission's campaign, else
  `default_lead_source`. This is the customer's first touch.
- **Existing customer (step 1 matched):** **write nothing.** This receiver is an automated path, and
  automation never rewrites an existing origin (R3/R4). A returning customer who submits through a
  different campaign keeps where they first came from. The submission's campaign still lands in
  `Lead.attribution` (§3e), so the per-submission detail is not lost - it just does not rewrite who the
  customer is. A person may still change it by hand; that is R5 and it is not this code's business.
- **Never `Lead.source`.** The column is dead (no writer, only a demo dashboard widget reads it) and
  under the first-touch rule it must stay that way: leads do not have sources.

### 3e. Attribution parity with calls

Add **`Lead.attribution Json?`** - pure-expand, nullable - mirroring `CallSession.attribution`, and
write the SAME key names `lib/ctm/ingest.ts` and `lib/call-tracking/types.ts` already use (`source`,
`medium`, `campaign`, `keyword`, `referrer`, `landing_page`, `gclid`). One column then reads the same
whether the lead came from a call or a form, and "which campaign produced revenue" is one UNION rather
than two schemas.

**Do not write `gclid` from the phone system's value.** See
`2026-09-18-ctm-gclid-is-object-object.md`: that field is garbage in prod today and must not propagate.

### 3f. Idempotency and abuse

- **Idempotency:** a `web_form_submissions` ledger, unique on
  `(organization_id, provider, vendor_submission_id)`, claim-first, as `ctm_events` does.
  **The org leads that key**, and that is where this parts company with `ctm_events`: a CTM event id is
  minted by the one vendor account every org shares and really is globally unique, whereas the form
  plugin's entry id is its own SITE's sequential entry counter, so every site's second submission is
  `2`. Without the org in the key, one org's ordinary submission raises a duplicate against another
  org's row and the claim-first loser is stored nowhere at all.
  **The payload carries no entry id by default** (§2a), so until the
  agency adds the hidden Submission ID field (§4) the key is a hash of
  (form_title, contact handle, minute-truncated receive time). Imperfect, and exactly why §4 asks.
  The vendor does not retry, so the realistic duplicate is a human pressing submit twice - which under
  §3d.4 is a legitimate second lead anyway. Do not over-engineer this.
- **Abuse:** a public URL that creates rows. Three cheap defences: the 32-byte token, a per-token rate
  limit, and the "at least one contact handle" rule. A submission failing that is acked and dropped,
  never stored.
- **No notification in slice 1.** A form lead ringing every phone in the office on day one is how a new
  intake path gets switched off. Wire the bell in slice 3, once the shape is proven.

## 4. What we need from the agency

Note how short this got. Everything the plugin could answer, the source answered.

Q1. **Which field is which.** What does "Selected Option" (`select_1`) actually ask, and what are its
    exact options? Same for "Text Response" (`text_1`). We want those answers landing somewhere
    meaningful rather than in a generic notes field.
Q2. **Is this the only form on the site?** If a quote request and a contact form differ, we need both -
    each needs its own connection and may need its own `field_map`.
Q3. **Do the ad campaigns add tracking values to the landing page URL?** Asked in plain words, not in
    jargon: if their ads append anything to the URL, we want it captured. The mechanism is a Hidden
    field with Default Value set to "Query Parameter", one per value - cheap, but only works going
    forward, so it is worth asking before launch rather than after.
Q4. **Add a Hidden field with Default Value "Submission ID"**, so every payload carries the entry id.
    One field, once, and it makes duplicate handling exact instead of heuristic.

Not asked, deliberately: anything about method, format, headers, authentication, retries or payload
keys. Those are settled (§2a), and asking would invite a wrong answer from someone reading a UI.

## 5. Slices, and the sequencing that matters

**The receiver must be live in prod before the agency configures anything.** Saving the connection
fires a test POST, and a non-2xx blocks the save outright (§2a). We hand them a URL that already works,
or they hit an error on their first attempt and we lose the room.

1. **Receiver + adapter + ledger.** Table, migration, route, gates, adapter, test-request handling,
   idempotency. Ends at a stored submission and `last_event_at`, no lead yet. Provable with a synthetic
   POST, and the agency's own Save becomes the real smoke test.
2. **Customer + Lead creation**, §3d, `Lead.attribution`, `Customer.ad_source`.
3. **Notification + a status pill** ("Web forms: Active" - never the vendor name, per CLAUDE.md).

## 6. Out of scope, deliberately

- An admin UI for the integration row. One-off script, as call tracking did.
- File uploads. They arrive null (§2a); if the customer needs attachments this becomes a separate plan.
- De-duplicating against the CALL path (someone who calls and submits within the hour), and repeat
  submissions from one person. Both real; both need the form path live to know how often they happen.
  §3d.4 is the deliberate starting position.

## 7. Risks

- **Positional slugs drift.** Mitigated by `field_map`, not eliminated. A form rebuild silently remaps
  `text_1`. Defence: Q2 plus the unknown-key warning in §3c.
- **Real-submission keys are source-derived, not observed.** `referer_url` / `current_url` and the
  multi-input sub-keys were read from the plugin source, not captured on the wire. **Confirm on the
  first live submission before trusting them**; the adapter must treat all of them as optional.
- **A failed delivery is a destroyed lead.** No retries anywhere in the vendor. Uptime on this endpoint
  is the feature. Any deploy that 502s a form POST loses that customer silently.
- **Spam becomes leads.** The office notices faster than we will. Slice 3 is where the contact-handle
  rule earns its keep.

---

## 8. What the build changed about this plan (2026-09-18, post-ship)

Three adversarial reviews ran over the finished branch. What they found is recorded here because the
plan was wrong in two places, not merely incomplete.

- **§3f's idempotency key was specified without the org** (`(provider, submission_key)`). The vendor's
  entry id is a **per-site sequential counter**, so every org's second submission is `2`. Org B's insert
  would have hit `P2002`, been read by the claim-first path as ordinary de-duplication, and dropped the
  lead **with the payload unarchived** - the exact failure this receiver exists to prevent. Reproduced on
  Postgres 16. The key is now `(organization_id, provider, submission_key)`. A vendor id being globally
  unique is true of the phone system's `ctm_events` and NOT of a per-site form plugin; the two look alike
  and have opposite tenancy.
- **§3b's "never return a 4xx/5xx" was not achievable as written.** Three live violations existed: a
  deeply-nested value exhausted the stack in the adapter *before the ack and outside any try/catch* (and
  because Express 4 does not adopt a rejected async handler's promise, the result was **no response at
  all**); a body over 100KB hit body-parser's default limit and fell through to the global handler's
  hardcoded 500; and a cosmetic `last_event_at` write was sequenced ahead of the payload archive, so one
  transient error lost the lead. The invariant is not a property of careful coding - it needs the whole
  pre-ack path wrapped, an explicit body limit, and nothing cosmetic ahead of the claim.
- **§3c's "warn on every unmapped key" is unusable as written** - `form_title` and `entry_time` are
  appended to every delivery and are unmapped, so the drift alarm would fire 100% of the time. An
  envelope allowlist makes it mean something.
- **The source must be written to BOTH `Customer.source` and `Customer.ad_source`.** Neither plan said
  so. The customer form's single "How Did They Hear About Us?" control writes both as mirrors while the
  customers list renders `ad_source`; writing one would leave a source in the list and a blank field on
  the customer's own record - which would also have invalidated the first-touch plan's §7 argument that a
  wrong source is "correctable in one click on the customer record".
- **Adding a Prisma enum trips a FRONTEND guard.** `frontend/src/design-system/__tests__/status-registry-schema-guard.test.ts`
  parses `schema.prisma` and requires every enum to be claimed by a status domain or explicitly excluded
  with a written reason. The backend suite passes either way, so only CI catches it. `WebFormProvider` is
  excluded as a vendor discriminator, beside `CallTrackingProvider`.
- **Org purge is a hard ratchet.** `purge-tenant-coverage.test.ts` fails the whole suite for any new
  tenant-scoped model not wired into `lib/purge.ts`. Nothing in the plan covered it.

### Still missing, named honestly

A **per-token rate limit** (§3f's third defence). Nothing rate-limits this endpoint - `/api/webhooks`
mounts ahead of the global limiter - and every limiter in `middleware/rate-limit.ts` answers with a 429,
which here destroys a real lead. What IS bounded is the post-ack work (`WEB_FORM_MAX_IN_FLIGHT = 50`),
because unbounded it held shared-pool connections while taking an exclusive lock on the org's
`organizations` row twice per submission - so one leaked URL could degrade the API for **every** tenant.
The remaining exposure is confined to the token's own org, and `--rotate` is the kill switch.
