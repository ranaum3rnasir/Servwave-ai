# Slice 10 - Automation conditions and templates

**Parent:** SRVW-115 · **Type:** AFK · **Blocked by:** Slice 9
**Not approved to start.**

## What to build

Two SRVW-115 criteria, both landing in the Automation Center:

1. **Conditions** - an automation rule can branch on a custom-field value. "If the job's Access Type
   is Gated, send the code to the assigned tech." Conditions are typed per definition, reusing the
   comparison semantics slice 7 built for filters rather than inventing a second set.
2. **Templates** - the same merge tokens slice 9 built, usable in automation message bodies. Blocked
   on slice 9 precisely so there is one token resolver, not two.

**The trap this repo has already been bitten by:** SRVW-114's neighbours in the Automation Center
showed that autonomous paths bypass request-layer gates - the engine and seeder ran without checking
the `automations` entitlement, because they never pass through a controller. The automation engine
evaluating a custom-field condition runs outside the request layer too. It has no `req`, so it has no
`tenantWhere`. Org scoping has to be explicit in the engine's own queries, and it needs a test that
proves one org's automation cannot read another org's values.

## Acceptance criteria

- [ ] Automation conditions can reference custom-field values, typed per definition, using slice 7's comparison semantics
- [ ] Custom-field merge tokens resolve in automation message bodies, through slice 9's resolver
- [ ] The engine's evaluation is explicitly org-scoped, with a test proving cross-org isolation in the autonomous path
- [ ] A condition on an archived or deleted-scope definition fails safe: the rule does not fire on a wrong match
- [ ] A missing value evaluates predictably and is documented, rather than throwing mid-run
- [ ] Existing automations are unaffected, proven by the current automation suite staying green
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Blocked by

- Slice 9 (one token resolver, shared)
