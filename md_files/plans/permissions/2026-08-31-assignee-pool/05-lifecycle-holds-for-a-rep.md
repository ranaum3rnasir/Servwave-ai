# Slice 5 — The whole booking lifecycle holds for a rep on their own lead

**Type:** AFK.
**Blocked by:** [Slice 4](04-form-seeds-the-rep-and-states-the-rule.md).
**Covers user stories:** 6, 7, 8, 9, 10, 11, 12, 17, 18, 34, 35.

## Parent

[00-prd.md](00-prd.md) — *Scoped assignee pool: a salesperson can schedule their own walkthrough.*

## What to build

Coverage for the claim the rest of the PRD rests on: that row scoping is **already** correct, and
that opening the performer pool is therefore the only change needed for a rep to own a walkthrough
end to end.

That claim is true on inspection — every walkthrough door already runs the canonical per-instance
access check, and the sales scheduling and performing grants are already conditioned on the lead's
assignee set with no status filter, which is exactly Ran's ruling. It is not yet true in executable
form. This slice makes it so, and fixes or refiles whatever the coverage turns up.

Deliberately last: run against the finished behaviour, this is a regression sweep. Run earlier, it
would be asserting against a moving target.

## Acceptance criteria

The rep's own lifecycle, as an assigned salesperson:

- [ ] Reschedule a walkthrough they booked, without re-picking performers.
- [ ] Book a second visit on the same lead, with identical behaviour to the first — the
      additional-visit door does not diverge.
- [ ] Unschedule and cancel walkthroughs on their own leads: they own the whole lifecycle, not just
      its start.
- [ ] Keep booking walkthroughs on a lead **after** it has been closed or marked lost. Authority
      survives the lead closing; the existing conditions carry no status filter, so this should pass
      unchanged — assert it so a future condition change cannot quietly remove it.

Behaviour that must be identical to a dispatcher's:

- [ ] The double-booking conflict warning still fires when the rep is already busy at that time.
- [ ] The rep can override that warning and book anyway, keeping the judgement call dispatchers have.
- [ ] The customer notification goes out exactly as it does when a dispatcher books — the customer's
      experience does not depend on who scheduled it.
- [ ] Internal notices fire as they do today.

Nothing else moved:

- [ ] A dispatcher can still book walkthroughs on leads they are **not** assigned to — covering for
      a rep still works.
- [ ] An admin's access is unchanged end to end; this was not a migration anyone had to supervise.
- [ ] The job crew picker behaves exactly as it does today for dispatchers and technicians.

## Notes

Conflict detection, customer email and notification behaviour are **out of scope to change**. This
slice asserts they are untouched. If any of them turns out to already be broken for a rep, fix it
only if it is a consequence of this build; otherwise refile it, since it is a pre-existing defect
this work merely surfaced.
