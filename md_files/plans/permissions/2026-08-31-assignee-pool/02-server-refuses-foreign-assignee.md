# Slice 2 — The server refuses a foreign performer or crew member

**Type:** AFK.
**Blocked by:** [Slice 1](01-grant-exists-and-is-visible.md) — the grant must exist to be read.
**Covers user stories:** 19, 28, 29, 30, 31, 33.

## Parent

[00-prd.md](00-prd.md) — *Scoped assignee pool: a salesperson can schedule their own walkthrough.*

## What to build

The enforcement half, end to end: a requester who does not hold the grant from Slice 1 may name only
themselves when setting a walkthrough's performers or a job's crew, and the server says so.

Two pieces, shipped together because the first is not demoable without the second:

**The pool resolver.** One module answering a single question — *for this requester and this
purpose, may they name people other than themselves?* — returning either an org-wide scope or a
self-only scope carrying the requester's id. It reads the CASL ability the session already carries,
never a role name, so a custom role holding the grant resolves to org scope and per-user overrides
work with no extra code. It touches no database, which is what makes it a unit-testable seam rather
than another integration surface.

The resolver is **purpose-aware**. It takes the picker's purpose and reads the grant that matches
it: tasks keep asking the existing task-assign grant, crew and performer pickers ask the new one.
Collapsing these onto one grant would silently break a custom role that today holds task-assign and
nothing else — it would lose task assignment the moment this ships.

**The two validators.** The crew validator and the performer validator are twins: same shape, same
per-member eligibility rule, different error strings. Do not merge them. Each gains a call to the
shared pool check as its **first** step. Every door that sets a performer or crew list already
funnels through one of them, which is what makes this the complete set of enforcement points.

Shipping enforcement before the picker opens up is deliberate and safe: a salesperson cannot reach
these fields in the UI today, so this slice closes a hand-made-request hole without changing anything
a user can see.

## Acceptance criteria

- [ ] The resolver reads the granted ability, never a role name, and performs no database access.
- [ ] The resolver is purpose-aware: the task purpose reads the task-assign grant; crew and
      performer purposes read the grant from Slice 1.
- [ ] A sales user on a lead they are assigned to, naming **themselves** as performer, succeeds — at
      all three walkthrough doors (schedule, performers-only, additional visit).
- [ ] The same user naming a colleague is refused — whether alone or alongside themselves — at all
      three doors.
- [ ] A dispatcher naming anyone succeeds, unchanged, at every door.
- [ ] A technician adding a colleague to the crew of a job they created still succeeds. This is the
      regression guard on Slice 1's default-holder decision.
- [ ] The job crew doors enforce the same rule as the walkthrough doors.
- [ ] Refusal is **403**, not 400: naming somebody else is a permission failure, not a malformed
      request. The existing eligibility failures in both validators (unknown, inactive, ineligible
      role) stay 400.
- [ ] The refusal message states the rule in the user's terms.
- [ ] An empty performer list is still accepted. This is a deliberate, recorded divergence from the
      task validator, which does reject an empty roster — Ran's call. "They cannot take themselves
      off" is enforced by the form in Slice 4, not by a minimum-length check here.
- [ ] Row scoping is untouched. The per-instance access check and the assignee-set conditions on the
      sales scheduling grants are already correct; this slice adds the pool rule on top of them.

## Testing

**Resolver — unit.** The purest seam and the cheapest to cover exhaustively: grant holder resolves
to org scope; non-holder resolves to self-only carrying the right id; admin resolves to org without
holding an explicit row; a custom role holding the grant resolves to org; a per-user allow resolves
to org; a per-user deny resolves to self-only; the task purpose reads the task grant and not the new
one. No database, so each case is a few lines. Prior art: the existing permission-enforcement unit
tests.

**Validators — integration, through the routes.** This is the suite that states Ran's ruling in
executable form, and the one a reviewer should read to decide whether this PRD was built. **Write it
before the implementation.** Every door is exercised, because "there is no unguarded door" is the
actual claim being made.

The standard for this slice: a test that would still pass if the server accepted a foreign performer
id is testing nothing that matters. This codebase has been bitten repeatedly by tests that cannot
fail — the check on each assertion is whether breaking the rule it names would actually turn it red.
