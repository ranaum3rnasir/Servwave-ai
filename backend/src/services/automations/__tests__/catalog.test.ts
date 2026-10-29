import { describe, it, expect } from 'vitest';
import { AutomationTriggerType, AutomationActionType, WorkflowStepType } from '@prisma/client';
import {
  TRIGGERS,
  ACTIONS,
  TEMPLATES,
  MERGE_FIELD_LABELS,
  SAMPLE_CONTEXT,
  recipientsFor,
  audiencesFor,
  AUDIENCES,
  ANCHOR_OPTIONS,
  type AutomationTemplate,
  type AuthorableActionType,
} from '../catalog';
import { validateWorkflowDefinition } from '../workflowValidation';
import { LEAD_STAGE_CLOCK_ANCHORS } from '../anchors';

const ALL_TRIGGERS = Object.values(AutomationTriggerType);
/** The actions the catalogue still offers - NOT Object.values(AutomationActionType). */
const AUTHORABLE_ACTIONS = ['SEND_EMAIL', 'SEND_SMS'] as const satisfies readonly AuthorableActionType[];

/** Extract {{merge.fields}} used in a piece of template copy. */
function fieldsIn(text: string): string[] {
  return [...text.matchAll(/\{\{([a-z_.]+)\}\}/g)].map((m) => m[1]);
}

describe('automation catalog — triggers', () => {
  it('defines every AutomationTriggerType with label, description, entity and category', () => {
    for (const t of ALL_TRIGGERS) {
      const def = TRIGGERS[t];
      expect(def, `missing TRIGGERS entry for ${t}`).toBeDefined();
      expect(def.label.length).toBeGreaterThan(3);
      expect(def.description.length).toBeGreaterThan(10);
      expect(['job', 'estimate', 'invoice', 'lead', 'task']).toContain(def.entity);
      expect(['events', 'timed', 'date']).toContain(def.category);
    }
  });

  it('time-based triggers carry a positive default offset; event triggers none', () => {
    for (const t of ALL_TRIGGERS) {
      const def = TRIGGERS[t];
      if (def.category === 'timed') {
        expect(def.timeBased).toBe(true);
        expect(def.defaultOffsetMinutes, `${t} needs defaultOffsetMinutes`).toBeGreaterThan(0);
      } else {
        expect(def.timeBased).toBe(false);
        expect(def.defaultOffsetMinutes).toBeUndefined();
      }
    }
  });

  // Split, not loosened. A customer-bearing entity keeps the ORIGINAL guarantee
  // character for character; `task` is the first entity with no customer at all, so
  // asserting a customer field on it would only be satisfiable by giving tasks a fake
  // one. What every trigger still shares is the organisation.
  it('every trigger exposes the org merge fields at minimum', () => {
    for (const t of ALL_TRIGGERS) {
      expect(TRIGGERS[t].mergeFields, `${t} lost its org fields`).toEqual(
        expect.arrayContaining(['org.name', 'org.phone']),
      );
    }
  });

  /**
   * Ran, 2026-09-15: no trigger offers a name for the person a copy of a send is ADDRESSED to.
   *
   * `{{recipient.first_name}}` used to ride in BASE and TASK_BASE and so appeared on all of
   * them. It is gone, and this is the assertion that keeps it gone - the reasoning is on
   * `BASE` in catalog.ts, and `20260915170000_drop_recipient_first_name_from_saved_copy` is
   * the cost of reversing it.
   *
   * WRITTEN SO IT CANNOT PASS VACUOUSLY, which is the trap every absence test falls into: a
   * build where the catalogue failed to load, or where `mergeFields` came back empty, would
   * satisfy "does not contain X" on every trigger and report green. So the trigger count is
   * pinned first, and each trigger must still be OFFERING something before it is checked for
   * what it no longer offers.
   *
   * The whole `recipient.` namespace rather than the one field name, because the defect being
   * prevented is "a per-recipient name came back", not "this exact string came back".
   */
  it('no trigger offers any recipient-scoped field, and every trigger still offers fields', () => {
    expect(ALL_TRIGGERS.length, 'the trigger enum did not load').toBeGreaterThan(10);
    for (const t of ALL_TRIGGERS) {
      expect(TRIGGERS[t].mergeFields.length, `${t} offers nothing at all`).toBeGreaterThan(1);
      expect(
        TRIGGERS[t].mergeFields.filter((f) => f.startsWith('recipient.')),
        `${t} offers a recipient-scoped field again`,
      ).toEqual([]);
    }
    // The label table and the preview sample are the two other places the field lived; a
    // leftover in either is a chip with a human name on a field nothing can render.
    expect(Object.keys(MERGE_FIELD_LABELS).filter((f) => f.startsWith('recipient.'))).toEqual([]);
    expect(Object.keys(SAMPLE_CONTEXT).filter((f) => f.startsWith('recipient.'))).toEqual([]);
    expect(Object.keys(MERGE_FIELD_LABELS).length, 'the label table did not load').toBeGreaterThan(20);
  });

  it('every CUSTOMER-BEARING trigger still exposes customer merge fields', () => {
    for (const t of ALL_TRIGGERS) {
      if (TRIGGERS[t].entity === 'task') continue;
      expect(TRIGGERS[t].mergeFields, `${t} lost its customer fields`).toEqual(
        expect.arrayContaining(['customer.first_name']),
      );
    }
  });

  it('a task trigger carries NO customer merge field (a task has no customer)', () => {
    for (const t of ALL_TRIGGERS) {
      if (TRIGGERS[t].entity !== 'task') continue;
      expect(TRIGGERS[t].mergeFields.filter((f) => f.startsWith('customer.'))).toEqual([]);
    }
  });
});

describe('automation catalog — actions & recipients', () => {
  // This replaces a loop over Object.values(AutomationActionType), which asserted
  // the served catalogue was complete over the PRISMA enum. That is the exact
  // claim the retirement denies: storage keeps every label it has ever had so
  // historic rows resolve, while the catalogue offers only what an admin may
  // still author. Keeping the old loop would have made re-adding the retired
  // action the way to get back to green.
  it('offers only the two channels the Automation Center owns', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(['SEND_EMAIL', 'SEND_SMS']);
    expect(ACTIONS).not.toHaveProperty('NOTIFY_TEAM');
  });

  it('gives every offered action admin-facing label and description copy', () => {
    for (const a of AUTHORABLE_ACTIONS) {
      expect(ACTIONS[a].label.length, `${a} needs a label`).toBeGreaterThan(3);
      expect(ACTIONS[a].description.length, `${a} needs a description`).toBeGreaterThan(10);
    }
  });

  it('only offers assigned_techs recipients on job-entity triggers', () => {
    expect(recipientsFor('TECH_ASSIGNED', 'SEND_EMAIL')).toContain('assigned_techs');
    expect(recipientsFor('BEFORE_JOB_START', 'SEND_EMAIL')).toContain('assigned_techs');
    expect(recipientsFor('INVOICE_OVERDUE', 'SEND_EMAIL')).not.toContain('assigned_techs');
    expect(recipientsFor('LEAD_CREATED', 'SEND_EMAIL')).not.toContain('assigned_techs');
  });

  // The LAST customer-only narrowing on the text channel, and after Spec C slice 1 the only
  // one: audiencesFor below now serves a text step the same audiences as an email step, and
  // this legacy six-member list was deliberately left alone because nothing an admin can see
  // reads it. Entity-aware all the same - a task has no customer, so its legal SMS recipient
  // set here is EMPTY rather than ['customer'].
  it('SMS is customer-only in the legacy recipient list, and empty where the entity has no customer', () => {
    for (const t of ALL_TRIGGERS) {
      const expected = TRIGGERS[t].entity === 'task' ? [] : ['customer'];
      expect(recipientsFor(t, 'SEND_SMS'), `${t}`).toEqual(expected);
    }
  });
});

describe('automation catalog — merge-field registry', () => {
  it('labels and sample values exist for every merge field any trigger offers', () => {
    const all = new Set(ALL_TRIGGERS.flatMap((t) => TRIGGERS[t].mergeFields));
    for (const f of all) {
      expect(MERGE_FIELD_LABELS[f], `missing label for {{${f}}}`).toBeTruthy();
      expect(SAMPLE_CONTEXT[f], `missing sample value for {{${f}}}`).toBeTruthy();
    }
  });
});

