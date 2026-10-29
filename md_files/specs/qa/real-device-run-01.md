# Real-device run 01: run sheet and record

First run of the [real-device release checklist](real-device-release-checklist.md) (mobile slice 73,
rubric TEST-07, and the on-hardware confirmation of VP-02, VP-03, VP-04, VP-06, KB-06, KB-07, KB-09,
TOUCH-09, TOUCH-12, CMP-06, CMP-14, CMP-15, CMP-16, PUB-01, PUB-02, PWA-02, PWA-06, A11Y-01, A11Y-08).

This is a local planning document. It is not published, and its follow-ups are local (no issue is
filed from it).

## Status

| Part | State |
|---|---|
| The sheet (what to bring, what to do, where to record) | written, below |
| The emulation half (everything a headless browser can show) | **run 2026-10-06 against the staging base, results below** |
| The real-device half | **to be run by Ran.** Nothing in the Results table is marked passed: that is the tester's word, not an agent's |
| Rows whose owning slice has not landed | marked **pending**, never passed (RD-13 fully; RD-04 in part) |

- **Code under test:** `origin/staging` at `615af542b` (mobile slice 54 merged, #2493), plus this
  slice's test files. (Staging moved on to `ac9764d35`, a slice 62 sweep-script fix that changes no
  app file, after the run; this branch is rebased onto it and the guard tests were re-run.) The gate serves this checkout's frontend with its own API on the staging
  database; it is not the deployed site. Before the run on phones, write down the commits that are
  live on deployed staging (the backend commit from the hosting dashboard's latest deploy, the
  frontend commit from the latest frontend deploy) in the Recording block at the end. If the deployed
  site is behind `615af542b` or the phone shows the old app, close and reopen the app (or reload
  twice) first: a stale service worker serves the old frontend.
- **Landed since the checklist was written:** every slice the checklist cites except 63 and 21
  (calling) and 69 (single-pane text and chat reader). The checklist's own rule applies: an item
  whose owner has not landed is **pending**.

## What Ran must do

About three hours for everything; about 45 minutes for the first tier. Do tier A first: it is the
slice's own acceptance list (the on-hardware confirmations), so a short session still closes the
slice's real question.

1. **Prepare (15 minutes).**
   - Staging, not production, and the demo organisation only. Never a real customer's organisation.
   - Create the two tester users below (Settings > Users & Teams > Invite User) and accept the
     invitations on the phone.
   - Put a long test list in place so row-menu and scroll items have something to scroll: Inventory
     with at least 25 items (RD-11, RD-22, RD-55), Tasks with more than 25 tasks (RD-54), a job with
     a few photos and notes (RD-07, RD-22), an estimate with three or more lines (RD-44) and a sent
     estimate and invoice you can open from their customer link (RD-12, RD-14, RD-17, RD-40).
   - Install the app to the Home Screen on one iPhone and one Android phone (RD-57 is exactly this
     step; look at the icon as you do it).
   - Ask for the live commits and write them in the Recording block.
2. **Tier A, about 45 minutes.** RD-02, RD-03, RD-05, RD-06, RD-07, RD-08, RD-09, RD-10, RD-11,
   RD-12, RD-14, RD-15, RD-16, RD-17, RD-18, RD-19, RD-20 (the VoiceOver and TalkBack pass can be a
   shorter walk if time is short; say so in the notes), RD-01, RD-04 (email compose part only),
   RD-46. These are the rows the rubric marks as needing a device.
3. **Tier B.** Every other row that is not pending, in numeric order. Each row says which browser
   and device codes it needs (the tables under Devices and browsers); a row you cannot run for lack
   of a device is **pending: no device**, not skipped silently.
4. **Rows with a known emulation result.**
   - **RD-11** already fails in the headless browser (F73-1). Confirm it with a finger on a real
     phone and note the device. Do the scroll from a row's three-dot button, not from the row body.
   - **RD-15** is predicted to fail from the code (F73-2). A failing row needs no extra work: record
     fail, the device and browser, and the follow-up is already named.
5. **Record** (see Recording the run): one line per item, per device and browser, in the Recording
   block; then replace "to be run by Ran" in the Results table with pass, fail, pending or n.a. (a
   row passes only if every line for it passed). A failed row names its follow-up in the Notes
   column; if it is not one of F73-1 to F73-6, add the next F73-n to the Follow-ups table.
