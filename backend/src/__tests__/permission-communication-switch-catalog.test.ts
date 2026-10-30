/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.10 - the Communication and Automations groups of the switch catalog.

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

const COMMUNICATION_ROWS: Record<string, Row> = {
  'View communication': [true, true, true, true],
  'Contact customers': [true, true, true, true],
  'Attach conversations to jobs and leads': [true, true, true, true],
  'Edit communication records': [true, false, true, false],
  'Delete communication records': [true, false, true, false],
  'Access Communication': [true, true, true, true],
  'Show Phone': [true, true, true, true],
  'Show Text': [true, true, true, true],
  'Show Email': [true, true, true, true],
  'Communication scope': ['all', 'attached', 'attached', 'attached'],
  'See the main line when I have no number': [true, true, true, false],
  'Play recording': [true, true, true, false],
  'View transcript': [true, true, true, false],
  'Download recording': [true, false, false, false],
  'Download transcript': [true, true, false, false],
  'See call insights': [true, true, true, false],
  'Export call log': [true, false, false, false],
  'Log past communications': [true, false, true, true],
  "Edit other people's logged communications": [true, false, false, false],
  'Phone numbers tab': [true, false, true, false],
  'Call flows tab': [true, false, true, false],
  'Call masking tab': [true, false, true, false],
  'Call groups tab': [true, false, true, false],
  'Training tab': [true, false, true, false],
  'Blocked callers tab': [true, false, true, false],
  'Office phone in the browser': [true, true, true, false],
};
const AUTOMATION_ROWS: Record<string, Row> = {
  'View automations': [true, false, false, false],
  'Create automations': [true, false, false, false],
  'Edit automations': [true, false, false, false],
  'Delete automations': [true, false, false, false],
};
const GROUPS: Record<string, Record<string, Row>> = {
  Communication: COMMUNICATION_ROWS,
  Automations: AUTOMATION_ROWS,
};

const keyOfLabel = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)?.key;
const entryOf = (label: string) => {
  const key = keyOfLabel(label);
  expect(key, `a switch labelled "${label}"`).toBeDefined();
  return findSwitch(key!)!;
};

