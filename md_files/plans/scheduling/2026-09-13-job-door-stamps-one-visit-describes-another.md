# The job-level milestone doors stamp one trip and describe another

Found 2026-09-12 while building per-visit visit locations (#2059, #2061, #2080, #2082).

## The defect

`POST /api/jobs/:id/en-route` stamps the job's **current** visit through
`stampCurrentJobVisitMilestone` → `resolveCurrentJobVisit`, whose rule is *"a trip that has already
BEGUN beats one that has not"*. It then dispatched `JOB_EN_ROUTE` with **no `visitId` and no merge
fields**, so `context.ts`'s job arm resolved the customer's email per **entity** →
`resolveNextJobVisit`, *"the earliest still-UPCOMING live trip"*.

Those two resolvers part company the moment a crew runs past their slot — the ordinary case this
door exists for:

| | visit 1 | visit 2 |
|---|---|---|
| booked | today 09:00–11:30, at the customer's house | next week 13:00–15:30, at the showroom |
| `resolveCurrentJobVisit` at 11:45 | **wins** (begun) | — |
| `resolveNextJobVisit` at 11:45 | — (elapsed) | **wins** (upcoming) |

The stamp landed on visit 1; the email described visit 2. Since #2082 put `{{job.visit_location}}`
on that same per-entity resolution, the customer was told the wrong **address** as well as the
wrong time: *"we're on our way"* to the showroom, for a trip happening at their house.

Reproduced in both directions by `backend/src/__tests__/job-door-visit-mismatch.test.ts`, which
fires the real door and then renders the captured event through `loadExecutionBundle` exactly as
`enrollment.ts` renders it on every step load. Before the fix:

```
expected 'Showroom, 12 Harbor St, Asheville, NC' to be '123 Main St, Austin, TX'
expected '123 Main St, Austin, TX' to be 'Showroom, 12 Harbor St, Asheville, NC'
```

Both `stampedVisitIds()` assertions passed in both runs, which is what proves the split is real
rather than a fixture accident: the stamp genuinely follows `resolveCurrentJobVisit` and the email
genuinely follows `resolveNextJobVisit`.

This is the same defect family #2082 closed at the five **visit-scoped** dispatch sites. Its
structural test (`job-visit-location.test.ts`) enumerates every dispatch carrying `visitId:` and
fails one lacking `mergeFields:` — it correctly did **not** flag this door, because this door
passed no `visitId` at all.

## The two candidate fixes

### B — make the job arm of `context.ts` resolve against the stamped visit. Rejected.

1. **It cannot actually do what the name says.** The stamped visit id is not reachable from an
   enrollment. `enrollOnEvent` passes `visitId` to `buildDedupeKey` and nothing else; it is never
   persisted. So "resolve against the stamped visit" can only mean *swap `resolveNextJobVisit` for
   `resolveCurrentJobVisit`* — a re-derivation at send time, not a record of what was stamped.
2. **That re-derivation decays.** A send parked behind a WAIT step renders whatever
   `resolveCurrentJobVisit` answers hours or days later, not the trip the crew left for.
3. **The blast radius is every job automation in every org, not en-route.** The job arm is loaded
   for `JOB_SCHEDULED`, `JOB_RESCHEDULED`, `JOB_COMPLETED`, `JOB_CANCELLED`, `TECH_ASSIGNED`,
   `TECH_UNASSIGNED`, `JOB_SUB_STATUS_ENTERED`, and both cron paths. `{{job.scheduled_date}}` there
   is deliberately the same "next upcoming live visit" the board, `lib/job-schedule-projection.ts`
   and the retired D14 mirror all mean by *next*; and `state.jobScheduledStart` off the same
   resolution feeds `anchorDateFor` → every `BEFORE_JOB_START` anchored wait and
   `rearmAnchoredWaits`. Switching the resolver re-anchors live reminders onto elapsed trips.

### A — scope the dispatch to the stamped visit, as the five visit-scoped sites already do. Chosen.

`stampCurrentJobVisitMilestone` already **returns** the id it stamped (`Promise<string | null>`);
all three job-level call sites discarded it. Passing it as `visitId`, with the matching
`eventPayload.mergeFields`, puts this door on the channel #2082 built and brings it under the
existing structural test.

## The dedupe-key consequence, worked out

Adding `visitId` changes the key from `JOB_EN_ROUTE:{jobId}:{ISO}` to
`JOB_EN_ROUTE:{jobId}:{visitId}:{ISO}`. What that can and cannot disturb:

- **`visitId` does exactly one thing.** It is spliced into `buildDedupeKey` and nothing else. It
  is not persisted on the enrollment. `rearmAnchoredWaits` matches on
  `entity_type`/`entity_id`/`status` and never on `dedupe_key`. `bundle.dedupeKey` is assembled in
  `context.ts` and read by **nothing** in the tree.
- **No in-flight enrolment can be resurrected or suppressed.** `JOB_EN_ROUTE` is occurrence-scoped
  with occurrence = `en_route_at.toISOString()`, a `new Date()` minted at press time. A new press
  therefore cannot collide with any historical key under **either** format. `dedupe.ts`'s own
  "REJECTED, and why" note already records this reasoning for `JOB_EN_ROUTE` by name, which is why
  #2082 shipped the same key change at the sibling door with no migration.
- **The legacy-run cutover lookup is unreachable for the same reason.** It needs an exact
  `(rule_id, dedupe_key)` match on `automation_runs`, and the fresh millisecond makes one
  impossible.
- **The only outcome the format can alter is two presses in the same millisecond on one job.**
  Resolving the same current visit, the second is still swallowed. Resolving different visits, they
  now enrol separately — which is D18's rule (*"two crews leaving for two trips on one job are two
  occurrences"*) and is already what the visit-scoped door does.
- **It removes a divergence rather than creating one.** The two en-route doors emit the same
  trigger in two different key shapes today. After this they emit one.

**No migration, and none is possible to want:** rewriting the two persisted ledgers would either
suppress the enrolments D18 exists to create, or rewrite rows that can never collide again.

## Scope: which other doors need this

| door | stamps a visit | dispatches | verdict |
|---|---|---|---|
| `POST /:id/en-route` (job-level) | `resolveCurrentJobVisit` | `JOB_EN_ROUTE`, per entity | **fixed here** |
| `POST /:id/start` | `resolveCurrentJobVisit` | nothing to automations | no change — see below |
| `POST /:id/arrive` | `resolveCurrentJobVisit` | nothing to automations | no change — see below |
| `POST /:id/complete` | — (no visit stamp) | `JOB_COMPLETED`, per entity | correct: a job-level fact |
| `POST /:id/cancel` | — (cancels the whole set) | `JOB_CANCELLED`, per entity | correct: job-wide |
| `POST /:id/sub-status` | — | `JOB_SUB_STATUS_ENTERED` | correct: job-level |
| the five visit-scoped sites | per-visit | with `visitId` + `mergeFields` | done in #2082 |

`/start` and `/arrive` stamp a visit and describe **nothing**: there is no `JOB_STARTED`,
`JOB_ON_SITE` or `JOB_ARRIVED` value in `AutomationTriggerType`, `/arrive` emits no notification at
all, and `/start`'s in-app `emit('job.started')` renders only `"{job_number} started — {customer}"`
with no date, no crew and no address. So there is no second trip for them to describe. They are
left alone rather than given a speculative dispatch — but a new structural test now fails the day
either of them grows one without naming the trip it stamped.

`POST /:id/status` and the bulk endpoints reach these same three handlers in-process, so they
inherit the fix by construction.

## Deliberately NOT changed: the crew gate

The dispatch is gated on `jobCrewIds(existing).length > 0` — the crew union across **all** the
job's trips. The sibling visit-scoped door gates on the crew of the **one** trip
(`if (ctx.crew.length === 0) return;`).

Scoping the render without scoping the gate leaves an inconsistency, and the honest reading of the
gate's own docstring (*"dispatching with an empty crew would email them a notification naming
nobody"*) is that `'Our team'` is naming nobody politely. But narrowing it **silences an email that
sends today** for any org that books trips without per-visit crew, and that is a behaviour change
for live automations, not a bug fix.

So the gate is left exactly as it is and flagged instead. What the fix does change is that a
crewless current visit now renders `'Our team'` rather than naming a technician who is on a
different trip — strictly more honest than today, and it silences nothing.

**Open question for Ran:** should the job-level en-route door gate on the stamped visit's crew,
matching the per-visit door? That would stop "we're on our way" for a trip nobody is assigned to,
at the cost of silencing orgs that rely on the job-level union.
