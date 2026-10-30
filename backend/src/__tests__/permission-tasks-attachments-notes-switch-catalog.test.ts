/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.11 - the Tasks, Events and Notes groups of the switch catalog, and the
   Edit jobs / Edit leads switches that notes no longer ride on. Uploads are the record's own data (P10, A8d), so the
   Attachments group and Delete other people's notes are gone.

   Pure: no database. The expected values are the PRD's catalog table, written out as literals here (they
   are the source of truth the catalog is built from), never read back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_ROLES,
  SWITCH_CATALOG,
  findSwitch,
  presetSwitchSet,
} from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { compileSwitchGrants } from '../lib/permissions/switches/store';

type Row = [admin: boolean | string, sales: boolean | string, dispatcher: boolean | string, technician: boolean | string];

const TASK_ROWS: Record<string, Row> = {
  'View tasks': [true, true, true, true],
  'Create tasks': [true, true, true, true],
  'Edit tasks': [true, true, true, true],
  'Delete tasks': [true, true, true, false],
  'Assign tasks to others': [true, false, true, false],
  // The See-all toggle is the module's one scope switch now (P6): Attached, Team or All, Dispatcher on All as before.
  'Tasks scope': ['all', 'attached', 'all', 'attached'],
};
const EVENT_ROWS: Record<string, Row> = {
  'View events': [true, false, true, true],
  'Create events': [true, false, true, false],
  'Edit events': [true, false, true, false],
  'Delete events': [true, false, true, false],
  'Events scope': ['all', 'attached', 'all', 'attached'],
};
const NOTE_ROWS: Record<string, Row> = {
  'Add notes': [true, true, true, true],
};
const GROUPS: Record<string, Record<string, Row>> = {
  Tasks: TASK_ROWS,
  Events: EVENT_ROWS,
  Notes: NOTE_ROWS,
};

const keyOfLabel = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)?.key;
const entryOf = (label: string) => {
  const key = keyOfLabel(label);
  expect(key, `a switch labelled "${label}"`).toBeDefined();
  return findSwitch(key!)!;
};
const pairs = (label: string) => entryOf(label).grants.map((g) => `${g.action}:${g.subject}`);

describe('the Tasks, Events and Notes rows of the switch catalog', () => {
  it('hold every switch the PRD lists, in its group, with the four preset values and help text', () => {
    for (const [group, rows] of Object.entries(GROUPS)) {
      for (const [label, [admin, sales, dispatcher, technician]] of Object.entries(rows)) {
        const entry = entryOf(label);
        expect(entry.module, label).toBe(group);
        expect(entry.helpText.length, label).toBeGreaterThan(0);
        expect(entry.presets, label).toEqual({ ADMIN: admin, SALES: sales, DISPATCHER: dispatcher, TECHNICIAN: technician });
      }
    }
  });

  it('hold nothing else in those groups', () => {
    for (const [group, rows] of Object.entries(GROUPS)) {
      const labels = SWITCH_CATALOG.filter((s) => s.module === group).map((s) => s.label);
      expect(labels.sort(), group).toEqual(Object.keys(rows).sort());
    }
  });

  it('pass the catalog validator for every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });

  it('name a server check for each switch, or say which slice builds it', () => {
    for (const rows of Object.values(GROUPS)) {
      for (const label of Object.keys(rows)) {
        const entry = entryOf(label);
        expect(entry.serverChecks.length > 0 || Boolean(entry.pending), label).toBe(true);
      }
    }
  });

  it('name no vendor in a label or help text', () => {
    for (const rows of Object.values(GROUPS)) {
      for (const label of Object.keys(rows)) {
        const entry = entryOf(label);
        expect(`${entry.label} ${entry.helpText}`, label).not.toMatch(/\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics)\b/i);
      }
    }
  });
});

