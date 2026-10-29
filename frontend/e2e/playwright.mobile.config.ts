import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { GATE_DEVICES, SWEEP_DEVICES, deviceUse } from './mobile/devices';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

/**
 * The mobile gate (PRD module 12, slice 01). How to run it: e2e/mobile/README.md.
 *
 * Runs like the other local suites in this folder: this worktree's frontend and a doored API on
 * the STAGING database, a throwaway `e2e-qa-` org provisioned per run and torn down after. Not in
 * CI. Its own ports (per checkout, printed at start) so it never borrows another session's dev
 * server, and the API
 * is booted WITHOUT index.ts's crons (backend/src/scripts/e2e-api-server.ts): a laptop running
 * the cross-org automation poller against staging would send other orgs' due texts.
 *
 * Projects: `setup` (provision + seed), the six device projects, and two `selftest-*` projects
 * that prove each check goes red on a deliberately broken fixture page (no servers needed:
 * MOBILE_GATE_SERVERS=off).
 */
// Ports are derived from this checkout's path, so gate runs in two worktrees at once never share
// (and silently measure) each other's dev servers, while reruns in one worktree reuse its own.
const slot = [...ROOT].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 200;
const API_PORT = Number(process.env.MOBILE_GATE_API_PORT || 3400 + slot);
const WEB_PORT = Number(process.env.MOBILE_GATE_WEB_PORT || 5400 + slot);
if (!process.env.TEST_WORKER_INDEX) console.log(`[mobile-gate] API :${API_PORT}  web :${WEB_PORT}`);
process.env.E2E_BACKEND_URL ||= `http://127.0.0.1:${API_PORT}`;
const BASE_URL = process.env.MOBILE_GATE_BASE_URL || `http://localhost:${WEB_PORT}`;
const servers = process.env.MOBILE_GATE_SERVERS !== 'off';
// The full sweep (slice 62, `npm run test:mobile:sweep`): the extra matrix devices, the sweep-only
// routes and the Lighthouse budget, in the SAME run (one throwaway org, one report).
const sweep = process.env.MOBILE_GATE_SWEEP === '1';
const lighthouseOn = sweep || process.env.MOBILE_GATE_LIGHTHOUSE === '1';
// Lighthouse measures the PRODUCTION build served by `vite preview` (a dev server's unbundled
// modules say nothing about weight). Its port derives from this checkout like the other two.
const PREVIEW_PORT = Number(process.env.MOBILE_GATE_PREVIEW_PORT || 5600 + slot);
process.env.MOBILE_GATE_PREVIEW_URL ||= `http://localhost:${PREVIEW_PORT}`;