describe('automation catalog — prebuilt templates', () => {
  // The `team` category held nothing but in-app alerts, so retiring that channel emptied it
  // rather than shrinking it - and Spec B slice 7 REFILLS it, with task recipes that are
  // emails. The category was never about the in-app channel; it is about who the message
  // reaches, and a task is internal work whose audience is staff. The guard that actually
  // matters here is the separate "no prebuilt template installs an in-app step" test below,
  // which watches the step types rather than the grouping label.
  it('ships a meaningful gallery with unique keys across all three categories', () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(14);
    const keys = TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of ['customer', 'money', 'team']) {
      expect(TEMPLATES.some((t) => t.category === c), `no templates in category ${c}`).toBe(true);
    }
  });

  // Story 2 fails on its own terms without these: an admin picks the Tasks tile, opens the
  // gallery, and finds nothing. Three recipes, one per shape a task automation takes - a
  // reminder before the date, a chase after it, and an event notice.
  it('offers task recipes now that the task triggers can actually deliver', () => {
    const taskRecipes = TEMPLATES.filter((t) => TRIGGERS[t.trigger_type].entity === 'task');
    expect(taskRecipes.map((t) => t.key)).toEqual([
      'task-due-soon-reminder',
      'task-overdue-chase',
      'task-comment-notice',
    ]);
    for (const tpl of taskRecipes) {
      // Email only, and now as a product choice rather than a structural one. Until Spec C
      // slice 1 a task trigger had ZERO legal SMS audiences, so a text recipe here could not
      // have been published at all; a task text is publishable today, and the gallery still
      // does not ship one because a prebuilt recipe should not spend an org's texts by
      // default. Add one deliberately, not by relaxing this line.
      expect(tpl.action_type, `${tpl.key}: the task recipes are email`).toBe('SEND_EMAIL');
      expect(tpl.category, `${tpl.key}: a task is internal work`).toBe('team');
    }
  });

  // One trigger, both directions - which is why Spec B has no separate overdue trigger and
  // why these two recipes differ only in their config.
  it('the two task date recipes are the same trigger pointed in opposite directions', () => {
    const before = TEMPLATES.find((t) => t.key === 'task-due-soon-reminder')!;
    const after = TEMPLATES.find((t) => t.key === 'task-overdue-chase')!;
    expect(before.trigger_type).toBe('TASK_DATE_ANCHORED');
    expect(after.trigger_type).toBe('TASK_DATE_ANCHORED');
    expect(before.trigger_config).toEqual({ anchor: 'task.due_at', direction: 'before', offset_minutes: 24 * 60 });
    expect(after.trigger_config).toEqual({ anchor: 'task.due_at', direction: 'after', offset_minutes: 24 * 60 });
  });

  it('includes the canonical 24h customer reminder', () => {
    const reminder = TEMPLATES.find(
      (t) => t.trigger_type === 'BEFORE_JOB_START' && t.trigger_config?.offset_minutes === 24 * 60,
    );
    expect(reminder).toBeDefined();
    expect(reminder!.action_type).toBe('SEND_SMS');
  });

  it('no prebuilt template installs an in-app step', () => {
    // The gallery used to hand an admin a NOTIFY_TEAM workflow in one click,
    // which is the very configuration being retired. Every remaining template
    // must fold to a step type the builder still offers.
    //
    // A template's single-action `action_type` is now the AUTHORABLE union, so
    // writing the retired label there does not compile and there is nothing left
    // for this test to assert about that field. Its multi-step `steps` array
    // still spans the storage enum - a recipe has to be able to describe a stored
    // sequence - so that is the door this test watches.
    const actionTypes: string[] = TEMPLATES.map((t) => t.action_type);
    expect(actionTypes.filter((a) => a !== 'SEND_EMAIL' && a !== 'SEND_SMS')).toEqual([]);
    expect(TEMPLATES.flatMap((t) => t.steps ?? []).filter((s) => s.step_type === 'NOTIFY_TEAM')).toEqual([]);
  });

  it('every template is internally valid against the catalog', () => {
    for (const tpl of TEMPLATES) {
      const trig = TRIGGERS[tpl.trigger_type];
      expect(trig, `${tpl.key}: unknown trigger`).toBeDefined();
      expect(ACTIONS[tpl.action_type], `${tpl.key}: unknown action`).toBeDefined();

      // timing config matches trigger kind. `category: 'date'` is exactly the date-anchored
      // family (five triggers, one per entity), whose timing is anchor + direction + offset
      // rather than the legacy bare offset.
      if (trig.category === 'date') {
        expect(tpl.trigger_config, `${tpl.key}: a date-anchored recipe needs an anchor config`).toMatchObject({
          anchor: expect.any(String),
          direction: expect.stringMatching(/^(before|after)$/),
        });
        expect(tpl.trigger_config?.offset_minutes, `${tpl.key}: offset required`).toBeGreaterThan(0);
      } else if (trig.timeBased) {
        expect(tpl.trigger_config?.offset_minutes, `${tpl.key}: offset required`).toBeGreaterThan(0);
      } else {
        expect(tpl.trigger_config).toBeUndefined();
      }

      // The recipient must be offered for this trigger+action pair. Checked against
      // audiencesFor, NOT the legacy recipientsFor: audiencesFor is the multi-select's data
      // source AND what validateStep enforces, while recipientsFor is the six-key back-compat
      // list that predates the task audiences and knows nothing of `assignees`/`watchers`.
      // Asserting on the legacy list would have refused a correct task recipe.
      const cfg = tpl.action_config as { recipient: string; subject?: string; body: string };
      expect(
        audiencesFor(tpl.trigger_type, tpl.action_type).map((a) => a.key),
        `${tpl.key}: recipient ${cfg.recipient} not allowed`,
      ).toContain(cfg.recipient);

      // copy constraints
      expect(cfg.body.length).toBeGreaterThan(20);
      if (tpl.action_type === 'SEND_EMAIL') {
        expect(cfg.subject, `${tpl.key}: email needs subject`).toBeTruthy();
      }
      if (tpl.action_type === 'SEND_SMS') {
        expect(cfg.body.length, `${tpl.key}: SMS too long`).toBeLessThanOrEqual(320);
      }

      // every {{field}} used must be valid for the trigger
      const used = [...fieldsIn(cfg.body), ...fieldsIn(cfg.subject ?? '')];
      for (const f of used) {
        expect(trig.mergeFields, `${tpl.key}: {{${f}}} not valid for ${tpl.trigger_type}`).toContain(f);
      }
    }
  });
});

