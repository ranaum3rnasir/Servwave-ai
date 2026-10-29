import { describe, it, expect } from 'vitest';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import { validateWorkflowDefinition } from '../workflowValidation';
import { TRIGGERS } from '../catalog';

/** Merge fields referenced in a piece of copy - same regex the validator uses. */
function fieldsIn(text: string): string[] {
  return [...text.matchAll(/\{\{([a-z_.]+)\}\}/g)].map((m) => m[1]);
}

describe('DEFAULT_AUTOMATIONS', () => {
  it('has a unique builtin_key per entry, all prefixed "default-" (distinct from the template_key namespace)', () => {
    const keys = DEFAULT_AUTOMATIONS.map((a) => a.builtin_key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key.startsWith('default-'), `${key} must be prefixed "default-"`).toBe(true);
    }
  });

  it('covers one entry per migratable trigger plus one per task trigger - 18 built-ins, no duplicate trigger_type', () => {
    expect(DEFAULT_AUTOMATIONS).toHaveLength(18);
    const triggers = DEFAULT_AUTOMATIONS.map((a) => a.trigger_type);
    expect(new Set(triggers).size).toBe(triggers.length);
  });

  // A tripwire, not a description. Enabling a default while its hard-coded
  // sender still fires double-emails every customer of every org — the one
  // sequencing mistake in this migration that is customer-visible. Keeping the
  // cut-over set in a test means a key cannot be switched on as a side effect of
  // editing the registry: you have to come here and say so deliberately, in the
  // same change that deletes the sender.
  //
  // Add a key to this list ONLY in the commit that deletes its hard-coded sender.
  // Phase 3 slice 1 = jobs, slice 2 = walkthroughs, slice 3 = estimates.
  //
  // ── THE FIVE TASK KEYS ARE A DELIBERATE DEPARTURE FROM THAT RULE ─────────────
  // Spec B slice 7 added `default-task-*` to this list WITHOUT deleting any
  // hard-coded sender, because there is none to delete. Written here rather than
  // in a commit message so the next person reading a violated tripwire can tell
  // whether it was deliberate.
  //
  // The rule above exists for exactly ONE reason: a default that duplicates a
  // built-in sender still firing double-emails the same person. Tasks have never
  // had a built-in sender - the whole point of Spec B is that a task notifies
  // nobody outside the app today - so there is nothing for these five to
  // duplicate and the double-send failure mode cannot occur.
  //
  // What they ARE is net-new email, which the rule above does not cover and does
  // not protect against. That is a product decision, not a sequencing one, and it
  // was taken explicitly ("ship them on for everyone") against a measured
  // first-sweep blast radius rather than assumed: four of the five are event
  // triggers and send nothing until somebody acts, and the fifth is a
  // before-reminder whose first window is [now, now + 24h], deliberately chosen
  // over an after-chase so a first run against a backlog of overdue tasks cannot
  // produce a flood. See defaultAutomations.ts's task block for the measurement.
  //
  // The rule is NOT suspended for anything else. A key whose built-in sender is
  // still alive still may not appear below.
  it('only entries whose hard-coded sender has been deleted seed enabled (plus the five net-new task defaults - see above)', () => {
    const CUT_OVER: string[] = [
      'default-job-scheduled',
      'default-job-rescheduled',
      'default-tech-assigned',
      'default-tech-unassigned',
      'default-job-en-route',
      'default-walkthrough-scheduled',
      'default-walkthrough-rescheduled',
      'default-walkthrough-performer-assigned',
      'default-walkthrough-performer-removed',
      'default-walkthrough-completed',
      'default-walkthrough-cancelled',
      'default-estimate-approved-notify-creator',
      'default-estimate-declined-notify-creator',
      // Net-new, no sender retired. Reason recorded in full above.
      'default-task-created',
      'default-task-assigned',
      'default-task-comment-added',
      'default-task-deleted',
      'default-task-due-reminder',
    ];

    for (const a of DEFAULT_AUTOMATIONS) {
      expect(
        a.seed_enabled,
        `${a.builtin_key}: seed_enabled must be ${CUT_OVER.includes(a.builtin_key)} — a default may only seed enabled once its hard-coded sender is gone`,
      ).toBe(CUT_OVER.includes(a.builtin_key));
    }
  });

  // The real publish-tier gate — same validator PATCH/publish runs through
  // (workflow.controller.ts), so a green result here is a genuine guarantee
  // this definition is publishable as-is: legal trigger, legal recipients
  // (audiencesFor — trigger-scoped, not just entity-scoped), every
  // {{merge.field}} the copy references actually exists for this trigger.
  it('every entry validates cleanly as a one-step SEND_EMAIL workflow (the exact shape the seeder writes)', () => {
    for (const a of DEFAULT_AUTOMATIONS) {
      const issues = validateWorkflowDefinition({
        trigger_type: a.trigger_type,
        // The registry's own config, not a hardcoded null. Passing null here would have
        // reported the date-anchored task default as valid while the seeder wrote a row the
        // poller then skips - the exact silent failure this suite exists to catch.
        trigger_config: a.trigger_config ?? null,
        send_window: 'ANYTIME',
        steps: [
          {
            position: 0,
            step_type: 'SEND_EMAIL',
            config: { recipients: a.recipients, subject: a.subject, body: a.body },
          },
        ],
      });
      expect(issues, `${a.builtin_key}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('every trigger_type is a real, defined catalog trigger', () => {
    for (const a of DEFAULT_AUTOMATIONS) {
      expect(TRIGGERS[a.trigger_type], `${a.builtin_key}: unknown trigger ${a.trigger_type}`).toBeDefined();
    }
  });

  it('the two cancellation-adjacent entries are the only ones referencing {{event.reason}}', () => {
    const withReason = DEFAULT_AUTOMATIONS.filter((a) => a.body.includes('{{event.reason}}'));
    expect(withReason.map((a) => a.builtin_key)).toEqual(['default-walkthrough-cancelled']);
  });

  // {{technician.names}} renders the WHOLE crew ("Carlos Tran, Mike Turner, Dre
  // Patel"), so any copy that makes it the subject of a verb reads as broken
  // English the moment a job has more than one person on it — "Carlos Tran, Mike
  // Turner, Dre Patel is heading to…". Presenting it as a labelled list instead
  // reads correctly at every crew size, which is the shape Ran chose on
  // 2026-07-27 over dropping back to a single name.
  it('every entry naming the crew presents {{technician.names}} as a labelled list, never a sentence subject', () => {
    const withCrew = DEFAULT_AUTOMATIONS.filter((a) => a.body.includes('{{technician.names}}'));
    expect(withCrew.length).toBeGreaterThan(0);
    for (const a of withCrew) {
      expect(
        a.body,
        `${a.builtin_key}: {{technician.names}} must follow "Who's coming: " so the copy survives a multi-person crew`,
      ).toContain("Who's coming: {{technician.names}}");
    }
  });

  // Same reason, one level up: a subject line that says "The technician" is
  // wrong for a three-person crew, so the crew-facing subjects stay count-neutral.
  it('no subject line hard-codes a singular technician', () => {
    for (const a of DEFAULT_AUTOMATIONS) {
      expect(a.subject.toLowerCase(), `${a.builtin_key}: subject assumes exactly one technician`).not.toContain(
        'the technician',
      );
    }
  });

  // ── Spec B slice 7: the five task defaults ─────────────────────────────────

  it('ships exactly one default per task trigger, all five on the task entity', () => {
    const taskDefaults = DEFAULT_AUTOMATIONS.filter((a) => TRIGGERS[a.trigger_type].entity === 'task');
    expect(taskDefaults.map((a) => a.builtin_key)).toEqual([
      'default-task-created',
      'default-task-assigned',
      'default-task-comment-added',
      'default-task-deleted',
      'default-task-due-reminder',
    ]);
    expect(taskDefaults.map((a) => a.trigger_type).sort()).toEqual([
      'TASK_ASSIGNED',
      'TASK_COMMENT_ADDED',
      'TASK_CREATED',
      'TASK_DATE_ANCHORED',
      'TASK_DELETED',
    ]);
  });

  // The single highest-damage line in this slice. `assignees` resolves to the LIVE roster, so
  // the assignment default built on it would re-email everyone already on the task every time
  // one more person joined - the exact bug `assigned_user` was invented to prevent, with no
  // error and nothing in the logs. A single-assignee fixture cannot see it: with one person on
  // the task the two audiences return the same row.
  it('the assignment default targets assigned_user, never the live roster', () => {
    const assigned = DEFAULT_AUTOMATIONS.find((a) => a.trigger_type === 'TASK_ASSIGNED')!;
    expect(assigned.recipients).toEqual(['assigned_user']);
    expect(assigned.recipients).not.toContain('assignees');
  });

  // The reminder is the one seeded default whose timing is data rather than an event, and a
  // null config is not a validation error anywhere: the poller reads the config off the
  // Workflow row, logs "invalid trigger_config - skipping", and the reminder never fires for
  // any org, ever, with nothing red.
  it('the due-date default carries a real anchor, direction and offset - and is the only entry that carries any config', () => {
    const withConfig = DEFAULT_AUTOMATIONS.filter((a) => a.trigger_config != null);
    expect(withConfig.map((a) => a.builtin_key)).toEqual(['default-task-due-reminder']);
    expect(withConfig[0].trigger_config).toEqual({
      anchor: 'task.due_at',
      direction: 'before',
      offset_minutes: 24 * 60,
    });
  });

  // BEFORE, not after, and not one of each. An after-chase's first sweep window is
  // [now - offset - 7 days, now - offset] because of dateAnchorSweep's fixed grace, so the
  // first run after seeding would enroll every task that went overdue in the preceding week
  // at once. A before-reminder's first window is [now, now + offset] and can only ever contain
  // work that has not come due yet.
  it('seeds the before-reminder only, so a first run cannot chase a backlog', () => {
    const chases = DEFAULT_AUTOMATIONS.filter(
      (a) => a.trigger_config != null && 'direction' in a.trigger_config && a.trigger_config.direction === 'after',
    );
    expect(chases).toEqual([]);
  });

  // A deleted task is a HARD delete, so by send time there is no row to read a due date, a
  // status, a priority or a live roster off. The catalogue offers this trigger the snapshot
  // fields alone and the validator enforces it - but the validator cannot see copy that
  // references a field which resolves to an empty string, and an empty merge field reads as a
  // broken template rather than as a deleted task.
  it("the deleted default's copy uses only the two identity fields the pre-delete snapshot captures", () => {
    const deleted = DEFAULT_AUTOMATIONS.find((a) => a.trigger_type === 'TASK_DELETED')!;
    const used = [...fieldsIn(deleted.subject), ...fieldsIn(deleted.body)];
    const taskFields = used.filter((f) => f.startsWith('task.'));
    expect(taskFields.length).toBeGreaterThan(0);
    for (const f of taskFields) {
      expect(['task.number', 'task.title'], `${f} does not survive the delete`).toContain(f);
    }
  });

  // The validator refuses an ILLEGAL merge field; it cannot refuse a legal one that renders
  // blank. `task.due_date` is empty on a task with no due date and `task.linked_record` is
  // empty on a free-standing task, and both are legal on four of the five task triggers - so
  // the copy is what has to keep them out. The reminder is the one exception: its sweep
  // selects on due_at, so the date is guaranteed present there.
  it('no task default renders a field that is routinely empty, except the reminder naming the date it is about', () => {
    const SOMETIMES_EMPTY = ['task.due_date', 'task.linked_record'];
    for (const a of DEFAULT_AUTOMATIONS.filter((d) => TRIGGERS[d.trigger_type].entity === 'task')) {
      const used = [...fieldsIn(a.subject), ...fieldsIn(a.body)];
      const allowed = a.builtin_key === 'default-task-due-reminder' ? ['task.due_date'] : [];
      for (const f of SOMETIMES_EMPTY) {
        if (allowed.includes(f)) continue;
        expect(used, `${a.builtin_key}: {{${f}}} is routinely empty and reads as a broken template`).not.toContain(f);
      }
    }
  });

  it('the two "removed" entries target removed_user, matching their trigger', () => {
    const unassigned = DEFAULT_AUTOMATIONS.find((a) => a.trigger_type === 'TECH_UNASSIGNED');
    const performerRemoved = DEFAULT_AUTOMATIONS.find((a) => a.trigger_type === 'WALKTHROUGH_PERFORMER_REMOVED');
    expect(unassigned?.recipients).toEqual(['removed_user']);
    expect(performerRemoved?.recipients).toEqual(['removed_user']);
  });
});

// Scheduling-notifications slice 07: a NEW org's seeded template for the milestone is named the
// way the rest of the app now speaks. The builtin_key stays `default-job-en-route` because it is
// the identity the seeder upserts on; an existing org's copy is its own and is not rewritten.
describe('DEFAULT_AUTOMATIONS - the on-the-way vocabulary', () => {
  it('names the JOB_EN_ROUTE built-in "Technician on the way"', () => {
    const entry = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === 'default-job-en-route');
    expect(entry?.name).toBe('Technician on the way');
  });

  it('never says "en route" in any seeded name, description, subject or body', () => {
    for (const a of DEFAULT_AUTOMATIONS) {
      for (const [field, text] of Object.entries({ name: a.name, description: a.description, subject: a.subject, body: a.body })) {
        expect(text, `${a.builtin_key} ${field}`).not.toMatch(/en[ -]route/i);
      }
    }
  });
});
