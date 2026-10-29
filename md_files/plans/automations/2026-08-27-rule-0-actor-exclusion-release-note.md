# Release note - the Automation Center stops emailing you about your own action

Spec A, slice 2. Ships with the branch `feat/notification-ground-rules`.

## What changed

**Rule 0: never tell someone about their own action.** The bell has always dropped the
acting user; the Automation Center never did. `AutomationEvent.actorId` was declared and
populated at all 38 staff/webhook dispatch sites, and read by nothing - so approving your
own estimate emailed you that your estimate had been approved.

The acting user is now dropped from every audience that resolves to people, at the one
function that turns an audience key into concrete recipients. That covers every action
type (email and text), all 29 triggers, all four entities, and both enrollment paths,
with no per-trigger code. When this slice landed there was a third action type, in-app;
slice 4 deleted its executor and slice 5 narrowed the served `ACTIONS` catalogue to
`SEND_EMAIL` and `SEND_SMS`, so email and text are now the whole set (docs/adr/0005).

The acting user rides the enrollment's `event_payload` JSON, which is re-read on every
step, so the exclusion still holds when the send sits behind a WAIT of days.

## Behaviour changes an admin will notice

Nine of the eleven audiences resolve to user rows and are affected: `assigned_team`,
`dispatcher`, `salesperson`, `creator`, `all_admins`, `all_dispatchers`, `specific_user`,
`removed_user`, `assigned_user`. The `customer` and `custom` audiences resolve to raw
addresses and are unchanged.

Eight of the thirteen seeded defaults - all of them shipped enabled - can now resolve to
nobody where they previously resolved to the person who acted:

| builtin_key | audiences | who stops being emailed |
|---|---|---|
| `default-estimate-approved-notify-creator` | `creator` | approving an estimate you created |
| `default-estimate-declined-notify-creator` | `creator` | declining an estimate you created |
| `default-tech-assigned` | `assigned_user` | a technician who assigns themselves |
| `default-tech-unassigned` | `removed_user` | a technician who removes themselves |
| `default-walkthrough-performer-assigned` | `assigned_user` | a performer who assigns themselves |
| `default-walkthrough-performer-removed` | `removed_user` | a performer who removes themselves |
| `default-walkthrough-completed` | `customer`, `salesperson` | the salesperson who completed their own walkthrough (the customer is still emailed) |
| `default-walkthrough-cancelled` | `customer`, `assigned_team`, `salesperson` | the salesperson or crew member who cancelled it (the customer is still emailed) |

The five customer-only defaults are unaffected: `default-job-scheduled`,
`default-job-rescheduled`, `default-job-en-route`, `default-walkthrough-scheduled`,
`default-walkthrough-rescheduled`.

Two cases worth naming outright, because they are the first thing that gets reported:

- **Self-assignment.** `TECH_ASSIGNED` dispatches once per newly-added person, with the
  occurrence key set to that person's user id. A technician who adds themselves to a job
  empties the audience completely, so the step run records **SKIPPED** with a plain-English
  reason rather than sending. Someone else assigning that technician still emails them.
- **Single-admin organisations.** Every workflow targeting `all_admins` (or
  `all_dispatchers`) stops emailing that one person whenever they are the one who acted.
  In a two-admin org the other admin is still emailed.

Nothing fails. An audience emptied by the exclusion returns the plain-English reason
*"The only person to notify is the one who triggered this"*, which renders in the
Activity tab beside the eleven reasons already there. An audience that was already empty
for its own reason keeps that reason - an unassigned job still says nobody is assigned.

## What is deliberately unaffected

- **Time-driven automations.** Both cron enrollment paths create enrollments with no event
  payload, so a swept enrollment has no acting user and the filter is a no-op. Overdue-invoice
  reminders still reach the commission owner.
- **Stripe webhooks and the public estimate/invoice doors**, which pass a null actor on
  purpose. They send to their full audience.
- **The Test dialog's "send to me" receipt** (`workflow.controller.ts`). It resolves its
  recipient from a pre-built id list and never reaches the audience resolver, so testing a
  workflow still sends you the test.

## Deploy-window gap

The acting user is written to `workflow_enrollments.event_payload` once, at enrollment.
Any enrollment **already parked on a WAIT at deploy time** has no actor in that JSON,
resumes with a null actor, and still emails the person who acted. The gap lasts exactly as
long as the longest configured WAIT and then closes on its own. It is not a rollback
hazard - an unknown JSON key is ignored by the loader in both directions - but the WAIT
guarantee is about enrollments created after this deploys.

## Why there is no exception vocabulary here

The bell gets a `self` family and a named exception string; the audience resolver gets an
unconditional filter and no way to opt out. That asymmetry is a decision, not an oversight:
audience keys are configured by admins, not classified by developers, so an exception
string would have nowhere to live and no reviewer. The one deliberate notify-yourself path
in the product does not pass through this resolver. ADR 0005, added later in this same
branch, restates this.