describe('Requires in the Tasks, Events and Notes groups', () => {
  it('puts every other Tasks switch under View tasks', () => {
    for (const label of ['Edit tasks', 'Delete tasks', 'Assign tasks to others']) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View tasks')]);
    }
    // Create needs Edit (P2, AL-04).
    expect(entryOf('Create tasks').requires).toEqual([keyOfLabel('View tasks'), keyOfLabel('Edit tasks')]);
    // A scope is a choice over the module's rows, not a verb: it needs nothing and offers the standard three.
    expect(entryOf('Tasks scope').requires).toEqual([]);
    expect(entryOf('Tasks scope').choices).toEqual(['attached', 'team', 'all']);
  });

  it('puts every other Events switch under View events, and Events scope is the standard three-choice scope', () => {
    for (const label of ['Edit events', 'Delete events']) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View events')]);
    }
    expect(entryOf('Create events').requires).toEqual([keyOfLabel('View events'), keyOfLabel('Edit events')]);
    expect(entryOf('Events scope').requires).toEqual([]);
    expect(entryOf('Events scope').choices).toEqual(['attached', 'team', 'all']);
  });

  it('has no Attachments switch and no Delete-other-people\'s-notes switch: uploads and notes are the record\'s own data (P10)', () => {
    const keys = SWITCH_CATALOG.map((x) => x.key);
    for (const retired of ['view_attachments', 'upload_attachments', 'edit_attachments', 'delete_attachments', 'delete_others_notes']) {
      expect(keys, retired).not.toContain(retired);
    }
    expect(SWITCH_CATALOG.some((x) => x.module === 'Attachments')).toBe(false);
    expect(SWITCH_CATALOG.some((x) => x.grants.some((g) => g.subject === 'Attachment' || (g.action as string) === 'delete_others_note'))).toBe(false);
  });

  it('needs nothing for Add notes: a note belongs to the job or lead the person can open', () => {
    for (const label of Object.keys(NOTE_ROWS)) expect(entryOf(label).requires, label).toEqual([]);
    const noView = { ...presetSwitchSet('ADMIN'), view_tasks: false, view_events: false };
    const refused = validateSwitchSet(noView).map((v) => v.switchKey);
    expect(refused).not.toContain(keyOfLabel('Add notes'));
  });

  it('refuses a value Tasks scope does not offer, and has no See-all toggle left (P6)', () => {
    const set = { ...presetSwitchSet('ADMIN'), tasks_scope: 'everyone' };
    expect(validateSwitchSet(set).some((v) => v.switchKey === keyOfLabel('Tasks scope'))).toBe(true);
    expect(SWITCH_CATALOG.map((s) => s.label)).not.toContain('See all tasks');
    expect(SWITCH_CATALOG.map((s) => s.label)).not.toContain('See all calendar entries');
  });
});

describe('what these switches compile into', () => {
  it('maps the task switches onto the Task subject; Tasks scope compiles into no grant of its own', () => {
    expect(pairs('View tasks')).toEqual(['read:Task']);
    expect(pairs('Create tasks')).toEqual(['create:Task']);
    expect(pairs('Edit tasks')).toEqual(['update:Task']);
    expect(pairs('Delete tasks')).toEqual(['delete:Task']);
    expect(pairs('Assign tasks to others')).toEqual(['assign:Task']);
    expect(pairs('Tasks scope')).toEqual([]);
  });

  it('maps the event switches onto the CalendarEntry subject; Events scope compiles into no grant of its own', () => {
    expect(pairs('View events')).toEqual(['read:CalendarEntry']);
    expect(pairs('Create events')).toEqual(['create:CalendarEntry']);
    expect(pairs('Edit events')).toEqual(['update:CalendarEntry']);
    expect(pairs('Delete events')).toEqual(['delete:CalendarEntry']);
    expect(pairs('Events scope')).toEqual([]);
  });

  it('gives Add notes an action of its own on jobs and on leads, apart from Edit jobs and Edit leads', () => {
    expect(pairs('Add notes').sort()).toEqual(['add_note:Job', 'add_note:Lead']);
    expect(pairs('Edit jobs')).toEqual(['update:Job']);
    expect(pairs('Edit leads')).toEqual(['update:Lead']);
    expect(pairs('Edit jobs')).not.toContain('add_note:Job');
  });

  it('compiles the Technician preset into Add notes and Edit jobs and leads (Their own, AL-04), and no task-wide delete', () => {
    const tech = compileSwitchGrants(presetSwitchSet('TECHNICIAN')).map((g) => `${g.action}:${g.subject}`);
    expect(tech).toEqual(expect.arrayContaining(['add_note:Job', 'add_note:Lead']));
    expect(tech).toEqual(expect.arrayContaining(['update:Job', 'update:Lead']));
    expect(tech).not.toContain('assign:Task');
  });

  it('compiles the Dispatcher preset into assigning tasks and editing jobs and leads; the scope is a value, not a grant', () => {
    const dispatcher = compileSwitchGrants(presetSwitchSet('DISPATCHER')).map((g) => `${g.action}:${g.subject}`);
    expect(dispatcher).toEqual(expect.arrayContaining(['assign:Task', 'update:Job', 'update:Lead']));
    expect(dispatcher.some((g) => g.startsWith('see_all'))).toBe(false);
    expect(presetSwitchSet('DISPATCHER').tasks_scope).toBe('all');
    expect(presetSwitchSet('SALES').tasks_scope).toBe('attached');
  });
});
