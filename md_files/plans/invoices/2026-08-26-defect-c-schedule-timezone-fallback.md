# Defect C — `useScheduleTimezone()` falls back to Eastern while the org is loading

Date: 2026-08-26
Branch: `staging` (verified against `origin/staging` @ `a66ab84d5`)

> **Re-scoped during planning.** The defect as filed was "the hook falls back to Eastern while the
> org loads" (LOW, cosmetic). Investigation found the read path is indeed cosmetic, but that **three
> write-path forms bake that fallback into persisted state** — a silent, non-self-correcting 2-hour
> shift for a Denver org. The real defect is those three forms, not the hook.

## 1. Root cause and honest severity

### The code

`frontend/src/lib/schedule-tz.ts:33-36`

```ts
export function useScheduleTimezone(): string {
  const { data: org } = useOrganization();
  return org?.timezone || DEFAULT_SCHEDULE_TIMEZONE;   // 'America/New_York'
}
```

**The central finding: `org?.timezone || DEFAULT` conflates two conditions that need different
answers.**

| | Condition | Correct behaviour |
|---|---|---|
| **A** | `org === undefined` — query in flight, or errored out | **This is the defect.** We do not know the zone; guessing Eastern is a lie. |
| **B** | `org.timezone === null` — org loaded, zone never configured | **Legitimate fallback.** `Organization.timezone` is `string \| null` (`frontend/src/lib/api/organization.ts:74`), and `frontend/src/__tests__/jobs-page.test.tsx:216-223` explicitly depends on this. |

Any fix must preserve B and only address A. That distinction is what keeps this change small.

### Is the org usually already loaded?

Partly — the strongest argument *for* low severity on the read path:

- No prefetch, no suspense, no persisted cache. `frontend/src/lib/queryClient.ts` sets
  `staleTime: 5min`, `retry: 1`, in-memory only.
- `useOrganization()` (`frontend/src/lib/api/organization.ts:134-142`) is a plain
  `useQuery(['organization'])`.
- The query is kicked off at the **shell** level — `frontend/src/components/layout/AppLayout.tsx:28`
  and `frontend/src/pages/v2/V2AppLayout.tsx:169` — an ancestor of every route. The shell does
  **not** gate its children, so on a cold load the shell and its children mount in the same commit
  with `data: undefined`.
- However, every page that mounts a schedule-seeding form gates on **its own** `isLoading` first
  (e.g. `frontend/src/pages/v2/invoices/InvoiceDetailPage.tsx:208` early-returns a `<Skeleton>`). So
  those forms mount at least one network round trip *after* the shell fired the org query. For the
  defect to bite, the page's own query must resolve *before* `/api/organization` — a genuine race,
  but an unlikely one.

**Verdict on the read path: LOW, cosmetic, self-correcting.** react-query re-renders on resolve and
display-only consumers repaint correctly.

### But two sub-cases are not cosmetic

**(1) Seed-once-then-write-back — a real data defect.** Three write-path forms bake the tz into React
state at mount and never re-derive it, then write that state back through the *resolved* zone:

- `frontend/src/pages/v2/jobs/components/visitScheduleDialog.tsx:78` —
  `useState(() => seedFrom(visit, tz))`, whose own comment says *"Seeded ONCE, at mount"*. Save at
  line ~127 sends `dayAndTimeToIso(value.date, value.startTime, tz)`.
- `frontend/src/components/invoices/RecordPaymentDialog.tsx:47-50` — `paidAt` seeded from
  `isoToPickerValue(new Date().toISOString(), timezone)`. This dialog is rendered **unconditionally**
  by its hosts (`pages/v2/invoices/InvoiceDetailPage.tsx:973`,
  `pages/v2/jobs/JobDetailPage.tsx:1924`, `pages/InvoiceDetailPage.tsx:1091`) — its own comment
  confirms *"The dialog stays mounted while closed"* — so it mounts with the page, not on open.
