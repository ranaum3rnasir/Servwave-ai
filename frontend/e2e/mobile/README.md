# Mobile gate

Playwright checks that measure the app the way the 2026-10-01 mobile audit did, on six device
projects, on every key route and the overlays opened on them. It runs locally, like the other
suites in `frontend/e2e/`: this checkout's frontend plus a doored API on the **staging** database,
in a throwaway `e2e-qa-` org that is provisioned for the run and torn down after it. It is not in
CI; CI stays Vitest-only.

## Run it

From `frontend/`. The config boots both servers itself (or reuses them if they are already up on
this checkout's ports, which it prints first).

```bash
# One slice's routes (comma-separated state ids; a route id also selects its overlays):
MOBILE_GATE_ROUTES=leads,customers npm run test:mobile

# The same, on chosen devices only:
MOBILE_GATE_ROUTES=leads npm run test:mobile -- --project=iphone-se --project=desktop

# Everything: every key route and overlay on all six devices (plus the self-test):
npm run test:mobile

# What the last run found, per check and device, and which listed pairs are now clean:
npm run test:mobile:summary
```

The gate's API does not run the tenant guard unless you ask: deployed staging and production do
(`DB_TENANT_GUARD=on`), and that changes how multi-statement writes behave (a batch
`$transaction([...])` writes and then 500s). For a slice that adds a way to reach a write endpoint,
run with the guard on so the gate sees what a user sees:
`DB_TENANT_GUARD=on MOBILE_GATE_ROUTES=<ids> npm run test:mobile`.

`MOBILE_GATE_ROUTES` also takes `group:<shell|crm|money|field|admin|public>` and prefixes
ending in `*` (`settings*`). The ids are in [`routes.ts`](routes.ts).

Before the first run in a fresh worktree: `npm ci` at the repo root, `npx prisma generate` in
`backend/`, and copy `backend/.env` and `frontend/.env` from the main checkout. `backend/.env`
must carry `E2E_ALLOWED_DB_HOSTS` and `E2E_ALLOWED_DB_REF` for the staging project, as for the
other e2e suites; the provisioner refuses any other database.

## Flip a route/check to enforce (the one place)

[`allowlist.json`](allowlist.json), `entries.<state id>.<check>`:

```json
"leads": {
  "overflow": { "mode": "report", "devices": ["galaxy-s24", "iphone-se"] }
}
```

- `"mode": "report"`: today's known offenders. They are printed as `REPORT` and do not fail, but
  only on the listed devices.
- Set `"mode": "enforce"` (or delete the entry) when your slice fixes that pair. Any offender then
  fails the run.
- A pair that is not on the list is enforced already: any offender on it is new, and fails.
- The run prints `CLEAN` for a listed pair that measured clean, and `test:mobile:summary` lists
  them all, so you can see which pairs your slice can enforce.
- `MOBILE_GATE_ENFORCE_ALL=1` enforces every pair (the final sweep, slice 75).
- `a11y` entries also carry `"rules"`, the axe rule ids known on that route. A rule that is not
  listed fails even on a listed device, so a new kind of violation on a known route is caught like
  a new route. When your slice fixes one rule on a route, delete it from `rules` (and the entry
  when `rules` is empty).

`npm run test:mobile:allowlist` merges the last run's offenders into the file (run the gate first
with `MOBILE_GATE_RETRIES=0`, so a red run is not retried). It only adds report
entries; it never loosens an `enforce` entry and never deletes one. Use it only to record
offenders that already exist on staging, never to wave through a regression your branch made.
`--only=<check,...>` (for example `node e2e/mobile/build-allowlist.mjs --only=a11y`) merges only
those checks, so recording one new check's baseline cannot also widen another check's entries.

### The allow-list after slice 75: documented exceptions only

Slice 75 swept every route on all 15 devices and left in report mode only what cannot be closed by a
page change today. Each `report` entry carries a `slice` and a `reason`, and
`src/__tests__/mobile-gate-allowlist.test.ts` fails without them (and fails an `a11y` entry whose
reason does not name each axe rule it excuses):

```json
"comm-inbox": {
  "a11y": { "mode": "report", "devices": ["..."], "rules": ["scrollable-region-focusable"], "slice": "46", "reason": "what fails (name each rule), and who has to decide or build what" }
}
```

- `slice` is the slice that owns the fix (digits), or `unowned` when no slice does.
- `reason` is at least 20 characters: what still fails, and who has to decide or build what.
- `npm run test:mobile:allowlist` writes entries without a reason on purpose, so a new offender it
  records fails that test until someone documents it or fixes the page.
- An exception is closed by fixing the page and deleting the entry (the next sweep prints `CLEAN`).

What is left: the live-call behaviour of slices 11 and 21, which has no entry
because it is not built yet (no route measures it). No route/check pair is in report mode any more
(`entries` is empty): the Schedule, the last one, is enforced on every device, with the double-booked cards as
a narrow accepted exception (next section). `vendorConsole` is no longer report-only: the notification
bell polls instead of holding a socket to the auth provider, so nothing in our own document makes the browser
print the provider's address, and any vendor name in a console line from our own document fails the run. The
one exception is `acceptedExceptions.vendorConsole` in `allowlist.json` (owner and reason; Ran, 2026-10-08):
lines from the vendors' embedded frames (the phone dialer, the payment form), which print their own console
lines. [`console-lines.ts`](console-lines.ts) attributes a line to a frame by the origin it came from, and the
gate prints those lines as `EXEMPT`. A second, narrower exception (Ran, 2026-10-09): Firefox's two
`Feature Policy: Skipping unsupported feature name` warnings for `clipboard-read` and `clipboard-write`, which the
dialer's own embed script causes by setting `allow=` on its iframe; matched only by feature name, warning text and
that script's path (`isDialerFeaturePolicyWarning`, unit-tested in `src/__tests__/mobile-gate-console-lines.test.ts`),
printed as `EXEMPT` too. `no-provider-socket.spec.ts` holds the other half: a signed-in page opens
no WebSocket to the provider, and neither do the real sign-in form, a token refresh and a sign-out (desktop
control; the sign-out requests are answered by the test so the shared throwaway admin stays signed in).

#### The Schedule's double-booked cards (Ran, 2026-10-08, Option A)

Double-booked jobs stay side by side in one day column. With four or more at the same time each card is
narrower than the 24 px touch-target floor and the later cards can cover the earlier ones. That is
`acceptedExceptions.scheduleDoubleBooked` in `allowlist.json` (owner Ran, reason recorded there). It used to be
three report-mode pairs on `schedule` (`targets`, `a11y` target-size, `scrollReach`), which switched each check
off for the whole route. Now every Schedule pair is enforced on every device, and the exception excuses only
a finding that is a calendar event card overlapping another card in time
([`schedule-double-booked.ts`](schedule-double-booked.ts); classifier tests in
`src/__tests__/mobile-gate-schedule-double-booked.test.ts`):