6. **Do not**: call or text a customer number, press Call on any number but the staging test phone
   (and only with your OK for that run), sign out of the shared demo admin, or use a real
   customer's data. RD-13 is pending, so no call is placed in this run.

## Devices and browsers

Codes are those of the checklist.

| Code | Device | Notes for the run |
|---|---|---|
| P1 | a small iPhone (SE class), 320 px | the narrowest screen; most overflow and keyboard rows start here |
| P2 | a current iPhone with a Dynamic Island | notch, home indicator, installed app, VoiceOver |
| P3 | a mid or low-end Galaxy A-series | Chrome and Samsung Internet; the Android keyboard |
| P4 | a Pixel | the installed app and TalkBack |
| P5 | an iPad | the tablet layout, a keyboard and a trackpad |

| Code | Browser |
|---|---|
| B1 | iOS Safari in a tab |
| B2 | iOS Safari from the Home Screen (the installed app) |
| B3 | Chrome on iOS |
| B4 | Chrome on Android, in a tab and as the installed app |
| B5 | Samsung Internet, including its forced dark mode |
| B6 | Firefox on Android |
| B7 | in-app browser from an SMS link |
| B8 | in-app browser from an email-app link |
| B9 | in-app browser from a social-app direct message |
| B10 | iPadOS Safari with its desktop user agent |

Bring what you have and record what you used. The checklist names the pairing for each row; if a
pairing is missing, run the row on the closest device and write that down.

## Accounts

- **Tester A** (an Admin) and **Tester B** (any other role, only to be a second user for RD-07's
  "sign in as a second user"), both invited by you in the staging demo organisation, with addresses
  you can read on the phone (the sign-in code arrives by email, RD-25).
- Do not use the shared demo admin on a phone: several rows ask you to sign out, and signing that
  account out signs out everyone else using it. RD-33 says not to tap Sign Out on a shared account;
  the same holds here. Sign out only as Tester A or Tester B.
- Passwords come from your password manager. Nothing in this document holds a credential.
- Public links (RD-12, RD-14, RD-17, RD-40) are the customer links of a sent estimate and a sent
  invoice in the demo organisation. Send them to yourself (a text to your own number, an email to your
  own address) so that they open from an SMS, a mail app and a direct message as a customer would
  open them. A card payment (RD-17) uses a test card on staging; if the pay step is not offered on
  staging, record RD-17 as n.a. for the pay part and say why.

## Routes

Where each group of rows happens (staging app paths; the gate measures the same ones).

| Area | Paths |
|---|---|
| Shell, drawer, top bar | `/`, the navigation button, Create New, Settings |
| Create forms (long forms, keyboard, guard) | `/leads/new`, `/customers/new`, `/jobs/new`, `/invoices/new`, New Task on `/tasks` |
| Lists and cards | `/leads`, `/customers`, `/jobs`, `/estimates`, `/invoices`, `/tasks`, `/inventory`, `/service-plans`, `/automations` |
| Detail pages | `/leads/:id`, `/customers/:id`, `/jobs/:id` (Notes, Items, Attachments), `/estimates/:id`, `/invoices/:id`, `/customers/:id/statement` |
| Scheduler | `/schedule` (Day, Week, Month, Member board, Plan Mode, Unscheduled jobs) |
| Communication | `/communication/inbox` (compose), `/communication/text`, `/communication/phone` (calling is not run) |
| Reports | `/reports/revenue`, Items & Services, Expenses |
| Settings | `/settings/users`, `/settings/roles`, `/settings/profile`, `/settings/company`, decline reasons, job sub-statuses, payments and lists |
| Customer pages | the public estimate and invoice links (`/p/estimates/...`, `/p/invoices/...`) |
| Installed app | the Home Screen app; the manifest at `/manifest.webmanifest` |

## Emulation evidence

