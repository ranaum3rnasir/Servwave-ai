# PRD — scoped assignee pool: a salesperson can schedule their own walkthrough

> PRD generated from the Sales-Role QA tracker, row 017 (Leads/Jobs → Schedule Walkthrough).
> Product ruling by Ran, 2026-08-31. Grounded against `origin/staging`.

## Problem Statement

A salesperson cannot schedule a walkthrough on their own lead. Not "with difficulty" — at all.

They open a lead they are assigned to, go to the Walkthrough tab, pick a date and a time, and
then reach the Performers field. It says **"No more members"** and will not open. The Schedule
Walkthrough button stays greyed out no matter what else they fill in, because the form refuses to
submit with an empty performer list. The rep is the person who is going to do the walkthrough, and
there is no way for them to say so.

Nothing on screen explains this. It reads as an empty company — as if the org had no staff — so
the rep's next move is to ask a dispatcher or an admin to book it for them. The one role whose
entire job is running leads through to a walkthrough is the one role that cannot book one.

The same empty picker appears wherever a salesperson is asked to name people: the task assignee
field, the scheduler board's participants field. Same cause every time.

## Solution

A salesperson who is assigned to a lead can schedule that lead's walkthrough, for themselves, in
one pass and without asking anyone.

When they open the Performers field they see their own name already there. They cannot take
themselves off it and they are not offered a list of colleagues, because on their own leads they
are the performer — that is what being assigned to the lead means. The field states the outcome
rather than presenting a choice that does not exist, and the Schedule button is live from the
moment a valid time is entered.

Everyone who books work on behalf of other people — dispatchers, admins — sees exactly what they
see today: the full assignable roster, freely editable.

The difference between those two experiences is a permission, not a hardcoded role check. An org
that wants a sales manager to book walkthroughs for their team grants them "assign crew and
performers other than yourself" in the Roles screen, and that person's picker opens up. Nothing is
deployed to make that happen.

The rule is enforced by the server, not by the disabled field. A request that names somebody else
is refused whatever sent it.

## User Stories

**The salesperson booking their own walkthrough**

1. As a salesperson assigned to a lead, I want the Performers field to show my own name already
   filled in, so that I can see who is going without having to search a list for myself.
2. As a salesperson assigned to a lead, I want the Schedule Walkthrough button to be clickable as
   soon as I have entered a valid date and time, so that I am not blocked by a field I cannot edit.
3. As a salesperson assigned to a lead, I want no "remove" control on my own performer chip, so
   that I cannot accidentally take myself off the walkthrough I am about to perform.
4. As a salesperson assigned to a lead, I want no "Add member" dropdown on my own leads, so that
   the form does not offer me a choice the server will refuse.
5. As a salesperson, I want a short line of text under the field telling me I can only put myself
   on a walkthrough, so that the absence of the dropdown reads as a rule and not as a bug.
6. As a salesperson, I want to reschedule a walkthrough I already booked without re-picking
   performers, so that moving a time is a one-field change.
7. As a salesperson, I want to book a second visit on the same lead with the same behaviour, so
   that the additional-visit door does not behave differently from the first.
8. As a salesperson, I want to keep booking walkthroughs on a lead after it has been closed or
   marked lost, so that a late follow-up visit does not require an admin.
9. As a salesperson, I want my walkthrough booking to still warn me when I am already busy at that
   time, so that I do not double-book myself.
10. As a salesperson, I want to be able to override that warning and book anyway, so that I keep
    the judgement call that dispatchers already have.
11. As a salesperson, I want the customer notification to go out exactly as it does today when a
    dispatcher books, so that the customer's experience does not depend on who scheduled it.
12. As a salesperson, I want to unschedule and cancel walkthroughs on my own leads, so that I own
    the whole booking lifecycle and not just its start.

**The salesperson everywhere else people are named**

13. As a salesperson, I want the task assignee field to offer me myself rather than reading "No
    more members", so that I can create a task for myself from a lead.
14. As a salesperson, I want the scheduler board's participants field to behave the same way as
    the lead's Performers field, so that the rule does not change depending on which screen I book
    from.
15. As a salesperson, I want to see my own name rendered correctly on any chip that names me, so
    that I never see "Unknown" where my name should be.

