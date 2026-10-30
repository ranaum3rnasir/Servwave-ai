/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.2 - the Leads and Jobs rows of the switch catalog and the
   catalog validator (the row rule and each switch's Requires).

   Pure: no database. The expected values are the PRD's catalog tables, written out as literals here
   (they are the source of truth the catalog is built from), never read back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_ROLES,
  SWITCH_CATALOG,
  findSwitch,
  presetSwitchSet,
  type SwitchValue,
} from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';

/** The labels of the Leads and Jobs rows this slice adds, as the slice states them. */
const LEAD_ROW_LABELS = [
  'View leads', 'Create leads', 'Edit leads', 'Delete leads', 'Export leads',
  'Log contact attempts', 'Mark leads lost', 'Reopen leads', 'Book walkthroughs', 'Perform walkthroughs',
  'Edit record ID numbers (leads)', 'Alert me about every lead',
];
const JOB_ROW_LABELS = [
  'View jobs', 'Create jobs', 'Edit jobs', 'Delete jobs', 'Export jobs',
  'Edit job and lead contact details', 'Assign work to other people', 'Schedule visits', 'Mark on my way',
  'Mark arrived', 'Office review', 'Close jobs', 'Close jobs with money owed', 'Cancel jobs',
  'Reopen Done jobs', 'Change locked jobs', 'Edit record ID numbers (jobs)', 'Alert me about every job',
];

const keyOfLabel = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)?.key;

describe('the Leads and Jobs scope switches', () => {
  it('are choices between Attached, Team and All, in the Data Scope group', () => {
    for (const key of ['leads_scope', 'jobs_scope']) {
      const entry = findSwitch(key)!;
      expect(entry, key).toBeDefined();
      expect(entry.module).toBe('Data Scope');
      expect(entry.kind).toBe('choice');
      expect(entry.choices).toEqual(['attached', 'team', 'all']);
      expect(entry.requires).toEqual([]);
    }
  });

  it('hold All for the Dispatcher preset, Attached on Leads for Sales and Technician, Attached on Jobs for Technician', () => {
    expect(findSwitch('leads_scope')!.presets).toMatchObject({ ADMIN: 'all', SALES: 'attached', DISPATCHER: 'all', TECHNICIAN: 'attached' });
    expect(findSwitch('jobs_scope')!.presets).toMatchObject({ ADMIN: 'all', DISPATCHER: 'all', TECHNICIAN: 'attached' });
  });
});

describe('the Leads and Jobs rows', () => {
  it('hold every switch the slice lists, each with help text and a value for all four built-in roles', () => {
    for (const label of [...LEAD_ROW_LABELS, ...JOB_ROW_LABELS]) {
      const key = keyOfLabel(label);
      expect(key, `a switch labelled "${label}"`).toBeDefined();
      const entry = findSwitch(key!)!;
      expect(entry.helpText.length, label).toBeGreaterThan(0);
      expect(Object.keys(entry.presets).sort(), label).toEqual([...BUILT_IN_ROLES].sort());
    }
  });

  it('carry the PRD presets for Admin, Sales, Dispatcher and Technician', () => {
    const rows: Record<string, [boolean, boolean, boolean, boolean]> = {
      'View leads': [true, true, true, true],
      'Create leads': [true, true, true, true],
      'Edit leads': [true, true, true, true],
      'Delete leads': [true, true, true, false],
      'Export leads': [true, true, false, false],
      'Log contact attempts': [true, true, true, false],
      'Mark leads lost': [true, true, true, false],
      // Ran, 8 Oct: Sales keeps Reopen leads.
      'Reopen leads': [true, true, true, false],
      'Book walkthroughs': [true, true, true, false],
      'Perform walkthroughs': [true, true, true, true],
      'Edit record ID numbers (leads)': [true, false, true, false],
      'Alert me about every lead': [true, false, false, false],
      'View jobs': [true, true, true, true],
      'Create jobs': [true, false, true, true],
      'Edit jobs': [true, false, true, true],
      'Delete jobs': [true, false, false, false],
      'Export jobs': [true, true, false, false],
      'Edit job and lead contact details': [true, true, true, true],
      'Assign work to other people': [true, false, true, false],
      'Schedule visits': [true, false, true, false],
      'Mark on my way': [true, false, true, true],
      'Mark arrived': [true, false, true, true],
      'Office review': [true, false, true, false],
      'Close jobs': [true, false, false, false],
      'Close jobs with money owed': [true, false, false, false],
      'Cancel jobs': [true, false, false, false],
      'Reopen Done jobs': [true, false, false, false],
      'Change locked jobs': [true, false, false, false],
      'Edit record ID numbers (jobs)': [true, false, true, false],
      'Alert me about every job': [true, false, false, false],
    };
    for (const [label, [admin, sales, dispatcher, technician]] of Object.entries(rows)) {
      const entry = findSwitch(keyOfLabel(label)!)!;
      expect(entry.presets, label).toEqual({ ADMIN: admin, SALES: sales, DISPATCHER: dispatcher, TECHNICIAN: technician });
    }
  });

  it('hold no Mark jobs lost and no Cancel leads switch, and Cancel jobs names the required reason from the company list', () => {
    const labels = SWITCH_CATALOG.map((s) => s.label.toLowerCase());
    expect(labels).not.toContain('mark jobs lost');
    expect(labels).not.toContain('cancel leads');
    const cancel = findSwitch(keyOfLabel('Cancel jobs')!)!;
    expect(cancel.helpText).toMatch(/reason/i);
    expect(cancel.helpText).toMatch(/list/i);
  });
});