Every command was run from the repository root's `frontend/` folder in this slice's own checkout
(`origin/staging` at `615af542b` plus this slice's files) on 2026-10-06. The machine was under heavy
load from other work (load average above 60), so times are long.

| ID | What | Command | Result |
|---|---|---|---|
| E1 | The whole mobile gate: every key route and overlay, the checklist-related specs, on the six device projects (iPhone SE 320x568, Galaxy S24 360x780, iPhone 15 393x659, landscape phone 838x390, iPad Mini 768x1024, Desktop Chrome 1280x720 control). Run 04:02:07Z to 06:05:10Z, 2.1 hours | `cd frontend && npm run test:mobile` | **exit 1**: 1799 passed, 10 failed, 2 flaky (passed on retry), 158 skipped. The 10 failures are 9 pairs that `known-failing.json` already lists (the Filters-popover date sheet on three phones, the "600 total" inventory-activity check on six projects) and one new: `settings-users` on iPad Mini (F73-3). Per-row spec counts below are read from this run |
| E2 | The row-menu scroll finding (RD-11, TOUCH-12). A new spec: the Stock list is answered with 40 invented items (a read-only stub); a swipe starts on a row's More actions button, then a tap | `cd frontend && MOBILE_GATE_ROUTES=inventory npx playwright test --config=e2e/playwright.mobile.config.ts real-device-emulation` | **Red first**, with the finding not yet listed: 5 of 5 touch projects failed ("the menu opened when a scroll started on its button"; on Galaxy S24 the open menu also held the page still, the page moved 0 px). Listed in the spec's REPORT map, it then passes with a `REPORT` line per project; the desktop control is skipped (no finger). The tap that opens the menu is asserted too, so a fix cannot "pass" by making the button dead |
| E3 | User-agent families (RD-21). Chrome on iOS (WebKit with a `CriOS` agent) gets the phone drawer; the iPad with a desktop (Mac) agent, a `MacIntel` platform and 5 touch points gets the 60 px rail, not the desktop sidebar. Plus a unit test that `isIosDevice` knows both, and not a real Mac or an Android phone | `cd frontend && MOBILE_GATE_ROUTES=home npx playwright test --config=e2e/playwright.mobile.config.ts real-device-emulation -g "RD-21"` and `npx vitest run src/__tests__/contactHrefs-user-agents.test.ts` | Pass on iPhone 15 and iPad Mini. **Red checks:** with the rail's mode marker renamed the iPad test failed; with the navigation button's name changed the Chrome-on-iOS test failed (the first version matched a prefix and passed: fixed to an exact name); with `isIosDevice` returning false the unit test failed on the iPad case and the Apple Maps case. The iPad's rail toggle measures 26 px (over the 24 px floor, under the 44 px primary size): judge it by thumb in RD-21 |
| E4 | What the page asks the browser for (RD-02, RD-03): the viewport meta has `viewport-fit=cover` and `interactive-widget=resizes-content`. Also read from deployed staging | `cd frontend && MOBILE_GATE_ROUTES=home npx playwright test --config=e2e/playwright.mobile.config.ts real-device-emulation` and `curl -s https://servwave-demo.vercel.app/` | Pass on all six projects; deployed staging serves `width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content`. **Red check:** with `viewport-fit=cover, ` removed from `index.html` the test failed on iPad Mini ("Expected substring: viewport-fit=cover") |
| E5 | The installed-app manifest on deployed staging (RD-19, RD-18, RD-57): no orientation lock; standalone display; the declared colours; the declared icons | `curl -s https://servwave-demo.vercel.app/manifest.webmanifest` | `display: standalone`, **no `orientation` key**, `theme_color` and `background_color` `#ffffff`, icons 192 and 512 (`any`) and a 512 `maskable`, `start_url` `/`. Forced dark mode and the Home Screen icon as the launcher draws it are not readable here |
| E6 | The statement window (RD-15), read from the code: no browser can show the popup rule | `grep -n "window.open" src/pages/StatementPage.tsx src/pages/v2/customers/StatementPage.tsx` | Both pages open the PDF with `window.open(url, '_blank', 'noopener')` **after** `await getCustomerStatement(..., { format: 'pdf' })` (a network round trip), not inside the click. Safari on iPhone and in-app webviews are expected to treat a window opened after that wait as a popup and block it. Predicted fail (F73-2); only a device settles it |
| E7 | Unit and guard tests for the files this slice touches | `cd frontend && VITEST_MAX_WORKERS=4 npx vitest run src/__tests__/real-device-checklist.test.ts src/__tests__/real-device-run-record.test.ts src/__tests__/contactHrefs-user-agents.test.ts` | 3 files, 22 tests passed (the checklist guard with the new RD-57 row, the run-record guard, the user-agent unit test). Red first: the record guard failed 4 of 7 with no record file; the user-agent unit test failed 2 of 6 with `isIosDevice` returning false; the record guard failed 3 of 7 with a row marked "passed" and an undefined follow-up |
| E8 | Typecheck and lint of what changed | `cd frontend && npx tsc --noEmit -p tsconfig.json` ; `node scripts/lint-changed-lines.mjs origin/staging` ; `npx eslint` on the three new files | exit 0, exit 0 ("No lintable frontend files changed"), exit 0 (the e2e folder is ignored by the repo's lint config) |

A search of the project vault found no earlier note on this behaviour; the closest hit was the design
system note, which lists the dropdown menu without covering touch. The rubric itself (TOUCH-12)
names the cause: a Radix trigger opens on the press, not the tap, so a scroll that starts on it opens it.


## Results

One line per checklist row. **Emulation** is what the headless run showed (counts are from E1; a row's
spec is the one that measures its geometry, not the row's real-device question, which is in the
checklist). **Real device** starts as "to be run by Ran" for every row that can be run now; the tester
replaces it with `pass`, `fail`, `pending` or `n.a.` and keeps the note. A row passes only when it
passed on every device and browser the checklist names for it.

| Item | Owner slices | Owner status | Emulation | Real device (Ran) |
|---|---|---|---|---|
| RD-01 | 34, 22 | landed | E1: page-frame.spec 24 passed; phone-drawer.spec 10 passed, 2 skipped. Cannot show: the iOS toolbar itself. | to be run by Ran |
| RD-02 | 52 | landed | E1: safe-areas.spec 11 passed, 19 skipped; phone-drawer.spec 10 passed, 2 skipped; E4. Cannot show: a real notch, Dynamic Island and home indicator (insets are emulated on Chromium only). | to be run by Ran |
| RD-03 | 54, 43 | landed | E1: keyboard-inset.spec 18 passed; dirty-guard.spec 6 passed; E4. Cannot show: a real keyboard (simulated by shrinking the visual viewport). | to be run by Ran |
| RD-04 | 54, 69 | owner 54 landed; 69 pending | E1: keyboard-inset.spec 18 passed. Cannot show: a real keyboard; the text and chat reader is slice 69 (not landed). | to be run by Ran (partial: the text and chat reader is slice 69, not landed; run the email compose part, mark the rest pending) |
| RD-05 | 54 | landed | E1: keyboard-inset.spec 18 passed. Cannot show: a real keyboard. | to be run by Ran |
| RD-06 | 43 | landed | E1: dirty-guard.spec 6 passed. Cannot show: Android WebView resizing the page. | to be run by Ran |
| RD-07 | 57 | landed | E1: field-drafts.spec 12 passed. Cannot show: a reclaimed tab, a camera round trip, a locked screen. | to be run by Ran |
| RD-08 | 66 | landed | E1: drafts-walkthrough-and-create-guard.spec 30 passed. Cannot show: the phone back swipe and a reclaimed tab. | to be run by Ran |
| RD-09 | 32 | landed | E1: task-board.spec 18 passed, 6 skipped. Cannot show: real iOS touch (WebKit swipes are synthesised in the page) and the system callout. | to be run by Ran |
| RD-10 | 58 | landed | E1: scheduler-touch-drag.spec 22 passed, 14 skipped. Cannot show: real iOS touch and the system callout. | to be run by Ran |
| RD-11 | 73 | owner is this slice (no fix slice exists) | E2: reproduced, menu opens on scroll start on 5 of 5 touch projects (F73-1). Cannot show: the finding below is reproduced on every touch project; a finger on glass confirms it. | to be run by Ran (emulation already fails: F73-1; confirm it by finger) |
| RD-12 | 5 | landed | E1: signature.spec 6 passed. Cannot show: a real 3x screen and real rotation. | to be run by Ran |
| RD-13 | 63, 21, 50 | pending: slice 21, 63 not landed | E1: contact-action.spec 12 passed (the Call or Text choice, slice 50). Cannot show: slices 63 and 21 not landed; the same-tab dialer does not exist yet (the gate spec never presses Call). | pending (slices 63 and 21 not landed; the same-tab dialer and the bridge ring do not exist yet; Call must not be pressed) |
| RD-14 | 4 | landed | E1: wave0-behaviours.spec 66 passed; public-pages.spec 23 passed, 1 skipped. Cannot show: in-app browsers (SMS, mail and social links). | to be run by Ran |
| RD-15 | 73 | owner is this slice (no fix slice exists) | E6: predicted fail from the code (F73-2). Cannot show: popup blocking is off in an automated browser, so only the code can be read. | to be run by Ran (predicted fail: F73-2; confirm by finger) |
| RD-16 | 27 | landed | E1: toaster.spec 6 passed. Cannot show: the home indicator and a real Save footer. | to be run by Ran |
| RD-17 | 28 | landed | E1: public-pages.spec 23 passed, 1 skipped; public-bundle.spec 24 passed. Cannot show: in-app browsers and a real tel: or mailto: hand-off. | to be run by Ran |
| RD-18 | 6 | landed | E5. Cannot show: forced dark mode cannot be emulated (slice 06 finding); only the declared colours are read. | to be run by Ran (the only check of forced dark mode there is) |
| RD-19 | 6 | landed | E5. Cannot show: a rotating Android phone. | to be run by Ran |
| RD-20 | 39, 22 | landed | E1: phone-list-cards.spec 6 passed; phone-drawer.spec 10 passed, 2 skipped. Cannot show: VoiceOver and TalkBack themselves. | to be run by Ran |
| RD-21 | 13, 35 | landed | E3. Cannot show: the real Chrome-on-iOS and iPadOS Safari engines. | to be run by Ran |
| RD-22 | 15 | landed | E1: hover-policy.spec 20 passed, 4 skipped. Cannot show: a real trackpad attached to an iPad. | to be run by Ran |
| RD-23 | 14 | landed | E1: text-entry.spec 11 passed, 1 skipped. Cannot show: whether iOS really zooms (the gate measures the 16 px floor on every key route). | to be run by Ran |
| RD-24 | 17 | landed | E1: admin-tables.spec 9 passed, 3 skipped; gate.spec settings-users on ipad-mini FAILED scrollReach (F73-3). Cannot show: momentum flicks and back-navigation by edge swipe. | to be run by Ran |
| RD-25 | 23 | landed | E1: field-kinds.spec 60 passed. Cannot show: which keyboard the phone opens and what it offers to fill. | to be run by Ran |
| RD-26 | 24 | landed | E1: labels-autofocus.spec 48 passed. Cannot show: VoiceOver and TalkBack reading the labels. | to be run by Ran |
| RD-27 | 30 | landed | E1: reports-readable.spec 24 passed. Cannot show: tapping bars with a finger. | to be run by Ran |
| RD-28 | 36 | landed | E1: phone-fields.spec 36 passed. Cannot show: the telephone keypad and own-number suggestion. | to be run by Ran |
| RD-29 | 37 | landed | E1: money-fields.spec 12 passed. Cannot show: the decimal keypad and a comma region. | to be run by Ran |
| RD-30 | 38 | landed | E1: form-flow.spec 24 passed. Cannot show: the keyboard action key (Next / Done) and screen readers. | to be run by Ran |
| RD-31 | 13 | landed | E1: gate.spec 487 passed across all key routes. Cannot show: real browser toolbars and landscape. | to be run by Ran |
| RD-32 | 16 | landed | E1: overlay-motion.spec 18 passed. Cannot show: VoiceOver and TalkBack focus and the system reduced-motion setting. | to be run by Ran |
| RD-33 | 22 | landed | E1: phone-drawer.spec 10 passed, 2 skipped. Cannot show: the real location prompt and a screen reader. | to be run by Ran |
| RD-34 | 25 | landed | E1: gate.spec 487 passed across all key routes. Cannot show: a finger instead of a stylus and VoiceOver. | to be run by Ran |
| RD-35 | 26 | landed | E1: adaptive-overlay-forms.spec 24 passed. Cannot show: collapsing browser toolbars and the home indicator. | to be run by Ran |
| RD-36 | 42 | landed | E1: scheduler-phone.spec 13 passed, 5 skipped. Cannot show: VoiceOver and TalkBack reading day cells. | to be run by Ran |
| RD-37 | 40 | landed | E1: disabled-reasons.spec 6 passed. Cannot show: VoiceOver reading the reason. | to be run by Ran |
| RD-38 | 39 | landed | E1: phone-list-cards.spec 6 passed. Cannot show: VoiceOver and TalkBack swiping the cards. | to be run by Ran |
| RD-39 | 43 | landed | E1: dirty-guard.spec 6 passed. Cannot show: system Back and the browser leave prompt. | to be run by Ran |
| RD-40 | 47 | landed | E1: public-bundle.spec 24 passed; create-new-flows.spec 36 passed. Cannot show: a phone that has never opened the site, on mobile data. | to be run by Ran |
| RD-41 | 44 | landed | E1: popovers-and-pickers.spec 24 passed. Cannot show: a real keyboard over the picker. | to be run by Ran |
| RD-42 | 55 | landed | E1: detail-headers.spec 30 passed. Cannot show: collapsing browser toolbars. | to be run by Ran |
| RD-43 | 45 | landed | E1: date-picker-sheet.spec 8 passed, 3 FAILED (the Filters popover case, already in known-failing.json: F73-4). Cannot show: a thumb on the day cells. | to be run by Ran |
| RD-44 | 59 | landed | E1: line-items-cards.spec 18 passed. Cannot show: the decimal keypad and a drag by finger. | to be run by Ran |
| RD-45 | 64 | landed | E1: gate.spec 487 passed across all key routes. Cannot show: the filter sheet with a real keyboard (slice 64 filters are measured as overlay states of the gate). | to be run by Ran |
| RD-46 | 50 | landed | E1: contact-action.spec 12 passed. Cannot show: the phone's own maps app; Call is never pressed. | to be run by Ran |
| RD-47 | 60 | landed | E1: scheduler-tap-alternatives.spec 12 passed. Cannot show: a thumb on small targets. | to be run by Ran |
| RD-48 | 56 | landed | E1: side-rail.spec 18 passed. Cannot show: VoiceOver and TalkBack inside the panel. | to be run by Ran |
| RD-49 | 53 | landed | E1: legacy-modal.spec 132 passed. Cannot show: a real keyboard and the home indicator. | to be run by Ran |
| RD-50 | 61 | landed | E1: first-paint-fonts.spec 18 passed. Cannot show: a cold phone on slow mobile data (the timing spec needs a production build and was skipped). | to be run by Ran |
| RD-51 | 70 | landed | E1: scheduler-unscheduled-sheet.spec 6 passed. Cannot show: a real keyboard over the sheet. | to be run by Ran |
| RD-52 | 67 | landed | E1: update-available.spec 12 passed. Cannot show: a real deploy, the app switcher and a locked screen. | to be run by Ran |
| RD-53 | 18 | landed | E1: text-200.spec 54 passed. Cannot show: the phone's own text-size setting (the gate uses a 200% root size). | to be run by Ran |
| RD-54 | 72 | landed | E1: tasks-list-cards.spec 7 passed, 5 skipped. Cannot show: a fling with momentum. | to be run by Ran |
| RD-55 | 48 | landed | E1: reorder-by-tap.spec 30 passed. Cannot show: a long-press drag on the iPad. | to be run by Ran |
| RD-56 | 49 | landed | E1: call-routing-admin.spec 18 passed. Cannot show: the iPad itself and its flow editor sheet. | to be run by Ran |
| RD-57 | 6 | landed | E5. Cannot show: the Home Screen icon itself; only the declared icons are read. | to be run by Ran |
| RD-58 | 69 | landed | E1: sms-chat-single-pane.spec passed. Cannot show: a real keyboard and the system Back gesture. | to be run by Ran |
| RD-59 | 65 | landed | E1: remaining-dialogs.spec (slice 65's own spec). Cannot show: a real keyboard over a long form, the home indicator, and a swipe on a long list. | to be run by Ran |
| RD-60 | 46 | landed | E1: inbox-reader.spec 24 passed (4 on each of the six projects) and the gate's comm-inbox route enforced. Cannot show: VoiceOver and TalkBack inside the reader, the system back gesture, a real keyboard over the compose window. | to be run by Ran |

## Follow-ups

Local. None is a published issue. Findings of the emulation run are filed here so that the person
running on hardware sees them first; a real-device failure adds its own row.

| ID | Row | Finding | Rubric | Where to fix | State |
|---|---|---|---|---|---|
| F73-1 | RD-11 | A scroll that starts on a row's three-dot button opens its menu instead of scrolling, on all five touch projects (and the open menu holds the page still). The menu trigger opens on the press, not the tap. 48 files use the shared trigger; the per-row menus (Stock list, vendor and attachment rows) are the exposed ones | TOUCH-12 (medium) | `frontend/src/ui-kit/components/ui/dropdownMenu.tsx`: the shared trigger. Open on touch by the tap (the click), keep the press for mouse and pen; keyboard unchanged. The spec's REPORT map (`rd11`) is deleted when it is fixed | open: needs a slice (none owns it) |
| F73-2 | RD-15 | The statement's "Download PDF" opens its window after an awaited request, so Safari and in-app webviews are expected to block it as a popup. Predicted from the code (E6); confirm on a device | CMP-15, PUB-02 | `frontend/src/pages/v2/customers/StatementPage.tsx` and `frontend/src/pages/StatementPage.tsx`: open the window (or navigate) inside the click, fill it after the fetch; or link to the PDF address directly | open: predicted, to confirm on hardware; no slice owns it |
| F73-3 | RD-24 | The gate's own `settings-users` state fails on iPad Mini: `scrollReach`, "last control 'Team for E2E Admin' is covered by main.canvas-body" in the full run and "...by div.relative.w-full.overflow-x-auto" run alone, so it is steady on the staging base and not a flake. It is not on the allow-list: a regression on staging after slice 29, not caused by this slice | VP-06 | the Settings users table on the iPad (slices 29, 34, 56 own its frame). Do not allow-list it; fix or the sweep stays red | open |
| F73-4 | RD-43 | Already tracked: `known-failing.json` lists the Filters-popover date sheet case (iPhone SE, Galaxy S24, iPhone 15: the spec waits for a "Created" tab it never finds) and the inventory-activity "600 total" check (six projects). Both failed in E1 with the same text; nothing new | CMP-04 | slice 45 and the inventory owner, as `known-failing.json` says | already tracked |
| F73-5 | all | `docs/qa/real-device-release-checklist.md` is the stub the real checklist replaced. It still says slice 10 owns it and lists four rows (06-1 to 06-4) that RD-18, RD-19 and the new RD-57 now cover. Two checklists invite the wrong one being run | TEST-07 | delete the stub or reduce it to a pointer to `md_files/specs/qa/real-device-release-checklist.md` | open (a one-line change; not done here to keep this slice to the run) |
| F73-6 | RD-21 | Not a defect yet: on the iPad the rail toggle is a 26 px icon (E3). It meets the 24 px floor and is under the 44 px used for primary controls. If it is hard to hit by thumb on the real iPad, RD-21 fails and this becomes the fix | TOUCH-01 | `frontend/src/ui-kit/components/layout/nav/sidebar.tsx` (slice 35's toggle) | watch: judged on the iPad |

## Recording the run

Copy this block into the release notes, or fill it in here, one line per item, per device and
browser it was run on (the checklist's own format). "Staging commit" is the frontend and backend
commits that were live when you ran, not the gate's checkout.

```
Run date:            YYYY-MM-DD
Staging commit:      frontend <sha> / backend <sha>
Tester:              <name>
Account:             Tester A / Tester B (never the shared demo admin)

| Item  | Device | Browser | Result (pass / fail / pending / n.a.) | Notes or follow-up issue |
|-------|--------|---------|----------------------------------------|--------------------------|
| RD-01 |        |         |                                        |                          |
```

- **pass**: the checklist's "Pass when" held.
- **fail**: say what you saw and name the follow-up (F73-n above; add a row for a new one).
- **pending**: the owning slice has not landed (RD-13 now) or you had no device for it ("pending: no device").
- **n.a.**: the row does not apply (for example, no pay step offered on staging); say why.
- When the run is complete, set the **Real device** column of the Results table from your lines. The
  guard test `frontend/src/__tests__/real-device-run-record.test.ts` keeps this record in step with the
  checklist: one line per row, only the allowed words, every cited evidence and follow-up defined.

## After the run

- Every failed row has a follow-up row above before the run is called done (slice 73's second
  acceptance line).
- A later release that touches the shell, overlays, the scheduler, communication or the public pages
  re-runs the checklist; copy this file to `real-device-run-02.md` and start from the emulation half
  again (`npm run test:mobile`), then run the rows on hardware.
- The pending rows (RD-13, and RD-04's text and chat reader) are run once slices 63, 21 and 69 land.