- `frontend/src/pages/LeadFormPage.tsx:739-742` — react-hook-form `defaultValues` consume `timezone`
  once at first render; submit re-resolves via `dayAndTimeToIso`.

Mechanism: a visit stored at `2026-06-15T18:00:00Z` seeds as `14:00` (Eastern) while loading; the org
resolves to `America/Denver`; the user saves without touching the schedule fields;
`dayAndTimeToIso('2026-06-15','14:00','America/Denver')` writes `2026-06-15T20:00:00Z`. **A silent
2-hour shift on a save that never touched the schedule.** Unlike the read, this does not
self-correct — it is persisted.

**This repo already knows about this hazard.**
`frontend/src/pages/v2/leads/components/walkthroughTab.tsx:127-135` carries the fix and names the
cause exactly:

> `// The page re-keys this component when the LEAD's values change, but the org-timezone`
> `// query can land after mount - and the same wall clock read against a different zone is`
> `// a different instant, so the fields must be re-seeded when it does.`

`git grep lastTz` returns **exactly one hit** — that file. The other three write-path seeds are
unguarded.

**(2) The error path is not transient at all.** With `retry: 1` and no `placeholderData`, a failing
`GET /api/organization` leaves `data === undefined` for the rest of the session. All 53 call sites
are then permanently pinned to Eastern, silently. For Talon Septic that is a permanent 2-hour error
on every read *and* write, with no user-visible signal.

### Severity verdict

- Read path: **LOW** (cosmetic, self-correcting).
- Write path: **MEDIUM** — silent, persisted, 2-hour data corruption. Low probability, but it does
  not self-correct once written, and the repo has already paid to fix one instance of it.

**Net: keep the defect in the PR, but re-scoped.** It is not "the hook falls back"; it is "three
write-path forms bake the fallback into persisted state."

### Confirmed environment fact

Staging DB (`knriiqdqxgfoecsfarlx`, SELECT only):

| Org | timezone |
|---|---|
| Talon Septic, LLC | **America/Denver** |
| all 8 others | America/New_York |

Denver / New York is a clean 2-hour offset. No org currently has a null timezone — but the column is
nullable and a test depends on case B, so the fallback stays.

## 2. Chosen fix, and the alternatives rejected

### Chosen: apply the repo's own existing re-seed pattern to the three unguarded write-path seeds. Do not change the hook's signature.

Lift the pattern verbatim from `walkthroughTab.tsx:127-135` — React's documented "adjust state during
render when a prop changes", which the repo prefers because `react-hooks/set-state-in-effect` is
enforced on changed lines in CI:

```ts
const [lastTz, setLastTz] = useState(timezone);
if (timezone !== lastTz) {
  setLastTz(timezone);
  setValue(seedFrom(visit, timezone));
}
```

Why keying on the tz **value** (not an `isLoading` flag) is exactly right: for the 8 Eastern orgs the
fallback equals the real value, so the guard never fires and nothing is disturbed. It fires only when
the guess was actually wrong. That is the minimum possible blast radius.

`useScheduleTimezone()` keeps returning `string` — all 53 call sites keep compiling and no consumer
changes.

**Rejected — (a) return `undefined`/`null` while loading.** The hook's return type would become
`string | undefined`, and because PR #1804 made `timeZone` **required** on the pure functions,
TypeScript would break at all 53 call sites across 47 files. Worse, the runtime failure mode is
severe: `formatInTimeZone(iso, undefined, fmt)` throws
`RangeError: Invalid time zone specified: undefined`. Disproportionate for a LOW-severity read path.

**Rejected — (b) keep the fallback but expose an `isLoading` flag.** Sound in principle, but nothing
would consume it. The three sites that need fixing key off the tz *value* changing, so the flag is
dead API. Adding an unused export to a heavily-documented shared module is a net loss.