**The dispatcher and the admin**

16. As a dispatcher, I want the Performers field to keep offering me every assignable member of the
    org, so that nothing about my scheduling changes.
17. As a dispatcher, I want to keep booking walkthroughs on leads I am not assigned to, so that
    covering for a rep still works.
18. As an admin, I want my access to be unchanged, so that this is not a migration I have to
    supervise.
19. As a technician who created a job, I want to keep adding colleagues to that job's crew, so
    that the new rule does not quietly take away something I can do today.

**The org owner configuring roles**

20. As an org owner, I want "assign crew and performers other than yourself" to appear as a single
    switch in the Roles screen, so that I can see who has it without reading code.
21. As an org owner, I want that switch to cover both job crew and walkthrough performers, so that
    I am granting one coherent capability rather than remembering to set two.
22. As an org owner, I want to grant it to a custom sales-manager role, so that a team lead can
    book walkthroughs for their reps without becoming a dispatcher.
23. As an org owner, I want to grant it to one individual rep as a per-user override, so that an
    exception does not require a new role.
24. As an org owner, I want revoking it to take effect on that user's next request, so that
    removing it is as immediate as granting it.
25. As an org owner, I want my existing roles to come out of this change with exactly the
    permissions they had before it, so that an upgrade is not a permission change.

**Privacy and enforcement**

26. As an org owner, I want a salesperson to be unable to retrieve my staff's email addresses and
    phone numbers from the people-picker, so that a rep's browser session is not a directory export.
27. As an org owner, I want a salesperson to be unable to enumerate who works here through the
    picker at all, so that the roster is not a side channel around the Users screen.
28. As an org owner, I want a request that names somebody else as a performer to be refused by the
    server even when it did not come from our UI, so that the rule holds against a replayed or
    hand-made request.
29. As an org owner, I want the same refusal at every door that sets a performer or crew list, so
    that there is no unguarded one.
30. As a developer, I want one module to answer "who may this person assign work to", so that a
    future door cannot forget to ask.
31. As a developer, I want the answer to come from a granted permission rather than a role name, so
    that custom roles — which are already in production — are not invisible to it.
32. As a developer, I want the front end to read the same grant the server enforces, so that the
    form never offers something the API will reject, or hide something it would accept.

**Things that must not break**

33. As a dispatcher, I want the job crew picker to keep working exactly as it does now, so that
    widening this rule to jobs does not change today's behaviour.
34. As any user, I want the walkthrough conflict warning, the customer email and the internal
    notices to fire as they do today, so that this change is about who may be named and nothing else.
35. As any user, I want existing walkthroughs with multiple performers to keep them, so that this
    is not a data change.

## Implementation Decisions

**The pool resolver (new module).**
One module answers a single question: *for this requester and this purpose, may they name people
other than themselves?* It returns either an org-wide scope or a self-only scope carrying the
requester's id. It reads the CASL ability the session already carries — never a role name — so a
custom role holding the grant resolves to org scope, and per-user overrides work with no extra
code. It performs no database access, which is what makes it a unit-testable seam rather than
another integration surface.

**The pool is purpose-aware.** The resolver takes the picker's purpose and reads the grant that
matches it. Tasks keep asking the existing task-assign grant; crew and performer pickers ask the
new one. Collapsing these onto a single grant would silently break a custom role that today holds
task-assign and nothing else — it would lose the ability to assign tasks the moment this ships.

**One new grant, covering both crew and performers.** Per Ran's ruling: not a walkthrough-specific
permission. A single catalog entry — *assign crew and performers other than yourself* — governs
both the job crew list and the walkthrough performer list. Design notes:

- Modelled directly on the shipped task-assign grant, which already implements this exact
  self-versus-others distinction and is the prior art the reviewer should compare against.
- The subject is the **people being named**, not the work, because one grant spans two kinds of
  work. Naming it after either Job or Walkthrough would misdescribe half of what it governs.
- Default holders: **dispatcher and technician**. Technician is not optional — a technician who
  created a job can add colleagues to its crew today, and omitting them would be a silent removal
  of a working capability. Admin passes through manage-all and needs no row. Sales deliberately
  holds nothing, which is the whole point.
