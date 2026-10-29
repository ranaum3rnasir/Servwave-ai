# Mobile first paint: fonts, the staff budget, and what was measured

Mobile slice 61 (rubric PERF-01, PERF-02, PERF-03). Measured 2026-10-04 on the slice's branch, on a
production build (`vite build`), with the doored API and the staging database behind it. Nothing
here is a promise about production; it is the record of what the lab said and how to repeat it.

## What changed

| Before | After |
|---|---|
| Three font families from a third-party stylesheet host: two CSS `@import`s (a chain) and a third stylesheet link in the head. All render-blocking. | Fonts are ours, same origin (`/fonts/`), `font-display: swap`, cached as immutable. The two faces that paint the first screen are preloaded (`crossorigin`); the signature script (Caveat) is only fetched when a typed signature is drawn. A metric-matched fallback face keeps the swap from moving the page. |
| Staff entry 562 KB gzipped (437 KB without the copilot, by a size-proportional share; about 468 KB by the stricter method below). | 457 KB with the copilot, 361 KB without it (target 350 KB; the build enforces a 363 KB ceiling that only goes down). |

How the staff entry came down by about 105 KB gzipped, without touching the copilot:

- the header dialer button is its own tiny module (`GlobalDialer.tsx`), so the softphone
  workspace, the call-control SDK wrapper, the inventory API with its mock data and the date picker
  are no longer in the first download;
- the agent catalog modal loads the first time it is opened (`LazyAgentCatalog.tsx`);
- date-fns' formatter and English locale tables are out (two helpers in `lib/format-date.ts` are
  plain `Date` code now, pinned by a test that uses date-fns as the oracle);
- the Radix toast is out (the new-notification toast's action is a plain element; the toast
  adapter only reads its label and handler);
- the table and virtual-list engines (about 138 KB of source) are in chunks of their own
  (`vendor-chunks.ts`) instead of the query client's, 14.4 KB gzipped off the first download;
- one copy of the error-reporting core instead of three or four (`resolve.dedupe` in
  `vite.config.ts`: the install leaves an identical copy inside each of the SDK's packages and the
  bundler treated each path as a different module).

Two things that nobody is waiting for no longer compete with the document on the wire
(`lib/platform/runAfterSettle.ts`): the session-replay recorder and the public estimate's
decline-dialog chunk both start after the page has loaded and been quiet for a few seconds, and the
decline chunk only after the estimate is on screen. On a phone line that was worth about 0.4 s of
largest paint on the public estimate.

### What was left between 361 KB and the 350 KB target after round 0 (the first of the two cuts below was taken in a cheaper form in round 2, see below)

Measured by source map, the remainder is mostly code the first screen uses: react and the router
(85 KB gzipped), the auth and realtime client (59), error reporting (about 65), menu and popover
primitives (about 35), the query client (12.6), the http client (17), the toaster (10). Two cuts
would reach the target and each is a decision, not a tidy-up:

- Build the auth client from the two parts the app uses (sign-in and realtime) instead of the
  umbrella package. The umbrella also ships database, file-storage and functions clients the app
  never calls (about 49 KB of source, an estimated 12 KB gzipped), but it also wires the access token
  into the realtime client and the request headers, so replacing it touches sign-in. It needs its own
  slice and a real sign-in check.
- Drop page-load tracing from error reporting (its share of the error-reporting core and the browser
  utilities was not isolated; 10% sampled today). That removes route-named performance data, an observability change
  for Ran to approve.

## How the staff number is taken

"Initial JavaScript" is the staff page's module script, its modulepreloads, and everything those
import statically, gzipped as the host ships it (the host's per-file error-reporting stamp is
added to a local build so a laptop measures what the host serves). **Excluding the copilot** means
the copilot's own text is taken out of each chunk (its folder, its store, its helpers, the voice SDK
and that SDK's retry dependency, found through the build's source maps) and the chunk is gzipped
again. That is the cost of everything else. A size-proportional share would hand the copilot most of
the gzip size, because the voice SDK is large, repetitive generated code that compresses far better
than the rest, and it would make the rest of the app look 25 KB lighter than it is. The copilot's
own code, chunking and mounting are unchanged.

