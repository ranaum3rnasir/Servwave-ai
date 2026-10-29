import { describe, it, expect } from 'vitest';
import { DEFAULT_MERGE_FIELD_FALLBACKS, fallbacksFor } from '../mergeFieldFallbacks';
import { SERVICE_ADDRESS_FALLBACK } from '../../visitLocation';
import { MAIN_LINE_FALLBACK } from '../../performerPhone';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import { renderMergeFields } from '../renderMergeFields';

/**
 * "If empty, fill with" - the seeded defaults and how a stored step config is read.
 *
 * Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
 * The context builders inject nothing any more (context.technicianFallback.test.ts), so what keeps
 * an untouched template rendering exactly as it did is this module.
 *
 * 2026-09-15 (Ran): the defaults are now MERGED UNDER a stored map rather than replaced by it, and
 * nine more fields joined them. Both halves are pinned below, and the merge is the half that is
 * easy to mistake for a nicety: every stored map is a SNAPSHOT of these defaults as they stood
 * when it was written - `seedDefaultAutomations.ts` writes one into every seeded step - so under
 * the old as-is rule a newly added key reached NO existing automation in ANY organisation, and
 * each of the nine new fields would have rendered a hole in a live customer send.
 */

describe('DEFAULT_MERGE_FIELD_FALLBACKS', () => {
  it('names the crew, the greeting, the addresses, the phones and the two staff words, and nothing else', () => {
    expect(DEFAULT_MERGE_FIELD_FALLBACKS).toEqual({
      'technician.names': 'Our team',
      'technician.first_name': 'Our technician',
      'lead.performer_names': 'Our team',
      'customer.first_name': 'there',

      'lead.address': 'the address we have on file for you',
      'job.address': 'the address we have on file for you',
      'lead.walkthrough_location': 'the address we have on file for you',
      'job.visit_location': 'the address we have on file for you',

      'org.phone': 'our office',
      'technician.phones': 'our office',
      'technician.servwave_phones': 'our office',
      'lead.performer_phones': 'our office',
      'lead.performer_servwave_phones': 'our office',

      'job.scope_notes': 'not specified',
      'task.assignee_names': 'nobody yet',

      // SRVW-303: the owner sign-off. An unsigned email is worse than one signed by the team.
      'lead.owner_name': 'Our team',
      'lead.owner_first_name': 'Our team',
      'job.owner_name': 'Our team',
      'job.owner_first_name': 'Our team',
      'estimate.owner_name': 'Our team',
      'estimate.owner_first_name': 'Our team',
    });
  });

  /**
   * The two phrases are written as LITERALS above and asserted against their imported source here,
   * rather than being interpolated from it. Interpolating is the tempting shape and it cannot
   * fail: rewording `SERVICE_ADDRESS_FALLBACK` would rewrite the expectation in the same motion
   * and this file would stay green over nine fields whose customer-facing wording had silently
   * changed. Two assertions, so a drift is a failure rather than a rename.
   */
  it('takes its wording from the modules that own it, so one email cannot offer two phrasings', () => {
    expect(SERVICE_ADDRESS_FALLBACK).toBe('the address we have on file for you');
    expect(MAIN_LINE_FALLBACK).toBe('our office');
  });

  // Within a family the value comes off ONE resolution (context.ts), so two fields in a family
  // rendering different words would be one email answering the same absent thing twice.
  it('gives every field in a family the same words', () => {
    const addresses = ['lead.address', 'job.address', 'lead.walkthrough_location', 'job.visit_location'];
    const phones = [
      'org.phone', 'technician.phones', 'technician.servwave_phones',
      'lead.performer_phones', 'lead.performer_servwave_phones',
    ];
    expect(new Set(addresses.map((f) => DEFAULT_MERGE_FIELD_FALLBACKS[f])).size).toBe(1);
    expect(new Set(phones.map((f) => DEFAULT_MERGE_FIELD_FALLBACKS[f])).size).toBe(1);
  });
});

