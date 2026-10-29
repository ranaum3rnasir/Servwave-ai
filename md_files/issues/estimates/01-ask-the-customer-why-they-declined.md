# Ask the customer why they declined

**Linear:** SRVW-285 — Capture a decline reason on the public estimate page
**Slice 1 of 2.** Slice 2 (the per-organisation configurable reason list and its settings
screen) is deliberately NOT in this slice — see "Why this is sliced" below.

## The problem

When a customer declines an estimate from the emailed public page, ServWave records *that* they
declined and nothing about *why*. The business loses the one moment where the answer is cheap to
get: the customer has just made the decision and is still on the page. Reconstructing it later
means someone ringing to ask, which mostly does not happen.

Raised by the general manager of a cabinet business on 2026-09-03, unprompted. He asked for it to
work "similar to what Amazon has when you submit a return" — a reason picker plus a comment box.

## What already exists — this slice is mostly wiring

- **`POST /api/estimates/:id/decline` already accepts an optional `lost_reason`, validates it and
  persists it.** Live in production today. `estimate.controller.ts` → `declinePublicSchema` /
  `declinePublic`.
- `Estimate.lost_reason` (the `LostReason` enum: `PRICE | TIMING | COMPETITOR | NO_RESPONSE |
  OTHER`) exists and is in production.
- Staff-recorded declines already require a reason, through
  `components/estimates/DeclineEstimateInternalDialog.tsx`. Its `LOST_REASON_LABELS` map is the
  customer-facing wording to reuse, so both sides read the same words.
- The estimates conversion report already consumes the column
  (`report.controller.ts:48,93` → `services/estimate-conversion-report.ts`).

**What is missing is the customer's end of it.** `PublicEstimatePage.tsx`'s `handleDecline` posts
**no body at all**, and the dialog behind it is a plain yes/no `ConfirmDialog` asking only "Are you
sure?".

## What to build

**1. A reason step on the public decline.** Replace the bare confirm with a dialog that asks why,
offering the five reasons above under the same labels staff see, and sends the chosen value as
`lost_reason` on the existing route.

**The reason is OPTIONAL.** A "Skip" / "Prefer not to say" path must decline the estimate exactly
as today. Requiring an answer risks the customer abandoning the decline and simply going silent,
which is a strictly worse outcome than an unlabelled decline — we lose both the reason *and* the
status. Do not add a required-field guard.

**2. A free-text comment, stored.** This is the genuinely new part: there is no column for it
anywhere. Add one nullable `TEXT` column on `Estimate` — `lost_reason_note` — and accept it on
`declinePublicSchema` beside `lost_reason`.

**The comment box is always visible, not only under "Other".** "Price" plus *"we got it three
thousand cheaper down the road"* is worth far more than "Price" alone, and a box that appears only
on one branch trains the customer that the other branches do not want to hear from them. Cap it
server-side, trim it, and store `null` rather than `''` for an empty one — an empty string here is
the same never-render-a-hole problem the automations work has been fixing all week.

**3. Show it back to the business.** The estimate's own surface must display the reason and the
note where a staff member will see them — follow whatever the internal decline already does, and
if it displays nothing, say so in your report rather than inventing a surface.

**Migration:** one `ADD COLUMN IF NOT EXISTS`, nullable, no backfill, no default. Additive and
deploy-overlap safe. Nothing reads it until the frontend sends it.

## Why this is sliced

Ran resolved the shape on 2026-09-08: **the reason list is per-organisation configurable**, built-in
options plus "Other" with free text, managed by admins from a settings screen. That is correct and
it is what gives a cabinet business "designer" and "quality", which the five-value enum has no home
for.

It is also the part that is **not** small: a new per-org option model (copy the `UomOption` shape —
`code` / `label` / `is_active`, unique on `(organization_id, code)` — plus a `sort_order` for the
reordering), its CRUD, a settings screen, and a migration moving `lost_reason` off a Prisma enum
onto the configurable list without breaking rows already written or the conversion report.

So slice 1 ships the capability against the five reasons that already exist, and the always-on
comment box means a customer can type "the designer wasn't the right fit" **today**. Slice 2
replaces the fixed list with the configurable one. Build slice 1 so that the picker reads its
options from ONE exported array — slice 2 should have to change that array's source, and nothing
else in the dialog.

## Acceptance

- Declining from the public page with a reason persists that reason on the estimate.
- Declining with a reason AND a comment persists both.
- Declining with **neither** still declines the estimate, exactly as it does today — same status,
  same `declined_at`, same deposit-invoice voiding, same notification.
- A comment with no reason is accepted and stored.
- An empty or whitespace-only comment stores `null`, never `''`.
- A `lost_reason` that is not a known value is ignored rather than 400-ing, matching the route's
  existing behaviour — do not tighten this in a slice that is not about it.
- An over-long comment is refused or truncated server-side by an explicit rule, not by a database
  error reaching the customer.
- The customer-facing copy names no vendor and no other customer; it is ServWave's own voice.
- The public payload still exposes no staff PII — the decline dialog must not start returning
  anything the page did not already have.

## Out of scope for this slice

- The per-organisation configurable reason list and its settings screen (slice 2).
- Changing the `LostReason` enum's members.
- Any change to the staff-recorded decline or to `decline-internal`.
- Reporting changes. The conversion report already reads `lost_reason`; it gains data, not code.

## Note for the builder

`DeclineEstimateInternalDialog.tsx` carries a comment claiming the public decline route is
"free-text, optional". The "optional" half is right; **"free-text" is wrong** — the handler checks
membership in the `LostReason` enum and silently drops anything else. Correct that comment while
you are in there; it is the kind of stale note that sends the next person down a wrong path.
