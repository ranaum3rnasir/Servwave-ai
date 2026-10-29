# Slice 3 — The people-picker returns a scoped roster instead of nothing

**Type:** AFK.
**Blocked by:** [Slice 2](02-server-refuses-foreign-assignee.md) — the endpoint is scoped by the resolver.
**Covers user stories:** 13, 14, 15, 16, 26, 27.

## Parent

[00-prd.md](00-prd.md) — *Scoped assignee pool: a salesperson can schedule their own walkthrough.*

## What to build

Split the assignable-roster branch out of the user-directory handler onto its own authenticated
endpoint, return a narrowed field set, scope the result with the Slice 2 resolver, and repoint the
single front-end hook that every picker goes through.

This is the slice where the reported symptom disappears: a salesperson's Performers field stops
reading **"No more members"** and starts listing them.

**Why a split rather than granting sales *read User*.** The cheap fix is wrong twice. The directory
route is gated on *read User*; granting it to sales would hand every rep the full staff directory —
email, phone, extension, department, login state — and would open the single-user read route as
well. And it would enforce nothing: without Slice 2, any rep could still put any colleague on any
walkthrough. A route-level gate also cannot branch on a query parameter, so keeping one endpoint
would mean burying the permission decision inside the handler and leaving the route unable to state
its own contract.

**The narrowed field set is the privacy control.** A picker needs a name and a grouping. It has
never needed a contact card.

## Acceptance criteria

- [ ] A new authenticated endpoint returns id, first and last name, role, department and avatar —
      and nothing else. No email, no phone, no extension, no login state, no timestamps.
- [ ] It takes the picker's purpose and scopes by the resolver: a self-only requester receives
      exactly one row, their own; a grant holder receives the org pool.
- [ ] The eligibility and department filters the existing pickers depend on are preserved.
- [ ] The user-directory route keeps its *read User* gate. A sales user still gets 403 there — the
      split must not become a way in.
- [ ] The assignable-users query parameters are **removed** from the directory handler, so there is
      no second implementation left behind to drift.
- [ ] Every picker call site migrates by repointing the one hook; no call site keeps the old path.
- [ ] A sales user's Performers field lists them instead of reading "No more members", and their
      chip renders their name rather than "Unknown" — the single returned row is what makes the name
      resolvable.
- [ ] The task assignee field and the scheduler board's participants field populate the same way.
      This is tracker row 016's root cause.
- [ ] Row 016's own reported symptom — a created task reading "Unassigned" — is **confirmed or
      refiled separately**, not assumed fixed. The server already coerces a non-holder's create to
      the actor, so the record may well be correctly owned and the defect merely cosmetic.

## Testing

**Integration.** As a sales user: 200, exactly one row, that row is themselves, and the payload
carries no email and no phone. As a dispatcher: the full pool. As a sales user against the user
directory route: still 403.

Asserting the **absence** of the contact fields is the point of this suite. A test that only counts
rows would pass against the leaky version.

---

## Review, live QA and outcomes (PR #1951)

### Row 016 — REFILED, not fixed. Closing the open acceptance criterion.

The criterion required this to be *confirmed or refiled separately, not assumed fixed*. Traced
independently twice, four links, and the reported symptom is **not reproducible against this code**:

1. The server cannot persist an empty assignee set on the task-create path — it defaults to the
   actor on omission and 403s any requested set that is not exactly `[actor]`. An explicit `[]` is
   truthy, so it refuses rather than persisting empty.
2. The create dialog never sends an empty list, and seeds a non-holder's field from the session, not
   from the roster — so the empty-roster bug could never reach it.
3. Task assignee names resolve through a direct tenant-scoped query with **no ability gate**, so a
   salesperson's own name always resolves.
4. `"Unassigned"` has exactly one trigger: a genuinely empty assignee list. An id whose name cannot
   be resolved renders `"Unknown user"`.

What this slice fixes is row 016's stated **root cause** — the picker's empty roster, which rendered
the seeded chip as "Unknown" — not its stated **symptom**. Most likely the symptom predates the
enforcement slices and is already gone. **Refile with a repro or close; do not mark it fixed here.**
Caveat stated plainly: this is a code and test-suite trace, not a click-through on a live SALES
session.

### The finding that mattered: the `task` hold was a widening

Holding `purpose=task` org-wide, so Tasks stayed untouched (issue #1950), skipped the narrowing for
**everyone** — so a SALES user could fetch the whole staff roster from a route with no `canDo` gate,
where `staging` answers 403. A new enumeration capability, introduced by the slice whose entire
purpose is to remove one.

The root cause was `purpose` doing two jobs: naming *which grant gates this list* and *which picker
is asking*. Split into two families:

| family | purposes | gated by |
|---|---|---|
| pool-governed | `jobCrew`, `walkthroughPerformer`, `task` | `assign User` / `assign Task`, via the resolver |
| directory | `directory` | `read User` |

`AssigneePurpose` in `assigneePool.ts` is deliberately **unchanged** — that module answers "whose
names may I put on a piece of work", and a directory read is not that question.

Ten call sites moved to `directory`: the automation recipient pickers, the three task **filter**
surfaces, the lead **owner** picker, the job **dispatcher** picker, calendar-entry **participants**,
and the two assignee filter dropdowns. None of their writes consult `isAssigneeSetPermitted`, which
has exactly two callers. Before the split they were narrowing on a grant that does not govern them,
so a custom role holding `read User` without `assign User` would have seen its New Lead "Assign to"
dropdown collapse while `POST /api/leads` went on accepting anyone — breaking story 25's promise
that existing roles come out with exactly the permissions they had.

`AssignTeamPopover` was the seventh such surface and is now explicit: its purpose is a **prop**, so
the lead-owner wrapper asks for `directory` and the crew wrapper for `jobCrew`. A shared component
guessing on behalf of two different writes is how this class of bug gets in.

### Live QA — staging DB, real sessions, both directions

| purpose | SALES | DISPATCHER |
|---|---|---|
| `task` | **1 row** (before the fix: the whole org) | 21 — unchanged |
| `directory` | 1 | 21 — unchanged |
| `jobCrew` / `walkthroughPerformer` | 1 | 21 |
| `GET /api/users` | **403** | 200 |
| `GET /api/users/:id` | **403** | — |

The returned row's keys are exactly `avatar_url, department, first_name, id, last_name, role` —
nothing leaked. A request with no `purpose` is refused rather than defaulted open.

**The symptom is gone, on the surface it was reported against.** As a SALES rep on their own lead,
the Performers field reads `Mike Turner` / `Add performer...` — no "No more members", no "Unknown"
anywhere on the page. Mike Turner is a technician an ADMIN put on that walkthrough, named from the
**record** by a viewer whose roster contains exactly one row. That is Ran's ruling working end to
end: they see who is assigned, they simply cannot reach for anyone else.

### Found during QA, pre-existing, filed separately

Issue #1952 — the lead walkthrough card names performers from **every** visit, including cancelled
ones, while taking its date from the current one. Duplication is the mild symptom; the real failure
is a cancelled visit staffed by Alice plus a live one staffed by Bob rendering as "with Alice, Bob".
`walkthrough.service.ts` is byte-identical to `origin/staging` on this branch.
