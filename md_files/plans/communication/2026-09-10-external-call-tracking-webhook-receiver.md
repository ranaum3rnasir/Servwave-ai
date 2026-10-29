# Plan - External call-tracking webhook receiver (CallRail first, WhatConverts next)

**Date:** 2026-09-10
**Module:** communication (phone)
**Status:** approved by Ran 2026-09-10, built (PR to staging 2026-09-10)
**Target:** production (the org is live on prod; the agency will point CallRail at the prod URL)
**Related:** `2026-08-19-number-source-synced-to-lead-sources.md` (ad-group UI, now a nicer editor for
the same field, not a prerequisite)

---

## 1. The problem

A customer keeps its tracking numbers on CallRail, managed by an outside agency, and will not port
them. CallRail forwards every call to a ServWave number, so the call itself arrives fine and is
ingested by the existing CTM webhook path. What does not arrive is **why the person called**:

- A CallRail **website pool** (four numbers, one per visitor session) forwards all four to ONE
  ServWave number. The dialled number is lost on re-origination, so ServWave sees one destination and
  nothing else.
- The marketing source (Google Ads, organic, direct, referral), the landing page, the gclid and the
  original tracking number exist only in CallRail's session record.

The agency pushes that record elsewhere via Zapier. ServWave has no Zapier, and Ran rejected manual
entry and reading the agency's Google Sheet. So the record has to be pushed to us directly.

## 2. Decision

**ServWave becomes a webhook destination for the call-tracking vendor.** CallRail's Webhooks
integration (company level, base plan, any HTTPS URL) posts the call object on `pre_call` and
`post_call`. We store the pre-call record in the existing pending-attribution stash, the CTM ingest
claims it when the matching call row is created, and post-call enriches the row afterwards.

This is a **data sync, not a routing change**. Numbers, forwarding, caller ID and recording stay
exactly as they are.

Number assignment, decided 2026-09-10:

| ServWave number | Receives from CallRail | CTM tracking source (renamed from "offsite") |
|---|---|---|
| 570-8007 | the four website-pool numbers | Website |
| 523-2530 | the one static Google Ads extension number | Google Ads |

The tracking-source rename is an ops step in CTM, no code. It gives the static number a label with
zero code, and gives the pool a sensible fallback label when CallRail says nothing.

## 3. Why the sequence is deterministic (no race)

Measured facts from CallRail's docs, verified during the 2026-09-09 research:

- `pre_call` fires **when the tracking number rings**, i.e. before CallRail forwards the leg to us.
  CTM's `starts` and `end` webhooks fire after that. The stash is always in place first.
- `post_call` can lag **up to 20 minutes** after hangup. It must never be the thing the CTM row waits
  for. It enriches by CallRail call id, whenever it arrives.
- Caller ID must stay CallRail's default, **"Caller's number"**. The join key is the caller's number
  plus a time window. If the agency ever switches caller ID to "tracking number", every call joins to
  nothing. The email to the agency already asks for the default; the receiver also logs a loud warning
  when a pre-call's `customer_phone_number` never matches an ingested row within the window.