- Existing orgs need a backfill so their dispatcher and technician roles gain the row. Without it,
  live orgs would come out of the deploy with those roles quietly demoted to self-only.

**The roster endpoint is split from the user directory.** The assignable-roster branch moves out of
the user-list handler onto its own authenticated endpoint. Rationale:

- The list route is gated on *read User*, which sales does not hold and should not. Granting it to
  make the picker work would hand every salesperson the full staff directory — email, phone,
  extension, department, login state — and would open the single-user read route as well. That is
  the cheap fix, and it is wrong twice: over-broad, and it enforces nothing.
- A route-level gate cannot branch on a query parameter, so keeping one endpoint would mean moving
  the permission decision into the handler and leaving the route unable to state its own contract.
- The new endpoint returns a **narrowed field set**: id, names, role, department, avatar. No email,
  no phone, no extension, no login state, no timestamps. A picker needs a name and a grouping; it
  has never needed a contact card.
- The response is scoped by the resolver. A self-only requester receives exactly one row — their
  own — which is also what lets their chip render their name instead of "Unknown".
- One front-end hook calls this endpoint, so all twenty-odd picker call sites migrate by repointing
  that hook. The old query parameters are removed from the directory handler rather than left
  behind, so there is no second implementation to drift.

**Enforcement sits in the two existing validators.** The crew validator and the performer validator
are twins — same shape, same per-member eligibility rule, different error strings. They are not
merged; each gains a call to the shared pool check as its first step. Every door that sets a
performer or crew list already funnels through one of them, so this is the complete set of
enforcement points and there is no fourth place to remember.

**Refusal is 403, not 400.** A self-only caller naming somebody else is a permission failure, not a
malformed request. The existing eligibility failures in both validators stay 400. The message
states the rule in the user's terms.

**Row scoping is already correct and is not touched.** Every walkthrough door already runs the
canonical per-instance access check, and the sales grants for scheduling and performing are already
conditioned on the lead's assignee set with no status filter. Ran's ruling — assigned rep has full
authority, authority survives the lead closing — is already what the code does. This PRD adds the
performer-pool rule on top of scoping that works.

**An empty performer list stays legal at the API.** Ran's call. "They cannot take themselves off" is
enforced by the form, which gives a self-only user no remove control, and not by a minimum-length
check. This diverges from the task validator, which does reject an empty roster — a deliberate,
recorded difference, not an oversight. The cost is data quality on a hand-made request; access is
unaffected either way, since the rep holds the lead through its assignee set regardless.

**The front-end hook mirrors the existing task one.** Same shape, same reasoning, same warning
against reading the role instead of the ability. Both walkthrough booking surfaces — the lead's
walkthrough tab and the scheduler board — consume it.

**Seeding, not defaulting.** A self-only user's performer list is seeded with their own id when the
visit has none, computed from the grant and the session rather than hardcoded, and re-seeded if the
session hydrates after the form mounts. The multi-assignee picker's existing disabled state already
produces the required behaviour — chips render, remove buttons are suppressed, the combobox will
not open — so the visual rule needs no new component.

**The stuck Schedule button needs no separate fix.** It is disabled because the performer list is
empty; seeding it resolves it. There is no second cause. In particular there is no past-date check
anywhere in that condition — the dates in the original QA screenshots were never a factor.

## Testing Decisions

A good test here fixes the **rule**, not the plumbing. It sends a request as a role and asserts what
comes back, or renders a form as a user and asserts what is on screen. It does not assert that a
particular function was called, does not reach into the resolver's return shape from a controller
test, and does not assert on the presence of a grant row — a test that would still pass if the
server accepted a foreign performer id is testing nothing that matters. This codebase has been
bitten repeatedly by tests that cannot fail; the check for each test below is whether breaking the
rule it names would actually turn it red.

All four modules are tested.

**Pool resolver — unit.** The purest seam and the cheapest to cover exhaustively: grant holder
resolves to org scope; non-holder resolves to self-only carrying the right id; admin resolves to
org without holding an explicit row; a custom role holding the grant resolves to org; a per-user
allow override resolves to org; a per-user deny resolves to self-only; the task purpose reads the
task grant and not the new one. No database, so every case is a few lines. Prior art: the existing
permission-enforcement unit tests.