describe('the catalog as a whole', () => {
  it('has unique keys, and every Requires names a switch the catalog holds', () => {
    const keys = SWITCH_CATALOG.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SWITCH_CATALOG) {
      for (const needed of [...s.requires, ...(s.requiresAny ?? [])]) expect(keys, `${s.key} requires ${needed}`).toContain(needed);
    }
  });

  it('names no vendor in any label or help text', () => {
    const text = SWITCH_CATALOG.map((s) => `${s.label} ${s.helpText}`).join(' ');
    // "resend" the verb (resend an invoice) is ordinary copy; the capitalised vendor name is not.
    expect(text).not.toMatch(/stripe|twilio|supabase|\brender\b|ctm|calltracking/i);
    expect(text).not.toMatch(/\bResend\b/);
  });
});

describe('the catalog validator', () => {
  const base = () => presetSwitchSet('ADMIN');
  const without = (set: Record<string, SwitchValue>, ...off: string[]) => ({ ...set, ...Object.fromEntries(off.map((k) => [k, false])) });

  it('passes every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) {
      expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
    }
  });

  it('refuses Create on with View off, naming both switches', () => {
    const violations = validateSwitchSet(without(base(), 'view_leads'));
    expect(violations.some((v) => v.switchKey === 'create_leads' && v.needs.includes('view_leads'))).toBe(true);
    const jobs = validateSwitchSet(without(base(), 'view_jobs'));
    expect(jobs.some((v) => v.switchKey === 'create_jobs' && v.needs.includes('view_jobs'))).toBe(true);
  });

  it('applies the row rule to Create, Edit, Delete and Export, and each switch Requires beyond it', () => {
    const rowRule = ['create_leads', 'edit_leads', 'delete_leads', 'export_leads'];
    const violated = validateSwitchSet(without(base(), 'view_leads')).map((v) => v.switchKey);
    for (const key of rowRule) expect(violated, key).toContain(key);
    // A switch with its own Requires (Log contact attempts) is held to it too.
    expect(violated).toContain('log_contact_attempts');
  });

  it('accepts a switch whose Requires is nothing with its row\'s View off', () => {
    const set = without(base(), 'view_jobs', 'create_jobs', 'edit_jobs', 'delete_jobs', 'export_jobs',
      'assign_work_to_others', 'schedule_visits', 'mark_on_my_way', 'mark_arrived', 'office_review', 'close_jobs',
      'close_jobs_with_money_owed', 'cancel_jobs', 'reopen_done_jobs', 'change_locked_jobs', 'edit_job_record_ids', 'alert_every_job',
      'assign_people_to_jobs', 'start_and_finish_visits', 'update_any_visit_status', 'complete_jobs', 'duplicate_jobs', 'edit_job_line_items');
    // jobs_scope (Requires nothing) and apply_discounts (Requires nothing) stay on and valid.
    expect(set.jobs_scope).toBe('all');
    expect(set.apply_discounts).toBe(true);
    expect(validateSwitchSet(set)).toEqual([]);
  });

  it('holds Edit job and lead contact details to View jobs or View leads, at least one', () => {
    const noJobs = without(base(), 'view_jobs');
    expect(validateSwitchSet(without(noJobs, 'create_jobs', 'edit_jobs', 'delete_jobs', 'export_jobs',
      'assign_work_to_others', 'schedule_visits', 'mark_on_my_way', 'mark_arrived', 'office_review', 'close_jobs',
      'close_jobs_with_money_owed', 'cancel_jobs', 'reopen_done_jobs', 'change_locked_jobs', 'edit_job_record_ids', 'alert_every_job',
      'assign_people_to_jobs', 'start_and_finish_visits', 'update_any_visit_status', 'complete_jobs', 'duplicate_jobs', 'edit_job_line_items'))).toEqual([]);
    const neither = without(base(), 'view_jobs', 'view_leads');
    expect(validateSwitchSet(neither).some((v) => v.switchKey === 'edit_job_and_lead_contact_details')).toBe(true);
  });

  it('refuses a choice value that is not one of the switch\'s choices, or the wrong kind of value', () => {
    expect(validateSwitchSet({ ...base(), leads_scope: 'everyone' }).some((v) => v.switchKey === 'leads_scope')).toBe(true);
    expect(validateSwitchSet({ ...base(), leads_scope: true }).some((v) => v.switchKey === 'leads_scope')).toBe(true);
    expect(validateSwitchSet({ ...base(), view_leads: 'all' }).some((v) => v.switchKey === 'view_leads')).toBe(true);
    expect(validateSwitchSet({ ...base(), not_a_switch: true }).some((v) => v.switchKey === 'not_a_switch')).toBe(true);
  });

  it('offers no Location choice on any scope switch, and refuses a stored Location value with a plain message', () => {
    const scoped = SWITCH_CATALOG.filter((s) => s.kind === 'choice' && s.choices?.includes('attached'));
    expect(scoped.length).toBeGreaterThan(0);
    for (const s of scoped) {
      expect(s.choices, s.key).toEqual(['attached', 'team', 'all']);
      expect(s.keptValues ?? [], s.key).not.toContain('location');
    }
    for (const key of ['leads_scope', 'jobs_scope']) {
      const violation = validateSwitchSet({ ...base(), [key]: 'location' }).find((v) => v.switchKey === key);
      expect(violation?.message, key).toBe(`${findSwitch(key)!.label} cannot be set to "location". Choose one of: attached, team, all.`);
    }
  });

  it('accepts every choice the catalog offers', () => {
    for (const scope of findSwitch('jobs_scope')!.choices!) {
      expect(validateSwitchSet({ ...base(), jobs_scope: scope }), scope).toEqual([]);
    }
  });
});