`scripts/check-public-bundle-budget.mjs` (the last step of `npm run build`) enforces it.

## Results

Lighthouse 13.5 mobile preset (simulated slow 4G: 1.6 Mbit/s, 150 ms round trip, CPU 4x slower),
cold cache, the production build served over HTTP/2 (as the host does) from a local preview, the
API local and the database staging's. Median of three runs.

| Page | LCP | CLS | FCP | Score | Target (LCP <= 2.5 s, CLS <= 0.1) |
|---|---|---|---|---|---|
| Public estimate | 2.19 s | 0 | 2.04 s | 93-95 | met |
| Public invoice | 2.16 s | 0 | 2.01 s | 96-97 | met |
| Technician landing page (the scheduler) | 6.3 s | 0.006 | 3.4 s | 60-66 | **LCP not met**, CLS met |

Before the deferral of the recorder and the decline chunk the public estimate measured 2.61 s and
the invoice 2.33 s; over plain HTTP/1.1 (the preview's own protocol, which models six connections
for 35 small files) they measure about 4.0 s and 3.5 s, which is a property of the lab setup, not of
the page. The same run is written to `e2e/test-results-mobile/first-paint-metrics.json` by the
browser-throttled spec below, which is harsher and noisier (the public pages land at 2.4 to 3.3 s
there) and is held to a regression bound.

Re-run after the table engine left the first download (browser-throttled spec, production build,
host load average 50 to 100, so indicative only): public estimate 2.5 s (Galaxy S24 profile) and
2.7 s (desktop), public invoice 2.6 s on both, CLS 0; scheduler 7.9 s and 6.9 s, CLS 0.007. The
spec bounds public pages at 4 s and the scheduler at 8 s; it does not enforce the 2.5 s target, so
the Lighthouse table above is the record for that target. INP on that run: open a job 120 ms,
type in search 16 ms, switch the scheduler day 40 ms, and one 344 ms reading for change a status
(16 ms in the earlier runs; under the 500 ms bound, and on a machine at load 50).

### Why the technician landing page misses LCP

It is the staff app. The initial download is 361 KB gzipped without the copilot (457 KB with it),
which alone is 2 to 3 s on that line. Then the page is gated on a sign-in check (`/auth/v1/user`,
then `/api/auth/me` twice), then its own 110 KB lazy chunk (the scheduler), then the organisation
and notification requests, and only then the scheduler's own data (about 3.4 s on the unthrottled
timeline, 1.4 s after the others). Reaching 2.5 s needs one of: a much smaller entry (replacing or
lazy-loading the auth/realtime client, the error-reporting tracing or the menu primitives, or the
copilot, which is out of scope), preloading the scheduler chunk and starting its data requests
alongside the sign-in check, or painting the scheduler's frame before its data. Those are separate
decisions; the build now holds the entry at 363 KB (target 350 KB) so it cannot grow meanwhile.

### Round 1 after the staging check (2026-10-06): what was taken, what moved, what is still open

The staging verifier measured the scheduler's largest paint at 4.4 to 7.0 s on deployed staging
(unthrottled, five device sizes) and recorded criterion 3 as unmet. The target is still not met;
the fix round took the parts of the chain that were waste, without touching the copilot or any
decision this note lists below.

What the timeline showed (a cold start, CPU 4x, 1.6 Mbit/s, the production build over HTTP/2):
the entry lands at about 3.1 s; the sign-in check answers at about 4.0 s; only then did the
scheduler's chunk (93 files, 267 KB gzipped beyond the entry) start downloading, because the
router asks for a page's chunk when it first renders the page and renders "Loading..." until the
check answers; the scheduler's own data requests start after that chunk runs; the largest paint is
the first card or the empty-state line, once the jobs answer.

