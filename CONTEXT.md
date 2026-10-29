# ServWave

ServWave is an AI-first field-service CRM. This file is a glossary of domain terms whose
meaning is not obvious from the code alone, or that have been a source of confusion in prior
discussion - no implementation detail, no task status (those live in CLAUDE.md,
docs/architecture-reference.md, and md_files/).

## Language

**Run** (of a `Workflow`):
One enrollment completing its walk through a workflow's steps, from trigger to a terminal
state. Counted by `trigger_count`, incremented once per enrollment at creation time -
regardless of whether any step later sends anything.
_Avoid_: "Send", "fire", "trigger" as a noun for this count.

**Send** (of a workflow step):
One `SEND_EMAIL` / `SEND_TEXT` step's delivery outcome, recorded as `WorkflowStepRun.status`:
`SENT`, `SKIPPED` (suppressed before delivery - kill switch, missing provider key, nobody left
to send to, or a step type this build no longer sends), or `FAILED` (provider rejected it).
Those two are the only step kinds that send: `WAIT` and `STOP_IF` never did, and the retired
in-app step is not a third sender but a case of "suppressed before delivery" - storage still
holds rows naming it, and they record a `SKIPPED` send rather than reaching the bell. A run and
its steps' sends are counted separately - a run can complete with every send skipped, and that
is not a run failure.
_Avoid_: Using "sent" to describe a run, or "ran" to describe a step outcome. Also avoid naming
the retired in-app step as a way to notify anyone: the bell is hardcoded and the Automation
Center owns email and text (docs/adr/0005).

**Gate at the point of effect**:
The principle that anything able to act without a human in the loop - pollers, webhooks,
background jobs, event dispatch - needs its own entitlement/authorization check inline in the
execution path, because request-path gates (nav, route, API) only stop a person from initiating
a request and are never reached by autonomous execution. "Point of effect" is the last place
before the side effect happens (an email sent, a record written), not the first place a request
could have been blocked.
_Avoid_: Assuming a route-level `requireFeature` check covers a poller or event-dispatch path
that never issues that request.

**Participant** (of a Calendar Entry):
A person an event concerns - a user or a customer, in one list - recorded so they can see the
event and, if the creator ticks the box, be emailed about it. Optional: an entry with no
participants at all is normal ("Dave is off" names Dave in its title and attaches nobody), and
the person who created an entry is not a participant by virtue of having created it. A
participant is not working the event and is not being asked a question: there is no
accept/decline, so the list never changes state. Attaching a person to an event therefore says
nothing about their availability - the board will still schedule real work over them at that
hour, deliberately.
_Avoid_: "Attachment", which in ServWave is a file (`Attachment`, `AttachmentEntity`) and nothing
else. Also "invitee" (implies an RSVP that does not exist), "crew"/"performer" (people doing the
work - a participant never is), "assignee" (`JobAssignee`/`LeadAssignee`, again work), and
"watcher" (`Task.watcher_ids`, a different follow relation on a different entity).

**Calendar Entry** (user-facing: **Event**):
Something on the scheduler that is not the work itself - a meeting, a reminder, a birthday, a day
off. It is anchored to nothing by default: no lead, no job, no estimate, and it produces no
revenue and no pipeline movement. Users are shown the word "Event"; the model, the board type and
the API say `CalendarEntry`, because "event" is already spoken for four times over in this
codebase.
_Avoid_: Bare "Event" in code or in schema discussion. `TimelineEvent` is an audit-trail row,
`StripeEvent`/`CtmEvent`/`AssetEvent` are webhook payloads, and the scheduler's own
`SchedulableEvent`/`BoardEvent`/`EventType` already mean "any card on the board" - a job is an
event by that definition. Also avoid "appointment", which does not describe a birthday or a day
off.

**Notification family** (of an in-app verb):
Who a bell notification is for, and why - one of three, declared per verb in `VERB_RULES`
(`backend/src/services/notifications/templates.ts`). **Involvement**: you are attached to the
record - assignee, watcher, owner, performer, participant, thread holder. **Duty**: acting on it
is your job, by role - dispatcher, admin, the rep who carries the customer; nobody had to attach
you. **Self**: it is about your own account, or you asked for it. One family per verb is lossy on
purpose: several verbs reach an attached person and role holders both, and the family names the
audience the verb exists to reach, with an `exception` string recording any caveat. A second,
orthogonal axis states timing: `event` (emitted at a call site, carrying an actor when a
signed-in person caused it and null when a webhook, a public door or a system detector did) or
`time` (emitted by a sweep, structurally never carrying one). Timing is an axis rather than a
fourth family because arriving via cron changed nothing about *who* was told - a "reminder"
family would be answering a different question from the other three.
_Avoid_: "notification type" and "category" (`NotificationCategory` is a different, existing enum
that drives UI grouping), and "priority" (`INTERRUPT`/`FEED` selects a delivery route, not an
audience).

**Rule 0** (of notifications):
Never tell someone about their own action. Its scope is both channels - the hardcoded bell and
the Automation Center that owns email and text - and each enforces it exactly once: the bell in
`dedupe()` (`backend/src/services/notifications/resolveRecipients.ts`), the engine in
`dropActingUser`, wrapped around `resolveAudience`
(`backend/src/services/automations/recipients.ts`). The rule reads "drop the actor when there
is one", so it is vacuous rather than special-cased wherever there is no actor: every `time`
verb, and every `event` path whose cause was a webhook, a public door or a system detector. The
`self` family is the single named exception, and it is a mechanism rather than a convention: a
`security.*` alert must reach the account holder even when they appear to be the actor, because
an attacker holding their session is exactly the case the alert exists for.
_Avoid_: "self-notification suppression" (it names the mechanism, not the rule, and reads as if
`self` were the thing being suppressed). Also avoid calling a deviation "an exception" as though
that were a category: an exception is a justification string on one verb's rule, and a rule
carrying an empty one is a bug.
