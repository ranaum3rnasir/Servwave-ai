# Slice 4 — The booking form seeds the rep and states the rule

**Type:** AFK.
**Blocked by:** [Slice 3](03-scoped-roster-endpoint.md) — the hook needs a roster that resolves the rep's own name.
**Covers user stories:** 1, 2, 3, 4, 5, 32.

## Parent

[00-prd.md](00-prd.md) — *Scoped assignee pool: a salesperson can schedule their own walkthrough.*

## What to build

The front end stops offering a choice that does not exist. A self-only user opens the Performers
field and finds their own name already in it, with no way to remove it and no dropdown to add
anyone else, and a line of text saying why.

**A hook mirroring the shipped task-assign one.** Same shape, same reasoning, same warning against
reading the role instead of the ability. It returns whether the user may name others, plus their own
id. Both booking surfaces consume it — the lead's Walkthrough tab and the scheduler board — so the
rule does not change depending on which screen the rep books from.

**Seeding, not defaulting.** A self-only user's performer list is seeded with their own id when the
visit has none, computed from the grant and the session rather than hardcoded, and re-seeded if the
session hydrates after the form mounts.

**No new component.** The multi-assignee picker's existing disabled state already produces exactly
the required behaviour: chips render, remove buttons are suppressed, the combobox will not open.

**The stuck Schedule button needs no separate fix.** It is disabled because the performer list is
empty; seeding it resolves it. There is no second cause — in particular there is no past-date check
anywhere in that condition, and the dates in the original QA screenshots were never a factor.

## Acceptance criteria

- [ ] The hook reads the same grant the server enforces in Slice 2 — the ability, never the role — so
      the form never offers something the API will reject, nor hides something it would accept.
- [ ] On the lead's Walkthrough tab, a self-only user sees their own name pre-filled when the visit
      has no performers yet.
- [ ] Seeding recomputes if the session hydrates after the form has mounted.
- [ ] The self-only user's chip has no remove control.
- [ ] The self-only user gets no add-member trigger.
- [ ] A short helper line under the field states that they can only put themselves on a walkthrough,
      so the missing dropdown reads as a rule and not as a bug.
- [ ] **The Schedule Walkthrough button is enabled once a valid date and time are entered.** This is
      the reported bug; the assertion must fail against today's code.
- [ ] A grant holder sees the full roster and an editable field, exactly as today.
- [ ] The scheduler board's booking surface behaves identically to the Walkthrough tab.
- [ ] Rescheduling an existing walkthrough does not require re-picking performers.
- [ ] Existing visits with multiple performers keep them — this is not a data change.

## Testing

**Component.** Rendering the lead's walkthrough tab as a self-only user: their own name is present,
no remove control, no add-member trigger, the explanatory line is shown, and the Schedule button is
enabled once a valid time is entered. As a grant holder: the roster renders and the field is
editable.

Prior art: the existing task drawer and task dialog suites, which cover this same distinction for
tasks.