describe('fallbacksFor', () => {
  it('reads a step config with no fallbacks key as the default set', () => {
    expect(fallbacksFor({ recipients: ['customer'], subject: 's', body: 'b' })).toEqual(DEFAULT_MERGE_FIELD_FALLBACKS);
  });

  it('lets an author who CLEARED a fallback keep the empty field', () => {
    // Clearing stores the key with '' - it does not delete it (frontend/src/lib/workflows/
    // fallbacks.ts) - so the merge below cannot resurrect a default the author deliberately
    // emptied. This is the assertion that makes merging safe rather than presumptuous.
    expect(fallbacksFor({ body: 'b', fallbacks: { 'technician.names': '' } })['technician.names']).toBe('');
  });

  /**
   * THE SNAPSHOT TEST, and the reason the read is a merge at all.
   *
   * A map written before a default existed cannot carry it. `seedDefaultAutomations.ts` writes
   * `fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS }` into every seeded step, so EVERY automation
   * in EVERY organisation holds exactly such a snapshot. Read as-is, a field added to the defaults
   * resolves '' with no fallback declared and `renderMergeFields` puts a HOLE in a customer's
   * email - which is D7, in the one place D7 was supposed to have been moved to.
   */
  it('fills a gap a stored snapshot never had the chance to carry', () => {
    const snapshot = { body: 'b', fallbacks: { 'technician.names': 'the crew' } };
    const read = fallbacksFor(snapshot);

    expect(read['technician.names']).toBe('the crew');
    for (const [field, text] of Object.entries(DEFAULT_MERGE_FIELD_FALLBACKS)) {
      if (field === 'technician.names') continue;
      expect(read[field], `${field} lost its default to an older snapshot`).toBe(text);
    }
  });

  it('drops non-string values back to the default, and treats a non-object config as untouched', () => {
    // A malformed value is not an author's choice, so it falls back to the default rather than to
    // nothing: answering `fallbacks: { 'job.address': 42 }` with a hole in a customer's email is
    // the worse of the two readings.
    expect(fallbacksFor({ body: 'b', fallbacks: { 'job.address': 7 } })['job.address'])
      .toBe(DEFAULT_MERGE_FIELD_FALLBACKS['job.address']);
    expect(fallbacksFor(null)).toEqual(DEFAULT_MERGE_FIELD_FALLBACKS);
    expect(fallbacksFor({ body: 'b', fallbacks: 'nope' })).toEqual(DEFAULT_MERGE_FIELD_FALLBACKS);
    expect(fallbacksFor({ body: 'b', fallbacks: {} })).toEqual(DEFAULT_MERGE_FIELD_FALLBACKS);
  });
});

describe('the seeded job-scheduled template, untouched, renders exactly as before', () => {
  it("still says \"Who's coming: Our team.\" for a crewless job", () => {
    const automation = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === 'default-job-scheduled')!;
    // A step published before fallbacks existed: recipients + subject + body, no fallbacks key.
    const storedConfig = { recipients: automation.recipients, subject: automation.subject, body: automation.body };
    // The mergeCtx a crewless job now produces: the crew field is EMPTY.
    const ctx: Record<string, string> = {
      'customer.first_name': 'Sarah',
      'job.number': 'J00099',
      'job.scheduled_date': 'Sat, Aug 1',
      'job.scheduled_time': '11:00 AM',
      'job.address': '123 Main St, Raleigh, NC',
      'technician.names': '',
    };

    const rendered = renderMergeFields(automation.body, ctx, { html: false, fallbacks: fallbacksFor(storedConfig) });

    expect(rendered).toBe(
      "Hi Sarah, your service J00099 has been scheduled for Sat, Aug 1 at 11:00 AM. Who's coming: Our team. Address: 123 Main St, Raleigh, NC.",
    );
  });
});