export default defineConfig({
  testDir: './mobile',
  // Generous: on a loaded shared machine a cold dev-server route can take a minute to settle.
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: Number(process.env.MOBILE_GATE_WORKERS || 4),
  // One retry absorbs the shared machine's load spikes (a page that times out or loses its
  // session). A real offender fails both attempts. Use MOBILE_GATE_RETRIES=0 for a first run that
  // is expected to be red (allow-list generation), so it does not take twice as long.
  retries: Number(process.env.MOBILE_GATE_RETRIES ?? 1),
  globalTeardown: path.resolve(__dirname, 'mobile', 'mobile-teardown.ts'),
  reporter: [
    ['list'],
    // The sweep skips the HTML report: its ~2,900 tests each attach a record, and the sweep report is the artefact.
    ...(sweep ? [] : [['html', { open: 'never', outputFolder: '../playwright-report-mobile' }] as ['html', { open: 'never'; outputFolder: string }]]),
    // The sweep report (e2e/mobile/sweep.mjs) is built from this, plus the gate's own records. Not
    // the built-in JSON reporter: it inlines every attachment and breaks at this size.
    ...(sweep ? [[path.resolve(__dirname, 'mobile', 'sweep-reporter.ts'), { outputFile: path.resolve(__dirname, 'test-results-mobile', 'sweep-playwright.json') }] as [string, { outputFile: string }]] : []),
  ],
  outputDir: './test-results-mobile/artifacts',

  use: {
    baseURL: BASE_URL,
    serviceWorkers: 'block',
    // The sweep keeps neither: roughly 650 known offenders on a first run would write gigabytes of
    // traces, and a full disk ended a sweep once. The failure text is in the report.
    trace: sweep ? 'off' : 'retain-on-failure',
    screenshot: sweep ? 'off' : 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'setup', testMatch: /mobile-setup\.ts/ },
    ...GATE_DEVICES.map((d) => ({
      name: d.id,
      // gate.spec.ts: the six checks on every key state. kpi-figures.spec.ts: KPI tiles with
      // large sums (F03a). signature.spec.ts: the public estimate's signature pad signed, rotated
      // and submitted (slice 05), when its state is selected. hover-policy.spec.ts: row actions
      // usable without hover and no sticky hover after a tap (slice 15). form-fields.spec.ts: forms
      // one column below sm, wider layouts unchanged (slice 20). text-entry.spec.ts: the compose
      // fields' size and focus indicator, and select triggers on touch (slice 14). admin-tables.spec.ts:
      // a full tax-rates list keeps its Name column in its box on every device (slice 17).
      // wave0-behaviours.spec.ts: the wave-0 slices' device behaviour that merged before the gate
      // (scheduler default view, one-row tabs, two-up KPI tiles, public terms and PDF link, head; GC1).
      // field-kinds.spec.ts: email/search keyboards and the touch-hidden shortcut hint (slice 23).
      // public-pages.spec.ts: the public estimate and invoice at 320 with a stretched document (slice 28).
      // public-bundle.spec.ts: a customer's link is served by the light page, loads no staff module and
      // registers no service worker (slice 47). create-new-flows.spec.ts: Create New still opens every
      // create flow now that the two create dialogs are lazy chunks (slice 47).
      // labels-autofocus.spec.ts: bound settings labels, the named customer block, and no text field
      // focused on its own when a dialog or search popover opens on touch (slice 24).
      // task-board.spec.ts: the task board scrolls on a swipe, drags on a long-press, moves by tap,
      // and the task drawer fits a 320 phone (slice 32).
      // reports-readable.spec.ts: report titles wrap, chart axis labels never overlap or clip, the
      // bars keep their room and the Expenses filter panel fits (slice 30).
      // phone-fields.spec.ts: the customer, profile and company phone fields are the phone input
      // (tel type and keypad, the right autofill) and keep every digit typed (slice 36).
      // form-flow.spec.ts: Next on the create forms' fields, and an empty submit lands on First
      // Name, in view and naming its error (slice 38). overlay-motion.spec.ts: overlays under reduced
      // motion and scrims without blur on touch (slice 16), with `home`.
      // disabled-reasons.spec.ts: a disabled Publish explains itself with one tap (slice 40).
      // toaster.spec.ts: one toaster, top-centre under the top bar on phones, a named close on
      // every toast (slice 27). job-header.spec.ts: the job page header, Back, Actions and the Mark
      // Complete dock in reach on a phone (slice 41). tablet-rail.spec.ts: the 60 px icon rail on a
      // tablet and an unfolded foldable, expanding over the page as a dialog (slice 35).
      // detail-headers.spec.ts: the customer, invoice, estimate, lead and automation builder
      // headers on the shared detail header, in reach on a phone (slice 55).
      // scheduler-touch-drag.spec.ts: a long-press picks up a calendar event or a dispatch-board card
      // and moves it, a swipe scrolls and moves nothing, the mouse drag is unchanged (slice 58).
      // date-picker-sheet.spec.ts: the date calendar as a bottom sheet with 40 px days below md, the
      // popover with its 36 px days from md up (slice 45), with `tasks`.
      // line-items-cards.spec.ts: the line-items editor as editable cards below md, with Move up/down
      // that persist the order a drag would, the table unchanged from md up, and the statement as a
      // stacked list on a phone (slice 59).
      // contact-action.spec.ts: a tapped number offers Call or Text and is never a telephone link,
      // and the job page's Call and Text tiles are 44 px on touch (slice 50), with `customer-detail`
      // and `job-detail`. Never presses Call.
      // calling-by-device.spec.ts: choosing Call on a number opens a same-tab dialer sheet on a phone
      // (no window, no second tab, the phone rings first) and the dedicated phone tab on a computer
      // (slice 63), with `customer-detail`. Never presses the dialer's Call; window.open is stubbed.
      // safe-areas.spec.ts: the top bar, drawer and page frame clear the status bar, the notch and the
      // home indicator, with the insets emulated on Chromium (slice 52).
      // field-drafts.spec.ts: a job note typed on the Notes tab survives rotation, the page being
      // hidden and discarded, comes back with "Draft restored", and is cleared by Add Note; another
      // user's draft is never offered (slice 57), with `job-detail`.
      // drafts-walkthrough-and-create-guard.spec.ts: the lead's walkthrough notes and the log-a-call
      // notes are kept, and the lead, customer and job create forms ask before they are left
      // (slice 66), with `lead-detail`, `lead-new`, `job-new` and `customer-new`.
      // scheduler-tap-alternatives.spec.ts: a Plan Mode draft opens Confirm / Remove by tap, and a day of
      // the week view widens by a header button, the double-click shortcut kept on desktop (slice 60).
      // scheduler-unscheduled-sheet.spec.ts: below lg the unscheduled-jobs panel is not in the DOM, a
      // toolbar button opens it as a sheet, and a tap on a job opens the scheduling form and schedules
      // it; the desktop control keeps the side panel with draggable cards (slice 70).
      // side-rail.spec.ts: the activity side rail takes no width below md, opens as a sheet from the
      // header menu with focus trapped and Escape, and keeps its column from md up with a panel
      // inside the viewport (slice 56).
      // detail-tabs-and-errors.spec.ts: every tab of the customer and lead pages fits, with cards
      // below md; a forced 500 on the lead page, leads list, customer page and customers list shows
      // an error with Retry (fixed, vendor-free copy) and Retry recovers (slice 68).
      // legacy-modal.spec.ts: the older titled dialog on the adaptive overlay: a form or reader full-screen
      // and a confirmation a bottom sheet below md, the close and footer pinned, the card from md up (slice 53).
      // first-paint-fonts.spec.ts: no font stylesheet blocks the first render; the fonts are ours,
      // swap-displayed and preloaded, on the public pages and the scheduler (slice 61).
      // first-paint-metrics.spec.ts: LCP, CLS and INP on a 4x CPU / slow-4G profile; needs a
      // production build (MOBILE_GATE_PROD_BUILD=1), else it skips (slice 61).
      // update-available.spec.ts: a waiting update shows "Update available" and is never applied or
      // reloaded under a dirty New Task; a tap applies it on a clean page (slice 67).
      // text-200.spec.ts: text enlarged to 200% reflows on the lead form, the DataTable toolbars,
      // the jobs and schedule toolbars and the dashboard's KPI tiles (slice 18).
      // tasks-list-cards.spec.ts: the Tasks list is cards below lg, draws one bounded page of 25 and
      // loads the rest on scroll; every filter and sort pages to the same rows as the whole list
      // (slice 72), with `tasks`.
      // reorder-by-tap.spec.ts: the three drag-only settings lists and the home page's widgets reorder
      // by tap (Move up / Move down), the order persists, the catalog is a sheet below md, and drag
      // still works with a mouse (slice 48), with `settings-decline-reasons`,
      // `settings-job-sub-statuses`, `settings-payments` and `home`.
      // technician-flow.spec.ts: a fresh scheduled job is started and marked complete by tap, each
      // control in reach and uncovered (slice 62; it also runs on the sweep's extra devices).
      // call-routing-admin.spec.ts: the call-group and call-flow tables scroll in their own box with the
      // Action column reachable, and the flow editor's inspector is a sheet below md (slice 49), with
      // `comm-phone`.
      // keyboard-inset.spec.ts: with a simulated keyboard, New Task's Create and the email compose's Send stay
      // above it, and a layout that itself resizes is not lifted twice (slice 54), with `tasks` and `comm-inbox`.
      // real-device-emulation.spec.ts: the emulation half of the real-device checklist: a scroll that starts on a row
      // menu button (RD-11, REPORT map), Chrome on iOS and the iPad with a desktop agent (RD-21), the viewport meta (slice 73).
      // sms-chat-single-pane.spec.ts: text messages and chat are one pane at a time below md with the open
      // conversation in the URL (Back returns to the list), the messages the only vertical scroller, Send on
      // screen and above a simulated keyboard, both panes from md up, and a bounded DOM on a phone with a
      // 300-customer directory (slice 69), with `comm-text` and `comm-whatsapp`.
      // remaining-dialogs.spec.ts: every other dialog on the adaptive overlay: a form or reader full-screen
      // and a confirmation a bottom sheet below md, the close and footer pinned, no list scrolling in the
      // body, the card from md up (slice 65), with `lead-detail`, `customer-detail`, `estimate-detail`,
      // `job-detail` and the pages named in the spec.
      // phone-page-fit.spec.ts: the Phone page's call log is cards below md and a named table box from md
      // up with at least 200 px and one vertical scroller, and the pop-out phone page is one bounded
      // scroller with the dialer's job search on screen and its last key reachable (slice 71), with
      // `comm-phone` and `phone-tab`. Never presses Call.
      // no-provider-socket.spec.ts: a signed-in page opens no WebSocket to the auth provider; the bell polls
      // instead of holding a live subscription (slice 75 follow-up), with `home` and `customers`.
      // public-logo-no-shift.spec.ts: the public estimate's branded header does not move when a wide logo
      // arrives late (the 320 px layout shift the staging check found; slice 61 round 2), with
      // `public-estimate-open`.
      // schedule-double-booked.spec.ts: the Schedule's double-booked cards, the one excused finding; everything else
      // there is enforced (mobile slice 75 follow-up), with `schedule`. Read-only; it also runs on the sweep's extra devices.
      // inbox-reader.spec.ts: the inbox rail closed below lg, the reader as a full-screen dialog with a
      // short bar, and the compose window full-screen on phones (slice 46).
      testMatch: /(gate|no-provider-socket|keyboard-inset|reorder-by-tap|kpi-figures|signature|overlay-motion|hover-policy|form-fields|text-entry|admin-tables|wave0-behaviours|field-kinds|public-pages|labels-autofocus|settings-users-roles|task-board|inventory-plans-automations|reports-readable|phone-fields|money-fields|form-flow|phone-drawer|adaptive-overlay-forms|toaster|page-frame|job-header|scheduler-phone|disabled-reasons|phone-list-cards|dirty-guard|tablet-rail|public-bundle|create-new-flows|popovers-and-pickers|detail-headers|scheduler-touch-drag|line-items-cards|date-picker-sheet|contact-action|calling-by-device|safe-areas|field-drafts|drafts-walkthrough-and-create-guard|scheduler-tap-alternatives|scheduler-unscheduled-sheet|side-rail|detail-tabs-and-errors|legacy-modal|first-paint-fonts|first-paint-metrics|update-available|text-200|tasks-list-cards|technician-flow|call-routing-admin|real-device-emulation|sms-chat-single-pane|remaining-dialogs|phone-page-fit|public-logo-no-shift|inbox-reader|schedule-double-booked)\.spec\.ts/,
      use: deviceUse(d),
      dependencies: ['setup'],
    })),
    // Slice 62: the rest of the device matrix. Each runs the gate's checks on every key route and
    // every sweep-only route, plus the technician job-completion flow; the targeted per-slice specs
    // stay on the six projects above (they assert behaviour at those sizes).
    ...(sweep
      ? SWEEP_DEVICES.map((d) => ({
          name: d.id,
          testMatch: /(gate|technician-flow|no-provider-socket|schedule-double-booked)\.spec\.ts/,
          use: deviceUse(d),
          dependencies: ['setup'],
        }))
      : []),
    // Slice 62: the Lighthouse mobile budget on the public pages and the technician landing page.
    // Needs a production build (the sweep script builds it) and runs in the sweep, or on its own with
    // `--project=lighthouse` after `npx vite build`.
    ...(lighthouseOn
      ? [
          { name: 'lighthouse', testMatch: /lighthouse\.spec\.ts/, use: deviceUse(GATE_DEVICES[1]!), dependencies: ['setup'] },
          // The budget goes red on a deliberately bloated build (no servers needed).
          { name: 'selftest-lighthouse', testMatch: /lighthouse-budget-red\.spec\.ts/, use: deviceUse(GATE_DEVICES[1]!) },
        ]
      : []),
    // Slice 62: `npm run test:mobile:teardown`: tear down the throwaway org a killed run left behind
    // (its id is in e2e/.auth/e2e-org.json). Fails if the teardown does, unlike the global teardown.
    ...(process.env.MOBILE_GATE_TEARDOWN_ONLY === '1' ? [{ name: 'teardown-only', testMatch: /teardown-only\.spec\.ts/ }] : []),
    { name: 'selftest-touch', testMatch: /selftest\.spec\.ts/, use: deviceUse(GATE_DEVICES[0]!) },
    // The touch helpers (touch.ts) take a different path on Chromium (the browser's own touch
    // input) than on WebKit (synthetic gestures), so their self-test also runs on a Chromium phone.
    { name: 'selftest-touch-chromium', testMatch: /touch-selftest\.spec\.ts/, use: deviceUse(GATE_DEVICES[1]!) },
    { name: 'selftest-desktop', testMatch: /selftest\.spec\.ts/, use: deviceUse(GATE_DEVICES[5]!) },
  ],

  webServer: servers
    ? [
        {
          command: 'npx tsx src/scripts/e2e-api-server.ts',
          cwd: path.resolve(ROOT, '..', 'backend'),
          url: `http://127.0.0.1:${API_PORT}/health`,
          env: { PORT: String(API_PORT), E2E_TEST_DOORS: 'true' },
          reuseExistingServer: true,
          timeout: 180_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
        ...(lighthouseOn
          ? [
              {
                command: `npx vite preview --port ${PREVIEW_PORT} --strictPort`,
                cwd: ROOT,
                url: `http://localhost:${PREVIEW_PORT}`,
                // `vite preview` proxies /api with the dev server's rule: point it at the doored API.
                env: { VITE_BACKEND_PORT: String(API_PORT), VITE_DASHBOARD_USE_MOCK: 'false' },
                reuseExistingServer: true,
                timeout: 60_000,
              },
            ]
          : []),
        {
          command: `npx vite --port ${WEB_PORT} --strictPort`,
          cwd: ROOT,
          url: `http://localhost:${WEB_PORT}`,
          env: { VITE_BACKEND_PORT: String(API_PORT), VITE_DASHBOARD_USE_MOCK: 'false' },
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ]
    : undefined,
});