| Change | Why it was waste | Measured effect |
|---|---|---|
| The landing page's chunk is requested at entry (`lib/platform/preloadLandingRoute.ts`, called from `main.tsx`): `/schedule` as itself, and at `/` the page the cached abilities redirect to, by the same rule `V2HomeRoute` uses (`pages/v2/dashboard/homeDestination.ts`). Nothing is fetched without a stored sign-in. | The chunk waited for a network round trip it does not depend on. | The chunk download overlaps the sign-in check (about 0.9 s on the cold start). |
| One `/api/auth/me` per session at a time (`checkAuth` in `stores/auth.store.ts`). | The auth client announces a stored session twice on a cold start (INITIAL_SESSION, then SIGNED_IN) and both ran the check: two identical round trips back to back, the second delaying everything queued behind it. A check under a different session never borrows another's answer. | One request instead of two. |
| Six dialogs the scheduler mounts once and drives with `open` (the create popover, the event editor and entry dialog, the drop modal, assign and cancel job) are fetched the first time one opens (`pages/v2/schedule/scheduleDialogs.ts`, `lib/platform/lazyWhenOpened.tsx`), and warmed once the board has settled (`runAfterSettle`), so the first tap is still instant. | Most visits open none, yet their form controls (customer picker, address search, date and time fields, crew picker) were in the first download. | The scheduler's first download beyond the entry: 267 KB gzipped in 93 files to 217 KB in 60 files (-19%). `dialogsAreLazy.test.ts` fails if one comes back. |

Results, the same Lighthouse budget run (`MOBILE_GATE_LIGHTHOUSE=1 npm run test:mobile --
--project=lighthouse`) before and after, back to back, on a host at load 50 to 110 (so indicative):

| Page | LCP before | LCP after | Target |
|---|---|---|---|
| Public estimate | 3.50 s | 3.47 s | 2.5 s, not met |
| Public invoice | 3.47 s | 3.47 s | 2.5 s, not met |
| Technician landing page (the scheduler, cold start) | 8.49 s | 7.62 s | 2.5 s, not met |

CLS is unchanged and inside the target on all three (0, 0, 0.006). The browser-throttled spec
(`first-paint-metrics.spec.ts`, local HTTP/1.1 preview, Galaxy S24 profile and desktop) measures the
scheduler at 6.0 s on both, where the round before measured 6.9 to 7.9 s, and its ceiling comes down
from 8 s to 7 s; the public pages are 2.5 to 2.7 s there. INP on the same run: open a job 120 ms
(Galaxy S24 profile), type in search 24 ms, switch the scheduler day 48 ms, change a status under the
observer's 16 ms floor.

The entry is 361.6 KB gzipped excluding the copilot (457.5 KB with it), 0.4 KB more than before for
the preload and the shared check; the 363 KB ceiling holds and the 350 KB target is still reported
as missed. The public pages are untouched (182.7 KB, budget 200).

Still open, each a decision for Ran and not taken here:

- **The entry itself.** At 361 KB gzipped (CPU 4x, 1.6 Mbit/s) the first paint of the staff app is
  about 3.3 s before any page code runs, so no page can reach 2.5 s on this profile until the entry
  is much smaller: the auth client built from the two parts the app uses, page-load tracing out of
  error reporting (both described above), the menu and popover primitives, or the copilot (out of
  scope).
- **The public pages' 3.5 s.** 183 KB of script plus 36 KB of stylesheet (the whole app's, shared)
  arrive before anything paints; first paint is about 3.0 s and the estimate itself 0.5 s after it,
  because its data request starts only when the page's code runs. Starting that request earlier
  needs a same-origin script (the content security policy has no inline scripts) and the API
  address at build time; deferring the error-reporting SDK (54 KB gzipped) is the other lever and is
  an observability decision.
