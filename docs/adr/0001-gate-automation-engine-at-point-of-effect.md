# Gate the automation engine at the point of effect, not only at the request layer

**Status:** accepted

The Automation Center is gated by `feature: 'automations'` at every point a human touches it -
the nav row, the direct route, and the `/api/workflows*` API - but the engine that actually
sends (`enrollOnEvent -> executeAction -> sendAutomationEmail`) is reached from a business event
via `dispatchAutomationEvent` and the minute poller, never from a request, so none of those
request-path gates apply to it. Seeding the 13 default automations into every org on prod
promotion would give a Starter org (which hasn't paid for `automations`) 13 enabled workflows
emailing its customers, while its own admins are 403'd out of the screen that could disable
them - and the same gap lets a PRO org keep firing after a downgrade to Starter.

We considered gating only at seed time (never create the rows for an unentitled org) and
decided that alone was insufficient: it does nothing for plan downgrade or a manually-created
workflow on an org that later loses entitlement. We chose to gate both - `enrollOnEvent` checks
the org's `automations` entitlement and fails closed, and the seeder additionally filters to
entitled orgs so the rows never exist in the first place for a Starter org. The engine check is
the one that must never be removed even if the seeder filter is; it is the only layer that
survives every future dispatch site, plan change, or hand-built workflow.

See [[CONTEXT.md#gate-at-the-point-of-effect]] and
`md_files/plans/automations/2026-07-30-task-76-automations-prod-readiness.md` for the full
review this decision came out of.
