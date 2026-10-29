# In-app notifications - scenario reference

**What this is:** the maintained catalogue of every in-app notification ServWave can raise - what
triggers it, which family it belongs to, who receives it, and how loud it is. Every row below was
read from the code, not from memory:

- Catalogue, copy and classification: `backend/src/services/notifications/templates.ts`
  (the template registry, then `VERB_RULES` beside it)
- Who gets what: `backend/src/services/notifications/resolveRecipients.ts`
- Triggers: the `emit({ verb: ... })` call sites across the controllers, plus the cron sweeps
- Access filter: `backend/src/services/notifications/filterByAccess.ts`
- Delivery: `backend/src/services/notifications/realtimePublish.ts`

> **Scope note.** This covers in-app notifications only: the bell and its needs-action pins. It is
> a separate channel from the customer-facing emails (estimate sent, invoice sent, receipts via
> Resend) and from SMS, both of which the Automation Center owns. See
> `docs/adr/0005-the-bell-is-hardcoded-the-automation-center-owns-email-and-text.md`.
>
> **Who this document is for.** Support and engineering, not admins. There is deliberately no
> user-facing catalogue in the product: 61 unexplained rows in a settings screen answers a
> different question from the one admins actually ask. What an admin gets is an answer from a
> support engineer, and this reference plus the three families is what makes that answer one
> sentence long ("that one is a `duty` notification, so it went to dispatchers by role, and you
> are not one") rather than a walk through the recipient resolver.
>
> `VERB_RULES` in `templates.ts` is authoritative for family and timing. If this table and that
> map ever disagree, the map is right and this file is stale - fix it here. Those two axes are
> the whole of what it is authoritative for: which systems may write to the bell at all is ADR
> 0005's question, and neither that map nor this table settles it independently.

---

## 1. How a notification is born

Every in-app notification takes the same single path. Understanding it explains why, for example,
a technician sometimes does not get a notification even though the rule lists their role.

```
something happens in a controller, a webhook, or a cron sweep
        |
        v
  emit({ verb, object, entity, data, actorId })          notificationService.ts
        |
        +- renderTemplate(verb)      -> title/body/category/priority/action    templates.ts
        +- resolveRecipients(verb)   -> list of (userId, priority, needs_action) resolveRecipients.ts
        +- filterByAccess(...)       -> drop anyone who cannot actually see the row filterByAccess.ts
        +- dedupe                    -> one row per user; INTERRUPT wins; drop the actor (Rule 0)
        +- persist                   -> one Notification row plus one recipient row each
        +- realtimePublish           -> ping each recipient's private channel
```

**`emit()` is the only way into the bell.** There is one path, not two. The Automation Center
owns email and text and no longer offers an in-app step, so a workflow *run* does not reach this
pipeline - and not only because no admin can author one: the run path skips a step type it cannot
run before dispatch, so a version published before the retirement is skipped rather than sent.

The Automation Center keeps exactly **one door** into this pipeline, stated here so nobody has to
discover it by grepping: pressing **Test** in the workflow builder with "send to me" ticked emits
`automation.message` to the person who pressed it
(`backend/src/controllers/workflow.controller.ts:766`). That is a receipt the actor asked for,
delivered synchronously to one person, not a workflow run notifying anybody. It is classified
`self` for that reason. One door is the whole count, and it is asserted rather than remembered -
`backend/src/services/automations/__tests__/retired-in-app-step-references.test.ts` fails if a
second emit site of that verb appears. ADR 0005 is where that ownership is decided; `VERB_RULES`
names the same door and defers there too, so all three tell one story.

### The three families, and the timing axis

Every verb declares a **family**, which answers *who this is for and why*:

| Family | What it means | Typical shape |
|---|---|---|
| `involvement` | You are attached to the record - assignee, watcher, owner, performer, participant, thread holder. | Somebody put you on this, or you own it. |
| `duty` | Acting on it is your job, by role - dispatcher, admin, the rep who carries the customer. Nobody had to attach you. | You would get it on a record you had never seen. |
| `self` | It is about your own account, or you asked for it. | Security alerts; the Test receipt. |

One family per verb is lossy on purpose. Several verbs reach an attached person *and* role
holders: most of billing reaches admins and the customer's rep, `inventory.staging_ready`
interrupts the assigned tech on top of the stockroom. The family names the audience the verb
exists to reach; anyone receiving it for awareness alone does not change it. Where that judgement
is close, the rule in `VERB_RULES` carries an `exception` string recording the caveat, and the
Family column below is marked with a dagger.

A second, orthogonal axis states **timing**:

- `event` - emitted at a call site. It carries an actor when a signed-in person caused it, and
  null when a webhook, a public door or a system detector did. Both are normal, and the same verb
  can do both: `estimate.approved` is actor-bearing from the staff door and actorless from the
  Stripe webhook.
- `time` - emitted by a sweep. Structurally never carries an actor.

Timing is deliberately not a fourth family. Arriving by cron changed nothing about *who* was
told, so a "reminder" family would be answering a different question from the other three.

### Four rules that shape every row below

1. **Never tell someone about their own action - Rule 0.** The rule reads *drop the actor when
   there is one*, which is why it needs no branch: it is vacuous for every `time` verb and for
   every `event` path whose cause was a webhook, a public door or a system detector, exactly as
   it is for a staff action. (A dispatcher who assigns a job to a tech does not get "job
   assigned"; the tech does.)
   **The `self` family is the single named exception.** A `self` verb reaches its recipient even
   when they appear to be the actor, and this is a mechanism rather than a convention: the
   resolver reads the family and passes a null actor. A password change made by an attacker
   holding your session looks exactly like one you made yourself, and that is precisely the alert
   that must not be silenced by the session that triggered it.
2. **Access is re-checked per recipient, fail-closed.** For object types `LEAD / ESTIMATE / JOB /
   INVOICE`, each candidate must pass the same CASL row-scope check used everywhere else. If a
   sales rep would not be allowed to open that lead, they do not get its notification even if a
   rule names them. Anyone the check cannot resolve is dropped, not included. `TASK`,
   `LOGISTIC_ORDER` and `AUTOMATION` are deliberately absent from the scope map, because every
   recipient of those verbs is already someone the record itself names.
3. **Priority and the pin are per-recipient.** The same event can be an `INTERRUPT` for one person
   and a passive `FEED` item for another - an approved estimate interrupts the sales owner but
   only feeds the dispatcher's list beside a "schedule job" pin.
4. **De-dup merges.** If someone qualifies twice (both admin and lead owner), they get one row:
   `INTERRUPT` beats `FEED`, and the pin flag is ORed.

### Priority and action vocabulary

| Concept | Values | Meaning |
|---|---|---|
| **Priority** | `INTERRUPT` / `FEED` | Selects a delivery route, not an appearance: `INTERRUPT` raises a toast, `FEED` is a passive activity-feed entry. |
| **PIN** (`needs_action`) | true / false | true means an actionable pin that stays open until resolved (`acted_at` is set). Read from the **recipient** row, not from the template. |
| **action_type** | `SCHEDULE_JOB`, `SEND_REMINDER`, `VIEW`, `APPROVE_OT`, `APPROVE_STOCK` | The CTA on a pinned row. |

### A word on roles

The recipient rules reference **role groups** (all active admins, all dispatchers) and **named
people on the record** (the lead's owner, a job's assignees, the customer's owner). Two things
worth knowing:

- **SALES is never notified as a group.** Sales reps only ever receive a notification because they
  own the specific lead or estimate (`commission_owner_id`), never as a blanket broadcast. That is
  the `involvement` family doing its job.
- **Technicians are only notified as named assignees** of a job, as walkthrough performers, or as
  people named on a task - never as a group.

---

## 2. Master matrix - every verb

61 verbs, the same 61 that `VERB_RULES` classifies. Priority markers: **I** = INTERRUPT,
**F** = FEED, **PIN** = needs-action pin with its CTA in brackets. A dagger on the family means the
rule carries an `exception` string in `VERB_RULES` - read it there before re-classifying the verb.

### Leads

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `lead.assigned` | involvement | event | A lead is assigned or re-assigned to an owner | The new owner **I** |
| `lead.unassigned_created` | duty | event | A new lead is created with no owner | All admins **F** - all dispatchers **F** |
| `lead.reassigned_away` | involvement | event | A lead's owner changes | The previous owner **F** |
| `lead.walkthrough_scheduled` | involvement † | event | A site walkthrough is booked on a lead | Performers **I** - the lead owner **F** - all dispatchers **F** |

### Estimates

Every estimate verb reaches the commission owner, who is attached to the record; the admin feed is
awareness. Two verbs add a real dispatch duty, and say so.

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `estimate.approved` | involvement † | event | Customer approves, from the public door, the staff door, or the Stripe webhook | Lead owner **I** - all dispatchers **F PIN** [Schedule job] - all admins **F** |
| `estimate.deposit_paid` | involvement † | event | Deposit recorded on the estimate, or paid via Stripe | Lead owner **I** - all dispatchers **F PIN** [Schedule job] - all admins **F** |
| `estimate.declined` | involvement | event | Customer declines the estimate | Lead owner **I** - all admins **F** |
| `estimate.cancelled` | involvement | event | Estimate is archived internally | Lead owner **F** - all admins **F** |
| `estimate.deposit_waived` | involvement | event | A required deposit is waived | Lead owner **F** - all admins **F** |
| `estimate.approval_voided` | involvement | event | A recorded approval is unwound | Lead owner **F** - all admins **F** |
| `estimate.status_corrected` | involvement | event | An estimate's status is corrected by hand | Lead owner **F** - all admins **F** |

> The **Schedule job** pin on the dispatcher is the path validated end to end: approving or
> depositing an estimate pins every dispatcher, clicking it deep-links to the lead and opens
> "Create job", and creating the job resolves the pin.

### Dispatch (job assignment and scheduling)

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `dispatch.job_assigned` | involvement | event | A tech or crew is added to a job | The assignees **I** - all dispatchers **F** |
| `dispatch.job_unassigned` | involvement | event | A tech or crew is removed from a job | The removed assignees **I** - all dispatchers **F** |
| `dispatch.job_rescheduled` | involvement | event | A job's schedule time changes | The assignees **I** - all dispatchers **F** |
| `dispatch.job_created` | duty † | event | A job is created directly from a customer, with no estimate | All dispatchers **I** - all admins **F** - assignees **I** (usually none yet) |

> A job created by converting an estimate raises no "job created" notification. The precursor
> (estimate approved or deposit paid) already pinned the dispatcher with "schedule job", and
> creating the job is what resolves that pin. Only directly created jobs announce themselves.

### Job lifecycle

`duty` is the classification worth reading twice here. The assignees and the selling rep are
attached and do receive these, but the constant across all four verbs is the dispatcher, whose
board these events exist to keep true. That is the declared difference from `task.*`: a job
carries a dispatch duty, a task does not.

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `job.started` | duty | event | Tech marks the job in progress | All dispatchers **F** - sold-by rep **F** - assignees **F** |
| `job.completed` | duty | event | Job marked complete | All dispatchers **F** - sold-by rep **F** - assignees **F** |
| `job.cancelled` | duty | event | Job cancelled | Assignees **I** - all dispatchers **F** - sold-by rep **F** |
| `job.reopened` | duty | event | A completed job is reopened | All dispatchers **F** - assignees **F** |

### Tasks

Pure attachment: assignees, watchers, and the deltas of those two lists. No role is consulted for
any task verb, which is what makes the family unambiguous. The actor falls out at `dedupe()`, so
completing a task you were alone on notifies nobody and writes no row.

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `task.assigned` | involvement | event | Assignees are added to a task | Only the newly added assignees **F** |
| `task.watching` | involvement | event | Watchers are added to a task | Only the newly added watchers **F** |
| `task.completed` | involvement | event | A task is completed | Assignees and watchers after the update **F** |
| `task.cancelled` | involvement | event | A task is cancelled | Assignees and watchers after the update **F** |
| `task.removed` | involvement | event | People are taken off a task | The removed people, from either list **F** |
| `task.deleted` | involvement | event | A task is destroyed | Everyone on it at the moment of deletion **F** |

### Calendar entries (user-facing: Events)

Participants only, never a role - an event concerns the people attached to it. Never `INTERRUPT`,
because an entry is not a request for action.

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `calendar_entry.scheduled` | involvement | event | An entry naming you is created | User participants **F** |
| `calendar_entry.moved` | involvement | event | An entry naming you is moved | User participants **F** |
| `calendar_entry.cancelled` | involvement | event | An entry naming you is cancelled | User participants **F** |

### Billing and invoices

Money is the books' business. Even where the customer's rep is a recipient, they are there because
collecting is their job, not because they are attached to the invoice.

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `billing.payment_received` | duty | event | A payment brings an invoice to fully paid | All admins **F** - all dispatchers **F** - the customer's owner **F** |
| `billing.partial_payment` | duty | event | A payment leaves a balance | All admins **F** - all dispatchers **F** - the customer's owner **F** |
| `billing.invoice_overdue` | duty | **time** | Daily sweep: the due date has passed (SENT/PARTIAL) | All admins **F PIN** [Send reminder] - the customer's owner **F PIN** |
| `billing.invoice_due_soon` | duty | **time** | Daily sweep: due within 3 days | All admins **F PIN** [Send reminder] - the customer's owner **F PIN** |
| `billing.refunded` | duty | event | A refund is recorded | All admins **I** |
| `billing.disputed` | duty † | event | Stripe dispute webhook | All admins **I** |
| `billing.chargeback` | duty † | event | Stripe dispute-closed webhook | All admins **I** |
| `billing.voided` | duty | event | An invoice is voided | All admins **F** |
| `billing.credit_applied` | duty | event | A credit is applied to an invoice | All admins **F** |
| `billing.payments_activated` | duty † | event | Stripe `account.updated`: card payments go live | All admins **F** |
| `billing.payouts_activated` | duty † | event | Stripe `account.updated`: payouts go live | All admins **F** |
| `billing.payments_action_needed` | duty † | event | Stripe `account.updated`: requirements outstanding | All admins **I PIN** [View] |
| `billing.payments_paused` | duty † | event | Stripe `account.updated`: charges disabled | All admins **I PIN** [View] |
| `billing.payouts_pending_first_payment` | duty † | event | Stripe payment webhook: payouts held pending the first payment | All admins **F** |
| `billing.platform_fee_rate_changed` | duty † | event | A within-ceiling platform fee rate change | All admins **F** |

> **Refund, dispute and chargeback are loud but not pinned.** Their templates name a `VIEW` CTA
> and set the template-level `needs_action`, but `resolveRecipients` gives the admin row
> `needs_action: false`, and the pin count reads the recipient row
> (`notification.controller.ts:135`). So they interrupt, and they do not sit in "Needs action"
> until cleared. If that is not what the product wants, the fix is in `resolveRecipients`, not
> here.

### Team

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `team.ot_override_requested` | duty | event | A tech requests an overtime or geofence override | All admins **I PIN** [Approve OT] |
| `team.invite_accepted` | duty | event | An invited user accepts and logs in for the first time | All admins **F** |

### Inventory

Stock is the stockroom's to keep straight, so every inventory verb is a role's job.

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `inventory.stock_approval_requested` | duty | event | A stock adjustment needs sign-off | All admins **I PIN** [Approve stock] |
| `inventory.low_stock` | duty † | event | An item drops below its reorder threshold (system detector, no actor) | All admins **F** - all dispatchers **F** |
| `inventory.backorder` | duty | event | An item flips to backordered | All admins **F** - all dispatchers **F** |
| `inventory.staging_ready` | duty † | event | Parts for a job are staged | All admins **F** - all dispatchers **F** - the assigned techs **I** |
| `inventory.staging_no_area` | duty | event | Parts cannot be staged, no area | All admins **F** - all dispatchers **F** |
| `inventory.po_partial` | duty | event | A purchase order is partially received | All admins **F** - all dispatchers **F** |

### Logistic orders

The two halves split cleanly: approving is a granted job, being told your own order cleared is an
attachment.

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `lo.submitted` | duty | event | A logistic order is submitted for approval | Approve-grant holders **I PIN** [View] - all admins **I PIN** [View] |
| `lo.approved` | involvement | event | A logistic order is approved | The creator **I** (on self-approve, Rule 0 drops them and no row is written) |

### Security - the `self` family

These reach the account holder **even when they appear to be the actor**. That is the one named
exception to Rule 0, and it is enforced in the resolver rather than left to the emit sites.

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `security.new_signin` | self † | event | A login on the account | The account holder **F** |
| `security.password_changed` | self † | event | The password is changed | The account holder **F** |
| `security.mfa_enabled` | self † | event | MFA is turned on | The account holder **F** |
| `security.mfa_disabled` | self † | event | MFA is turned off | The account holder **F** |

### Communication (CTM phone, SMS, inbound email)

Org-wide phone coverage. All three are webhook-driven, so no actor is ever carried and Rule 0 is
vacuous. There is deliberately no `call_incoming` verb: an inbound call rings the cell, not the app.

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `communication.call_missed` | duty † | event | CTM reports a missed call or voicemail | All dispatchers **I PIN** [View] - all admins **I PIN** [View] |
| `communication.sms_inbound` | duty † | event | An inbound SMS arrives | All dispatchers **F** - all admins **F** |
| `communication.email_inbound` | involvement † | event | A reply lands on an email thread | The thread holder **I**; if the thread is unowned, all dispatchers **F** and all admins **F** instead |

### Automation Center

| Verb | Family | Timing | When it fires | Who gets notified |
|---|---|---|---|---|
| `automation.message` | self † | event | The Test dialog's "send to me" receipt | Only the person who pressed Test **I** |

> This is the one place the Automation Center writes to the bell, and the reason the ADR carves it
> out by name rather than claiming the Automation Center never does. It is `self` because the sole
> recipient asked for the receipt - the same shape as `security.*`, where the recipient must be
> told regardless of who appears to have acted. Recipients arrive pre-resolved in
> `entity.recipient_ids`, which is why it is neither `involvement` (nothing is attached) nor
> `duty` (no role is consulted).

---

## 3. "What lands in my bell?" - by role

A quick inversion of the matrix, with the family that explains each group.

- **Admin** - the org's catch-all, almost entirely `duty`. Money events (payments, refunds,
  disputes, chargebacks, voids, credits, the Stripe account lifecycle, overdue and due-soon pins),
  approvals (OT, stock, logistic orders), team growth, inventory health, and a feed copy of most
  lead and estimate activity. Does **not** get routine job assignment or lifecycle noise.
- **Dispatcher** - the operations hub, also `duty`. The schedule-job pins, every job assignment,
  unassignment and reschedule, directly created jobs, job lifecycle, new and unassigned leads,
  payments, inventory, and inbound phone and SMS.
- **Sales rep** - almost entirely `involvement`: only their **own** leads and estimates (assigned,
  reassigned away, approved, declined, deposit paid, cancelled, waived), plus payments and overdue
  pins on customers they own, which reach them as `duty`.
- **Technician** - `involvement`: only jobs they are on (assigned, unassigned, rescheduled,
  cancelled, lifecycle feed items), walkthroughs they perform, tasks that name them, staged parts
  for their job, and calendar entries naming them. Plus their own `self` security events.

**Diagnosing a missing notification** is therefore three questions, in order. What family is the
verb (`VERB_RULES`)? If `duty`, does this person hold the role? If `involvement`, are they actually
attached to the record - and was the list they are on the *delta* rather than the whole roster
(`task.assigned` notifies only the people just added)? If the family fits and they still got
nothing: were they the actor (Rule 0), or did the row-scope filter drop them (rule 2 above)?

---

## 4. Known gaps and deferred items

- **Deposit paid via the invoice door** (GitHub issue **#268**, accepted-minor): paying a
  `kind=DEPOSIT` invoice to full through the *invoice* record-payment screen emits only
  `billing.payment_received`, not `estimate.deposit_paid`, so it skips the dispatcher's schedule-job
  pin. The estimate page and the Stripe webhook both fire it correctly. Low impact, because the
  estimate-scoped dedup hides it whenever a deposit was ever paid once through another door.
- **Deferred verbs, registered nowhere:** `estimate.viewed`, `service_plan.*`, the delivery-failure
  verbs (`*.delivery_failed`), `billing.payment_failed`, and `task.due_soon` / `task.overdue`. The
  task reminders need a cron sweep that does not exist. Because they are not in the registry they
  are not in `VERB_RULES` either, which is the point: a verb cannot be classified without being
  registered, and cannot be registered without being classified.
- **No per-user preferences and no user-facing catalogue.** Both were considered and rejected in
  ADR 0005; see the scope note at the top for what ships instead.

---

## 5. Validation status

The estimate to schedule-job to create-job path (the dispatcher pin and its resolution) was
exercised end to end in the live Playwright QA run (44-case plan, 42 pass / 2 not applicable / 0
fail). Two bugs found there are fixed (a frontend button leak and a backend convert-authz PII
leak); the only open follow-up is the #268 invoice-door deposit gap above. The remaining verbs are
covered by the backend unit suites (`*-notifications.test.ts` and
`src/services/notifications/__tests__/`) but were not all walked through the browser.

The classification itself is covered differently, and deliberately so: exhaustiveness is enforced
by the compiler rather than by a test, and the tests assert behaviour driven by the map (a
`security.*` verb reaches its owner with that owner seated as the actor; every non-`self` verb
drops the actor) rather than the literal contents of the map. See
`md_files/plans/notifications/qa-checklist.md` for the manual pass.