**Rejected — (c) gate rendering higher up until the org resolves.** Would work, but it is the biggest
change of the four: it blocks the entire app shell on one query, adds a full-page blank/skeleton to
every cold load, and regresses perceived performance for all users to fix a race that harms one org's
forms. No precedent here — the established convention is per-page `if (isLoading) return <Skeleton>`,
not a global gate.

**Rejected — (d) accept the transient and document it.** Correct for the *read* path, and if the read
path were all there was this should be dropped from the PR. It is not defensible for the write path:
`visitScheduleDialog.tsx:78`, `RecordPaymentDialog.tsx:50` and `LeadFormPage.tsx:739` can persist a
wrong instant that never self-corrects, and `walkthroughTab.tsx` is standing proof the team already
judged this worth fixing once.

*Evidence that would flip this to (d):* if all three seeding sites turned out to be unreachable
before the org resolves — e.g. if the shell were changed to gate children on org readiness, or if
each host page's own query were proven to always resolve after `/api/organization`. Neither holds
today.

## 3. Blast radius

**Changes (3 files, ~8 lines each):**

| File:line | Change |
|---|---|
| `frontend/src/pages/v2/jobs/components/visitScheduleDialog.tsx:78` | Add `lastTz` guard re-seeding `value` via `seedFrom(visit, tz)`. |
| `frontend/src/components/invoices/RecordPaymentDialog.tsx:47-50` | Add `lastTz` guard re-seeding `paidAt` to the recomputed `defaultPaidAt`. Guard must not clobber a user-entered value — re-seed only if `paidAt` still equals the previously seeded default. |
| `frontend/src/pages/LeadFormPage.tsx:739-742` | RHF variant: on tz change, `form.reset({ ...form.getValues(), scheduled_date: ..., scheduled_time: ..., scheduled_end_date: ..., scheduled_end_time: ... })` — reset **only** the four schedule fields, preserving every other edited field. |

**Does NOT change:**

- `frontend/src/lib/schedule-tz.ts` — hook signature and fallback untouched. Optionally a doc-comment
  clarifying cases A vs B (non-behavioural).
- The other 50 invocation sites (47 files total) — all display-only or re-derive on every render.
- `frontend/src/pages/v2/leads/components/walkthroughTab.tsx` — already correct; the reference
  implementation.
- `frontend/src/__tests__/jobs-page.test.tsx:216-223` — depends on case B, which is preserved.
  **Verify this still passes.**
- `frontend/src/components/filters/controls/DateFacet.tsx:21` — deliberately passes `tz={undefined}`
  for non-`scheduled` facets; unaffected.

## 4. Failing tests to write first (TDD)

### The Denver requirement — non-negotiable

**Every test below must use `America/Denver`.** With an Eastern org the fallback value *equals* the
correct value, so the seed is right either way and the test passes identically against old and new
code — proving nothing. Denver produces a 2-hour divergence that only the fixed code resolves.

### How this repo mocks `useOrganization()`

Established convention, identical in at least five files (`jobRescheduleSeed.test.tsx:50`,
`jobVisits.test.tsx:54`, `leadDetailScheduleTimezone.test.tsx:53`, `scheduleSearch.test.tsx:20`,
`job-detail-schedule-timezone.test.tsx:48`):

```ts
vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({ data: { id: 'org-1', timezone: ORG_TZ }, isLoading: false, isError: false }),
  };
});
```

**Extension needed:** these mocks are static. To simulate *resolution after mount*, back the mock
with a module-level mutable the test flips, then force a re-render:

```ts
const ORG_TZ = 'America/Denver';                 // UTC-6 in June. NOT Eastern — see above.
let orgState: ReturnType<typeof useOrganization> =
  { data: undefined, isLoading: true, isError: false } as never;

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return { ...actual, useOrganization: () => orgState };
});

function resolveOrg() {                          // flip + repaint
  orgState = { data: { id: 'org-1', timezone: ORG_TZ }, isLoading: false, isError: false } as never;
}
```