describe('the Communication and Automations rows of the switch catalog', () => {
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

describe('Communication scope', () => {
  it('is a choice that offers the standard three, Attached, Team and All, and nothing else (P6)', () => {
    const entry = entryOf('Communication scope');
    expect(entry.kind).toBe('choice');
    expect(entry.choices).toEqual(['attached', 'team', 'all']);
    expect(entry.keptValues ?? []).toEqual([]);
  });

  it('refuses a value that is not one of the three, and no longer accepts the retired "Linked to me" spelling', () => {
    expect(validateSwitchSet({ ...presetSwitchSet('SALES'), communication_scope: 'location' }).map((v) => v.switchKey)).toEqual(['communication_scope']);
    expect(validateSwitchSet({ ...presetSwitchSet('SALES'), communication_scope: 'linked_to_me' }).map((v) => v.switchKey)).toEqual(['communication_scope']);
    expect(validateSwitchSet({ ...presetSwitchSet('SALES'), communication_scope: 'team' })).toEqual([]);
    expect(validateSwitchSet({ ...presetSwitchSet('SALES'), communication_scope: 'all' })).toEqual([]);
  });
});

describe('Requires in the Communication and Automations groups', () => {
  const view = keyOfLabel('View communication')!;
  const access = keyOfLabel('Access Communication')!;

  it('makes View communication the row\'s View: Contact customers, Edit and Delete communication records need it', () => {
    for (const label of ['Contact customers', 'Edit communication records', 'Delete communication records']) {
      expect(entryOf(label).requires, label).toEqual([view]);
    }
  });

  it('keeps the section\'s sub-pages and Export call log on Access Communication only, never on View communication', () => {
    const subPages = [
      'Show Phone', 'Show Text', 'Show Email', 'Phone numbers tab', 'Call flows tab', 'Call masking tab',
      'Call groups tab', 'Training tab', 'Blocked callers tab', 'Export call log',
    ];
    for (const label of subPages) expect(entryOf(label).requires, label).toEqual([access]);
    // So a person with the record tab closed can still hold them.
    const set = { ...presetSwitchSet('ADMIN'), view_communication: false, contact_customers: false, edit_communication_records: false, delete_communication_records: false };
    expect(validateSwitchSet(set).filter((v) => subPages.map(keyOfLabel).includes(v.switchKey))).toEqual([]);
  });

  it('needs nothing for Communication scope, the main line and Access Communication itself', () => {
    for (const label of ['Communication scope', 'See the main line when I have no number', 'Access Communication']) {
      expect(entryOf(label).requires, label).toEqual([]);
    }
  });

  it('puts the call and conversation switches under View communication', () => {
    for (const label of [
      'Play recording', 'View transcript', 'Download recording', 'Download transcript', 'See call insights',
      'Attach conversations to jobs and leads', 'Log past communications',
    ]) {
      expect(entryOf(label).requires, label).toEqual([view]);
    }
  });

  it('nests Edit other people\'s logged communications under Log past communications and Office phone under Contact customers', () => {
    expect(entryOf("Edit other people's logged communications").requires).toEqual([keyOfLabel('Log past communications')]);
    expect(entryOf('Office phone in the browser').requires).toEqual([keyOfLabel('Contact customers')]);
  });

  it('refuses Contact customers on with View communication off, and Edit other people\'s logged entries on with Log past communications off', () => {
    const noView = { ...presetSwitchSet('ADMIN'), view_communication: false };
    expect(validateSwitchSet(noView).some((v) => v.switchKey === 'contact_customers' && v.needs.includes(view))).toBe(true);
    const noLog = { ...presetSwitchSet('ADMIN'), log_past_communications: false };
    expect(validateSwitchSet(noLog).some((v) => v.switchKey === 'edit_others_logged_communications')).toBe(true);
  });

  it('puts Create, Edit, Delete and Show of automations under View automations', () => {
    for (const label of ['Edit automations', 'Delete automations']) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View automations')]);
    }
    // Create requires Edit (AL-04): Create automations needs both View and Edit automations.
    expect(entryOf('Create automations').requires).toEqual([keyOfLabel('View automations'), keyOfLabel('Edit automations')]);
  });
});

describe('what the Communication and Automations switches compile into', () => {
  const pairs = (label: string) => entryOf(label).grants.map((g) => `${g.action}:${g.subject}`);

  it('maps the record tab, contacting, editing, deleting and the section onto the Communication subject', () => {
    expect(pairs('View communication')).toEqual(['read:Communication']);
    expect(pairs('Contact customers')).toEqual(['create:Communication']);
    expect(pairs('Edit communication records')).toEqual(['update:Communication']);
    expect(pairs('Delete communication records')).toEqual(['delete:Communication']);
    expect(pairs('Access Communication')).toEqual(['access_inbox:Communication']);
    expect(pairs('Log past communications')).toEqual(['log_past:Communication']);
  });

  it('gives attaching a conversation and editing someone else\'s logged entry an action of their own, apart from Edit communication records', () => {
    expect(pairs('Attach conversations to jobs and leads')).toEqual(['attach:Communication']);
    expect(pairs("Edit other people's logged communications")).toEqual(['edit_others_log:Communication']);
    expect(pairs('Edit communication records')).not.toContain('attach:Communication');
  });

  it('gives the office phone in the browser an action of its own, checked by the phone token and by no role name', () => {
    expect(pairs('Office phone in the browser')).toEqual(['use_browser_phone:Communication']);
    expect(entryOf('Office phone in the browser').serverChecks).toEqual(['phone-token']);
    expect(entryOf('Office phone in the browser').pending).toBeUndefined();
    // A built-in role is only a preset: the three that hold the switch compile to the grant, Technician does not.
    for (const role of ['ADMIN', 'SALES', 'DISPATCHER'] as const) {
      expect(compileSwitchGrants(presetSwitchSet(role)).map((g) => `${g.action}:${g.subject}`), role).toContain('use_browser_phone:Communication');
    }
    expect(compileSwitchGrants(presetSwitchSet('TECHNICIAN')).map((g) => `${g.action}:${g.subject}`)).not.toContain('use_browser_phone:Communication');
  });

  it('maps the automation switches onto the Automation subject, text automations included', () => {
    expect(pairs('View automations')).toEqual(['read:Automation']);
    expect(pairs('Create automations')).toEqual(['create:Automation']);
    expect(pairs('Edit automations')).toEqual(['update:Automation']);
    expect(pairs('Delete automations')).toEqual(['delete:Automation']);
  });

  it('compiles the Sales preset into Communication access and no automation grant, and Admin into both', () => {
    const sales = compileSwitchGrants(presetSwitchSet('SALES')).map((g) => `${g.action}:${g.subject}`);
    expect(sales).toEqual(expect.arrayContaining(['access_inbox:Communication', 'attach:Communication', 'create:Communication']));
    expect(sales.some((g) => g.endsWith(':Automation'))).toBe(false);
    expect(sales).not.toContain('update:Communication');
    const admin = compileSwitchGrants(presetSwitchSet('ADMIN')).map((g) => `${g.action}:${g.subject}`);
    expect(admin).toEqual(expect.arrayContaining(['create:Automation', 'edit_others_log:Communication']));
  });

  it('gives Play recording and Download recording an action each, checked by the two recording links and by no role name', () => {
    expect(pairs('Play recording')).toEqual(['play_recording:Communication']);
    expect(pairs('Download recording')).toEqual(['download_recording:Communication']);
    expect(entryOf('Play recording').serverChecks).toEqual(['recording-play']);
    expect(entryOf('Download recording').serverChecks).toEqual(['recording-download']);
    expect(entryOf('Play recording').pending).toBeUndefined();
    expect(entryOf('Download recording').pending).toBeUndefined();
    // A built-in role is only a preset: the grant follows the preset's value, and the two switches are independent.
    const granted = (role: 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN') =>
      compileSwitchGrants(presetSwitchSet(role)).map((g) => `${g.action}:${g.subject}`);
    expect(granted('DISPATCHER')).toContain('play_recording:Communication');
    expect(granted('DISPATCHER')).not.toContain('download_recording:Communication');
    expect(granted('TECHNICIAN')).not.toContain('play_recording:Communication');
    expect(granted('TECHNICIAN')).not.toContain('download_recording:Communication');
    expect(granted('ADMIN')).toEqual(expect.arrayContaining(['play_recording:Communication', 'download_recording:Communication']));
  });

  it('says in the Download recording help text that it hides the download button and that playback can still be captured', () => {
    expect(entryOf('Download recording').helpText).toBe(
      'Shows the download button for call recordings. Off hides the download button only; recordings can still be played, ' +
        'and playback can be captured.',
    );
  });

  it('gives View transcript an action checked by the transcript endpoint and by no role name, and keeps Download transcript dormant', () => {
    expect(pairs('View transcript')).toEqual(['view_transcript:Communication']);
    expect(entryOf('View transcript').serverChecks).toEqual(['transcript-view']);
    expect(entryOf('View transcript').pending).toBeUndefined();
    const granted = (role: 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN') =>
      compileSwitchGrants(presetSwitchSet(role)).map((g) => `${g.action}:${g.subject}`);
    for (const role of ['ADMIN', 'SALES', 'DISPATCHER'] as const) expect(granted(role), role).toContain('view_transcript:Communication');
    expect(granted('TECHNICIAN')).not.toContain('view_transcript:Communication');
    // No transcript download is built, so the switch has no grant and no check, and its help text says so.
    expect(pairs('Download transcript')).toEqual([]);
    expect(entryOf('Download transcript').serverChecks).toEqual([]);
    expect(entryOf('Download transcript').helpText).toMatch(/no transcript download exists yet/i);
  });

  it('gives See call insights an action checked by the call responses and the agents list, and by no role name', () => {
    expect(pairs('See call insights')).toEqual(['see_call_insights:Communication']);
    expect(entryOf('See call insights').serverChecks).toEqual(['call-insights', 'phone-agent-metrics']);
    expect(entryOf('See call insights').pending).toBeUndefined();
    const granted = (role: 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN') =>
      compileSwitchGrants(presetSwitchSet(role)).map((g) => `${g.action}:${g.subject}`);
    for (const role of ['ADMIN', 'SALES', 'DISPATCHER'] as const) expect(granted(role), role).toContain('see_call_insights:Communication');
    expect(granted('TECHNICIAN')).not.toContain('see_call_insights:Communication');
  });

  it('gives Export call log a grant for the browser to hide the button by, and no server check (the file is built in the browser)', () => {
    const entry = entryOf('Export call log');
    expect(pairs('Export call log')).toEqual(['export:Communication']);
    expect(entry.serverChecks).toEqual([]);
    expect(entry.pending).toMatch(/built in the browser/);
    expect(entry.requires).toEqual([keyOfLabel('Access Communication')]);
    const granted = (role: 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN') =>
      compileSwitchGrants(presetSwitchSet(role)).map((g) => `${g.action}:${g.subject}`);
    expect(granted('ADMIN')).toContain('export:Communication');
    for (const role of ['SALES', 'DISPATCHER', 'TECHNICIAN'] as const) expect(granted(role), role).not.toContain('export:Communication');
    // Off for an admin too, the rule is gone.
    const noExport = compileSwitchGrants({ ...presetSwitchSet('ADMIN'), export_call_log: false });
    expect(noExport.map((g) => `${g.action}:${g.subject}`)).not.toContain('export:Communication');
  });

  it('gives each phone tab an action of its own, checked by no role name', () => {
    const switches: Array<[label: string, action: string]> = [
      ['Phone numbers tab', 'phone_numbers_tab'], ['Call flows tab', 'call_flows_tab'], ['Call masking tab', 'call_masking_tab'],
      ['Call groups tab', 'call_groups_tab'], ['Training tab', 'training_tab'], ['Blocked callers tab', 'blocked_callers_tab'],
    ];
    const granted = (role: 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN') =>
      compileSwitchGrants(presetSwitchSet(role)).map((g) => `${g.action}:${g.subject}`);
    for (const [label, action] of switches) {
      expect(pairs(label), label).toEqual([`${action}:Communication`]);
      for (const role of ['ADMIN', 'DISPATCHER'] as const) expect(granted(role), `${label} ${role}`).toContain(`${action}:Communication`);
      for (const role of ['SALES', 'TECHNICIAN'] as const) expect(granted(role), `${label} ${role}`).not.toContain(`${action}:Communication`);
    }
  });

  it('checks the Phone numbers tab on a number\'s routing change and on the numbers list, and the usage read', () => {
    expect(entryOf('Phone numbers tab').serverChecks).toEqual(['phone-numbers-routing', 'phone-numbers-fields', 'phone-usage']);
    expect(entryOf('Phone numbers tab').pending).toBeUndefined();
    expect(entryOf('Phone numbers tab').serverChecks).toContain('phone-usage');
    expect(SWITCH_CATALOG.map((s) => s.key)).not.toContain('phone_usage_bar');
  });

  it('lists the server checks of the four org-gated phone tabs, and leaves Call masking display only', () => {
    expect(entryOf('Call flows tab').serverChecks).toEqual(['call-flows-read', 'call-flows-write']);
    expect(entryOf('Call groups tab').serverChecks).toEqual(['call-groups-read', 'call-groups-write']);
    expect(entryOf('Training tab').serverChecks).toEqual(['training-scenarios', 'training-sessions']);
    expect(entryOf('Blocked callers tab').serverChecks).toEqual(['blocked-read', 'blocked-add', 'blocked-remove']);
    for (const label of ['Call flows tab', 'Call groups tab', 'Training tab', 'Blocked callers tab']) {
      expect(entryOf(label).pending, label).toBeUndefined();
    }
    expect(entryOf('Call masking tab').serverChecks).toEqual([]);
    expect(entryOf('Call masking tab').pending).toMatch(/^Display only/);
  });

  it('leaves Download transcript, Communication scope and the main-line switch as defined switches with no grant', () => {
    expect(entryOf('Download transcript').pending).toMatch(/PRD 8/);
    expect(entryOf('Download transcript').grants).toEqual([]);
    // S08.27: the two scope switches are built; they narrow rows and refuse nothing, and say so.
    for (const label of ['Communication scope', 'See the main line when I have no number']) {
      const entry = entryOf(label);
      expect(entry.pending, label).toMatch(/^Not a check of its own/);
      expect(entry.serverChecks, label).toEqual([]);
      expect(entry.grants, label).toEqual([]);
    }
  });
});