/* =============================================================================
   Slice S01.3 - the Estimates and Invoices rows, the two scopes and the kept "Through own leads" value.
   The expected values are the PRD's catalog table, written out here as literals.
   ========================================================================== */

const ESTIMATE_ROWS: Record<string, [boolean, boolean, boolean, boolean]> = {
  'View estimates': [true, true, true, true],
  'Create estimates': [true, true, true, true],
  'Edit estimates': [true, true, true, true],
  'Delete estimates': [true, true, false, false],
  'Export estimates': [true, true, false, false],
  'Approve estimates': [true, true, true, true],
  'Decline estimates': [true, true, true, true],
  'Waive deposits': [true, false, true, false],
  'Edit record ID numbers (estimates)': [true, false, true, false],
  'Alert me about every estimate': [true, false, false, false],
};
const INVOICE_ROWS: Record<string, [boolean, boolean, boolean, boolean]> = {
  'View invoices': [true, true, true, false],
  'Edit invoices': [true, false, true, false],
  'Delete invoices': [true, false, false, false],
  'Export invoices': [true, true, false, false],
  'Void invoices': [true, false, false, false],
  'Apply credits': [true, false, false, false],
  'Void payments': [true, false, false, false],
  'Refund payments': [true, false, false, false],
  'Edit invoice line items': [true, true, true, false],
  'Edit record ID numbers (invoices)': [true, false, true, false],
  'Alert me about every invoice and payment': [true, false, false, false],
};