Then `rerender(...)` from `renderWithProviders` (`frontend/src/__tests__/helpers.tsx`) inside `act()`.

### Test 1 — the primary, highest-value test

**File:** `frontend/src/pages/v2/jobs/__tests__/visitScheduleTzLateResolve.test.tsx`
(new; sits alongside the existing `jobRescheduleSeed.test.tsx`, whose fixture and mock scaffolding it
should copy)

**Name:** `does not shift a visit when the org timezone resolves after the dialog mounts`

- **Fixture:** a job visit with `scheduled_at: '2026-06-15T18:00:00.000Z'`,
  `scheduled_end: '2026-06-15T20:00:00.000Z'`. June avoids any DST boundary. In Denver (MDT, UTC-6)
  that reads `12:00`; in New York (EDT, UTC-4) it reads `14:00`.
- **Loading simulated:** `orgState` starts `{ data: undefined, isLoading: true }`. Mount
  `VisitScheduleDialog` with `open`. Then `resolveOrg()` + `rerender()` inside `act()`.
- **Org timezone:** `America/Denver`.
- **Assertion:** click Save without touching any schedule field; assert on the PATCH body:

  ```ts
  expect(body.scheduled_start).toBe('2026-06-15T18:00:00.000Z');
  expect(body.scheduled_end).toBe('2026-06-15T20:00:00.000Z');
  ```

- **Why it fails first:** old code seeds `14:00` (Eastern) and writes it back through Denver ->
  `2026-06-15T20:00:00.000Z` for the start, a `+2h` shift. New code re-seeds to `12:00` and
  round-trips to the original instant.

This asserts the **round trip through the public interface** (the request body), not the internal
seed — the strongest available formulation.

### Test 2 — visible field corrects

**Same file.** **Name:** `re-seeds the visible start time when the org timezone resolves after mount`

- Same fixture and loading simulation.
- **Assertion:** before `resolveOrg()`, the start-time field reads `14:00`; after `resolveOrg()` +
  rerender, it reads `12:00`.
- **Why it fails first:** old code leaves `14:00` on screen — the wrong hour, permanently, for the
  life of the dialog.

### Test 3 — user edits survive

**Same file.** **Name:** `keeps a user-edited time when the org timezone resolves after mount`

- Mount while loading, type `09:30` into the start-time field, *then* `resolveOrg()`.
- **Assertion:** field still reads `09:30`; the save body is
  `dayAndTimeToIso('2026-06-15','09:30','America/Denver')` = `'2026-06-15T15:30:00.000Z'`.
- **Purpose:** guards the regression the fix itself could introduce (see Risks). May need a "dirty"
  check alongside the `lastTz` guard. If the implementer decides clobbering a sub-300ms edit is
  acceptable (as `walkthroughTab` implicitly does), invert this test and document the decision — but
  decide it deliberately, not by accident.

### Test 4 — payment timestamp

**File:** `frontend/src/__tests__/record-payment-tz-late-resolve.test.tsx`
(new; reuse the mock scaffolding in the existing `record-payment-dialog.test.tsx`)

**Name:** `records the payment at the true instant when the org timezone resolves after mount`

- **Fixture:** `vi.setSystemTime(new Date('2026-06-15T18:00:00.000Z'))`. Mount `RecordPaymentDialog`
  with `open` while `orgState` is loading; `resolveOrg()` to `America/Denver`; submit without
  touching the date field.
- **Assertion:** `expect(body.paid_at).toBe('2026-06-15T18:00:00.000Z')`.
- **Why it fails first:** old code seeds `paidAt = '2026-06-15T14:00'` (Eastern) and submits it
  through Denver -> `'2026-06-15T20:00:00.000Z'`.
- **Note:** this dialog mounts with its host page rather than on open, so it is the most exposed of
  the three.