- **The scheduler's data.** Its five requests start when the page's code runs, after the chunk. They
  could start beside the chunk from a cached organisation time zone, but the window depends on the
  view (day, week, month, by screen width and the person's last choice), so a wrong guess costs a
  wasted request on every load; it needs its own design.
- **The Content-Security-Policy still names the font host.** It is not unused: the embedded
  payments onboarding asks that host for its own font stylesheet (`StripeOnboardingDrawer.tsx`), so
  the allowance stays.

### INP, recorded (CPU 4x slower, production build, Chromium)

Worst event per interaction (input delay + handlers + the next paint), in the throwaway org, over
three runs on a machine whose load average was above 60 throughout (so the upper ends are pessimistic):

| Interaction | Desktop control | Galaxy S24 profile |
|---|---|---|
| Open a job (list to job page) | 40 to 144 ms | 120 to 128 ms |
| Change a status (a visit's next step) | 32 to 40 ms | under 16 ms to 16 ms (the observer's floor is 16 ms) |
| Type in search | 32 to 88 ms | 24 ms |
| Switch the scheduler day | 104 to 200 ms | 48 ms |

All are at or inside the 200 ms "good" line; the spec asserts the 500 ms "poor" line so a
regression is caught without turning a lab number into a promise. Real phones are slower than a
4x-throttled laptop; the real-device checklist (RD-50) has the on-hardware check.

Re-run after the round 1 fix (2026-10-06, `first-paint-metrics.spec.ts` on a hand-started preview of
the production build, Galaxy S24 profile and desktop, 9 of 9 passed): open a job 112 ms and 24 ms,
change a status under the observer's 16 ms floor and 24 ms, type in search 16 ms and 16 ms, switch
the scheduler day 40 ms and 72 ms. Largest paint in the same run: public estimate 2.5 s and 2.5 s,
public invoice 2.5 s and 2.6 s, scheduler 6.0 s and 5.8 s; CLS 0 on the public pages, 0.007 and 0.004
on the scheduler.

### Round 2 after the staging check (2026-10-06): the logo shift and the entry's target

The second staging check (deployed build of round 1) found three things; two are fixed here.

| Finding | Cause | Fix |
|---|---|---|
| Public estimate at 320 px: CLS 0.283 on every cold load. | The business logo (`h-auto max-h-10 w-auto`) has no size until it downloads; a wide wordmark grew the header 48 px and wrapped the View PDF link under it, pushing the document down. Fonts were not the cause (it reproduced with the font files blocked), and the gate's throwaway org has no logo, so the gate never saw it. | The logo's height is fixed (`h-10`) and its width capped at half the header (`max-w-[50%]`), so the header has the same size before and after the logo arrives. `public-logo-no-shift.spec.ts` holds a 6:1 logo back and measures the header before and after: red on all six devices before the change (66 px to 72 px; 66 px to 114 px at 320), green on all six after. |
| Staff entry 361.6 KB gzipped excluding the copilot, 11.6 KB over the 350 KB target. | The auth and realtime umbrella package builds a database, a file-storage and a functions client eagerly in its constructor, so they ship in the first download although the app only uses `supabase.auth` and the realtime channels (every data call goes through our own API). | The three packages are aliased to inert stand-ins (`src/shims/unused-data-clients-shim.ts`, `vite.config.ts`). Sign-in, session refresh and realtime are untouched (the same auth and realtime code runs). `unused-data-clients.test.ts` fails if source starts calling one. The entry is **348.8 KB** excluding the copilot (444.7 KB with it), and the build now enforces the 350 KB target itself. |

Re-run on the production build (browser-throttled spec, Galaxy S24 profile and desktop, host load
average about 60, so indicative): public estimate 2.7 s and 2.4 s, public invoice 2.5 s and 2.5 s,
CLS 0 on both; scheduler 5.8 s and 5.7 s, CLS 0.007 and 0.006. INP: open a job 104 ms and 24 ms,
change a status under the observer's 16 ms floor and 24 ms, type in search 16 ms and 24 ms, switch
the scheduler day 40 ms and 64 ms.

Still open, as in round 1 and for the same reasons (each a decision for Ran): the scheduler's largest
paint (about 5.7 to 7.6 s on the harsh profile) is a chain of the entry, the sign-in check, the page's
chunk and its five data requests; page-load tracing is still in error reporting; the public pages
sit at 2.4 to 2.8 s in the browser-throttled run and 3.5 s in the Lighthouse run. A page whose
largest paint is a card or a line of text that arrives with its data cannot be painted earlier
without a skeleton that counts as content or the data requests starting beside the chunk.

### Round 3 after the staging check (2026-10-06): the customer's page on its own, and where criterion 3 stands

The third staging check re-ran the repo's own Lighthouse budget (`MOBILE_GATE_LIGHTHOUSE=1 npm run
test:mobile -- --project=lighthouse`, production build over `vite preview`, median of three) and
measured the public estimate at 3.48 s, the public invoice at 3.48 s and the technician landing page
at 7.50 s, so criterion 3 was open. This round reproduced those numbers (3.48 s, 3.47 s, 7.60 s) and
took what the trace showed.

**The public pages' time was request rounds, not bytes.** Built in one pass with the staff app, the
customer's page loaded 37 scripts (35 of them a few hundred bytes: an icon, a card, a label) because
the bundler cut every module that page shares with a lazy staff page into a chunk of its own.
Lighthouse's mobile run models a plain HTTP/1.1 connection (the preview's own protocol: six requests
at a time, 150 ms each way), so those 37 files cost about 0.6 s of first paint with only 183 KB to
fetch. A trial with the file count cut by merging small chunks (`experimentalMinChunkSize`) moved the
page by 0.3 to 0.4 s and pushed the staff entry over its ceiling, because the merged chunks landed in
the staff entry; assigning the page's modules to a manual chunk pulled the error-reporting core and
the lazy recorder into it for the same reason (a manual chunk takes in every module it imports that
has no chunk of its own). What worked is not to share a graph at all.

| Change | Why | Effect |
|---|---|---|
| The customer's page (`public.html`) is built on its own, right after the staff app, by the same `vite build` (`public-entry-build.ts`, a plugin that runs a nested build into the same `dist/`). | It was the only entry whose modules were shared with the lazy staff pages, so the bundler fragmented it. Built alone it is the entry, one chunk for the framework, one stylesheet and the font. It is a plugin, not a second npm script, because the gate, the sweep and the service-worker spec all build with `npx vite build`. The staff worker is generated before the nested build runs, so its precache no longer carries the customer's page. | 37 scripts to 3; 182.6 KB to 160.7 KB gzipped (the framework and error-reporting code compress better as a unit); the staff entry is also 4 files instead of 8 and 343.9 KB excluding the copilot (348.8 KB), because the customer's page no longer splits its graph. `check-public-bundle-budget.mjs` now fails the build above 8 scripts on the page (`PUBLIC_MAX_FILES`). |
| The document's request starts before the page's scripts have arrived (`frontend/public-early.template.js`, filled in and served or emitted by `frontend/public-early-script.ts` as `/public-early.js`, loaded `async` from `public.html`; `lib/platform/earlyPublicFetch.ts`). | The estimate's data request started only when the page's code ran, 0.5 s after the first paint on the phone line. A same-origin script of 1.2 KB (the content security policy has no inline scripts) starts the same `GET` as soon as it lands; the page takes that response once, for the same URL, and otherwise makes its own request. The API address reaches the script as a string literal that `public-early-script.ts` fills in at build time from `VITE_API_URL` (empty means this origin); there is no meta tag. | About 0.15 s of largest paint; the largest paint is now within 0.5 s of first paint. |

Lighthouse budget run, before and after, back to back on the same host (load average about 100, so
indicative, but the numbers repeat to within 0.05 s):

| Page | LCP before | LCP after | CLS | Target (LCP <= 2.5 s, CLS <= 0.1) |
|---|---|---|---|---|
| Public estimate | 3.48 s | **2.28 s** | 0 | met, now `enforce` in `lighthouse-budget.json` |
| Public invoice | 3.47 s | **2.26 s** | 0 | met, now `enforce` |
| Technician landing page (the scheduler, cold start) | 7.60 s | **7.29 s** | 0.006 | **LCP not met**, stays `report` (ceiling 8 s) |

**The technician landing page cannot reach 2.5 s inside this slice, and it is not a tuning gap.**
Lighthouse's slow-4G profile moves 1.6 Mbit/s. The staff entry is 439.9 KB gzipped with the copilot
(343.9 KB without it) and the page cannot paint until it has arrived, been parsed and run: 439.9 KB
is 2.15 s of transfer alone (1.68 s without the copilot), before a round trip, the stylesheet, the
sign-in check (two requests), the scheduler's own five data requests and the scripting that sits
between them. First paint measures 3.9 s and the largest paint 7.3 s. Reaching 2.5 s would take a
staff first download of about 100 KB, or a first paint that does not wait on the sign-in check and
the scheduler's data, and the one change that gets close, taking the copilot out of the first
download, is out of this slice by decision (its code, chunking, lazy loading and mounting stay as
they are). This is the deviation, **accepted by Ran 2026-10-06**: the technician landing page (the scheduler) stays in
`report` mode with the 8 s ceiling, which can only come down. Criterion 3 is met for the public
estimate and invoice pages (LCP <= 2.5 s, CLS <= 0.1, enforced in `lighthouse-budget.json`) and waived
for the scheduler's cold-start largest paint. The two other directions that were offered (a warm-cache
budget for staff pages, and re-opening the staff entry) were not taken.

The browser-throttled spec (`first-paint-metrics.spec.ts`, production build, Galaxy S24 profile and desktop, 9 of 9 passed) now measures the public estimate and invoice at 1.7 s on both (2.5 to 2.7 s before), CLS 0, and its public bound comes down from 4 s to 3 s; the scheduler measures 6.0 s and 5.7 s (CLS 0.007 and 0.006); INP: open a job 104 ms and 24 ms, change a status under the observer's 16 ms floor and 24 ms, type in search 24 ms and 32 ms, switch the scheduler day 40 ms and 80 ms.

The fonts, the staff budget and CLS are unchanged by this round except as stated: the staff
entry is 343.9 KB (budget 350 KB, margin 6.1 KB instead of 1.2 KB).

## Fonts, device by device

`e2e/mobile/first-paint-fonts.spec.ts` passes on all six device projects on the production build:
nothing is requested from a font host, no stylesheet is cross-origin, the head preloads a
`crossorigin` font file of ours, every face that downloads is `swap`, and the page's own face
(Manrope on the public pages, Figtree on the scheduler) loads. Against the code as it was, the same
spec fails with the three stylesheet requests to the font host and the font file from it.

## Repeating it

```bash
cd frontend
npx vite build && node scripts/check-public-bundle-budget.mjs     # bundle numbers and the font checks
# gate (dev server): fonts on all six devices
MOBILE_GATE_ROUTES=public-estimate-open,public-invoice-open,schedule npm run test:mobile -- first-paint-fonts
# timing (production build): see e2e/mobile/README.md, "Timing on a production build"
```

Lighthouse was run ad hoc (not committed: it is a large dependency): `lighthouse` 13.5 driven
through `puppeteer-core` against a Chrome, with the preview behind a small local HTTP/2 front, the
gate's throwaway org for the public links and the admin session for the scheduler. Slice 62 owns the
standing Lighthouse budget.
