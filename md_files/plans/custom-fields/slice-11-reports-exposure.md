# Slice 11 - Custom fields exposed to reports

**Parent:** SRVW-115 · **Type:** HITL · **Blocked by:** Slice 7
**Not approved to start.** Needs a scoping decision from Ran before any code.

## Why this is HITL

"Exposed to reports" is the vaguest line in SRVW-115, and it sits next to a decision already taken:
SRVW-179 declined the custom report builder on the reasoning that six real reports beat a builder
nobody configures. Custom fields in reports drifts toward that declined builder unless it is scoped
tightly and deliberately.

## The decision Ran owns

**Option A - group and filter existing reports by custom-field values.** Narrowest. Existing reports
gain custom-field values as a filter and grouping dimension. No new report surfaces.

**Option B - custom-field columns in report exports.** Values ride along in CSV and PDF exports of
existing reports, so an org can pivot in a spreadsheet. Cheap, and it sidesteps the builder question
entirely by handing off to a tool orgs already use.

**Option C - both.**

Also to settle: whether custom fields in reports is plan-gated, since the report set already has
per-plan gating open as a separate issue.

## Acceptance criteria

- [ ] Ran picks a scope, and the decision is recorded on SRVW-115 with its reasoning
- [ ] Whatever is built reuses slice 7's typed comparison and cast logic rather than a second implementation
- [ ] Reports stay tenant-scoped, with archived definitions still resolving for historical rows
- [ ] Report performance is checked on realistic row counts, since JSONB extraction in aggregate queries is the obvious regression risk
- [ ] Scope explicitly stops short of a custom report builder, per SRVW-179
- [ ] Backend written test-first; `npx tsc --noEmit` and `npm test --workspace=backend` both clean

## Blocked by

- Slice 7 (typed comparison and cast logic)
- A decision from Ran on the options above