describe('the Jobs scope and Leads scope switches, which estimates and invoices follow (P6)', () => {
  it('are Data Scope choices between Attached, Team and All, with "Through own leads" kept on Jobs but never offered', () => {
    for (const key of ['jobs_scope', 'leads_scope']) {
      const entry = findSwitch(key)!;
      expect(entry, key).toBeDefined();
      expect(entry.module).toBe('Data Scope');
      expect(entry.kind).toBe('choice');
      expect(entry.choices).toEqual(['attached', 'team', 'all']);
      expect(entry.requires).toEqual([]);
    }
    expect(findSwitch('jobs_scope')!.keptValues).toEqual(['through_own_leads']);
  });

  it('has no Estimates scope and no Invoices scope: a document follows the scope of its lead or job', () => {
    expect(findSwitch('estimates_scope')).toBeUndefined();
    expect(findSwitch('invoices_scope')).toBeUndefined();
  });

  it('holds the kept value on no other scope: Leads scope does not accept it', () => {
    expect(findSwitch('leads_scope')!.keptValues ?? []).toEqual([]);
    expect(validateSwitchSet({ ...presetSwitchSet('ADMIN'), leads_scope: 'through_own_leads' }).some((v) => v.switchKey === 'leads_scope')).toBe(true);
  });

  it('gives Sales Through own leads on Jobs, Dispatcher All, Technician Attached', () => {
    expect(findSwitch('jobs_scope')!.presets).toEqual({ ADMIN: 'all', SALES: 'through_own_leads', DISPATCHER: 'all', TECHNICIAN: 'attached' });
  });

  it('explains the kept value in plain words wherever the scope is shown', () => {
    const help = findSwitch('jobs_scope')!.keptValueHelp?.through_own_leads;
    expect(help?.label).toBe('Through own leads');
    expect(help?.meaning).toMatch(/lead/i);
  });
});

describe('the Estimates and Invoices rows', () => {
  it('carry the PRD presets, help text and a value for all four built-in roles', () => {
    for (const [label, [admin, sales, dispatcher, technician]] of [...Object.entries(ESTIMATE_ROWS), ...Object.entries(INVOICE_ROWS)]) {
      const entry = findSwitch(keyOfLabel(label)!);
      expect(entry, label).toBeDefined();
      expect(entry!.helpText.length, label).toBeGreaterThan(0);
      expect(entry!.presets, label).toEqual({ ADMIN: admin, SALES: sales, DISPATCHER: dispatcher, TECHNICIAN: technician });
    }
  });

  it('require the row\'s View, and every built-in preset passes the validator', () => {
    for (const label of Object.keys(ESTIMATE_ROWS).filter((l) => l !== 'View estimates')) {
      expect(findSwitch(keyOfLabel(label)!)!.requires, label).toContain(keyOfLabel('View estimates'));
    }
    for (const label of Object.keys(INVOICE_ROWS).filter((l) => l !== 'View invoices')) {
      expect(findSwitch(keyOfLabel(label)!)!.requires, label).toContain(keyOfLabel('View invoices'));
    }
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });

  it('refuses Approve estimates on with View estimates off', () => {
    const set = { ...presetSwitchSet('ADMIN'), view_estimates: false };
    expect(validateSwitchSet(set).some((v) => v.switchKey === 'approve_estimates' && v.needs.includes('view_estimates'))).toBe(true);
  });

  it('name no vendor and give every switch with no server check a note saying who builds it', () => {
    for (const label of [...Object.keys(ESTIMATE_ROWS), ...Object.keys(INVOICE_ROWS)]) {
      const entry = findSwitch(keyOfLabel(label)!)!;
      const text = `${entry.label} ${entry.helpText}`;
      // "resend" the verb is ordinary copy; the capitalised vendor name is not.
      expect(text, label).not.toMatch(/\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics)\b/i);
      expect(text, label).not.toMatch(/\bResend\b/);
      expect(entry.serverChecks.length > 0 || Boolean(entry.pending), label).toBe(true);
    }
  });
});

/* =============================================================================
   Slice S01.7 - the two Leads switches that decide who may use a lead's people and its status menu.
   The expected values are the PRD's catalog table, written out here as literals.
   ========================================================================== */

