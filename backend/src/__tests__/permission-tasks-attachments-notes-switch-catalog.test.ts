/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.11 - the Tasks, Events, Attachments and Notes groups of the switch
   catalog, and the Edit jobs / Edit leads switches that notes no longer ride on.

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

type Row = [admin: boolean, sales: boolean, dispatcher: boolean, technician: boolean];

const TASK_ROWS: Record<string, Row> = {
  'View tasks': [true, true, true, true],
  'Create tasks': [true, true, true, true],
  'Edit tasks': [true, true, true, true],
  'Delete tasks': [true, true, true, false],
  'Show Tasks page': [true, true, true, true],
  'Assign tasks to others': [true, false, true, false],
  'See all tasks': [true, false, true, false],
};
const EVENT_ROWS: Record<string, Row> = {
  'View events': [true, false, true, true],
  'Create events': [true, false, true, false],
  'Edit events': [true, false, true, false],
  'Delete events': [true, false, true, false],
  'See all calendar entries': [true, false, true, false],
};
const ATTACHMENT_ROWS: Record<string, Row> = {
  'View attachments': [true, true, true, true],
  'Upload attachments': [true, true, true, true],
  'Edit attachments': [true, true, true, false],
  'Delete attachments': [true, true, true, false],
};
const NOTE_ROWS: Record<string, Row> = {
  'Add notes': [true, true, true, true],
  "Delete other people's notes": [true, false, true, false],
};
const GROUPS: Record<string, Record<string, Row>> = {
  Tasks: TASK_ROWS,
  Events: EVENT_ROWS,
  Attachments: ATTACHMENT_ROWS,
  Notes: NOTE_ROWS,
};

const keyOfLabel = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)?.key;
const entryOf = (label: string) => {
  const key = keyOfLabel(label);
  expect(key, `a switch labelled "${label}"`).toBeDefined();
  return findSwitch(key!)!;
};
const pairs = (label: string) => entryOf(label).grants.map((g) => `${g.action}:${g.subject}`);

describe('the Tasks, Events, Attachments and Notes rows of the switch catalog', () => {
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

describe('Requires in the Tasks, Events, Attachments and Notes groups', () => {
  it('puts every other Tasks switch under View tasks', () => {
    for (const label of ['Create tasks', 'Edit tasks', 'Delete tasks', 'Show Tasks page', 'Assign tasks to others', 'See all tasks']) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View tasks')]);
    }
  });

  it('puts every other Events switch under View events, See all calendar entries included', () => {
    for (const label of ['Create events', 'Edit events', 'Delete events', 'See all calendar entries']) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View events')]);
    }
  });

  it('puts upload, edit and delete of attachments under View attachments', () => {
    for (const label of ['Upload attachments', 'Edit attachments', 'Delete attachments']) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View attachments')]);
    }
  });

  it('needs nothing for the two note switches: a note belongs to the job or lead the person can open', () => {
    for (const label of Object.keys(NOTE_ROWS)) expect(entryOf(label).requires, label).toEqual([]);
    const noView = { ...presetSwitchSet('ADMIN'), view_tasks: false, view_events: false, view_attachments: false };
    const refused = validateSwitchSet(noView).map((v) => v.switchKey);
    expect(refused).not.toContain(keyOfLabel('Add notes'));
    expect(refused).not.toContain(keyOfLabel("Delete other people's notes"));
  });

  it('refuses See all tasks on with View tasks off', () => {
    const set = { ...presetSwitchSet('ADMIN'), view_tasks: false };
    expect(validateSwitchSet(set).some((v) => v.switchKey === keyOfLabel('See all tasks'))).toBe(true);
  });
});

describe('what these switches compile into', () => {
  it('maps the task switches onto the Task subject, with See all tasks as an action of its own', () => {
    expect(pairs('View tasks')).toEqual(['read:Task']);
    expect(pairs('Create tasks')).toEqual(['create:Task']);
    expect(pairs('Edit tasks')).toEqual(['update:Task']);
    expect(pairs('Delete tasks')).toEqual(['delete:Task']);
    expect(pairs('Assign tasks to others')).toEqual(['assign:Task']);
    expect(pairs('See all tasks')).toEqual(['see_all:Task']);
    expect(pairs('Show Tasks page')).toEqual([]);
  });

  it('maps the event switches onto the CalendarEntry subject, See all calendar entries onto its own action', () => {
    expect(pairs('View events')).toEqual(['read:CalendarEntry']);
    expect(pairs('Create events')).toEqual(['create:CalendarEntry']);
    expect(pairs('Edit events')).toEqual(['update:CalendarEntry']);
    expect(pairs('Delete events')).toEqual(['delete:CalendarEntry']);
    expect(entryOf('See all calendar entries').pending).toBeUndefined();
    expect(pairs('See all calendar entries')).toEqual(['see_all:CalendarEntry']);
  });

  it('maps the attachment switches onto the Attachment subject', () => {
    expect(pairs('View attachments')).toEqual(['read:Attachment']);
    expect(pairs('Upload attachments')).toEqual(['create:Attachment']);
    expect(pairs('Edit attachments')).toEqual(['update:Attachment']);
    expect(pairs('Delete attachments')).toEqual(['delete:Attachment']);
  });

  it('gives Add notes an action of its own on jobs and on leads, apart from Edit jobs and Edit leads', () => {
    expect(pairs('Add notes').sort()).toEqual(['add_note:Job', 'add_note:Lead']);
    expect(pairs('Edit jobs')).toEqual(['update:Job']);
    expect(pairs('Edit leads')).toEqual(['update:Lead']);
    expect(pairs('Edit jobs')).not.toContain('add_note:Job');
  });

  it('gives Delete other people\'s notes an action of its own on jobs and on leads (S04.25 built the check)', () => {
    expect(entryOf("Delete other people's notes").pending).toBeUndefined();
    expect(pairs("Delete other people's notes").sort()).toEqual(['delete_others_note:Job', 'delete_others_note:Lead']);
    expect(pairs("Delete other people's notes")).not.toContain('delete:Attachment');
    expect(pairs('Add notes')).not.toContain('delete_others_note:Job');
  });

  it('compiles the Technician preset into Add notes but no job or lead edit, and no task-wide or attachment delete', () => {
    const tech = compileSwitchGrants(presetSwitchSet('TECHNICIAN')).map((g) => `${g.action}:${g.subject}`);
    expect(tech).toEqual(expect.arrayContaining(['add_note:Job', 'add_note:Lead', 'read:Attachment', 'create:Attachment']));
    expect(tech).not.toContain('update:Job');
    expect(tech).not.toContain('update:Lead');
    expect(tech).not.toContain('see_all:Task');
    expect(tech).not.toContain('delete:Attachment');
    expect(tech).not.toContain('assign:Task');
  });

  it('compiles the Dispatcher preset into See all tasks and the Admin preset into every task switch', () => {
    const dispatcher = compileSwitchGrants(presetSwitchSet('DISPATCHER')).map((g) => `${g.action}:${g.subject}`);
    expect(dispatcher).toEqual(expect.arrayContaining(['see_all:Task', 'assign:Task', 'update:Job', 'update:Lead']));
    const sales = compileSwitchGrants(presetSwitchSet('SALES')).map((g) => `${g.action}:${g.subject}`);
    expect(sales).not.toContain('see_all:Task');
  });
});