**Validators — integration, through the routes.** The rule Ran stated, so the one that must not
regress. As a sales user on their own lead: naming themselves succeeds; naming a colleague is
refused with 403; naming themselves plus a colleague is refused. As a dispatcher: naming anyone
succeeds. Every door is exercised — schedule, performers-only, additional visit, and the job crew
doors — because "there is no unguarded door" is the actual claim being made. A technician adding a
colleague to a job they created still succeeds, which is the regression guard for the default-holder
decision. Prior art: the existing lead and lead-visit route suites.

**Roster endpoint — integration.** As a sales user: 200, exactly one row, that row is themselves,
and the payload carries no email and no phone. As a dispatcher: the full pool. As a sales user
against the user directory route: still 403 — the split must not become a way in. Asserting the
*absence* of the contact fields is the point of this suite; a test that only counts rows would pass
against the leaky version.

**Front-end picker — component.** Rendering the lead's walkthrough tab as a self-only user: their
own name is present, no remove control, no add-member trigger, the explanatory line is shown, and
the Schedule button is enabled once a valid time is entered — that last assertion is the reported
bug and should fail against today's code. As a grant holder: the roster renders and the field is
editable. Prior art: the existing task drawer and task dialog suites, which cover the same
distinction for tasks.

**Ordering.** The resolver's unit tests come first and stand alone. The validator suite is the one
to write before the implementation — it states the ruling in executable form, and it is the suite a
reviewer should read to decide whether this PRD was built.

## Out of Scope

**Widening what sales may do to jobs.** Ran's ruling covers both crew and performers, and the grant
built here spans both. But sales currently holds exactly one job permission — a read, reached
through the estimate's parent lead — and no create, update or assign. So a salesperson cannot
schedule a job at all, and the crew picker is not what stops them. This PRD makes the job crew door
ask the same question as the walkthrough door, which changes nothing for sales today and preserves
today's behaviour for dispatchers and technicians. Whether sales gains scoped job write rights is an
unmade grant decision in the same roles-and-permissions territory Ran put out of scope, and it is
what tracker row 020 actually turns on. It should be decided deliberately, not absorbed here.

**Letting a salesperson add other performers.** Explicitly out of scope by Ran's ruling. The grant
built here is the mechanism by which an org could later allow it; no default role gains it.

**Retiring the separate task-assign grant.** Two grants now express a similar idea for different
work. Consolidating would mean migrating existing role rows and per-user overrides for a control
that already works correctly in production. Not worth doing as a rider on a bug fix.

**A minimum-performer rule.** See the implementation decision above — Ran's call, deliberately left
optional at the API.

**The remaining tracker rows.** Row 016 (task assignee picker) shares the root cause and is fixed
incidentally by the roster split, but its own reported symptom — a created task reading
"Unassigned" — needs confirming separately before it is called done; the server coerces a
non-holder's create to the actor, so the record may well be correctly owned and the defect merely
cosmetic. Row 020 is above.

**Any change to conflict detection, customer email, or notification behaviour.** Untouched.

## Further Notes

**Why the cheap fix was rejected, in one line:** granting sales *read User* would turn the picker on
in an afternoon, leak the staff directory, and still let any salesperson put any colleague on any
walkthrough — because nothing on the write path checks. The build is worth it because the
enforcement is the feature; the picker is just where it shows.

**Verify against the merged tree.** This repo's CI runs on pull requests only, so nothing re-runs on
the merge commit itself. The permission suites in particular should be confirmed green against the
merged result, not just the PR head.

**Branch policy.** Feature branch cut from `main`, first PR into `staging`, per the repo's branching
policy. Do not commit to either branch directly. This touches permissions and carries a backfill, so
it is **not** eligible for the nightly auto-fix cron.

**The grant backfill is the risk.** Everything else in this PRD fails closed and visibly. A missing
backfill fails quietly in the opposite direction: dispatchers and technicians in existing orgs would
find their pickers narrowed to themselves, and the symptom would look exactly like the bug this PRD
sets out to fix. Confirm the row count per org after deploying, not just that the migration ran.

**Source.** Row 017 of the Sales-Role QA tracker, and the follow-up permission card covering the
grantable "assign performers other than yourself" — this PRD is that card's implementation for the
walkthrough half plus the shared seam for the job half.