describe('automation catalog — multi-step templates', () => {
  const STEP_TYPE_FOR_ACTION: Record<AutomationActionType, WorkflowStepType> = {
    SEND_SMS: 'SEND_TEXT',
    SEND_EMAIL: 'SEND_EMAIL',
    NOTIFY_TEAM: 'NOTIFY_TEAM',
  };

  /**
   * Mirrors the FE's templateToWorkflowBody folding (describeWorkflow.ts),
   * backend-side, for validation only: explicit `steps` win verbatim, else
   * the single action_config folds into one step.
   */
  function stepsForTemplate(
    tpl: AutomationTemplate,
  ): Array<{ position: number; step_type: WorkflowStepType; config: unknown }> {
    if (tpl.steps) {
      return tpl.steps.map((step, position) => ({ position, step_type: step.step_type, config: step.config }));
    }
    const step_type = STEP_TYPE_FOR_ACTION[tpl.action_type];
    const { recipient, body, subject, custom_email, user_id } = tpl.action_config;
    let config: Record<string, unknown>;
    if (step_type === 'SEND_TEXT') {
      config = { recipient, body };
    } else if (step_type === 'SEND_EMAIL') {
      config = { recipient, subject: subject ?? '', body, ...(custom_email ? { custom_email } : {}) };
    } else {
      config = { recipient, body, ...(user_id ? { user_id } : {}) };
    }
    return [{ position: 0, step_type, config }];
  }

  it('walkthrough-scheduled-confirmation is a single-action SEND_EMAIL recipe on WALKTHROUGH_SCHEDULED', () => {
    const tpl = TEMPLATES.find((t) => t.key === 'walkthrough-scheduled-confirmation');
    expect(tpl).toBeDefined();
    expect(tpl!.trigger_type).toBe('WALKTHROUGH_SCHEDULED');
    expect(tpl!.action_type).toBe('SEND_EMAIL');
    expect(tpl!.steps).toBeUndefined();
  });

  it('walkthrough-reminder-1d carries an explicit two-step sequence: anchored WAIT then SEND_EMAIL', () => {
    const tpl = TEMPLATES.find((t) => t.key === 'walkthrough-reminder-1d');
    expect(tpl).toBeDefined();
    expect(tpl!.steps).toHaveLength(2);
    expect(tpl!.steps![0].step_type).toBe('WAIT');
    expect(tpl!.steps![0].config).toMatchObject({
      mode: 'anchored',
      anchor: 'lead.walkthrough_scheduled_at',
      direction: 'before',
    });
    expect(tpl!.steps![1].step_type).toBe('SEND_EMAIL');
  });

  it('every template — single-action or explicit steps — validates cleanly end to end', () => {
    for (const tpl of TEMPLATES) {
      const issues = validateWorkflowDefinition({
        trigger_type: tpl.trigger_type,
        trigger_config: tpl.trigger_config ?? null,
        send_window: tpl.send_window,
        steps: stepsForTemplate(tpl),
      });
      expect(issues, `${tpl.key}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });
});

describe('automation catalog — v2.1 recipient audiences (audiencesFor)', () => {
  it('a job trigger + SEND_EMAIL advertises all 7 entity audiences plus custom', () => {
    const keys = audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toEqual([
      'customer',
      'assigned_team',
      'dispatcher',
      'salesperson',
      'all_admins',
      'all_dispatchers',
      'specific_user',
      'custom',
    ]);
  });

  // Spec C slice 1 replaced the customer-only assertion that stood here. A text step now
  // reaches every audience an email step reaches, so the assertion is written as an
  // EQUIVALENCE over every trigger rather than as a key list: a trigger added later cannot
  // quietly acquire a narrower text audience than its email one, and neither can a trigger
  // whose entity gains an audience. `custom` is the whole of the difference - it is an
  // audience of literal email addresses and has no meaning on a handset, so it stays
  // email-only.
  it('offers a text step the same audiences as an email step, minus the email-only custom address', () => {
    for (const t of ALL_TRIGGERS) {
      const emailKeys = audiencesFor(t, 'SEND_EMAIL').map((a) => a.key);
      expect(emailKeys, `${t} should offer custom on email`).toContain('custom');
      expect(audiencesFor(t, 'SEND_SMS').map((a) => a.key), `${t}`).toEqual(
        emailKeys.filter((k) => k !== 'custom'),
      );
    }
  });

  it('an invoice trigger has no salesperson (or dispatcher/assigned_team/creator)', () => {
    const keys = audiencesFor('INVOICE_SENT', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toEqual(['customer', 'all_admins', 'all_dispatchers', 'specific_user', 'custom']);
  });

  it('an estimate trigger offers creator but not dispatcher/assigned_team', () => {
    const keys = audiencesFor('ESTIMATE_SENT', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toContain('creator');
    expect(keys).not.toContain('dispatcher');
    expect(keys).not.toContain('assigned_team');
  });

  it('carries a plain-English label for every advertised audience', () => {
    for (const t of ALL_TRIGGERS) {
      for (const a of AUTHORABLE_ACTIONS) {
        for (const opt of audiencesFor(t, a)) {
          expect(opt.label.length, `${t}/${a}/${opt.key} needs a label`).toBeGreaterThan(2);
        }
      }
    }
  });

  // `watchers` joins the four: following a task is self-service, so a task can perfectly
  // well have none. `assignees` deliberately does NOT - the task API refuses to leave a
  // live task with an empty assignee list, so there is nothing to warn the author about.
  it('carries a hint only for the not-guaranteed audiences (salesperson/dispatcher/creator/assigned_team/watchers)', () => {
    const NOT_GUARANTEED = new Set(['salesperson', 'dispatcher', 'creator', 'assigned_team', 'watchers']);
    for (const t of ALL_TRIGGERS) {
      for (const a of AUTHORABLE_ACTIONS) {
        for (const opt of audiencesFor(t, a)) {
          if (NOT_GUARANTEED.has(opt.key)) {
            expect(opt.hint, `${t}/${a}/${opt.key} needs a hint`).toBeTruthy();
          } else {
            expect(opt.hint, `${t}/${a}/${opt.key} shouldn't have a hint`).toBeUndefined();
          }
        }
      }
    }
  });

  it('the salesperson hint matches the documented copy', () => {
    const opt = audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').find((a) => a.key === 'salesperson');
    expect(opt?.hint).toBe('Skipped if no salesperson is set.');
  });

  it('assigned_team label + hint differ for lead (walkthrough team) vs job (assigned crew)', () => {
    const jobOpt = audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').find((a) => a.key === 'assigned_team');
    const leadOpt = audiencesFor('LEAD_CREATED', 'SEND_EMAIL').find((a) => a.key === 'assigned_team');
    expect(jobOpt?.label).toBe('the assigned crew');
    expect(leadOpt?.label).toBe('the walkthrough team');
    expect(jobOpt?.hint).not.toBe(leadOpt?.hint);
  });

  it('every trigger × action combo is present in the served AUDIENCES map, identical to audiencesFor()', () => {
    for (const t of ALL_TRIGGERS) {
      for (const a of AUTHORABLE_ACTIONS) {
        expect(AUDIENCES[t][a]).toEqual(audiencesFor(t, a));
      }
    }
  });

  // The served map is built through `{} as Record<…>` casts, which cannot fail
  // and therefore cannot be trusted to have stopped filling a key the type no
  // longer declares. Asserting the key set is what makes the cast honest.
  it('is keyed by the two offered actions and no others, for every trigger', () => {
    for (const t of ALL_TRIGGERS) {
      expect(Object.keys(AUDIENCES[t]).sort(), `${t} serves the wrong action keys`).toEqual([
        'SEND_EMAIL',
        'SEND_SMS',
      ]);
    }
  });
});

describe('catalog — date-anchored triggers', () => {
  it('defines one date-anchored trigger per entity', () => {
    expect(TRIGGERS.JOB_DATE_ANCHORED.entity).toBe('job');
    expect(TRIGGERS.LEAD_DATE_ANCHORED.entity).toBe('lead');
    expect(TRIGGERS.INVOICE_DATE_ANCHORED.entity).toBe('invoice');
    expect(TRIGGERS.ESTIMATE_DATE_ANCHORED.entity).toBe('estimate');
  });

  it('marks them category=date and NOT timeBased (their config is anchored, not a bare offset)', () => {
    for (const key of ['JOB_DATE_ANCHORED', 'LEAD_DATE_ANCHORED', 'INVOICE_DATE_ANCHORED', 'ESTIMATE_DATE_ANCHORED'] as const) {
      expect(TRIGGERS[key].category).toBe('date');
      expect(TRIGGERS[key].timeBased).toBe(false);
    }
  });

  it('carries the same merge fields as its entity event triggers', () => {
    expect(TRIGGERS.INVOICE_DATE_ANCHORED.mergeFields).toEqual(TRIGGERS.INVOICE_SENT.mergeFields);
    expect(TRIGGERS.JOB_DATE_ANCHORED.mergeFields).toEqual(TRIGGERS.JOB_SCHEDULED.mergeFields);
  });

  it('advertises the anchor options each entity offers the builder', () => {
    const both = ['before', 'after'];
    expect(ANCHOR_OPTIONS.invoice).toEqual([
      { key: 'invoice.due_date', label: 'the invoice due date', directions: both },
    ]);
    expect(ANCHOR_OPTIONS.job).toEqual([{ key: 'job.scheduled_start', label: 'the appointment', directions: both }]);
    expect(ANCHOR_OPTIONS.estimate).toEqual([
      { key: 'estimate.valid_until', label: 'the estimate expiration', directions: both },
    ]);
    // Spec #1751 D8: the lead gains three stage clocks, and the ORDER is asserted along with the
    // set because it is the order the builder's dropdown renders. The walkthrough anchor stays
    // first: it is the one every existing org's reminders already use.
    expect(ANCHOR_OPTIONS.lead).toEqual([
      { key: 'lead.walkthrough_scheduled_at', label: 'the walkthrough', directions: both },
      { key: 'lead.created_at', label: 'the lead arriving', directions: ['after'] },
      { key: 'lead.contacted_at', label: 'first contact', directions: ['after'] },
      { key: 'lead.last_visit_completed_at', label: 'the completed walkthrough', directions: ['after'] },
    ]);
  });

  // The builder reads `directions` to decide what to OFFER, so this list and the validator have to
  // agree: anything advertised as legal here must survive a save. Asserted against the same set the
  // validator tests, rather than against a second hand-written copy of it.
  it('advertises no direction the validator would reject', () => {
    for (const options of Object.values(ANCHOR_OPTIONS)) {
      for (const option of options) {
        const expected = LEAD_STAGE_CLOCK_ANCHORS.has(option.key) ? ['after'] : ['before', 'after'];
        expect(option.directions).toEqual(expected);
      }
    }
  });
});

// ── the hard-coded → Automation Center migration's new triggers ────────────