/**
 * THE DEAD BOX, AND THE PROOF IT IS ALIVE (Ran, 2026-09-15).
 *
 * Until this change, nine fields resolved through a formatter that substituted a phrase of its
 * own BEFORE the renderer was consulted. `renderMergeFields`'s rule is "empty -> the author's
 * text", and the value was never empty, so an author typing into "If empty, fill with" on any of
 * those nine was typing into a control that did nothing. No warning, no indication, no effect.
 *
 * These two tests are the before-and-after of that, and neither is satisfied by the other: the
 * first says the author's words WIN, the second says the built-in words still ARRIVE for every
 * step written before the box worked. A fix with only the first regresses every existing send;
 * a fix with only the second is the dead box again.
 */
describe('the author owns the words now', () => {
  /** A crewless trip at a parent with no address on file: the state all nine fields answer for. */
  const NOTHING_KNOWN: Record<string, string> = {
    'job.visit_location': '',
    'technician.phones': '',
    'org.phone': '',
  };

  it("renders the AUTHOR's text for a field whose box used to do nothing", () => {
    const authored = {
      body: 'b',
      fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS, 'job.visit_location': 'the yard on Depot Road' },
    };

    expect(
      renderMergeFields('Please meet us at {{job.visit_location}}.', NOTHING_KNOWN, {
        html: false,
        fallbacks: fallbacksFor(authored),
      }),
    ).toBe('Please meet us at the yard on Depot Road.');
  });

  it('renders OUR text for a step written before the box worked, with no migration', () => {
    // Exactly what `seedDefaultAutomations.ts` has written into every seeded step in every
    // organisation since the fallback feature shipped: a snapshot of the four defaults that
    // existed then. None of the nine is in it, and none of them can be.
    const preExisting = {
      body: 'b',
      fallbacks: {
        'technician.names': 'Our team',
        'technician.first_name': 'Our technician',
        'lead.performer_names': 'Our team',
        'customer.first_name': 'there',
      },
    };

    const rendered = renderMergeFields(
      'Please meet us at {{job.visit_location}}. Call {{org.phone}}.',
      NOTHING_KNOWN,
      { html: false, fallbacks: fallbacksFor(preExisting) },
    );

    expect(rendered).toBe('Please meet us at the address we have on file for you. Call our office.');
    // The defect this exact string is the cure for, stated as the sentence a customer read on
    // staging on 2026-09-12.
    expect(rendered).not.toMatch(/(^|\s)[.,](\s|$)/);
  });

  it('honours a cleared box, even on a field that used to ignore it entirely', () => {
    // '' is a deliberate choice - the author wants the line to disappear, not to be filled with
    // words the product chose. The merge must not resurrect the default over it.
    const cleared = { body: 'b', fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS, 'technician.phones': '' } };

    expect(
      renderMergeFields('Reach the crew on {{technician.phones}}', NOTHING_KNOWN, {
        html: false,
        fallbacks: fallbacksFor(cleared),
      }),
    ).toBe('Reach the crew on ');
  });
});

/**
 * THE THREE SEEDED STAFF BODIES, AND WHY THEIR WORDS HAD TO MOVE RATHER THAN GO.
 *
 * `context.ts` stopped substituting `SCOPE_NOTES_FALLBACK` and `TASK_ASSIGNEES_FALLBACK` when it
 * stopped substituting everything else, and for the same reason: a builder that fills a field
 * pre-empts the author's box. Unlike the customer-facing fields, though, these two land in copy
 * WE ship - `default-tech-assigned` ends "Scope: {{job.scope_notes}}", and both
 * `default-task-created` and `default-task-assigned` carry "Everyone on it:
 * {{task.assignee_names}}." - so removing the phrase without seeding it here would have sent
 * "Scope: " and "Everyone on it: ." to real staff. That is D7's hole, in the one layer D7 was
 * supposed to have been moved to.
 *
 * Two halves, and neither is satisfied by the other. The first says OUR words still arrive, for
 * every step written before either default existed. The second says the AUTHOR's words beat them
 * - which is the whole point of the move, and the regression a phrase put back in `context.ts`
 * would cause silently, because the field would never go empty for the renderer to act on.
 */