- **What counts as a card.** A time-grid event card is a `.rbc-event` inside a `.rbc-day-slot` (the day
  column). The all-day row and the month grid draw their events outside any `.rbc-day-slot`, so they are never
  cards. Two cards overlap in time when they are in the same day column and share more than 1 px of vertical
  extent (a card's top is its start time and its height is its duration); cards that only touch do not overlap.
- **`targets`.** An "under 24px and crowded" offender that is, or sits inside, a card that overlaps another
  card. The 44 px primary-control rule is never excused.
- **`a11y`.** Only the `target-size` rule, and only its nodes that are such cards. Its other nodes, and every
  other axe rule, fail as before. A `target-size` rule left with no node is not an offender.
- **`scrollReach`.** Only "the last control is covered by X" where the last control is a card and X is (or sits
  inside) a different card that overlaps it in time. A covering toolbar, popover or the events layer fails; so does a
  control left off screen.
- **Still fails:** a lone card under 24 px, any toolbar button, the view switcher, filters, date navigation, the
  all-day row, popovers, and every other rule.
- **The report.** Excused offenders are removed from the failing list and printed, with a count, as
  `EXEMPT scheduleDoubleBooked: N <check> offender(s) on double-booked event cards (...)`; they are in the run's
  record as `checks.<check>.exempt`.
- **Where it applies.** Only the gate's `schedule` state and its overlays, and only while the
  `scheduleDoubleBooked` record exists in `allowlist.json` (delete the record and the exception is off). Other specs
  call `measure()` without it, so it is off for them.
- **Seeing it work.** The throwaway org books its jobs and walkthroughs a day or two ahead, so on most days the
  gate's `schedule` test opens a week with none of them on screen. [`schedule-double-booked.spec.ts`](schedule-double-booked.spec.ts)
  (on the six devices and the sweep's extra devices) steps the calendar forward until the seeded four-at-once
  case is on screen (it fails, not skips, if that case is missing), waits until the time grid has stopped scrolling
  itself, holds that every double-booked card sits inside the box the grid shows, and then measures the page twice
  from that same resting scroll (the gate's scrollReach check scrolls the grid, so the grid is put back before each
  measurement): green with the exception, and, with it off, red on exactly the checks it excused. Whether a device
  excuses anything depends on its column width, and the run says which: a card is only excused when it is under
  24 px and another control's spacing circle meets it. Where nothing was excused (`nothing excused here` in the log)
  the spec asserts the page is green WITHOUT the exception too, rather than expecting a failure that cannot happen.
  Measured on 11 Oct 2026 (the fixed set below): the exception is exercised on the iPad Mini (portrait, 4 targets and
  4 target-size nodes) and the iPad Mini landscape (7 and 7); on the other 13 devices (iPhone SE, Galaxy S24,
  iPhone 15, iPhone 17 Pro Max, Pixel 7, the iPhone SE and Pixel 7 landscape, the landscape phone, the Fold cover and
  unfolded, the Galaxy Tab S9, Firefox and the desktop control) nothing is excused and the page is green without it.
- **The board holds a fixed set, at a fixed hour** ([`schedule-booking.ts`](schedule-booking.ts); guard in
  `src/__tests__/mobile-gate-schedule-booking.test.ts`). The whole gate shares one throwaway org and one
  technician, and the cards are never excused for overflowing the screen. `seedGateFixtures` books the set once
  per run: four walkthroughs tomorrow at 09:00 (the four-at-once case) and three jobs the day after at 09:00
  (`'board'`), by the ORG's calendar and clock (its timezone, or the Schedule's own fallback). Every record a spec
  builds for itself (`sentEstimate`, `scheduledJob` in `seed.ts`) is booked `'apart'` by default: a day of its own,
  more than a year ahead, which no calendar step reaches. Two things went wrong before this. Each device, retry and
  repeat added a walkthrough to tomorrow's column; by the time a full sweep reached the Fold cover and Firefox
  (360 px) the column held 26 to 43 cards and the last 20 px wide card stuck 1 to 3 px past the screen. And the set
  was booked "24 hours from now", so the hour the gate RAN decided where the cards sat: the Schedule opens on
  06:00 to 19:00 and scrolls its grid to 06:00, so a night run (03:00) put the four walkthroughs above the window,
  scrolled out of the grid yet still under the toolbar's buttons in the page's coordinates (the targets check
  counted the toolbar as crowding them, the scrollReach check then scrolled the grid and nothing was crowded any
  more, so the "fails without the exception" assertion failed on the desktop control), and a late run (23:00)
  found no four-at-once case at all. The set now sits mid-morning whatever the hour of the run; the Vitest guard
  holds it for every hour of the day, across the clocks changing and a date-line, and ties the hour to the
  Schedule's `DEFAULT_WINDOW`. The gate's own `schedule` test is not exposed the same way: a phone opens Day (today
  only), a tablet or computer opens Week with wide columns, and the booked days are tomorrow and the day after. A
  new spec that needs a visit on the calendar books it `'apart'`; the self-check fails with that advice if more than
  a handful of overlapping cards are on screen.

A trap worth knowing: the throwaway org carries a fake connected payments account, and the nightly
account-status refresh on the staging backend (07:30 UTC) fails it closed, so on a run that straddles
that time `/settings/payments` shows the "Under review" badge instead of "Active". The route must read
at AA in every state; `settings-payments-under-review` and `settings-payments-paused` measure the
other tints on their own (the status read stubbed), so a state change under a run is not a flake.
The gate also measures a page again, once, when a navigation destroys the page under a check.

A second trap: the six projects share ONE throwaway org, so a route is measured with every other
project's data in it, and a route can pass alone and fail in the full run. The week grid did: the
seed and each project's technician flow schedule jobs at the same hour (`futureDate(48)`), so a
busy week stacks many cards at one time, and the last card of that stack ended 2 px past the grid
on the iPad Mini (`schedule/overflow`, `div.rbc-time-content`). A
route that passes alone is not proven until it has been run with `MOBILE_GATE_ROUTES=<id>` on all six
projects together. `schedule-week-fit-selftest.spec.ts` holds that case on its own, with the page's
real stylesheets and no servers.

`MOBILE_GATE_A11Y_NODES=40` lists up to 40 nodes per axe rule in a failure, with the measured colours
of a contrast failure (and, for a target-size failure, the node's size and what covers it).

Slice 75 also made checks stricter or more exact, each with a red/green fixture in
`selftest.spec.ts`: `overflow` no longer reports the fill of a progress bar or a shape inside an svg
that its own box clips (they widen nothing); `scrollReach` judges a list that scrolls inside its own
bounded box by whether the box is on screen, and lets the page scroll to its end before it calls a
control covered by a fixed bottom bar; `chromeRatio` counts a sticky element only if it sticks to
the top or the bottom (one that sticks sideways, such as a table's empty state, scrolls away) and
names the bands it counted.

#### The gate's test-inbox address (Ran, 13 Oct 2026)

The gate's customers are on the email provider's test inbox (`delivered+<label>@resend.dev`, see "What it
will not do"), and a customer's email renders on the customer pages, so the always-enforced `vendorTerms`
check would flag it on `customers`, `customer-detail` and `invoice-detail`. That is
`acceptedExceptions.gateTestInbox` in `allowlist.json` (owner Ran, reason recorded there), and it is as narrow
as the gate can make it ([`gate-inbox.ts`](gate-inbox.ts), [`vendor-terms.ts`](vendor-terms.ts); tests in
`src/__tests__/mobile-gate-test-inbox-exception.test.ts` and the `gateTestInbox` cases of `selftest.spec.ts`):

- **What is ignored.** Exactly the address `gateCustomerEmail(label)` builds, as a whole token, in the page's
  rendered text, placeholders and accessible names. The label charset is `[a-z0-9-]`; the builder refuses any other
  label, and the match uses the same charset.
- **Still fails:** the provider's name (`Resend API`, `Resend dashboard`), `resend.com`, `resend.dev` in a URL,
  `delivered@resend.dev` without the gate label, `support@resend.dev` and every other address on that host, a
  sub-domain, a label outside the charset, the address inside a longer token (`x` or `.` before it, `.com`, `/path`,
  `:port`, `?query` or `-more` after it, `mailto:` or `https://` before it), the address in the page title or the
  URL, and the **browser console** (console lines are never exempted).
- **The report.** The ignored addresses are printed as
  `EXEMPT gateTestInbox: N gate test-inbox address(es) in the copy (...)`.
- **Where it applies.** The gate's copy check on every page, and only while the `gateTestInbox` record exists
  in `allowlist.json` (delete the record and the exception is off). Other specs call `measure()` and
  `findVendorTerms()` without the option, so it is off for them.

## The checks

| Check | Fails when | Devices |
|---|---|---|
| `overflow` | the page scrolls sideways, an element is past either edge outside a sideways scroller, a sideways scroller overflows without being documented, or a documented admin table loses its first column when scrolled | all |
| `topbarOverflow` | anything in the top bar (`[data-slot="topbar"]`) is past either edge, or the bar's content is wider than the bar. **Enforced on every route since slice 13** (not on the allow-list); not applicable where there is no top bar | all |
| `targets` | a target under 24 px fails the WCAG 2.5.8 spacing exception; on touch projects, a primary touch control (with its label) is under 44 px. The copilot pill in the top bar is not a primary control (the copilot is out of scope for the programme), but the 24 px rule still measures it. On touch, pairs of sub-44 px targets closer than 8 px are recorded in `checks.targets.info.tooClose` (not asserted yet; slice 25) | all / touch |
| `inputFont` | a text field's text is under 16 px (iOS zooms on focus). Enforced on every key route since slice 14. Its record also lists the computed size of every visible text field, select trigger and combobox (`checks.inputFont.info.sizes`, desktop included), so a slice that touches text entry can diff the desktop control against a run on staging | touch |
| `overlays` | an open dialog, menu, listbox, popover or the drawer is outside the viewport, or its last item cannot be scrolled to and tapped | all |
| `scrollReach` | after scrolling the main scroller to its end, its lowest enabled control is off screen or covered. A control out of view sideways (past the screen edge, or clipped by its own sideways scroll box, such as a wide table's far column) is not a candidate: that is the `overflow` check's business (slice 29) | all (page states) |
| `vendorTerms` | a vendor name is in the rendered text, title, an accessible name, a placeholder or the URL path. **Enforced from day one: it cannot be allow-listed.** The list is [`vendor-terms.ts`](vendor-terms.ts). One accepted exception: the gate's own test-inbox address (`acceptedExceptions.gateTestInbox`, printed as `EXEMPT`); the title, the URL and the console are never exempted | all |
| `a11y` | axe-core finds a WCAG 2.2 AA violation (tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`; [`a11y.ts`](a11y.ts)). One offender per rule: `<rule id> (<impact>): <n> node(s): <first targets>`. An overlay state scans only the open overlay. Frames (`iframe`) are excluded: their documents are not ours | touch |
| `vendorConsole` | a vendor name in a browser-console line from our own document. **Enforced from day one: it cannot be allow-listed.** Lines from the vendors' embedded frames (the phone dialer, the payment form) are excluded before the check, a documented exception ([`console-lines.ts`](console-lines.ts); `acceptedExceptions` in `allowlist.json`), printed as `EXEMPT`. So are Firefox's `clipboard-read`/`clipboard-write` Feature Policy warnings from the dialer's own embed script (nothing else from it) | all |
| `scrimBlur` | a layer covering at least 90% of the viewport applies a backdrop blur (a dialog or sheet scrim, the navigation drawer's scrim). Slice 16 put every scrim blur behind the `pointer-fine:` variant, so it has no allow-list entries: any offender is new | touch |
| `dialogScrollers` | on a dialog that is full-screen or a bottom sheet (`data-presentation` is not `card`), a list scrolls inside the dialog's body scroller: an element with a vertical `overflow` of auto or scroll that overflows now or has a pixel `max-height`, with a scrollable element around it (the body). Text fields and sideways scroll boxes are not scrollers; a card keeps its capped lists. Slice 65 (rubric SCR-02, the dialog half of A4); no allow-list entries, any offender is new | all (phone presentations only; not applicable on a page with no dialog) |
| `chromeRatio` | on a viewport at most 500 px tall (a phone held sideways), the top bar is taller than one row (56 px) or the chrome (bar plus fixed/sticky bands) covers more than 20% of the height. Slice 34; no allow-list entries, any offender is new | all (short viewports only) |

Also measured on every page state and kept in the record, not asserted yet: nested scrollers
(outside dialogs; the dialog half is the `dialogScrollers` check), chrome ratio, broken sticky headers, fields obscured on focus, inputs with no label.

Markers a slice can put in the app:

- `data-mobile-scroll-x="<name>"` on a sideways scroller that is meant to scroll. The name must be
  on the exemption list, [`src/ui-kit/lib/intendedScrollers.ts`](../../src/ui-kit/lib/intendedScrollers.ts)
  (slice 17): the wide admin tables (reports, marketing, the Settings tables, phone numbers,
  inventory administration) and the shared one-row tab strip (`tab-strip`). A bare marker or an
  unlisted name is still an `undocumented sideways scroller`. A listed admin table must also keep
  its first column inside its box when scrolled to its far end, or it fails as `admin table's first
  column scrolls out of its box`. Tables opt in with `scrollBox="<name>"` on the kit `Table` /
  `DataTable` (or the legacy `components/data/table`), which renders the marker and pins the first
  column; `src/__tests__/intended-scrollers.test.ts` holds the list to exactly the names in use.
- `data-touch-primary` on a primary touch control the built-in selectors cannot recognise (for
  example a detail page's main action). It must then be 44 px on touch projects.

## Targeted specs

Specs that run in the same six device projects, with the gate's session, beside `gate.spec.ts`.
`MOBILE_GATE_ROUTES` selects them by the route they open.

- [`kpi-figures.spec.ts`](kpi-figures.spec.ts) (`invoices`, `estimates`): the list response's
  KPI figures are swapped for five- to eight-figure sums, and every tile's value and second figure
  must sit on one line, end inside the tile and stay readable (at least 12 px for the value,
  11 px for the second figure: the floors `statCard.tsx` fits down to).
- [`signature.spec.ts`](signature.spec.ts) (`public-estimate-open`): the public estimate's
  signature pad: buffer = box x pixel ratio, at least 300x160 at 320, a 44 px Clear,
  `touch-action: none` and contained overscroll, ink under the pointer, signature kept and
  unstretched across a rotation (viewport width and height swapped), a dense signature under the
  server's 500,000-character cap, and the stored image equal to the pad's buffer with the ink in
  place. It signs a fresh estimate per device, never the shared key-route one (slice 05). It has
  no report mode.
- [`public-bundle.spec.ts`](public-bundle.spec.ts) (`public-estimate-open`, `public-invoice-open`;
  slice 47): a customer's link is served by the light page (`public.html`, entry `public-main`),
  and on the dev server's per-module network the page asks for no staff-only module (staff layout,
  route table, stores, signed-in client, identity SDK, query library), fetches no service-worker
  script and has none registered or in control. The decline dialog still opens from its own lazy
  chunk with the reason picker, and an unknown `/p/` path is handed to the staff app. Byte budgets
  cannot be read off a dev server; they are enforced on the production build by
  `scripts/check-public-bundle-budget.mjs` (the last step of `npm run build`: public initial
  JavaScript at most 200 KB gzipped, no service worker on the public page, the staff page still
  registering its own). No report mode.
- [`first-paint-fonts.spec.ts`](first-paint-fonts.spec.ts) (`public-estimate-open`,
  `public-invoice-open`, `schedule`; slice 61): no font stylesheet blocks the first render. Nothing is
  requested from a font host, no stylesheet in the document is cross-origin, the head preloads a
  font (as `crossorigin`, a file of ours under `/fonts/`), every declared face is `font-display:
  swap`, and the page's own face (Manrope on the public pages, Figtree on the scheduler) loaded; the
  public pages fetch neither the app face nor the signature script. Read-only, no report mode.
- [`first-paint-metrics.spec.ts`](first-paint-metrics.spec.ts) (`public-estimate-open`,
  `public-invoice-open`, `schedule`, plus `jobs` and `job-detail` for INP; slice 61): LCP and CLS on the
  public pages and the scheduler under Lighthouse's mobile profile (CPU 4x, 1.6 Mbit/s, 150 ms
  round trip, cold cache), and the INP of four interactions with the CPU 4x slow (open a job, change
  a status, type in search, switch the scheduler day), written to
  `e2e/test-results-mobile/first-paint-metrics.json`. **It needs a production build**, so it skips
  unless `MOBILE_GATE_PROD_BUILD=1`; Chromium only. See "Timing on a production build" below.
- [`public-logo-no-shift.spec.ts`](public-logo-no-shift.spec.ts) (`public-estimate-open`; slice 61 round 2):
  the public estimate gets a 6:1 business logo whose request the test holds back; the branded header's
  height, the View PDF link's place and the document's first row are measured before and after the logo
  arrives and must not move (at 320 the unsized logo wrapped the link and shifted the page, CLS 0.283).
  Plain geometry, so it runs on every device in either engine. Read-only; no report mode.
- [`create-new-flows.spec.ts`](create-new-flows.spec.ts) (`home`; slice 47): Create New still opens
  every create flow now that the New Estimate and New Task dialogs are lazy chunks. From the
  navigation drawer (phones, landscape phone) or the sidebar menu (iPad Mini, desktop), each of the
  six items opens what it promises (a dialog for Estimate and Task, reopened a second time from
  the mounted instance; the create page for the other four). Read-only, no report mode.
- [`legacy-modal.spec.ts`](legacy-modal.spec.ts) (`invoice-detail`, `job-detail`, `inventory*`,
  `comm-text`, `comm-inbox`; slice 53): every dialog built on the older titled dialog
  (`components/ui/modal`) that a key route can open in the throwaway org, opened the way a user
  would (a vendor and a catalog item of its own are created through the API for the vendor and item dialogs). Below md (320, 360,
  393) a form or a reader is the whole screen and a confirmation is a bottom sheet on the bottom
  edge; the landscape phone (838x390) takes forms full-screen and keeps a confirmation a card; the
  iPad Mini and the desktop control keep the centred card. On the phones the corner close is 44 px
  and inside the screen, the footer action is on screen without scrolling, and with the body made
  three screens tall and scrolled to its end the close and the footer have not moved. The desktop
  control must reach every dialog. It writes nothing but its one vendor and one catalog item; no report mode. The
  dialogs the org cannot reach are listed in the spec's header.
- [`remaining-dialogs.spec.ts`](remaining-dialogs.spec.ts) (`lead-detail`, `customer-detail`, `estimate-detail`,
  `job-detail`, `tasks`, `invoices`, `settings-users`, `inventory-vendors`; slice 65): every other dialog (the kit dialog
  and the older `components/ui/dialog`, which slot their own header, body and footer) that those routes can open in
  the throwaway org: Mark Lost, Delete client, Add Location, Send / Duplicate / Archive Estimate, Cancel
  Job, Assign, the Price Book picker, Task categories, To Be Invoiced, a user's Edit and Permissions, Add category.
  Same device rules as `legacy-modal.spec.ts` (a form or reader full-screen below md and on the landscape phone, the
  card from md up; close 44 px; footer on screen and unmoved while the body scrolls; the panel itself does not
  scroll), plus the `dialogScrollers` check on each. A reader with no footer (To Be Invoiced) must have no empty
  footer slot. The desktop control must reach every dialog. Nothing is saved; no report mode.
- [`hover-policy.spec.ts`](hover-policy.spec.ts) (`job-detail`, `lead-detail`, `tasks`,
  `inventory`; slice 15): seeds its own files, inventory location and category per project and
  deletes them through the UI. On touch projects each row action must be visible with nothing
  hovered and work by tap, and a tapped button must keep its rest look although the tap leaves it
  in `:hover`; on the desktop control the action must be hidden until its row is hovered. The
  inventory test runs on `ipad-mini` and `desktop` only.
- [`form-fields.spec.ts`](form-fields.spec.ts) (`job-new`, `lead-new`, `customer-new`,
  `job-detail`; slice 20): the job form, the visit dialog, Add Item and the lead and customer
  forms, every optional section open. Below `sm` (320, 360, 393) no two fields share a row and
  every field is at least 120 px wide (a phone extension beside its number is the one designed
  pair); from `sm` up the rows that were multi-column (City/State/ZIP, Address/Unit, the four
  money fields, date beside time) still are. Read-only: it never saves.

- [`admin-tables.spec.ts`](admin-tables.spec.ts) (`settings-tax-rates`; slice 17): the throwaway
  org has no tax rates, so the gate sees an empty state there and its first-column check has no
  table to judge (and the org purge does not delete tax rates yet, so they cannot be seeded). This
  spec answers the list with every state instead. On touch projects the Name column must still
  start inside its box with the box scrolled to its far end (the box must overflow on `ipad-mini`
  and `landscape-phone`, where the Settings two-pane layout is narrowest); wherever the Name cell is
  pinned, the table must use separated borders so the cell draws its own row rule; the desktop
  control's table must fit its box. Read-only: it stubs only the GET.

- [`settings-users-roles.spec.ts`](settings-users-roles.spec.ts) (`settings-roles`, `settings-users`;
  slice 29): the Settings shell, Users & Teams and Roles & Permissions. On every device the page never
  scrolls sideways and Save Changes, Close settings and Invite User are inside the viewport; below
  1024 px the page picker replaces the Settings side nav, from 1024 px the side nav is shown. Roles:
  the switch editor does not make the page scroll sideways; every role in the roles list is on screen. Users: below md the users are a
  card list (`list` named "Users") with no table, from md the table as before. Read-only.
  Since slice 29 the Settings side nav is a picker below 1024 px, so the tax-rates table fits its box
  on every gate device and `admin-tables.spec.ts` no longer requires it to overflow anywhere.

- [`reports-readable.spec.ts`](reports-readable.spec.ts) (`reports`, `report-*`; slice 30): on
  every device, the Revenue report's long title sits wholly inside its h1 (and takes more than one
  line at 320); on Revenue and Items & Services no two tick labels on one axis overlap and none runs
  past its chart; on touch phones a horizontal bar chart's bars keep at least a third of the chart;
  the Expenses "Filter results" panel fits the screen with every group inside it and no sideways
  scroll. Items & Services and Expenses are demo-only reports, so the spec flags the throwaway org
  as a demo org in the browser alone (it edits the `/api/auth/me` answer; nothing is written).
  Since slice 30 the gate also measures `report-revenue`. Its overflow, targets and a11y pairs,
  like those of `reports`, `report-unpaid-invoices` and `marketing`, stay in report mode: every
  offender on them is the shell's top bar or side bar (`div.tb-actions` past the edge at 320-393,
  its 32 px icon buttons, `.tb-pill`, side-bar contrast), owned by slices 13 and 22, not the
  report content.

- [`wave0-behaviours.spec.ts`](wave0-behaviours.spec.ts) (`schedule`, `job-detail`, `jobs`,
  `leads`, `customers`, `estimates`, `invoices`, `public-estimate-open`, `public-invoice-open`,
  `home`; slice GC1): the wave-0 slices that merged before this gate existed, asserted directly
  because the generic checks cannot see them. Slice 02: the scheduler opens on Day below md and on
  Week from md, a picked view survives a reload in the same tab, and `?view=` wins. Slice 03: the
  job page's tabs sit on one row that scrolls inside itself and the newly selected tab is scrolled
  fully into it; KPI tiles are two per row below sm and more than two at xl. Slice 04: the full
  terms are on the public estimate (long terms behind a 44 px "Show full terms") before the agree
  checkbox, and the public estimate and invoice PDF links open in the same tab and return the PDF
  inline. Slice 06: the head carries the apple-touch-icon, a theme colour and a light-only colour
  scheme. Read-only: it never saves, signs or sends. Each assertion was seen red against the old
  behaviour (the slice's change reverted locally) before it was committed.

- [`text-200.spec.ts`](text-200.spec.ts) (`lead-new`, `jobs`, `schedule`, `leads`, `customers`,
  `home`; slice 18): text enlarged to 200% (`html { font-size: 200% }`, the audit's method). On the
  iPhone 15 (all six pages) and the Galaxy S24 (all but `home`) the page must not scroll sideways,
  nothing may sit past an edge, no text may be wider than the box that clips it (a control whose
  label runs out of its button counts), and `/leads/new` must keep Create Lead wholly on the
  screen. The other devices are measured at 200% and printed (`[text-200] measured ...`), not
  asserted: the 320 px phone's top bar, the tablet and desktop navigation rails and the wide
  tables' own sideways scroll at 200% belong to the shell and table slices. At 100% (every device)
  the converted sizes must equal the px they replaced (page title 23 px, field label 13 px,
  buttons 13 and 13.5 px, KPI label 12 px and value 20/26 px), so the desktop control is unchanged.
  Read-only. The source side is guarded by `src/__tests__/type-scale-rem.guard.test.ts`: the
  files on its list set every font size in rem. Each assertion was seen red against the old source
  (the slice's change reverted locally) before it was committed.

The overlay states `job-detail~visitDialog` (Add visit, one-off address open) and
`job-detail~addItem` (Add item, new-item form) were added by slice 20; their `overflow` is
enforced.

- [`scheduler-touch-drag.spec.ts`](scheduler-touch-drag.spec.ts) (`schedule`; slice 58): on touch
  projects a long-press on a calendar event (Day view) and on a Member-board card picks it up, a
  drag to another time moves it and the move is saved (read back from the API); a swipe that starts
  on an event or a card scrolls its grid and moves nothing; on the desktop control a mouse drag
  moves an event and a board card as before. Real touch input through `touch.ts`. The events are
  calendar entries created for the test (a move saves directly), titled with the project; each
  board test takes a day of its own, because cards of one member at one hour stack in his lane and
  the six projects share one org. Seen red against the old scheduler: the four long-press tests
  failed on `galaxy-s24` and `ipad-mini` while the swipe and mouse tests passed.
- [`scheduler-unscheduled-sheet.spec.ts`](scheduler-unscheduled-sheet.spec.ts) (`schedule`; slice
  70): below lg (every project but the desktop control) the unscheduled-jobs panel and its search
  box are not in the DOM, the page is under 1,500 nodes with the bucket closed (the count is
  printed as `[slice70] ...`), the toolbar's entry (in the More sheet on a phone and a phone held
  sideways, a row button on a tablet) is 44 px and opens a sheet inside the screen, a tap on the
  job opens the scheduling form with a 44 px Schedule inside the screen, and Schedule saves it and
  shows it on the board (read back from the API). The desktop control keeps the side panel with
  draggable cards and has no such button. The job is a standalone one created for the test and
  deleted after it (no lead, so the board gains no walkthrough card). Seen red against the old
  scheduler: all five touch projects failed (the hidden panel was still mounted; no toolbar entry
  on the tablet) while the desktop control passed.
- [`text-entry.spec.ts`](text-entry.spec.ts) (`comm-inbox`, `lead-new`; slice 14): the email
  compose window's To, Cc and Bcc (the ghost input), Subject and body are at least 16 px on touch
  projects and 14 px on the desktop control, and each draws a focus indicator (an outline or a
  shadow it does not have at rest). On touch projects, every select and combobox trigger on the
  New lead page is at least 16 px. It writes nothing.
- [`field-kinds.spec.ts`](field-kinds.spec.ts) (`lead-new`, `job-new`, `invoice-new`, `leads`,
  `job-detail`; slice 23): the customer block's Email is an email input (email keyboard, no
  capitalisation or spell-check, no offer of the staff member's own address) and First name
  capitalises words; the leads list search has the Search action key; the job's Notes "Cmd +
  Enter" hint is hidden on touch projects and shown on the desktop control. It writes nothing.
- [`phone-fields.spec.ts`](phone-fields.spec.ts) (`lead-new`, `job-new`, `invoice-new`,
  `customer-new`, `settings-profile`, `settings-company`; slice 36): the Phone field is the phone
  input (tel type and telephone keypad; personal autofill off on a customer's number, phone
  autofill on the profile and company numbers), and typing keeps every digit: "5125550147" shows
  "(512) 555-0147" as before, "+1 512 555 0147" the same ten digits, "+44 7700 900123" exactly as
  typed. No form is submitted. Slice 36 owns no allow-list pair (no gate check measures keyboards).
- [`money-fields.spec.ts`](money-fields.spec.ts) (`job-detail~addItem`, `invoice-detail`; slice 37):
  Add Item's new-item form and Record Payment's Amount hold no number input; each money and
  quantity field is a text input with the decimal keypad, and "1,250.5" shows "1250.5". On the
  desktop control, the wheel and the arrow keys over a focused field leave the amount alone (a
  number input changed it). Nothing is submitted. Slice 37 owns no allow-list pair; the source
  guard `src/__tests__/input-guards/number-field.guard.test.ts` keeps every other field off
  `type="number"`.
- [`form-flow.spec.ts`](form-flow.spec.ts) (`lead-new`, `customer-new`, `job-new`, `invoice-new`;
  slice 38): First Name carries the Next action key; on touch projects Return on it moves to Last
  Name; the A11Y-07 empty-form submit (submit button scrolled into view, then pressed) focuses First
  Name, which is in the viewport, not covered (the element at its centre is the field), aria-invalid,
  and names "Enter a first name or a company name" through aria-describedby. Nothing is sent. Slice
  38 owns no allow-list pair (no gate check measures action keys or error focus); the helper is
  `src/ui-kit/lib/formFlow.ts`.

- [`public-pages.spec.ts`](public-pages.spec.ts) (`public-estimate-open`, `public-invoice-open`; slice 28):
  the public GET is answered with the real document stretched (a long business name, email and
  website, long line descriptions, seven-figure sums, a scope with four photos). On every device
  nothing scrolls sideways; below `sm` each estimate line is two rows (the amount under the image and
  description, scope photos at least 64 px) and the invoice lines are stacked, labelled rows (no
  table), from `sm` up as before; the Totals, header and PDF link are on screen; Approve and Decline
  are the same size and 44 px on touch; the business phone and email are `tel:` and `mailto:`
  links. A forced approval failure (the test answers the approve POST with a 500) is an alert in
  Approve's card and takes focus, and the decline dialog's fields are 16 px on touch. Read-only.

The overlay state `public-estimate-open~declineDialog` (the public estimate's Decline dialog) was
added by slice 28. Slice 28 also enforces `targets` on `public-estimate-open` and `overflow` on both
public invoice states; their `a11y` entries stay in report mode for the accessibility slices.

- [`inventory-plans-automations.spec.ts`](inventory-plans-automations.spec.ts) (`automations`,
  `inventory`, `inventory-activity`, `inventory-staging`, `service-plans`; slice 31): the throwaway
  org has no automations, stages or stock ledger, so each test answers its list GET with a full,
  invented list. A long automation name keeps at least 150 px on every device; the activity page's
  From/To dates are not cut off and keep 120 px each; `/inventory` (300 items) and
  `/inventory/activity` render fewer than 1,500 DOM nodes; staging renders at most 20 stage cards
  until "Show more" and the site line beside the progress column keeps 150 px; service plans page
  at 25 and the page never scrolls sideways; in the New service plan dialog a line's Description
  has its own row and 200 px below `sm` and shares a row with Qty and Price from `sm` up.
  Read-only: it stubs only GETs.

- [`overlay-motion.spec.ts`](overlay-motion.spec.ts) (`home`): opens one of each overlay
  primitive (kit and app Dialog, kit and app Sheet, kit Popover) and a toast from each of the
  two toasters on a signed-in page, through the dev server's own modules. Under emulated reduced
  motion every surface and scrim must compute `animation-name: none` and zero transitions; a
  control run without the preference must see the dialog and sheet animate. On the touch projects
  no dialog or sheet scrim may compute a backdrop blur and the image tile's blurred filler must be
  `display: none`; the desktop control keeps both (slice 16). No report mode.

- [`popovers-and-pickers.spec.ts`](popovers-and-pickers.spec.ts) (`home`, `tasks`, `job-detail`; slice 44):
  (1) one of each floating primitive (legacy and kit Popover, DropdownMenu and Select), mounted through
  the dev server's own modules in the bottom-right corner with a list far taller than the screen and a
  panel 640 px wide, must end inside the viewport with the 10 px collision gutter on every side (the
  two Selects keep 6 of it: they nudge 4 px toward the trigger); (2) the New Task dialog's linked-record
  picker (type Customer, 30 customers answered by the test): below md and on the landscape phone it is
  a full-screen dialog named "Link to a record" (edge to edge, search field in the top part, results
  under it and inside the screen), from md up a popover that fits; on every touch project a swipe
  over the results (the wheel on the desktop control) scrolls the last customer into view, and tapping
  it fills the trigger; (3) a job's sub-status control (the list answered by the test, the one POST
  answered by the test): below md a bottom sheet named "Sub-status" (`data-presentation="bottom-sheet"`,
  edge to edge, anchored to the bottom edge, 44 px options, the last one on screen), from md up the menu,
  on screen with its last item reachable; (4) the lead's status menu (landscape phone and up): a menu that
  has to scroll is in the tab order, so a keyboard can reach it (axe `scrollable-region-focusable`; the kit
  menu panel is `tabindex=0`). Writes nothing. No report mode.

The overlay states `lead-detail~statusChoice` (the lead's status: a bottom sheet below md, a menu from md
up) and `tasks~entityPicker` (New Task > linked record > Customer) were added by slice 44; they have no
allow-list entries, so every check, `overlays` included, is enforced on them. The four `*~filter`
`overlays` entries (the list filter, slices 51 and 64) and `home~notifications` (galaxy-s24; measured
clean in slice 44's runs, owned by the shell slices) stay in report mode.

- [`detail-headers.spec.ts`](detail-headers.spec.ts) (`lead-detail`, `customer-detail`,
  `invoice-detail`, `estimate-detail`, `automation-new`; slice 55): the other five detail headers
  on the shared detail header (`job-header.spec.ts` has the job page). Below `sm` each has a 44 px
  Back control beside the record's name (which keeps at least 80 px), the record's one primary
  action full width and 44 px tall, a labelled 44 px actions menu that opens inside the screen,
  and nothing in the header past an edge; from `sm` up there is no Back control (the estimate and
  the automation builder keep theirs) and the header fits. On the invoice the customer's name keeps
  room and its full value is in a title (it was 0 px at 393); on the estimate "Generate tasks",
  "Add item" and "Add scope of work" are inside the screen sideways; on the builder Publish is. The
  builder is measured as `automation-new` (the throwaway org seeds no automation). Read-only.
- [`detail-tabs-and-errors.spec.ts`](detail-tabs-and-errors.spec.ts) (`customer-detail`,
  `lead-detail`, `customers`, `leads`; slice 68): every tab of the customer and lead pages is
  opened and measured with the gate's own overflow check; below `lg` (1024, not `md`: the customer
  Leads table is 699 px wide on an iPad Mini's 634) the tab tables are cards (no table, each card's
  open control at least 44 px tall) and from `lg` up they are the tables they were. A forced 500 on
  the lead page, the leads list, the customer page and the customers list shows an error with a
  44 px Retry (fixed, vendor-free copy; the server's words never reach the screen), the words
  "Lead not found." / "Customer not found." / "No results found." are not used for a failure, and
  Retry recovers. The list pages' own table scroll box from `md` up (an owned-elsewhere offender of
  the `leads` and `customers` routes) is not measured in the error state.

- [`real-device-emulation.spec.ts`](real-device-emulation.spec.ts) (`inventory`, `home`; slice 73):
  the emulation half of the real-device checklist (`md_files/specs/qa/real-device-release-checklist.md`,
  first run in `real-device-run-01.md`). RD-11 (TOUCH-12): a swipe that starts on a Stock row's More
  actions button must scroll and not open the menu, and a tap must still open it (touch projects;
  a read-only 40-item stub of the Stock list). It has a `REPORT` map like the allow-list: a listed
  project that fails is printed and annotated `REPORT`, a listed project that passes is annotated
  `CLEAN` (delete it from the map), an unlisted failure fails the run. Today all five touch projects
  are listed (F73-1). RD-21: Chrome on iOS (`CriOS` agent) gets the phone drawer, and the iPad with a
  desktop (Mac) agent, platform and touch points gets the 60 px rail. RD-02/RD-03: the viewport meta
  asks for `viewport-fit=cover` and `interactive-widget=resizes-content`. Nothing is written.

- [`inbox-reader.spec.ts`](inbox-reader.spec.ts) (`comm-inbox`; slice 46): the throwaway org has no
  email, so the spec answers the email list GET with a two-message thread (a long unbroken subject,
  a wide table in the body) and two more conversations, and measures the inbox with them. The folder
  rail is closed below 1024 px and open on the desktop control, and the list sits inside the screen.
  Below 1024 px opening a message gives a dialog that fills the whole screen, keeps focus inside it
  through 14 Tabs and, on Escape, puts focus back on the message's row. Below 768 px the reader's bar
  is Back, Archive, Delete, Reply and More (every button on screen, 44 px on touch) and the other
  actions, with the four snooze choices, are in More; from 768 px it is the full bar; at 1024 px and up
  there is no dialog. The open reader, its More menu and the open compose window pass the gate's own
  overflow, targets, overlays, scrim-blur, vendor-term and accessibility checks (colour contrast is
  left out of the accessibility check: the "no job" pill and the menu label are shared and below
  4.5:1 today, see the spec). The compose window is a full-screen form below 768 px and on the
  landscape phone, with Send, Close and Discard 44 px and on screen, and the docked card elsewhere.
  Writes nothing. Seen red against staging before the change (every phone test failed on the missing
  dialog, the open rail or the missing bar). The wide email table scrolls inside its box: the marker
  `email-body` is on the exemption list. The slice also took the `comm-inbox` `a11y` entry
  (`scrollable-region-focusable`, the landscape phone) off the allow-list: the route is enforced on all six
  projects and measured clean with the new reader.

## Touch helpers

[`touch.ts`](touch.ts): `tap(locator)`, `swipe(page, from, to)` and `longPressDrag(page, from, to,
{ holdMs })`, where `from` and `to` are a locator (its centre) or a viewport point. Touch specs use
these, never `click()`, `page.mouse` or `dragTo()`. Each one:

- refuses (throws) on a project without touch, so the desktop control can never fall back to the
  mouse;
- checks that the page received a touchstart (and touchmoves for a gesture), that every pointerdown
  was `pointerType: "touch"`, and that no mousedown came first (and, for a gesture, none at all).

On Chromium (`galaxy-s24`, `desktop`) the swipe and the long-press drag go through the browser's
own touch input (the DevTools protocol's `Input.dispatchTouchEvent`): trusted events, the browser
decides panning, `touch-action` and `pointercancel`, and a swipe scrolls natively. On WebKit
(`iphone-se`, `iphone-15`, `landscape-phone`, `ipad-mini`) Playwright has no touch-move input, so
the gesture is synthesised in the page in the browser's event order and in real time, and the
default pan is emulated: when the first move past a 10 px slop was not cancelled by the page and
`touch-action` allows that direction, the pointer stream gets a `pointercancel` and the nearest
scroller follows the finger. Synthetic events are untrusted and iOS momentum is not modelled;
real-device items RD-09 and RD-10 confirm the task board and the scheduler on iOS hardware.

`press(touch, locator)` taps on a touch project and clicks on the desktop control; the gate's
openers and the targeted specs use it (or `tap`) for every touch interaction, never a bare
`locator.tap()`. The reason (FG2): headless Chromium on `galaxy-s24` sometimes holds a dispatched
touch back, mostly the first tap after a page load on a loaded machine (measured: 3 to 4 in 120).
`locator.tap()` then sits in "performing tap action" until it times out, while the page keeps
painting and no touchstart reaches it, however long it waits; a page capture makes the browser
composite a frame and the held touch is delivered at once. `tap` does that, and only in that
state: on Chromium, a tap that timed out while performing, with no touchstart received, is
followed by frame nudges (a small, fast JPEG capture of the visible surface, at most one in flight)
and a wait for that same touch, for up to 45 s; each time it runs it prints one `[touch] held
touch on ...` line saying whether the touch arrived. It never taps twice and never clicks; a
control the tap cannot reach (covered, never actionable) or a touch that never arrives still fails,
the latter with "the touch was held back and never reached the page". It does not use
`page.screenshot` for the release: that waits for fonts and encodes a full-resolution PNG, and on
a starved browser it hung for its whole 30 s timeout, so the release itself failed (FG2 round 1).

[`touch-selftest.spec.ts`](touch-selftest.spec.ts) proves each helper against fixture controls that
answer only touch and controls that answer only the mouse, on the `selftest-touch` (WebKit),
`selftest-touch-chromium` and `selftest-desktop` projects. A browser cannot be made to hold a
touch on demand, so the held-touch path is proven through `tap`'s third argument (a test seam the
gate never passes): a dispatch that times out "performing" and delivers the touch later must be
nudged and land exactly once; one that never delivers must fail at its budget; a touch that did
arrive, and any timeout on WebKit, must be rethrown at once. Run it with the self-test below after
any change to `touch.ts`. Slices 32 (task board) and 58 (scheduler long-press drag) build on them.

## The full sweep

Before each promotion to `main` (not per slice, and not in CI) one command runs everything the
gate knows, and writes one report:

```bash
npm run test:mobile:sweep          # builds, runs, writes the report; exit 0 only if it passed
npm run test:mobile:sweep:check    # is there a passing report for the commit being promoted?
npm run test:mobile:lighthouse     # only the Lighthouse budget (no report), for tuning
npm run test:mobile:lighthouse:selftest   # the budget goes red on a bloated build (no servers)
```

One Playwright run, one throwaway org, with `MOBILE_GATE_SWEEP=1`:

- **Devices.** The six gate devices with every targeted spec, plus nine more projects that run
  `gate.spec.ts` and the technician flow ([`devices.ts`](devices.ts), `SWEEP_DEVICES`): iPhone 17
  Pro Max portrait (D4), Pixel 7 (D5), iPhone SE landscape 568x320 (D6), Pixel 7 landscape (D8),
  Galaxy Z Fold 7 cover (D9) and unfolded (D10), iPad Mini landscape (D12), Galaxy Tab S9 at exactly
  `sm`, 640 wide (D13), and Firefox 360x740 with touch (D15; Firefox has no `isMobile`). D14, the
  Moto G4 at 4x CPU, is the Lighthouse run's own emulation. Slice runs never include these: the
  extra projects exist only when `MOBILE_GATE_SWEEP=1`.
- **Routes.** Every key route and overlay, plus the audit's "not swept at runtime" list
  ([`routes.ts`](routes.ts), `SWEEP_STATES`, `sweepOnly`): the lead and customer edit pages, an
  estimate version, a job statement, an automation, the phone and text sub-pages and the pop-out
  phone page, ten Settings pages, the 21 reports the key routes do not open, the accept-invite form
  (a stubbed invite, never submitted) and the not-authorized page. `MOBILE_GATE_ROUTES=group:sweep`
  runs just these on the six devices; selecting one by id works in any run.
- **The technician flow.** [`technician-flow.spec.ts`](technician-flow.spec.ts): a fresh scheduled
  job is started and marked complete by tap (click on the desktop control), each control reachable
  and uncovered.
- **Lighthouse.** [`lighthouse.spec.ts`](lighthouse.spec.ts) measures the production build
  (`vite preview`, proxied to the doored API) with Lighthouse's mobile defaults (slow 4G, 4x CPU),
  three runs, the median judged against [`lighthouse-budget.json`](lighthouse-budget.json): LCP at
  most 2.5 s and CLS at most 0.1 on the public estimate, the public invoice and the technician
  landing page (signed in as its own technician, so a sign-out there cannot end the gate's
  sessions). `mode` is `enforce` (a miss fails the sweep) or `report` (the miss is printed in the
  report, the page names the slice that owns the fix, and it carries a `ceiling`: over the ceiling
  the sweep fails even in report mode, so it cannot get worse meanwhile). A page moves to `enforce`
  when its owner lands, and ceilings only come down. First measured on 2026-10-04: all three pages
  were over 2.5 s (public estimate 4.1 s, public invoice 3.6 s, technician landing 9.3 s), so all
  three start in `report` with slice 61, whose acceptance criteria are this budget. Re-measured on
  2026-10-05, after slice 61 landed: 3.3 s, 3.3 s and 8.5 s, still over, so they stay in `report`
  with lower ceilings (4.2 s, 4.2 s, 10 s). Re-measured on 2026-10-06 after slice 61's round-1 staging fix: 3.5 s, 3.5 s and 7.6 s (8.5 s before it, same run conditions), still over, so they stay in `report`; the technician landing ceiling is now 9 s. Re-measured after slice 61's round-3 staging fix (the customer's page built on its own: 3 scripts instead of 37, its document request started early): public estimate 2.28 s and public invoice 2.26 s, under 2.5 s, so both are `enforce` now; the technician landing page measures 7.29 s and stays in `report` with an 8 s ceiling (it cannot reach 2.5 s without a much smaller staff first download, see `md_files/specs/qa/mobile-first-paint-measurements.md`). [`lighthouse-budget-red.spec.ts`](lighthouse-budget-red.spec.ts) proves the budget
  can fail: a lean page passes, a page blocking on a 5 MB script fails on LCP, a page whose content
  jumps fails on CLS, and the real production build with that script injected fails.
- **The report.** [`sweep.mjs`](sweep.mjs) reads the Playwright results, the gate's records and the
  Lighthouse numbers into `test-results-mobile/sweep/<UTC time>-<commit>/report.md` and `.json`
  (newest copied to `sweep/latest.*`; `MOBILE_SWEEP_REPORT_DIR` moves them). It lists every device
  with whether it ran, the route x device matrix, any state that did not run, the failures, the
  Lighthouse table and the known report-mode offenders still on the allow-list. A device or state
  that did not run fails the report, as does any failing self-test.
  [`sweep-check.mjs`](sweep-check.mjs) is the promotion check: see
  `docs/promotion-parity-check.md`, axis 5. The decisions are pure functions in
  `scripts/mobile-sweep-lib.mjs`, tested by `src/__tests__/mobile-sweep.test.ts`.
- **Known failing specs.** [`known-failing.json`](known-failing.json) records targeted specs (and
  gate states) that fail on the staging base itself, so one stale spec cannot block every
  promotion. An entry matches a failing row only by spec file, title (when given), device project
  (when listed) AND a piece of the error text; any other failure is new and fails the sweep. The
  report lists them under "Known failing specs" and notes an entry that passed this run (delete
  it). Each entry names an owner. Add one only from a run on a clean staging commit, with the error
  text; never to make a run green. A non-zero Playwright exit is excused only when every failing
  row is a recorded one.
- **The dashboard mock is pinned off.** A developer's `frontend/.env.local` may set
  `VITE_DASHBOARD_USE_MOCK=true` (the design-system preview); a fresh worktree copies it with the
  other env files. The config's dev and preview servers and the sweep's production build set it to
  `false`, so the dashboard checks measure the live API, not the static seed's seven-figure
  receivables.
- **A run that dies.** If the Playwright process is killed (no summary), the report is FAIL and says
  so, and `sweep.mjs` tears the throwaway org down itself. The teardown retries three times,
  clearing what a RESTRICT foreign key stops the org purge removing (`PURGE_BLOCKERS` in
  `scripts/mobile-sweep-lib.mjs`: tax rates, vendors, job sub-statuses; a spec that seeds records of
  another such table adds it there, the first teardown log names the `<table>_organization_id_fkey`)
  before each, and logs each attempt. If an org is still there, the report names it and its id is in
  `e2e/.auth/leaked-orgs.txt`. `npm run test:mobile:teardown` retries it by hand (it fails while the
  org remains), and every run's `setup` does the same for an earlier run's leftover org before it
  provisions its own. Orphaned `vite`/API servers from a killed run are not stopped by this: check
  the ports the run printed (`lsof -i :<port>`).
- **Known broken pages.** [`known-broken.json`](known-broken.json) lists pages that show the app's
  error screen for the throwaway org (today `/reports/estimate-conversion`: `s?.open.count` on a
  stats object with no `open`). The gate skips them, every report prints them under "Known broken
  pages", and whoever fixes the page deletes the entry. An unlisted page that crashes still fails.
- **Why not Playwright's JSON reporter.** The sweep writes its results with
  [`sweep-reporter.ts`](sweep-reporter.ts): the built-in one inlines every attachment, the gate
  attaches a record to each of its roughly 2,900 tests, and the resulting string is too large to
  build, which loses the run's summary. The sweep also skips the HTML report for the same reason.
- **New devices and routes start in report mode.** Their known offenders are in
  [`allowlist.json`](allowlist.json) like any other; the owning slice flips them to `enforce`.

Needs `npx playwright install` (Firefox included) once per machine, `npx prisma generate` in
`backend/` once per worktree (the doored API imports the generated client), and at least 3 GB of free disk
(`MOBILE_SWEEP_MIN_FREE_GB`): the sweep refuses to start without it, because a full disk ends a run
with no summary and no report, and keeps no traces or screenshots for the same reason.
`--partial` runs (`--routes=...`, `--projects=...`, `--skip-build`) are for developing the sweep and
can never pass the promotion check.

## Phone visual baselines

The gate measures; the baselines compare pixels. They catch a layout that is still inside every
measurement (no overflow, every target 44 px) but no longer looks as it was reviewed. Slice 74,
rubric TEST-06, story 148. It is the phone twin of the desktop visual-regression gate
(`npm run test:visual`) and has the same limit: **a local, macOS-only developer gate, not CI.** The
committed PNGs are named for their platform (`...-darwin.png`); a Linux run finds no file, writes its
own and compares nothing, so it proves nothing.

```bash
npm run test:mobile:visual            # compare: exit 0 only if every photograph matches
npm run test:mobile:visual:update     # re-record, then review the PNG diff before committing
MOBILE_VISUAL_STATES=lead-detail*,customers npm run test:mobile:visual -- --project=iphone-se   # a subset
```

- **What it photographs** ([`visual-states.ts`](visual-states.ts), the one list): the customer's public
  estimate (with its Decline dialog) and invoice (slice 28); the customer, lead, estimate, invoice,
  job and automation-builder pages on the shared header (slice 55); the lead's status sheet and Mark
  Lost dialog and the navigation drawer (slice 65); text messages, the list and an open thread, one
  pane at a time (slice 69); and the customers and invoices lists. Three phones: iPhone SE 320x568,
  iPhone 15 393x659 and the landscape phone 838x390.
- **How a screen is photographed.** A portrait phone gets the whole page in one tall image: the
  viewport keeps the phone's width, so every breakpoint decides as it does on the phone, and grows to
  the page's height (the app's layout is `100dvh` with an inner scroller, so `fullPage` alone would
  capture one screen). A page taller than 6,000 px fails the run and names the height, so coverage
  cannot shrink quietly. The height is part of the photograph, so a reading of the page's scroll
  extent counts only when it repeats and running animations have finished (`e2e/mobile/fit-page.ts`,
  unit-tested): one run in nine once failed on a transient 11 px overshoot under heavy machine load.
  An overlay (sheet, dialog, drawer) is photographed at the phone's real size,
  because it is placed against the viewport. The landscape phone gets its real-size first screen
  (`<id>-top`) and, when the page scrolls, the screen at the end of the scroll (`<id>-end`): the chrome
  that landscape squeezes and the last rows. Files: `e2e/visual-baselines/phone/<id>-<device>-darwin.png`.
- **Its own org, fixed data.** `visual-setup.ts` provisions a throwaway org of its own and seeds fixed
  literals (made-up people and sites), because the gate's org carries random names and its specs create
  records while they run. A fresh org numbers from 1, so every number on screen is the same each run.
  The text threads a throwaway org cannot have are answered by a test double with made-up content;
  nothing is sent. Same teardown as the gate.
- **Determinism, removed at source and never masked.** The clock is pinned (`page.clock.setFixedTime`),
  locale and timezone are pinned by the config, every date-shaped value in an `/api/**` response is
  rewritten to a fixed instant by field name, the run-id org name and admin email are pinned,
  animations are disabled and the caret hidden, the pointer is parked off the screen and the capture requires that no control is hovered or focused (a tap leaves the emulated pointer where the finger lifted, and a dialog opening under it gets a `:hover` border only some of the time, which once made one baseline flip between runs), and there are no retries (a retry that passes hides
  exactly the instability that makes a baseline worthless). Tolerance: 100 differing pixels, the
  desktop gate's value (a 4 px move on one small control is about 320).
- **It can fail.** `selftest: a deliberate layout change fails the comparison` moves one covered
  page's headings by 6 px, without changing its size, and requires the comparison against the
  committed baseline to fail with a pixel difference rather than a missing file. It does not run while
  baselines are being re-recorded (it would overwrite one).
- **When a baseline changes.** A layout change that is intended re-records the PNGs it moved, in the
  same PR, and the reviewer looks at the images. Never re-record to make a red run green without
  looking at what moved. The promotion check
  (`docs/promotion-parity-check.md`, axis 5) names this run beside the full sweep.
- `src/__tests__/phone-visual-baselines.test.ts` keeps the list, the committed files, the scripts and
  the checklist in step (a screen with no photograph, or a photograph with no screen, fails it).

## Devices

`iphone-se` 320x568 WebKit, `galaxy-s24` 360x780 Chromium, `iphone-15` 393x659 WebKit,
`landscape-phone` 838x390 WebKit, `ipad-mini` 768x1024 WebKit, `desktop` 1280x720 Chromium (the
control). All from Playwright's own device descriptors ([`devices.ts`](devices.ts)).

## Self-test

`npm run test:mobile:selftest` (no servers) proves every check goes red on a deliberately broken
fixture page and stays green on a clean one, through the same code that judges the real routes,
and that every touch helper drives the page by touch only. Run it after any change to `checks.ts`,
`a11y.ts` or `touch.ts`.

## What it will not do

- The API it boots (`backend/src/scripts/e2e-api-server.ts`) runs no crons: `npm run dev` would
  start the cross-org automation poller against staging and send other orgs' due texts.
- The throwaway org has outgoing email off, and seeding marks estimates sent and makes invoice
  links without sending them. The "Payment Received" receipt ignores that switch, though, so a
  recorded payment DOES send one receipt. Every customer the gate seeds is therefore on the email
  provider's test inbox (`delivered+<label>@resend.dev`, [`gate-customer.ts`](gate-customer.ts)),
  which accepts mail and never bounces; an address on a domain that cannot resolve (`.invalid`,
  `.test`, `.example`) bounces and hurts the staging sending domain.
  `src/__tests__/mobile-gate-receipt-inbox.test.ts` holds that. Nothing places calls or sends texts.
- Teardown deletes only this run's own Auth users (`auth_sweep: 'org'`), so a gate run in another
  worktree keeps its session. `MOBILE_GATE_KEEP_ORG=1` keeps the org for debugging; tear it down
  afterwards.
- Each checkout gets its own ports, so two worktrees never measure each other's dev server.
- It never lets the app's sign-out request through. The app signs out globally when one
  `/api/auth/me` call fails (audit finding F02), which on a loaded machine would end every
  worker's session mid-run.

## Reading a failure

- `mobile gate: new or enforced offenders on <state> (<device>)` lists each failing check, why
  (`new offender`, `switched to enforce`, `enforced from day one`) and the offenders. That is the
  gate doing its job.
- `could not open the overlay`, `rendered no text`, `sent the signed-in admin to /login`, or a
  timeout mean the page could not be measured. They are never allow-listable. On a heavily
  loaded machine rerun the failed states, or lower the workers: `MOBILE_GATE_WORKERS=2`.
- A skipped overlay state names why it does not apply (no drawer on wide screens; a New button
  that opens a page, which is measured as its own route).

## Run times

Measured on 2026-10-02 on the shared development machine while it was heavily loaded (load
average about 70 to 150), with 4 workers. Expect less on a quiet machine.

| Run | States x devices | Wall time |
|---|---|---|
| One slice: `MOBILE_GATE_ROUTES=leads,customers` (2 routes + their 4 overlays, all six devices, plus setup and self-test) | 36 | about 2 min |
| One route, all six devices | 18 | about 2 min |
| Full sweep: every key route and overlay on all six devices | 71 x 6 = 426 (27 skip as not applicable; 73 states since slice 20) | 10 to 15 min at load 100 to 140; 31 to 34 min at load 145 |
| Self-test only (no servers): checks on 2 projects, touch helpers on 3 | 2 x 41 + 3 x 9 | under 1 min |

Add about a minute when the API is not already running (it boots through `tsx`). Seeding the
throwaway org (four estimate-to-invoice chains) takes 30 to 60 s of each run.

## Timing on a production build

A dev server cannot say anything about load time, so the timing specs
(`first-paint-metrics.spec.ts`) run against `vite preview` of a built `dist/`, with the same
throwaway org and doored API as the rest of the gate. The gate's config reuses a server that is
already listening on its web port, so start the preview there first:

```bash
cd frontend
npm run build                     # or: npx vite build
# the ports are printed by the gate's first line: "[mobile-gate] API :3467  web :5467"
VITE_BACKEND_PORT=<api port> npx vite preview --port <web port> --strictPort &
MOBILE_GATE_PROD_BUILD=1 MOBILE_GATE_ROUTES=public-estimate-open,public-invoice-open,schedule,jobs,job-detail \
  npm run test:mobile -- --project=galaxy-s24 --project=desktop first-paint-metrics
```

The build also checks the bundle itself (the last step of `npm run build`,
`scripts/check-public-bundle-budget.mjs`): the public pages' initial JavaScript, the staff app's
initial JavaScript excluding the copilot (the 350 KB target, enforced), and font loading (no third-party stylesheet or preconnect, a crossorigin
preload for a file that shipped).