- CallRail does **not retry** and **auto-disables the integration after repeated non-2xx**. The
  receiver acks `200` before doing any work and processes asynchronously (same posture as the CTM
  receiver's early ack).

## 4. Design

### 4a. Storage: one integration row per org

New table `call_tracking_integrations` (Prisma model `CallTrackingIntegration`):

| column | type | notes |
|---|---|---|
| id | uuid | |
| organization_id | uuid | FK, one row per (org, provider) |
| provider | enum `callrail` \| `whatconverts` | |
| url_token | text, unique | random 32 bytes hex; part of the URL, identifies the org without exposing the org id |
| signing_key | text, nullable | CallRail company signing key; WhatConverts has none |
| enabled | boolean | flipped off on our side if the vendor payload is malformed repeatedly |
| last_event_at | timestamptz, nullable | for the status pill and for debugging "is it firing" |
| created_at / updated_at | | |

Why not env vars: the CTM secret is one per deployment because CTM is ServWave's own vendor. CallRail
keys are one per customer company, and the second customer arrives soon (the agency is migrating to
WhatConverts). Per-org rows are the only shape that does not need a deploy per customer.

No admin UI in this slice. The row is inserted by a one-off script run against prod, once the agency
sends the signing key. The Numbers page gets nothing new. (A later slice can show "Call tracking:
Active" as a status only, never the key or the vendor id in copy, per the CLAUDE.md boundary.)

### 4b. Route and auth

`POST /api/webhooks/call-tracking/:provider/:urlToken`, mounted in `webhook.routes.ts` with
`express.raw({ type: '*/*' })`, beside the CTM route, so it inherits `unscopedRequest`.

Gates, in order, each fail-closed:

1. `:provider` in the known set.
2. `:urlToken` resolves an `enabled` integration row for that provider (timing-safe compare is not
   needed; the token is a DB lookup, but the response is identical for unknown and disabled tokens).
3. CallRail: header `Signature` equals `base64(HMAC-SHA1(signing_key, raw_body))`. Reuse
   `timingSafeEqualStr` from the CTM controller (move it to a shared helper). If `signing_key` is
   null on a CallRail row, reject: the key is mandatory for CallRail.
   WhatConverts: no signature exists; the URL token is the only gate, which is why it is 32 random
   bytes and revocable per org.
4. Body parses as JSON and carries the fields the provider adapter needs; otherwise `202` with a
   logged warning (a `4xx` would count toward CallRail's auto-disable).

Respond `200` immediately after the gates, then process in a fire-and-forget promise with its own
try/catch and logger, exactly like the CTM receiver's post-ack path.

### 4c. Provider adapters

One normalised shape, two adapters. The adapter is the only place vendor field names live.

```ts
type TrackedCallEvent = {
  provider: 'callrail' | 'whatconverts';
  phase: 'pre' | 'post';
  vendorCallId: string;
  callerNumber: string;        // E.164, normalised through normalizeNAPhone
  trackingNumber: string | null;
  startedAt: Date;             // CallRail sends ISO-8601 with offset; WhatConverts sends UTC 'Z'
  source: string | null;       // CallRail `source`, NOT `source_name` (that is the tracker name)
  medium: string | null;
  campaign: string | null;
  keywords: string | null;
  landingPageUrl: string | null;
  referringUrl: string | null;
  gclid: string | null;
  fbclid: string | null;
  msclkid: string | null;
  firstCall: boolean | null;
  durationSec: number | null;  // post only
  recordingUrl: string | null; // post only
  raw: unknown;                // stored on the stash for forensics, never rendered
};
```

CallRail field map: `id`, `customer_phone_number`, `tracking_phone_number`, `start_time`, `source`,
`medium`, `campaign`, `keywords`, `landing_page_url`, `referring_url`, `gclid`, `fbclid`, `msclkid`,
`first_call`, `duration`, `recording`. Ignore `source_name` for attribution.

WhatConverts field map: `lead_id`, `caller_number`, `date_created`, `lead_source`, `lead_medium`,
`lead_campaign`, `lead_keyword`, `landing_url`, `gclid`. It has no pre/post split; treat every event
as `pre` if no row matches yet, else `post`.

### 4d. The join, reusing the existing stash

`PendingCallAttribution` already exists for the click-to-call direction (stash by `to_number`,
claimed in ingest at `backend/src/lib/ctm/ingest.ts:546-563`). Extend it rather than adding a
second stash table:

- New nullable columns: `from_number` (the caller), `vendor_call_id`, `provider`, `attribution`
  (Json, the normalised event minus `raw`), `tracking_source` (the label to write).
- New index `(organization_id, from_number, created_at)`.
- On `pre`: insert a stash row with `from_number = callerNumber`, `to_number = trackingNumber`,
  `consumed_at = null`. Idempotent on `(provider, vendor_call_id)`: a duplicate pre-call updates the
  same row.
- In `ingestCall`, on the **inbound** create path (today the claim block is `direction === 'out'`
  only): claim the newest unconsumed stash where `from_number` equals the normalised caller and
  `created_at` is within the window. Window for inbound: **90 seconds**, not the 30-minute
  click-to-call window. A CallRail ring-to-CTM-ring gap is a few seconds; 90 s covers a long ring
  with margin and keeps two calls from the same person in one afternoon from cross-joining.
- Also claim on the **update** path when the existing row has `tracking_source` null and no
  attribution, so a CTM `starts` that beat the stash by a hair still picks it up on `end`.
- When a stash is claimed, write `tracking_source` from it (CallRail `source` wins over CTM's
  tracking-source name; CTM's name is the fallback) and merge the event into `CallSession.attribution`.
  The Calls table's "Ad Source" column and Source facet then show it with **no frontend change**.
- Store `vendor_call_id` and `provider` on the CallSession too (two nullable columns), so post-call
  can find the row directly.

### 4e. Post-call enrichment

On `post`: find the CallSession by `(provider, vendor_call_id)`. If found, merge duration and
recording URL into `attribution` (do not overwrite CTM's own `duration_sec` or recording, CTM's are
authoritative for billing and playback). If not found, fall back to the same caller-plus-window claim
as `pre` against CallSessions created in the last 30 minutes, then to a stash insert so a very late
CTM row can still claim it. Log at warn if nothing matched: that is the "caller ID got changed"
signal from §3.

### 4f. Idempotency and the existing dedupe

The CTM receiver already dedupes on its own event id. The new receiver dedupes on
`(provider, vendor_call_id, phase)` via a unique on the stash for `pre` and a no-op merge for `post`.
A re-delivered `post` rewrites identical JSON, which is harmless.

## 5. Ops steps (no code)

1. In CTM, rename the "offsite" tracking source on 570-8007 to **Website** and on 523-2530 to
   **Google Ads** (two sources, not one). Done by Ran.
2. After the receiver is on prod: insert the integration row for the org (script under
   `backend/scripts/`, takes org id, provider and signing key from flags, prints the URL). The key
   arrives from the agency out of band; never paste it into the thread, an issue, or a commit.
3. Send the agency the URL and the two numbers. Ask them to enable the Webhooks integration for
   Pre-Call and Post-Call and to place one test call to each number.
4. Verify on prod: two CallSession rows with `tracking_source` "Google Ads" / whatever CallRail
   reports for the pool call, `attribution.gclid` populated on the ads call, `last_event_at` set.

## 6. Slices

Single PR to `staging`, then a cherry-pick promotion to `main`. Not big enough to slice further.

1. Migration: `CallTrackingIntegration` table, stash columns and index, two CallSession columns.
2. `lib/call-tracking/adapters/{callrail,whatconverts}.ts` with unit tests on captured sample
   payloads (CallRail's documented example, one synthetic WhatConverts).
3. `controllers/call-tracking-webhook.controller.ts` plus route. Tests: unknown provider 404, bad
   token 404, bad signature 401, missing key on a CallRail row 401, valid pre inserts stash and
   returns 200 before processing, malformed body returns 202.
4. Ingest change: inbound claim by `from_number` with the 90 s window, update-path claim, attribution
   merge. Tests: stash before `starts` joins; stash after `starts` but before `end` joins; stash older
   than 90 s does not join; two stashes for two different callers never cross.
5. Post-call enrichment and the "no match" warning.
6. The insert script.

## 7. Out of scope, deliberately

- Keywords and campaign in the UI. Stored in `attribution`, not rendered. Ran: not shown as of now.
- The ad-group picker in `NumbersView.tsx` (still a mock; do not demo it).
- Forms (Forminator email or webhook) and Calendly. Separate plans once the agency replies.
- Porting, SIP forwarding, whisper messages. All researched, all rejected as the mechanism.
- Any user-visible vendor naming. Status copy, if ever added, says "Call tracking: Active".

## 8. Risks

- **Caller ID changed on the vendor side** breaks the join silently. Mitigation: the no-match
  warning in §4e; a later slice can surface an in-app status.
- **Post-call lag up to 20 min** means a call can be viewed before its recording link and
  final duration arrive from CallRail. Acceptable: CTM's own recording and duration are already there.
- **Auto-disable on the vendor side** if we return non-2xx repeatedly. Mitigation: `202` for
  malformed bodies, early ack, async processing.
- **The same caller phoning twice in 90 s** (redial after a drop) can join the second call to the
  first call's stash if the first CTM row never claimed it. The stash is single-use, so at worst one
  call carries the other's source, never both.