describe('the lead people and lead closing switches', () => {
  const rows: Record<string, [boolean, boolean, boolean, boolean]> = {
    'Assign people to leads': [true, false, true, false],
    'Change lead status by hand': [true, false, true, false],
  };

  it('carry the PRD presets and help text, in the Leads group', () => {
    for (const [label, [admin, sales, dispatcher, technician]] of Object.entries(rows)) {
      const entry = findSwitch(keyOfLabel(label)!);
      expect(entry, label).toBeDefined();
      expect(entry!.module, label).toBe('Leads');
      expect(entry!.helpText.length, label).toBeGreaterThan(0);
      expect(entry!.presets, label).toEqual({ ADMIN: admin, SALES: sales, DISPATCHER: dispatcher, TECHNICIAN: technician });
    }
  });

  it('is renamed from Assign leads, and holds no Cancel leads switch', () => {
    expect(SWITCH_CATALOG.map((s) => s.label)).not.toContain('Assign leads');
    expect(SWITCH_CATALOG.map((s) => s.label.toLowerCase())).not.toContain('cancel leads');
  });

  it('puts Assign people to leads under View leads, and Change lead status by hand under Edit leads', () => {
    expect(findSwitch(keyOfLabel('Assign people to leads')!)!.requires).toEqual(['view_leads']);
    expect(findSwitch(keyOfLabel('Change lead status by hand')!)!.requires).toEqual([keyOfLabel('Edit leads')]);
    const set = { ...presetSwitchSet('ADMIN'), edit_leads: false };
    expect(validateSwitchSet(set).some((v) => v.switchKey === keyOfLabel('Change lead status by hand') && v.needs.includes('edit_leads'))).toBe(true);
  });

  it('names a server check for each switch, and passes the validator for every built-in preset', () => {
    for (const label of Object.keys(rows)) expect(findSwitch(keyOfLabel(label)!)!.serverChecks.length, label).toBeGreaterThan(0);
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });

  it('names Book walkthroughs as covering the cancel of a single walkthrough', () => {
    expect(findSwitch(keyOfLabel('Book walkthroughs')!)!.helpText).toMatch(/cancel/i);
  });
});

/* =============================================================================
   Slice S01.8 - the Jobs switches that decide who may put people on a job, step a visit, complete a job,
   duplicate it and price its lines. The expected values are the PRD's catalog table, written out as literals.
   ========================================================================== */

describe('the job people, visit step, job complete and job line item switches', () => {
  const rows: Record<string, [boolean, boolean, boolean, boolean]> = {
    'Assign people to jobs': [true, false, true, false],
    'Start and finish visits': [true, false, true, true],
    "Update any visit's status": [true, false, true, false],
    'Complete jobs': [true, false, true, false],
    'Duplicate jobs': [true, false, true, false],
    'Edit job line items': [true, false, true, true],
  };

  it('carry the PRD presets and help text, in the Jobs group', () => {
    for (const [label, [admin, sales, dispatcher, technician]] of Object.entries(rows)) {
      const entry = findSwitch(keyOfLabel(label)!);
      expect(entry, label).toBeDefined();
      expect(entry!.module, label).toBe('Jobs');
      expect(entry!.helpText.length, label).toBeGreaterThan(0);
      expect(entry!.presets, label).toEqual({ ADMIN: admin, SALES: sales, DISPATCHER: dispatcher, TECHNICIAN: technician });
    }
  });

  it('is renamed from Assign crew, and holds Start and finish visits with no separate Mark Work Completed or Start visits', () => {
    const labels = SWITCH_CATALOG.map((s) => s.label);
    expect(labels).not.toContain('Assign crew');
    expect(labels).not.toContain('Mark Work Completed');
    expect(labels).not.toContain('Start visits');
  });

  it('puts every one of them under View jobs, and Duplicate jobs under Create jobs as well', () => {
    for (const label of Object.keys(rows)) expect(findSwitch(keyOfLabel(label)!)!.requires, label).toContain('view_jobs');
    expect(findSwitch(keyOfLabel('Duplicate jobs')!)!.requires).toContain('create_jobs');
    const set = { ...presetSwitchSet('ADMIN'), create_jobs: false };
    expect(validateSwitchSet(set).some((v) => v.switchKey === keyOfLabel('Duplicate jobs') && v.needs.includes('create_jobs'))).toBe(true);
  });

  it('names a server check for each switch, and passes the validator for every built-in preset', () => {
    for (const label of Object.keys(rows)) expect(findSwitch(keyOfLabel(label)!)!.serverChecks.length, label).toBeGreaterThan(0);
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });

  it('says in the help text that finishing a visit never completes the job, and that line items stop at Completed', () => {
    expect(findSwitch(keyOfLabel('Start and finish visits')!)!.helpText).toMatch(/never.*job/i);
    expect(findSwitch(keyOfLabel('Edit job line items')!)!.helpText).toMatch(/completed/i);
  });
});
