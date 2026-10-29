# Let the author choose the ServWave number instead of the personal one

**Type:** AFK
**User stories covered:** 12, 13 (second reading — see "Why this is a second field")

## Parent

Spec: `md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md`
Sits on top of slice 05, which shipped `lead.performer_phones` / `technician.phones`.

## Why this is a second field, not a change to the first

Slice 05 answered "give the customer a number that reaches the person coming" with the
person's **own** number — `User.phone` / `User.phone_ext`, the one they typed into My Profile.
For a lot of organisations that is a personal mobile, and publishing it to every customer on
every confirmation is a decision the organisation has to be able to decline without giving up
the capability.

There is already a second number attached to the same person, and it is the organisation's
own: `UserPhoneNumber.is_default` links a user to a `PhoneNumber` the organisation owns. That
is the number the product already presents as their caller ID on outbound calls, resolved by
`lib/communication/resolveOutboundNumber.ts`. It is the right number to put in a customer's
inbox when the organisation does not want to publish mobiles: it reaches the same person, it
is reachable after they leave, and it is already recorded against calls.

So the author picks. Neither field replaces the other; both sit in the same group and the
template says which one this organisation is willing to print.

## What to build

**No schema work and no new capture.** `UserPhoneNumber`, `PhoneNumber` and the admin screens
that assign them already exist (`comm-number-assignments.controller.ts` for the org roster,
`comm-my-number.controller.ts` for the user's own). This slice is two catalog entries, a
resolver, and a fallback chain.

Two fields, siblings of the two slice 05 shipped, in the same groups:

- **`lead.performer_servwave_phones`** — "Walkthrough team ServWave phone(s)", beside
  `lead.performer_phones` in "Lead & walkthrough".
- **`technician.servwave_phones`** — "Technician ServWave phone(s)", beside
  `technician.phones` in "Job". The `technician.` prefix already buckets into "Job"; the
  prefixes are load-bearing, a name with no known one falls silently into "Other".

**Resolution.** For every person on the visit, their default assignment — the `PhoneNumber`
reached through `UserPhoneNumber` where `is_default` is true, restricted to the person's own
organisation and to `status: 'active'`. Render it for a human: prefer `PhoneNumber.formatted`,
fall back to formatting `e164` through `lib/phone-format.ts`, which is what every other
customer-facing surface renders through. Dedupe — two people sharing one departmental number
are one contact — and join the same way slice 05 does.

Unlike the personal field there is no extension to attach: an extension belongs to
`User.phone_ext` and describes the switchboard behind the personal number, not this one.
Do not borrow it.

**The fallback chain (D7 — never an empty string, never the bare token):**

1. the person's own default ServWave number
2. the organisation's default ServWave number — `PhoneNumber.is_org_default`, active
3. the organisation's main line — `Organization.phone`, the same value `{{org.phone}}` renders
4. `MAIN_LINE_FALLBACK` (`'our office'`), already exported by `services/performerPhone.ts`

**Step 1 never falls through to the person's personal number, and that is the point.** An
author who chose this field over `performer_phones` chose not to publish mobiles; quietly
substituting one would hand the customer exactly the number the choice was meant to withhold.
Silently degrading to an organisation-owned number is the correct failure.

As in slice 05, *some* of the crew lacking an assignment is not the fallback case — render the
ones that resolve. The fallback is for nobody on the trip having one.

**Naming is a boundary, not a preference.** The label says **ServWave**. The vendor behind
these numbers must not appear in the label, the sample value, the description, the field
picker, or any error that can reach the UI. `PhoneNumber.source` (`'ctm' | 'byo'`) is a
storage detail and must not be rendered or exposed as a distinction the author can see.

## Acceptance

- A walkthrough whose performer has a default ServWave number renders that number.
- The same person's personal number is NOT rendered by this field, and the ServWave number is
  NOT rendered by `lead.performer_phones` — the two fields stay independent.
- A two-person crew where one has an assignment renders that one number, not a fallback.
- A crew where nobody has an assignment renders the organisation's default ServWave number.
- An organisation with no default ServWave number renders its main line; with neither, `our office`.
- Neither field ever renders an empty string, and neither ever renders its own token.
- An inactive `PhoneNumber`, or one belonging to another organisation, is never rendered.
- Both fields carry a label and a sample value, so `catalog.test.ts` passes.
- The sample values are plausible ServWave numbers and differ from `org.phone`'s sample and
  from slice 05's samples, so a preview does not read as though every field is the same number.
- No rendered string anywhere in the diff names the telephony vendor.

## Out of scope for this slice

- Routing an inbound call to whoever is performing the visit (spec D11, still out).
- Any change to how numbers are assigned, bought, or released.
- Exposing the choice anywhere other than the field picker — no per-organisation "which number
  do we publish" setting. The template already carries that decision by naming a field.