describe('the seeded staff bodies that carry the two moved words', () => {
  /** A job whose scope was never filled in, and a task nobody is on: what both fields answer for. */
  const NOTHING_KNOWN: Record<string, string> = {
    'job.number': 'J00099',
    'customer.full_name': 'Harbor Cabinet Co',
    'job.address': '123 Main St, Raleigh, NC',
    'job.scheduled_date': 'Sat, Aug 1',
    'job.scheduled_time': '11:00 AM',
    'job.scope_notes': '',
    'org.name': 'Blue Ridge Plumbing',
    'task.number': 'T00042',
    'task.title': 'Order the replacement thermostat',
    'task.priority': 'Low',
    'task.link': 'https://app.example.com/tasks?task=t1',
    'task.assignee_names': '',
  };

  const CARRIERS = ['default-tech-assigned', 'default-task-created', 'default-task-assigned'];

  it.each(CARRIERS)('renders %s with no hole for a step that carries no fallbacks key', (key) => {
    const automation = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === key)!;
    // A step published before either default existed: recipients + subject + body and NO
    // `fallbacks` key, which is exactly what `fallbacksFor`'s merge has to answer for.
    const stored = { recipients: automation.recipients, subject: automation.subject, body: automation.body };

    const rendered = renderMergeFields(automation.body, NOTHING_KNOWN, {
      html: false,
      fallbacks: fallbacksFor(stored),
    });

    // Neither half of the trap: no token leaking through, and no stop or comma with nothing in
    // front of it - which is the exact shape of "Scope: " and "Everyone on it: ."
    expect(rendered).not.toContain('{{');
    expect(rendered, `${key} rendered a hole`).not.toMatch(/(^|\s)[.,](\s|$)/);
  });

  it('says "Scope: not specified" and "Everyone on it: nobody yet." - the words that ship today', () => {
    // Stated as LITERALS rather than read back out of the map: the point of the move was that
    // nothing renders differently, and an expectation interpolated from the default could not
    // fail if the wording drifted.
    const assigned = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === 'default-tech-assigned')!;
    const created = DEFAULT_AUTOMATIONS.find((a) => a.builtin_key === 'default-task-created')!;
    const seeded = { html: false as const, fallbacks: fallbacksFor({ body: 'b' }) };

    expect(renderMergeFields(assigned.body, NOTHING_KNOWN, seeded)).toContain('Scope: not specified');
    expect(renderMergeFields(created.body, NOTHING_KNOWN, seeded)).toContain('Everyone on it: nobody yet.');
  });

  it("lets the AUTHOR's own text beat the seeded default on both fields", () => {
    const authored = {
      body: 'b',
      fallbacks: {
        ...DEFAULT_MERGE_FIELD_FALLBACKS,
        'job.scope_notes': 'see the work order',
        'task.assignee_names': 'unassigned - please claim it',
      },
    };
    const fallbacks = fallbacksFor(authored);

    expect(renderMergeFields('Scope: {{job.scope_notes}}', NOTHING_KNOWN, { html: false, fallbacks }))
      .toBe('Scope: see the work order');
    expect(renderMergeFields('Everyone on it: {{task.assignee_names}}.', NOTHING_KNOWN, { html: false, fallbacks }))
      .toBe('Everyone on it: unassigned - please claim it.');
  });

  it('honours a CLEARED box on both, so an author can drop the words rather than replace them', () => {
    // '' is a deliberate choice and clearing STORES the key rather than deleting it, so the merge
    // must not resurrect the default over it - the same guarantee the nine fields above carry.
    const cleared = {
      body: 'b',
      fallbacks: { ...DEFAULT_MERGE_FIELD_FALLBACKS, 'job.scope_notes': '', 'task.assignee_names': '' },
    };
    const fallbacks = fallbacksFor(cleared);

    expect(renderMergeFields('{{job.scope_notes}}', NOTHING_KNOWN, { html: false, fallbacks })).toBe('');
    expect(renderMergeFields('{{task.assignee_names}}', NOTHING_KNOWN, { html: false, fallbacks })).toBe('');
  });
});