### Test 5 — case B must not regress

**File:** `frontend/src/lib/schedule-tz.reseed.test.tsx` (new) *or* extend the existing
`schedule-tz` suite.

**Name:** `useScheduleTimezone still falls back when the org has loaded with no timezone configured`

- **Fixture:**
  `useOrganization: () => ({ data: { id: 'org-1', timezone: null }, isLoading: false, isError: false })`.
- **Assertion:** `renderHook(() => useScheduleTimezone()).result.current === DEFAULT_SCHEDULE_TIMEZONE`.
- **Purpose:** pins case B so a future attempt at option (a) cannot silently break
  `jobs-page.test.tsx`. This one **passes** before the fix — it is a characterisation test, and this
  plan says so rather than pretending it is red.

### Suggested TDD order

1. Test 1 (red) -> fix `visitScheduleDialog.tsx` -> green.
2. Test 2 (red) -> already green from step 1; confirm.
3. Test 3 -> decide clobber-vs-preserve, implement, green.
4. Test 4 (red) -> fix `RecordPaymentDialog.tsx` -> green.
5. Test 5 (green throughout) -> then fix `LeadFormPage.tsx` by analogy.
6. Run `frontend/src/__tests__/jobs-page.test.tsx` and the full `schedule-tz*` suite to confirm no
   regression.

## 5. Risks

**Can removing the fallback crash or throw `Invalid time zone`?** Yes — which is precisely why the
chosen fix does **not** remove it. Since #1804 made `timeZone` required,
`formatInTimeZone(iso, undefined, fmt)` and `fromZonedTime(str, undefined)` throw
`RangeError: Invalid time zone specified: undefined` at runtime. Under option (a), 53 call sites
would first fail TypeScript, and any missed one (`as string`, a spread, a memo boundary) would become
a hard render crash on the loading paint — turning a cosmetic LOW into a white screen. **The chosen
fix leaves the hook's return type as `string`, so this risk is fully avoided.** Note `formatInstant`
is the benign exception: it forwards `timeZone` to `toLocaleString`, which silently falls back to the
system zone rather than throwing — meaning a missed site would fail *silently*, not loudly. Another
reason not to go down that road.

**Clobbering in-flight user edits.** The `lastTz` guard resets picker state when the zone changes. A
user who typed into the field inside the ~50-400ms loading window loses that input.
`walkthroughTab.tsx` already accepts this. Test 3 forces the decision to be explicit. Mitigation if
preservation is wanted: track a `dirty` flag and re-seed only when untouched.

**Render-phase `setState` loops.** The pattern must set `lastTz` *before* the dependent `setState` and
compare a primitive. `seedFrom` returns a new object each call, so comparing seeds instead of the tz
string would loop infinitely. Copy `walkthroughTab.tsx:127-135` structurally, do not improvise.

**RHF divergence.** `LeadFormPage` uses `defaultValues`, not `useState`, so the same guard needs
`form.reset()`. A naive `form.reset({ scheduled_date: ... })` **wipes every other field**; it must
spread `form.getValues()` first. This is the likeliest place to introduce a worse bug than the one
being fixed — land it last, and drop it to a follow-up if it fights back.

**`refetchOnWindowFocus: 'always'`.** Set on `useOrganization` (`organization.ts:141`). A background
refetch keeps the previous `data` (never `undefined`), so the guard will not fire spuriously on tab
focus — *unless* an admin genuinely changes the org timezone in another tab, in which case re-seeding
is the correct behaviour.

**Not addressed by this fix (deferred, worth an issue):** the permanent-error case. If
`/api/organization` fails, `data` stays `undefined` for the session and every consumer is silently
Eastern. The contained follow-up is a `useScheduleTimezoneResolved()` flag consumed by an app-level
banner, or `throwOnError`/a Sentry breadcrumb on the org query. Out of scope here — an observability
gap, not a correctness gap in these three forms.