describe('catalog — removed-recipient triggers (TECH_UNASSIGNED, WALKTHROUGH_PERFORMER_REMOVED, JOB_EN_ROUTE)', () => {
  it('TECH_UNASSIGNED and JOB_EN_ROUTE are job events; WALKTHROUGH_PERFORMER_REMOVED is a lead event', () => {
    expect(TRIGGERS.TECH_UNASSIGNED).toMatchObject({ entity: 'job', category: 'events', timeBased: false });
    expect(TRIGGERS.JOB_EN_ROUTE).toMatchObject({ entity: 'job', category: 'events', timeBased: false });
    expect(TRIGGERS.WALKTHROUGH_PERFORMER_REMOVED).toMatchObject({ entity: 'lead', category: 'events', timeBased: false });
  });

  it('reuse the same merge fields as their sibling ASSIGNED/SCHEDULED triggers — no info the built-in email had is unavailable here', () => {
    expect(TRIGGERS.TECH_UNASSIGNED.mergeFields).toEqual(TRIGGERS.TECH_ASSIGNED.mergeFields);
    expect(TRIGGERS.JOB_EN_ROUTE.mergeFields).toEqual(TRIGGERS.JOB_SCHEDULED.mergeFields);
    expect(TRIGGERS.WALKTHROUGH_PERFORMER_REMOVED.mergeFields).toEqual(TRIGGERS.WALKTHROUGH_PERFORMER_ASSIGNED.mergeFields);
  });

  // Spec C slice 1 flipped the SEND_SMS half of this. removed_user is appended just ABOVE
  // the old channel narrowing, so the customer-only filter was quietly dropping it along
  // with everything else non-customer: an admin could email the technician they had just
  // taken off a job and could not text them. Both channels now offer it.
  it('removed_user is offered ONLY on the two REMOVED triggers, on a text as much as an email', () => {
    expect(audiencesFor('TECH_UNASSIGNED', 'SEND_EMAIL').map((a) => a.key)).toContain('removed_user');
    expect(audiencesFor('TECH_UNASSIGNED', 'SEND_SMS').map((a) => a.key)).toContain('removed_user');
    expect(audiencesFor('WALKTHROUGH_PERFORMER_REMOVED', 'SEND_EMAIL').map((a) => a.key)).toContain('removed_user');
    expect(audiencesFor('WALKTHROUGH_PERFORMER_REMOVED', 'SEND_SMS').map((a) => a.key)).toContain('removed_user');

    // Not offered anywhere else — it's meaningless outside these two triggers.
    expect(audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').map((a) => a.key)).not.toContain('removed_user');
    expect(audiencesFor('TECH_ASSIGNED', 'SEND_EMAIL').map((a) => a.key)).not.toContain('removed_user');
    expect(audiencesFor('JOB_EN_ROUTE', 'SEND_EMAIL').map((a) => a.key)).not.toContain('removed_user');
    expect(audiencesFor('JOB_SCHEDULED', 'SEND_SMS').map((a) => a.key)).not.toContain('removed_user');
  });

  it('removed_user carries a plain-English label and no hint (always populated at dispatch time)', () => {
    const opt = audiencesFor('TECH_UNASSIGNED', 'SEND_EMAIL').find((a) => a.key === 'removed_user');
    expect(opt?.label).toBe('the removed technician');
    expect(opt?.hint).toBeUndefined();
  });

  // The mirror of the removed_user assertion above, and flipped by Spec C slice 1 for the
  // same reason: assigned_user is appended above the old narrowing too. Telling the person
  // just put on a job that they are on it is the single most text-shaped message in the
  // catalogue, and it was the one audience the channel could not reach.
  it('assigned_user is offered ONLY on the ASSIGNED triggers, on a text as much as an email', () => {
    expect(audiencesFor('TECH_ASSIGNED', 'SEND_EMAIL').map((a) => a.key)).toContain('assigned_user');
    expect(audiencesFor('TECH_ASSIGNED', 'SEND_SMS').map((a) => a.key)).toContain('assigned_user');
    expect(audiencesFor('WALKTHROUGH_PERFORMER_ASSIGNED', 'SEND_EMAIL').map((a) => a.key)).toContain('assigned_user');
    expect(audiencesFor('WALKTHROUGH_PERFORMER_ASSIGNED', 'SEND_SMS').map((a) => a.key)).toContain('assigned_user');
    // Spec B's third ASSIGNED trigger, which the two-trigger phrasing above predates.
    expect(audiencesFor('TASK_ASSIGNED', 'SEND_SMS').map((a) => a.key)).toContain('assigned_user');

    // Not offered anywhere else - it's meaningless outside these triggers.
    expect(audiencesFor('JOB_SCHEDULED', 'SEND_EMAIL').map((a) => a.key)).not.toContain('assigned_user');
    expect(audiencesFor('TECH_UNASSIGNED', 'SEND_EMAIL').map((a) => a.key)).not.toContain('assigned_user');
    expect(audiencesFor('JOB_EN_ROUTE', 'SEND_EMAIL').map((a) => a.key)).not.toContain('assigned_user');
    expect(audiencesFor('JOB_SCHEDULED', 'SEND_SMS').map((a) => a.key)).not.toContain('assigned_user');
  });

  it('assigned_user carries a plain-English label and no hint (always populated at dispatch time)', () => {
    const opt = audiencesFor('TECH_ASSIGNED', 'SEND_EMAIL').find((a) => a.key === 'assigned_user');
    expect(opt?.label).toBe('the assigned technician');
    expect(opt?.hint).toBeUndefined();
  });
});

describe('catalog — event.reason (cancellation triggers)', () => {
  // The cancellation reason is request-time text (req.body.cancelled_reason)
  // — no live column an entity load could re-derive it from — so it only
  // reaches an automation body via event_payload.mergeFields (context.ts),
  // and only the two cancellation triggers can legally reference it.
  it('JOB_CANCELLED and WALKTHROUGH_CANCELLED advertise event.reason; their siblings do not', () => {
    expect(TRIGGERS.JOB_CANCELLED.mergeFields).toContain('event.reason');
    expect(TRIGGERS.WALKTHROUGH_CANCELLED.mergeFields).toContain('event.reason');
    expect(TRIGGERS.JOB_COMPLETED.mergeFields).not.toContain('event.reason');
    expect(TRIGGERS.WALKTHROUGH_COMPLETED.mergeFields).not.toContain('event.reason');
  });

  it('has a label and sample value (covered by the generic merge-field-registry test too, asserted explicitly here for intent)', () => {
    expect(MERGE_FIELD_LABELS['event.reason']).toBeTruthy();
    expect(SAMPLE_CONTEXT['event.reason']).toBeTruthy();
  });
});

// ── Spec B slice 1: task as the fifth automation entity ──────────────────────

describe('catalog - task entity (TASK_CREATED)', () => {
  it('registers TASK_CREATED as a task event with admin-facing copy', () => {
    expect(TRIGGERS.TASK_CREATED).toMatchObject({
      entity: 'task',
      category: 'events',
      timeBased: false,
    });
    expect(TRIGGERS.TASK_CREATED.label.length).toBeGreaterThan(3);
    expect(TRIGGERS.TASK_CREATED.description.length).toBeGreaterThan(10);
  });

  it('offers organization and task merge fields - and no customer field', () => {
    const fields = TRIGGERS.TASK_CREATED.mergeFields;
    expect(fields).toEqual(
      expect.arrayContaining([
        'org.name',
        'task.number',
        'task.title',
        'task.due_date',
        'task.status',
        'task.priority',
        'task.assignee_names',
        'task.link',
        'task.linked_record',
      ]),
    );
    expect(fields.some((f) => f.startsWith('customer.'))).toBe(false);
  });

  it('offers assignees, watchers, creator, admins, dispatchers and a specific person - never the customer', () => {
    const keys = audiencesFor('TASK_CREATED', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toEqual([
      'assignees',
      'watchers',
      'creator',
      'all_admins',
      'all_dispatchers',
      'specific_user',
      'custom',
    ]);
    expect(keys).not.toContain('customer');
  });

  // Spec C slice 1 rewrote this; it used to read "has zero legal SMS audiences". A task's
  // audience is entirely staff, so the old customer-only narrowing left a task trigger with
  // NOTHING to text - which made the task entity look like the exception to the channel rule
  // when it was really the clearest case for changing it. Written as the same equivalence the
  // all-triggers assertion uses, so a task can never drift back to a narrower text audience.
  it('offers on a text every audience it offers on an email, minus the email-only custom address', () => {
    expect(audiencesFor('TASK_CREATED', 'SEND_SMS').map((a) => a.key)).toEqual(
      audiencesFor('TASK_CREATED', 'SEND_EMAIL')
        .map((a) => a.key)
        .filter((k) => k !== 'custom'),
    );
    // The legacy six-member list is a DIFFERENT union and Spec C did not touch it: it still
    // narrows SMS to `customer`, which a task does not have. Mirroring one is not evidence
    // for the other - see recipientsFor()'s note in catalog.ts.
    expect(recipientsFor('TASK_CREATED', 'SEND_SMS')).toEqual([]);
  });

  it('is an EVENT trigger and carries no timing anchor of its own', () => {
    // The task's timing anchor belongs to TASK_DATE_ANCHORED (slice 5), not here. Slice 1
    // deliberately held ANCHOR_OPTIONS.task empty until that enum value existed, so that an
    // admin could not author a date-mode task workflow the API had to reject; the assertion
    // that it is now served lives with that trigger, below.
    expect(TRIGGERS.TASK_CREATED.category).toBe('events');
    expect(TRIGGERS.TASK_CREATED.timeBased).toBe(false);
  });
});

// ── Spec B slice 2: someone added to a task that already existed ─────────────

describe('catalog - TASK_ASSIGNED', () => {
  it('registers TASK_ASSIGNED as a task event with admin-facing copy', () => {
    expect(TRIGGERS.TASK_ASSIGNED).toMatchObject({
      entity: 'task',
      category: 'events',
      timeBased: false,
    });
    expect(TRIGGERS.TASK_ASSIGNED.label.length).toBeGreaterThan(3);
    expect(TRIGGERS.TASK_ASSIGNED.description.length).toBeGreaterThan(10);
  });

  it('carries the same task merge fields as TASK_CREATED, and still no customer field', () => {
    expect(TRIGGERS.TASK_ASSIGNED.mergeFields).toEqual(TRIGGERS.TASK_CREATED.mergeFields);
    expect(TRIGGERS.TASK_ASSIGNED.mergeFields.some((f) => f.startsWith('customer.'))).toBe(false);
  });

  /**
   * THE audience test for this slice. `assigned_user` reads the newly-added person off the
   * dispatching event; `assignees` reads the LIVE roster. A task-assigned workflow built on
   * `assignees` re-emails everyone already on the task every time one more person joins - the
   * exact defect the key was invented to prevent, with no error anywhere.
   */
  it('offers assigned_user - the newly-added person - alongside the entity-wide task audiences', () => {
    const keys = audiencesFor('TASK_ASSIGNED', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toEqual([
      'assignees',
      'watchers',
      'creator',
      'all_admins',
      'all_dispatchers',
      'specific_user',
      'assigned_user',
      'custom',
    ]);
  });

  it('is the ONLY task trigger that offers assigned_user - the audience is trigger-specific, not entity-wide', () => {
    expect(audiencesFor('TASK_CREATED', 'SEND_EMAIL').map((a) => a.key)).not.toContain('assigned_user');
    for (const t of ALL_TRIGGERS) {
      if (TRIGGERS[t].entity !== 'task' || t === 'TASK_ASSIGNED') continue;
      expect(audiencesFor(t, 'SEND_EMAIL').map((a) => a.key), `${t}`).not.toContain('assigned_user');
    }
  });

  it('reads assigned_user as a person, not a technician - a task assignee holds no trade', () => {
    const option = audiencesFor('TASK_ASSIGNED', 'SEND_EMAIL').find((a) => a.key === 'assigned_user');
    expect(option?.label).toBe('the person just assigned');
  });

  // Spec C slice 1 rewrote this, as it did on TASK_CREATED, and in the same equivalence form.
  it('offers on a text every audience it offers on an email, minus the email-only custom address', () => {
    expect(audiencesFor('TASK_ASSIGNED', 'SEND_SMS').map((a) => a.key)).toEqual(
      audiencesFor('TASK_ASSIGNED', 'SEND_EMAIL')
        .map((a) => a.key)
        .filter((k) => k !== 'custom'),
    );
    // The legacy six-member list is a DIFFERENT union and Spec C did not touch it: it still
    // narrows SMS to `customer`, which a task does not have. Mirroring one is not evidence
    // for the other - see recipientsFor()'s note in catalog.ts.
    expect(recipientsFor('TASK_ASSIGNED', 'SEND_SMS')).toEqual([]);
  });
});

// ── Spec B slice 3: somebody commented on a task ─────────────────────────────

describe('catalog - TASK_COMMENT_ADDED', () => {
  it('registers TASK_COMMENT_ADDED as a task event with admin-facing copy', () => {
    expect(TRIGGERS.TASK_COMMENT_ADDED).toMatchObject({
      entity: 'task',
      category: 'events',
      timeBased: false,
    });
    expect(TRIGGERS.TASK_COMMENT_ADDED.label.length).toBeGreaterThan(3);
    expect(TRIGGERS.TASK_COMMENT_ADDED.description.length).toBeGreaterThan(10);
  });

  it('carries the same task merge fields as TASK_CREATED, and still no customer field', () => {
    expect(TRIGGERS.TASK_COMMENT_ADDED.mergeFields).toEqual(TRIGGERS.TASK_CREATED.mergeFields);
    expect(TRIGGERS.TASK_COMMENT_ADDED.mergeFields.some((f) => f.startsWith('customer.'))).toBe(false);
  });

  /**
   * A comment addresses the people ON the task, so the live-roster audiences are the right
   * ones here - the opposite of TASK_ASSIGNED, which is about one newly-added person and
   * must therefore NOT offer them. `assigned_user` would resolve to nobody on this trigger
   * (no event recipient is captured) and is correctly absent.
   */
  it('offers the entity-wide task audiences and NOT assigned_user', () => {
    const keys = audiencesFor('TASK_COMMENT_ADDED', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toEqual([
      'assignees',
      'watchers',
      'creator',
      'all_admins',
      'all_dispatchers',
      'specific_user',
      'custom',
    ]);
    expect(keys).not.toContain('customer');
  });

  // Spec C slice 1 rewrote this, as it did on TASK_CREATED, and in the same equivalence form.
  it('offers on a text every audience it offers on an email, minus the email-only custom address', () => {
    expect(audiencesFor('TASK_COMMENT_ADDED', 'SEND_SMS').map((a) => a.key)).toEqual(
      audiencesFor('TASK_COMMENT_ADDED', 'SEND_EMAIL')
        .map((a) => a.key)
        .filter((k) => k !== 'custom'),
    );
    // The legacy six-member list is a DIFFERENT union and Spec C did not touch it: it still
    // narrows SMS to `customer`, which a task does not have. Mirroring one is not evidence
    // for the other - see recipientsFor()'s note in catalog.ts.
    expect(recipientsFor('TASK_COMMENT_ADDED', 'SEND_SMS')).toEqual([]);
  });
});

// ── "Task is done" (visits-and-task-categories slice 14) ─────────────────────

describe('catalog - TASK_COMPLETED', () => {
  const T = 'TASK_COMPLETED' as AutomationTriggerType;

  it('registers "Task is done" as a task event with admin-facing copy', () => {
    expect(TRIGGERS[T]).toMatchObject({ label: 'Task is done', entity: 'task', category: 'events', timeBased: false });
    expect(TRIGGERS[T].description.length).toBeGreaterThan(10);
  });

  /**
   * The builder's event list is `Object.entries(catalog.triggers)` filtered by entity, so the
   * catalogue's KEY ORDER is the order an admin reads. Lifecycle order puts the finish before
   * the deletion.
   */
  it('sits in the Tasks trigger list before "Task is deleted", in lifecycle order', () => {
    const taskEvents = (Object.keys(TRIGGERS) as AutomationTriggerType[])
      .filter((t) => TRIGGERS[t].entity === 'task' && TRIGGERS[t].category === 'events');
    // Slice 15 puts "Task is cancelled" between the finish and the deletion.
    expect(taskEvents.slice(-3)).toEqual(['TASK_COMPLETED', 'TASK_CANCELLED', 'TASK_DELETED']);
  });

  it('offers the standard task audiences - assignees, watchers, creator, admins, dispatchers, a person, typed-in emails', () => {
    expect(audiencesFor(T, 'SEND_EMAIL').map((a) => a.key)).toEqual([
      'assignees', 'watchers', 'creator', 'all_admins', 'all_dispatchers', 'specific_user', 'custom',
    ]);
    expect(audiencesFor(T, 'SEND_SMS').map((a) => a.key)).toEqual([
      'assignees', 'watchers', 'creator', 'all_admins', 'all_dispatchers', 'specific_user',
    ]);
  });

  it('offers who finished it and when, beside the full task group - the linked record included - and no customer field', () => {
    const fields = TRIGGERS[T].mergeFields;
    expect(fields).toEqual(expect.arrayContaining([...TRIGGERS.TASK_CREATED.mergeFields, 'task.completed_by', 'task.completed_at']));
    expect(fields).toContain('task.linked_record');
    expect(fields.some((f) => f.startsWith('customer.'))).toBe(false);
    expect(MERGE_FIELD_LABELS['task.completed_by']).toBe('Completed by');
    expect(MERGE_FIELD_LABELS['task.completed_at']).toBe('Completed at');
  });

  it('does not advertise the finish fields on the triggers that have no finish to report', () => {
    for (const t of ['TASK_CREATED', 'TASK_ASSIGNED', 'TASK_COMMENT_ADDED', 'TASK_CANCELLED', 'TASK_DELETED', 'TASK_DATE_ANCHORED'] as const) {
      expect(TRIGGERS[t].mergeFields, t).not.toContain('task.completed_by');
      expect(TRIGGERS[t].mergeFields, t).not.toContain('task.completed_at');
    }
  });
});

// ── "Task is cancelled" (visits-and-task-categories slice 15) ────────────────

describe('catalog - TASK_CANCELLED', () => {
  const T = 'TASK_CANCELLED' as AutomationTriggerType;

  it('registers "Task is cancelled" as a task event with admin-facing copy', () => {
    expect(TRIGGERS[T]).toMatchObject({ label: 'Task is cancelled', entity: 'task', category: 'events', timeBased: false });
    expect(TRIGGERS[T].description.length).toBeGreaterThan(10);
  });

  /** Object-key order is the builder's order: after "Task is done", before "Task is deleted". */
  it('sits in the Tasks trigger list between "Task is done" and "Task is deleted"', () => {
    const taskEvents = (Object.keys(TRIGGERS) as AutomationTriggerType[])
      .filter((t) => TRIGGERS[t].entity === 'task' && TRIGGERS[t].category === 'events');
    const at = taskEvents.indexOf(T);
    expect(taskEvents.slice(at - 1, at + 2)).toEqual(['TASK_COMPLETED', 'TASK_CANCELLED', 'TASK_DELETED']);
  });

  it('offers the same audiences as "Task is done"', () => {
    for (const action of ['SEND_EMAIL', 'SEND_SMS'] as const) {
      expect(audiencesFor(T, action).map((a) => a.key), action)
        .toEqual(audiencesFor('TASK_COMPLETED' as AutomationTriggerType, action).map((a) => a.key));
    }
    expect(audiencesFor(T, 'SEND_EMAIL').map((a) => a.key)).toEqual([
      'assignees', 'watchers', 'creator', 'all_admins', 'all_dispatchers', 'specific_user', 'custom',
    ]);
  });

  it('offers who cancelled it and when, beside the full task group - and no customer field', () => {
    const fields = TRIGGERS[T].mergeFields;
    expect(fields).toEqual(expect.arrayContaining([...TRIGGERS.TASK_CREATED.mergeFields, 'task.cancelled_by', 'task.cancelled_at']));
    expect(fields).toContain('task.linked_record');
    expect(fields.some((f) => f.startsWith('customer.'))).toBe(false);
    expect(MERGE_FIELD_LABELS['task.cancelled_by']).toBe('Cancelled by');
    expect(MERGE_FIELD_LABELS['task.cancelled_at']).toBe('Cancelled at');
  });

  /**
   * "A cancellation reason if one exists": none does. A task has no reason column and the PATCH
   * takes none, so an advertised reason field would always render empty. It is left out.
   */
  it('offers no cancellation-reason field - a task records no reason', () => {
    expect(TRIGGERS[T].mergeFields.filter((f) => /reason/i.test(f))).toEqual([]);
  });

  it('does not advertise the cancel fields on any other trigger', () => {
    for (const t of Object.keys(TRIGGERS) as AutomationTriggerType[]) {
      if (t === T) continue;
      expect(TRIGGERS[t].mergeFields, t).not.toContain('task.cancelled_by');
      expect(TRIGGERS[t].mergeFields, t).not.toContain('task.cancelled_at');
    }
  });
});

// ── Spec B slice 4: the task is gone, and the email still has to name it ──────

describe('catalog - TASK_DELETED', () => {
  it('registers TASK_DELETED as a task event with admin-facing copy', () => {
    expect(TRIGGERS.TASK_DELETED).toMatchObject({
      entity: 'task',
      category: 'events',
      timeBased: false,
    });
    expect(TRIGGERS.TASK_DELETED.label.length).toBeGreaterThan(3);
    expect(TRIGGERS.TASK_DELETED.description.length).toBeGreaterThan(10);
  });

  /**
   * THE trigger-specific rule of this slice, and the one the validator enforces at save.
   *
   * A task deletion is a HARD delete, so when this workflow's email actually goes out there
   * is no row to read a due date, a status, a priority or a live assignee list off. The
   * merge context is built from what the delete handler snapshotted, and that is the number
   * and the title and nothing else. Advertising {{task.due_date}} here would produce an
   * email with a blank where a date should be, which reads as a broken template rather than
   * as a deleted task - so the offer is narrowed to what can honestly be rendered.
   */
  it('offers ONLY the two snapshot identity fields - no due date, status, priority, roster or link', () => {
    expect(TRIGGERS.TASK_DELETED.mergeFields).toEqual([
      'org.name',
      'org.phone',
      'task.number',
      'task.title',
    ]);
  });

  it('is a STRICT SUBSET of the live task triggers - it may never advertise a field they do not', () => {
    const live = new Set(TRIGGERS.TASK_CREATED.mergeFields);
    for (const field of TRIGGERS.TASK_DELETED.mergeFields) {
      expect(live.has(field), `${field} is offered on TASK_DELETED but not on TASK_CREATED`).toBe(true);
    }
    expect(TRIGGERS.TASK_DELETED.mergeFields.length).toBeLessThan(TRIGGERS.TASK_CREATED.mergeFields.length);
  });

  /**
   * The people who were on it - which after the row is gone means the snapshot roster the
   * event carried, resolved by context.ts. `assigned_user` is correctly absent: nobody was
   * just assigned, and a deletion is about the task rather than about one person.
   */
  it('offers the entity-wide task audiences and NOT assigned_user', () => {
    const keys = audiencesFor('TASK_DELETED', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toEqual([
      'assignees',
      'watchers',
      'creator',
      'all_admins',
      'all_dispatchers',
      'specific_user',
      'custom',
    ]);
    expect(keys).not.toContain('customer');
  });

  // Spec C slice 1 rewrote this, as it did on TASK_CREATED, and in the same equivalence form.
  it('offers on a text every audience it offers on an email, minus the email-only custom address', () => {
    expect(audiencesFor('TASK_DELETED', 'SEND_SMS').map((a) => a.key)).toEqual(
      audiencesFor('TASK_DELETED', 'SEND_EMAIL')
        .map((a) => a.key)
        .filter((k) => k !== 'custom'),
    );
    // The legacy six-member list is a DIFFERENT union and Spec C did not touch it: it still
    // narrows SMS to `customer`, which a task does not have. Mirroring one is not evidence
    // for the other - see recipientsFor()'s note in catalog.ts.
    expect(recipientsFor('TASK_DELETED', 'SEND_SMS')).toEqual([]);
  });
});

// ── Spec B slice 5: reminders before a task is due, and chases after ─────────

describe('catalog - TASK_DATE_ANCHORED', () => {
  it('registers TASK_DATE_ANCHORED as a task DATE trigger with admin-facing copy', () => {
    expect(TRIGGERS.TASK_DATE_ANCHORED).toMatchObject({
      entity: 'task',
      category: 'date',
      timeBased: false,
    });
    expect(TRIGGERS.TASK_DATE_ANCHORED.label.length).toBeGreaterThan(3);
    expect(TRIGGERS.TASK_DATE_ANCHORED.description.length).toBeGreaterThan(10);
  });

  it('carries the same task merge fields as TASK_CREATED, and still no customer field', () => {
    expect(TRIGGERS.TASK_DATE_ANCHORED.mergeFields).toEqual(TRIGGERS.TASK_CREATED.mergeFields);
    expect(TRIGGERS.TASK_DATE_ANCHORED.mergeFields).toContain('task.due_date');
    expect(TRIGGERS.TASK_DATE_ANCHORED.mergeFields.some((f) => f.startsWith('customer.'))).toBe(false);
  });

  /**
   * The builder reads ANCHOR_OPTIONS to decide whether the date-mode card is offered at all.
   * An empty list here locks that card, so this is the assertion that says a task workflow
   * can now be authored against a date in the first place.
   */
  it('offers the task due date to the builder, in BOTH directions', () => {
    expect(ANCHOR_OPTIONS.task).toEqual([
      { key: 'task.due_at', label: 'the task due date', directions: ['before', 'after'] },
    ]);
  });

  it('offers the entity-wide task audiences and NOT assigned_user - nobody was just added', () => {
    const keys = audiencesFor('TASK_DATE_ANCHORED', 'SEND_EMAIL').map((a) => a.key);
    expect(keys).toEqual([
      'assignees',
      'watchers',
      'creator',
      'all_admins',
      'all_dispatchers',
      'specific_user',
      'custom',
    ]);
    expect(keys).not.toContain('customer');
  });

  // Spec C slice 1 rewrote this, as it did on TASK_CREATED, and in the same equivalence form.
  it('offers on a text every audience it offers on an email, minus the email-only custom address', () => {
    expect(audiencesFor('TASK_DATE_ANCHORED', 'SEND_SMS').map((a) => a.key)).toEqual(
      audiencesFor('TASK_DATE_ANCHORED', 'SEND_EMAIL')
        .map((a) => a.key)
        .filter((k) => k !== 'custom'),
    );
    // The legacy six-member list is a DIFFERENT union and Spec C did not touch it: it still
    // narrows SMS to `customer`, which a task does not have. Mirroring one is not evidence
    // for the other - see recipientsFor()'s note in catalog.ts.
    expect(recipientsFor('TASK_DATE_ANCHORED', 'SEND_SMS')).toEqual([]);
  });
});

// ── lead.job_type (A2) ───────────────────────────────────────────────────────

describe('catalog — lead.job_type', () => {
  // `job.type` already shipped for the job entity. A lead carries the same
  // column, so the walkthrough automations can name the work they are about.
  // Named lead.job_type, not lead.type — the latter reads as lead source/stage.
  it('every lead-entity trigger advertises lead.job_type alongside the other lead fields', () => {
    for (const t of ALL_TRIGGERS) {
      if (TRIGGERS[t].entity !== 'lead') continue;
      expect(TRIGGERS[t].mergeFields, `${t} should offer lead.job_type`).toContain('lead.job_type');
    }
  });

  it('is not offered on non-lead entities', () => {
    expect(TRIGGERS.JOB_SCHEDULED.mergeFields).not.toContain('lead.job_type');
    expect(TRIGGERS.INVOICE_SENT.mergeFields).not.toContain('lead.job_type');
  });

  it('has a label and sample value (covered by the generic registry test too, asserted here for intent)', () => {
    expect(MERGE_FIELD_LABELS['lead.job_type']).toBe('Job type');
    expect(SAMPLE_CONTEXT['lead.job_type']).toBeTruthy();
  });
});

// ── lead.walkthrough_location ────────────────────────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D5/D6).
//
// The field that makes one automation serve every lead regardless of where each meeting is: the
// value varies per VISIT, which is exactly what an automation body cannot do. Its name is
// load-bearing twice over - the `lead.` prefix is what MergeFieldChips buckets on (a name without
// a known prefix falls silently into "Other"), and "walkthrough" rather than a generic word is
// D5, because the job side gets its own differently-named field.

describe('catalog — lead.walkthrough_location', () => {
  it('rides with the other walkthrough fields on every trigger that offers them', () => {
    for (const t of ALL_TRIGGERS) {
      if (!TRIGGERS[t].mergeFields.includes('lead.walkthrough_date')) continue;
      expect(
        TRIGGERS[t].mergeFields,
        `${t} offers the walkthrough date but not where the walkthrough is`,
      ).toContain('lead.walkthrough_location');
    }
  });

  it('is not offered on non-lead entities', () => {
    expect(TRIGGERS.JOB_SCHEDULED.mergeFields).not.toContain('lead.walkthrough_location');
    expect(TRIGGERS.INVOICE_SENT.mergeFields).not.toContain('lead.walkthrough_location');
  });

  it('is labelled for the surface, not for a generic concept (D5)', () => {
    expect(MERGE_FIELD_LABELS['lead.walkthrough_location']).toBe('Walkthrough visit address');
    expect(SAMPLE_CONTEXT['lead.walkthrough_location']).toBeTruthy();
  });

  it('keeps the lead. prefix the field picker buckets on', () => {
    // Not decoration: MergeFieldChips maps by PREFIX, so `walkthrough.location` would render in
    // "Other" rather than in "Lead & walkthrough" and nothing would say so.
    expect('lead.walkthrough_location'.startsWith('lead.')).toBe(true);
  });
});

// ── job.visit_location ───────────────────────────────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D5/D6).
// Slice: md_files/issues/scheduling/04-give-job-visits-their-own-location.md
//
// The job half of the pair. D6 is why it ships at all - the column is shared, so a lead-only
// field would read as an oversight in the picker. D5 is why it is not called the same thing:
// ServWave's vocabulary distinguishes a walkthrough from a job visit, so the field list does too.
// `lead.address` and `job.address` genuinely mean the same thing and resolve identically; they
// are distinguished only by the entity whose picker they appear in. These two are not the same
// thing at all, which is why the wording separates them as well as the prefix does.

describe('catalog — job.visit_location', () => {
  it('rides with the service address on every trigger that offers one', () => {
    for (const t of ALL_TRIGGERS) {
      if (!TRIGGERS[t].mergeFields.includes('job.address')) continue;
      expect(
        TRIGGERS[t].mergeFields,
        `${t} offers the job's service address but not where the visit actually is`,
      ).toContain('job.visit_location');
    }
  });

  it('is not offered on entities that have no job visit', () => {
    expect(TRIGGERS.INVOICE_SENT.mergeFields).not.toContain('job.visit_location');
    expect(TRIGGERS.WALKTHROUGH_SCHEDULED.mergeFields).not.toContain('job.visit_location');
  });

  it('is labelled for the surface, and NOT with the lead side’s wording (D5)', () => {
    expect(MERGE_FIELD_LABELS['job.visit_location']).toBe('Job visit address');
    expect(SAMPLE_CONTEXT['job.visit_location']).toBeTruthy();
    // The load-bearing half: the two fields are named apart on purpose. Sharing a label would put
    // two chips reading the same words in front of an author who has to tell them apart.
    expect(MERGE_FIELD_LABELS['job.visit_location'])
      .not.toBe(MERGE_FIELD_LABELS['lead.walkthrough_location']);
  });

  it('keeps the job. prefix the field picker buckets on', () => {
    // Not decoration: MergeFieldChips maps by PREFIX, so `visit.location` would render in "Other"
    // rather than in "Job" and nothing would say so.
    expect('job.visit_location'.startsWith('job.')).toBe(true);
  });
});

// ── lead.performer_phones / technician.phones ────────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D7).
// Slice: md_files/issues/scheduling/05-give-the-customer-a-number-that-reaches-the-person-coming.md
//
// A confirmation can already name who is coming; these two are what let it give the customer a way
// to reach them. Each is named for the group it lands in, and each prefix is load-bearing in the
// same way the location pair's is: `lead.` buckets into "Lead & walkthrough" and `technician.`
// into "Job", and a name with no known prefix falls silently into "Other".
//
// The generic registry test above already refuses a field with no label or no sample. These
// assert the INTENT: that the pair rides with the people it describes, and that the two are not
// interchangeable.

describe('catalog — the phone that reaches the person coming', () => {
  it('rides with the walkthrough team on every trigger that names them', () => {
    for (const t of ALL_TRIGGERS) {
      if (!TRIGGERS[t].mergeFields.includes('lead.performer_names')) continue;
      expect(
        TRIGGERS[t].mergeFields,
        `${t} names the walkthrough team but offers no way to reach them`,
      ).toContain('lead.performer_phones');
    }
  });

  it('rides with the crew on every trigger that names them', () => {
    for (const t of ALL_TRIGGERS) {
      if (!TRIGGERS[t].mergeFields.includes('technician.names')) continue;
      expect(
        TRIGGERS[t].mergeFields,
        `${t} names the crew but offers no way to reach them`,
      ).toContain('technician.phones');
    }
  });

  it('does not offer either field on an entity that has neither', () => {
    expect(TRIGGERS.INVOICE_SENT.mergeFields).not.toContain('lead.performer_phones');
    expect(TRIGGERS.INVOICE_SENT.mergeFields).not.toContain('technician.phones');
    expect(TRIGGERS.WALKTHROUGH_SCHEDULED.mergeFields).not.toContain('technician.phones');
    expect(TRIGGERS.JOB_SCHEDULED.mergeFields).not.toContain('lead.performer_phones');
  });

  it('labels each for the group it lands in, and not as each other', () => {
    expect(MERGE_FIELD_LABELS['lead.performer_phones']).toBe('Walkthrough team phone(s)');
    expect(MERGE_FIELD_LABELS['technician.phones']).toBe('Technician phone(s)');
    expect(MERGE_FIELD_LABELS['lead.performer_phones'])
      .not.toBe(MERGE_FIELD_LABELS['technician.phones']);
  });

  it('previews a real contact, and one that is not the main line', () => {
    // The sample is what the builder's live preview renders, so it is where an author learns the
    // format. A sample equal to {{org.phone}}'s would preview as though the field changed nothing
    // - which is the FALLBACK's behaviour, not the field's.
    for (const field of ['lead.performer_phones', 'technician.phones']) {
      expect(SAMPLE_CONTEXT[field], `${field} needs a sample`).toBeTruthy();
      expect(SAMPLE_CONTEXT[field]).not.toBe(SAMPLE_CONTEXT['org.phone']);
    }
    // One of the two shows an extension, because that is the half of the format an author cannot
    // guess: a number and its extension are one reachable contact, not two numbers.
    expect(SAMPLE_CONTEXT['technician.phones']).toContain('ext.');
  });

  it('keeps the prefixes the field picker buckets on', () => {
    expect('lead.performer_phones'.startsWith('lead.')).toBe(true);
    expect('technician.phones'.startsWith('technician.')).toBe(true);
  });
});

// Scheduling-notifications slice 07: the milestone is called "on the way" everywhere a user
// reads it. The trigger KEY stays JOB_EN_ROUTE; only the words an author sees in the trigger
// picker change.
describe('automation catalog - the on-the-way trigger vocabulary', () => {
  it('names the JOB_EN_ROUTE trigger "Technician is on the way"', () => {
    expect(TRIGGERS.JOB_EN_ROUTE.label).toBe('Technician is on the way');
  });

  it('never says "en route" in any trigger label or description', () => {
    for (const t of ALL_TRIGGERS) {
      expect(TRIGGERS[t].label, `${t} label`).not.toMatch(/en[ -]route/i);
      expect(TRIGGERS[t].description, `${t} description`).not.toMatch(/en[ -]route/i);
    }
  });
});

// ── the four address fields read as one family ───────────────────────────────
//
// Ran, 2026-09-15: "we need to rephrase the wording there, because it is not understandable."
//
// The pair that prompted it was 'Service address' and 'Walkthrough location' - two chips in ONE
// picker group naming the same kind of thing with no word in common, so nothing on screen told an
// author which of the two they wanted. Both halves of that are pinned here rather than left to the
// four separate label assertions above, because the defect was never in any single label: it was
// in the relationship between them, and a later rename of one field alone would restore it while
// every per-field test stayed green.

const ADDRESS_FIELDS = [
  'lead.address',
  'lead.walkthrough_location',
  'job.address',
  'job.visit_location',
] as const;

describe('catalog - the address fields are named as a family', () => {
  it('every one of them ends in the noun it actually holds', () => {
    for (const field of ADDRESS_FIELDS) {
      const label = MERGE_FIELD_LABELS[field];
      expect(label, `${field} has no label at all`).toBeTruthy();
      expect(label.toLowerCase(), `${field} is labelled "${label}" - an author cannot tell it holds an address`)
        .toMatch(/ address$/);
    }
  });

  it('never calls one of them a "location", which names no particular thing', () => {
    for (const field of ADDRESS_FIELDS) {
      expect(MERGE_FIELD_LABELS[field].toLowerCase(), `${field} is back to the vague wording`)
        .not.toContain('location');
    }
  });

  it('gives the two that share a picker group different words in front of that noun', () => {
    // `lead.` fields bucket into "Lead & walkthrough" and `job.` fields into "Job"
    // (MergeFieldChips.FIELD_GROUPS), so these are the two collisions an author can actually see.
    expect(MERGE_FIELD_LABELS['lead.address']).not.toBe(MERGE_FIELD_LABELS['lead.walkthrough_location']);
    expect(MERGE_FIELD_LABELS['job.address']).not.toBe(MERGE_FIELD_LABELS['job.visit_location']);
  });

  it('keeps the two service addresses distinguishable from the two visit addresses', () => {
    // The distinction that carries the meaning: one is the address held on the record, the other
    // is where a particular appointment is happening. The word that says so must be present.
    expect(MERGE_FIELD_LABELS['lead.address'].toLowerCase()).toContain('service');
    expect(MERGE_FIELD_LABELS['job.address'].toLowerCase()).toContain('service');
    expect(MERGE_FIELD_LABELS['lead.walkthrough_location'].toLowerCase()).toContain('visit');
    expect(MERGE_FIELD_LABELS['job.visit_location'].toLowerCase()).toContain('visit');
  });
});

// ── lead.performer_servwave_phones / technician.servwave_phones ──────────────
//
// Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md (D7).
// Slice: md_files/issues/scheduling/07-let-the-author-choose-the-servwave-number-instead-of-the-personal-one.md
//
// SIBLINGS OF THE PAIR ABOVE, NOT REPLACEMENTS FOR THEM. Slice 5 answered "give the customer a
// way to reach the person coming" with the person's OWN number - the mobile they typed into My
// Profile. Plenty of organisations will not publish that to every customer on every confirmation,
// and the capability should not be the price of declining. So a second pair renders the
// ORGANISATION'S number for the same people, and the template says which of the two this
// organisation is willing to print. Both live in the same group; the author picks.
//
// The generic registry test at the top of this file already refuses a field with no label or no
// sample. These assert the INTENT: that the four fields are four different things, that the pair
// rides with the people it describes, and that nothing rendered here names the telephony vendor.

describe('catalog — the organisation’s own number for the person coming', () => {
  const SERVWAVE_PAIR = ['lead.performer_servwave_phones', 'technician.servwave_phones'];
  const PERSONAL_PAIR = ['lead.performer_phones', 'technician.phones'];

  it('rides with the walkthrough team on every trigger that names them', () => {
    for (const t of ALL_TRIGGERS) {
      if (!TRIGGERS[t].mergeFields.includes('lead.performer_names')) continue;
      expect(
        TRIGGERS[t].mergeFields,
        `${t} names the walkthrough team but offers no organisation number for them`,
      ).toContain('lead.performer_servwave_phones');
    }
  });

  it('rides with the crew on every trigger that names them', () => {
    for (const t of ALL_TRIGGERS) {
      if (!TRIGGERS[t].mergeFields.includes('technician.names')) continue;
      expect(
        TRIGGERS[t].mergeFields,
        `${t} names the crew but offers no organisation number for them`,
      ).toContain('technician.servwave_phones');
    }
  });

  it('offers each beside the personal field it is the alternative to, never instead of it', () => {
    // The author chooses per template, so both have to be in the picker at the same time. A
    // trigger offering one and not the other has taken the decision away from them.
    for (const t of ALL_TRIGGERS) {
      const offered = TRIGGERS[t].mergeFields;
      expect(offered.includes('lead.performer_phones'))
        .toBe(offered.includes('lead.performer_servwave_phones'));
      expect(offered.includes('technician.phones'))
        .toBe(offered.includes('technician.servwave_phones'));
    }
  });

  it('does not offer either field on an entity that has neither', () => {
    expect(TRIGGERS.INVOICE_SENT.mergeFields).not.toContain('lead.performer_servwave_phones');
    expect(TRIGGERS.INVOICE_SENT.mergeFields).not.toContain('technician.servwave_phones');
    expect(TRIGGERS.WALKTHROUGH_SCHEDULED.mergeFields).not.toContain('technician.servwave_phones');
    expect(TRIGGERS.JOB_SCHEDULED.mergeFields).not.toContain('lead.performer_servwave_phones');
  });

  it('says ServWave in both labels, and names the two sides apart', () => {
    expect(MERGE_FIELD_LABELS['lead.performer_servwave_phones'])
      .toBe('Walkthrough team ServWave phone(s)');
    expect(MERGE_FIELD_LABELS['technician.servwave_phones'])
      .toBe('Technician ServWave phone(s)');
    // Four fields, four labels. An author scanning the picker has to be able to tell which of the
    // two numbers a chip prints, and the only thing that tells them is the label.
    const labels = [...SERVWAVE_PAIR, ...PERSONAL_PAIR].map((f) => MERGE_FIELD_LABELS[f]);
    expect(new Set(labels).size).toBe(4);
  });

  it('previews a plausible number that is not the main line, the personal one, or its twin', () => {
    // The sample is what the builder's live preview renders, so it is where an author sees what
    // choosing this chip over its sibling actually changes. Four samples that matched would
    // preview as though all four fields were one field.
    for (const field of SERVWAVE_PAIR) {
      expect(SAMPLE_CONTEXT[field], `${field} needs a sample`).toBeTruthy();
      expect(SAMPLE_CONTEXT[field]).toMatch(/\(555\) \d{3}-\d{4}/);
    }
    const samples = [...SERVWAVE_PAIR, ...PERSONAL_PAIR, 'org.phone'].map((f) => SAMPLE_CONTEXT[f]);
    expect(new Set(samples).size).toBe(5);
  });

  it('attaches no extension, because there is none to attach', () => {
    // An extension belongs to `User.phone_ext` and describes the switchboard behind the PERSONAL
    // number. Borrowing it here would print a routing code that does not exist on this line.
    for (const field of SERVWAVE_PAIR) {
      expect(SAMPLE_CONTEXT[field]).not.toContain('ext.');
    }
  });

  it('keeps the prefixes the field picker buckets on', () => {
    // Load-bearing, exactly as for the pair above: MergeFieldChips maps by PREFIX, and a name with
    // no known one falls silently into "Other" rather than beside the team it describes.
    expect('lead.performer_servwave_phones'.startsWith('lead.')).toBe(true);
    expect('technician.servwave_phones'.startsWith('technician.')).toBe(true);
  });

  it('names no telephony vendor anywhere an author can read', () => {
    // CLAUDE.md's boundary, asserted over the WHOLE registry rather than over the two new entries:
    // every capability is presented as ServWave's own, and a label, a sample or a field name is
    // about as user-visible as backend copy gets. `PhoneNumber.source` ('ctm' | 'byo') stays a
    // storage detail - it is never rendered and never offered as a choice.
    const vendor = /\bctm\b|calltrackingmetrics|call ?tracking ?metrics/i;
    for (const [field, label] of Object.entries(MERGE_FIELD_LABELS)) {
      expect(field, `${field} names a vendor`).not.toMatch(vendor);
      expect(label, `${field}'s label names a vendor`).not.toMatch(vendor);
    }
    for (const [field, sample] of Object.entries(SAMPLE_CONTEXT)) {
      expect(sample, `${field}'s sample names a vendor`).not.toMatch(vendor);
    }
  });
});

// SRVW-303 - the owner sign-off fields ride the entity prefixes the chip picker already groups
// (`lead.` -> "Lead & walkthrough", `job.` -> "Job", `estimate.` -> "Estimate"), so pinning them
// on every trigger of the three entities is the whole frontend contract.
describe('automation catalog - owner merge fields (SRVW-303)', () => {
  const OWNER_FIELDS: Record<string, string[]> = {
    lead: ['lead.owner_name', 'lead.owner_first_name'],
    job: ['job.owner_name', 'job.owner_first_name'],
    estimate: ['estimate.owner_name', 'estimate.owner_first_name'],
  };

  it('every lead, job and estimate trigger offers both owner fields; no other entity does', () => {
    for (const t of ALL_TRIGGERS) {
      const entity = TRIGGERS[t].entity;
      const expected = OWNER_FIELDS[entity] ?? [];
      for (const f of expected) {
        expect(TRIGGERS[t].mergeFields, `${t} is missing {{${f}}}`).toContain(f);
      }
      const strays = TRIGGERS[t].mergeFields.filter((f) => /\.owner_(first_)?name$/.test(f) && !expected.includes(f));
      expect(strays, `${t} offers an owner field for another entity`).toEqual([]);
    }
  });

  it('labels say "owner", the word the lead form and the leads table already use', () => {
    expect(MERGE_FIELD_LABELS['lead.owner_name']).toBe('Lead owner name');
    expect(MERGE_FIELD_LABELS['lead.owner_first_name']).toBe('Lead owner first name');
    expect(MERGE_FIELD_LABELS['job.owner_name']).toBe('Job owner name');
    expect(MERGE_FIELD_LABELS['job.owner_first_name']).toBe('Job owner first name');
    expect(MERGE_FIELD_LABELS['estimate.owner_name']).toBe('Estimate owner name');
    expect(MERGE_FIELD_LABELS['estimate.owner_first_name']).toBe('Estimate owner first name');
    // The first-name sample is the first word of the full-name sample, so the preview shows the
    // two fields are one person rather than two.
    for (const p of ['lead', 'job', 'estimate']) {
      expect(SAMPLE_CONTEXT[`${p}.owner_name`].split(' ')[0]).toBe(SAMPLE_CONTEXT[`${p}.owner_first_name`]);
    }
  });
});
