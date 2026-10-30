/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.19 - the catalog is complete.

   Pure: no database. Every grant a route checks is emitted by exactly one switch (or is one of the few fixed
   reads, or belongs to the Admin box alone); every switch is whole (key, module, label, help text, kind, Requires,
   four presets); every built-in preset passes the validator; no code outside the Admin box and the admin-identity
   guards decides access by a role's name; and every switch accounts for its server check or says who builds it.

   The expected values (the placement of the survey switches, the specific preset shapes) are written out here from
   the PRD; the lists of what routes check are read from the source files on disk.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import {
  BUILT_IN_ROLES,
  SWITCH_CATALOG,
  findSwitch,
  presetSwitchSet,
  type SwitchEntry,
} from '../lib/permissions/switches/catalog';
import { grantKey, grantOwners, sharedGrants } from '../lib/permissions/switches/ownership';
import { ADMIN_BOX_ONLY, FIXED_GRANTS } from '../lib/permissions/fixedGrants';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { compileSwitchGrants } from '../lib/permissions/switches/store';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    return path.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

/** The (action, subject) pairs a source text asks the ability about, as `action:Subject`. */
export function grantsChecked(source: string): string[] {
  const found = new Set<string>();
  // canDo('read', 'Job'), canDoOrCreator('update', 'Estimate', ...), req.ability.can('x', 'Y'), can(req, 'x', 'Y', row).
  const single = /\b(?:canDo|canDoOrCreator|can|cannot)\(\s*(?:req\s*,\s*)?'([a-z_]+)'\s*,\s*'([A-Z][A-Za-z]+)'/g;
  for (const m of source.matchAll(single)) found.add(`${m[1]}:${m[2]}`);
  // canDoAny([['create', 'Lead'], ['create', 'Job']]).
  for (const call of source.matchAll(/canDoAny\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    for (const m of call[1]!.matchAll(/\[\s*'([a-z_]+)'\s*,\s*'([A-Z][A-Za-z]+)'\s*\]/g)) found.add(`${m[1]}:${m[2]}`);
  }
  return [...found];
}

/** The checked grants nothing accounts for: no switch emits them, and they are neither fixed nor the Admin box's alone. */
export function unaccountedGrants(checked: string[], catalog: readonly SwitchEntry[] = SWITCH_CATALOG): string[] {
  const owned = grantOwners(catalog);
  const fixed = new Set(FIXED_GRANTS.map(grantKey));
  const adminBox = new Set(ADMIN_BOX_ONLY.map(grantKey));
  return checked.filter((g) => !owned.has(g) && !fixed.has(g) && !adminBox.has(g)).sort();
}

describe('every grant the server checks has exactly one owner', () => {
  const checkedByFile = new Map(sourceFiles().map((file) => [relative(SRC, file), grantsChecked(readFileSync(file, 'utf8'))] as const));
  const checked = [...new Set([...checkedByFile.values()].flat())];

  it('finds the checks (guards against a scan that reads nothing and so passes)', () => {
    expect(checked.length).toBeGreaterThan(100);
    expect(checkedByFile.get('routes/job.routes.ts')).toEqual(expect.arrayContaining(['read:Job', 'cancel:Job', 'renumber:Job']));
    expect(checkedByFile.get('routes/lead.routes.ts')).toEqual(expect.arrayContaining(['read:Lead']));
  });

  it('has a switch, a fixed read or the Admin box behind every checked grant', () => {
    expect(unaccountedGrants(checked)).toEqual([]);
  });

  it('has no grant two switches emit', () => {
    expect(sharedGrants()).toEqual([]);
  });

  it('gives no grant to both a switch and the fixed reads or the Admin box', () => {
    const owned = grantOwners();
    for (const g of [...FIXED_GRANTS, ...ADMIN_BOX_ONLY]) {
      expect(owned.has(grantKey(g)), grantKey(g)).toBe(false);
    }
  });

  describe('the scan itself', () => {
    it('reports a route that checks a grant no switch emits', () => {
      const route = `router.post('/:id/launch', canDo('launch', 'Rocket'), ctrl.launch);`;
      expect(unaccountedGrants(grantsChecked(route))).toEqual(['launch:Rocket']);
    });

    it('reads a canDoAny, an ability check and a creator-rule guard too', () => {
      const text = [
        `router.get('/p', canDoAny([['create', 'Lead'], ['create', 'Rocket']]), h);`,
        `if (req.ability?.can('probe', 'Planet')) {}`,
        `router.get('/c', canDoOrCreator('update', 'Comet', (r) => [r.params.id]), h);`,
      ].join('\n');
      expect(grantsChecked(text).sort()).toEqual(['create:Lead', 'create:Rocket', 'probe:Planet', 'update:Comet']);
    });

    it('reports a grant two switches emit', () => {
      const clone = (key: string): SwitchEntry => ({ ...findSwitch('view_jobs')!, key });
      expect(sharedGrants([clone('first'), clone('second')])).toEqual([{ grant: 'read:Job', switches: ['first', 'second'] }]);
    });

    it('accepts a fixed read and an Admin-box action as accounted for', () => {
      expect(unaccountedGrants(['read:Tag', 'force_purge:Customer'])).toEqual([]);
    });
  });
});

describe('the switches that stand for the guards the routes still check', () => {
  // [switch, the grants it emits that no other slice has moved yet]
  const stands: Array<[string, string[]]> = [
    ['edit_lead_record_ids', ['renumber:Lead']],
    ['edit_job_record_ids', ['renumber:Job']],
    ['edit_estimate_record_ids', ['renumber:Estimate']],
    ['edit_invoice_record_ids', ['renumber:Invoice']],
    ['cancel_jobs', ['cancel:Job']],
    ['reopen_done_jobs', ['reopen:Job']],
    ['reopen_leads', ['reopen:Lead']],
    ['create_estimates', ['create:Estimate', 'duplicate:Estimate']],
    ['company_settings', ['update:Organization', 'update:AppSetting']],
    ['manage_roles_and_permissions', ['manage_roles:Role', 'read:Role', 'update:Role']],
  ];

  for (const [key, grants] of stands) {
    it(`${key} emits ${grants.join(', ')}`, () => {
      expect(findSwitch(key)!.grants.map(grantKey)).toEqual(grants);
    });
  }

  it('compiles into what a preset holds: Dispatcher renumbers jobs and cannot cancel them, Admin does both', () => {
    const dispatcher = compileSwitchGrants(presetSwitchSet('DISPATCHER')).map(grantKey);
    expect(dispatcher).toContain('renumber:Job');
    expect(dispatcher).not.toContain('cancel:Job');
    const admin = compileSwitchGrants(presetSwitchSet('ADMIN')).map(grantKey);
    expect(admin).toEqual(expect.arrayContaining(['renumber:Job', 'cancel:Job', 'reopen:Job', 'duplicate:Estimate', 'update:AppSetting']));
  });
});

describe('no code decides access by a role\'s name outside the Admin box and the admin-identity guards', () => {
  // A comparison of a role (or a custom role's base role) with one of the four built-in names.
  const comparison = /(?:\.role|\brole|base_role)\s*[!=]==?\s*'(?:ADMIN|SALES|DISPATCHER|TECHNICIAN)'/;
  const sources = new Map(
    sourceFiles()
      // Seed scripts build fixtures; they are not request-time code.
      .map((file) => [relative(SRC, file), readFileSync(file, 'utf8').split('\n')] as const)
      .filter(([file]) => !/^seed|^e2e\//.test(file)),
  );
  /** The lines of a file that compare a role with a built-in name: code, not a comment about what an old check was. */
  const hits = (file: string) =>
    (sources.get(file) ?? [])
      .map((text, i) => ({ line: i + 1, text }))
      .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/.test(text) && comparison.test(text));

  const allowed: Record<string, number> = {
    // The Admin box test itself.
    'lib/permissions/effectiveRole.ts': 1,
    // The admin-identity guard: the last active admin cannot be demoted (the Admin box itself is read through isSuperUser).
    'controllers/user.controller.ts': 1,
    // "All admins" / "all dispatchers" is an audience a company picks by name, not an access check.
    'services/automations/recipients.ts': 1,
  };

  it('finds the allowed comparisons where they are (guards against a scan that reads nothing)', () => {
    for (const [file, count] of Object.entries(allowed)) expect(hits(file).length, file).toBe(count);
  });

  it('finds no other comparison of a role with a built-in name', () => {
    const stray = [...sources.keys()]
      .filter((file) => !(file in allowed))
      .flatMap((file) => hits(file).map(({ line, text }) => `${file}:${line} ${text.trim()}`));
    expect(stray).toEqual([]);
  });
});

describe('the catalog is whole', () => {
  it('gives every switch a key, a module, a label, help text, a kind, Requires and a value for each of the four built-in roles', () => {
    for (const s of SWITCH_CATALOG) {
      expect(s.key, 'key').toMatch(/^[a-z][a-z0-9_]*$/);
      expect(s.module.length, `${s.key} module`).toBeGreaterThan(0);
      expect(s.label.length, `${s.key} label`).toBeGreaterThan(0);
      expect(s.helpText.length, `${s.key} help text`).toBeGreaterThan(0);
      expect(['toggle', 'choice', 'list'], `${s.key} kind`).toContain(s.kind);
      expect(Array.isArray(s.requires), `${s.key} Requires`).toBe(true);
      expect(Object.keys(s.presets).sort(), `${s.key} presets`).toEqual([...BUILT_IN_ROLES].sort());
      for (const role of BUILT_IN_ROLES) expect(s.presets[role], `${s.key} ${role}`).not.toBeUndefined();
    }
  });

  it('keeps keys unique and every Requires pointing at a switch that exists', () => {
    const keys = SWITCH_CATALOG.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of SWITCH_CATALOG) {
      for (const needed of [...s.requires, ...(s.requiresAny ?? [])]) expect(keys, `${s.key} Requires ${needed}`).toContain(needed);
    }
  });

  it('names no vendor in any label or help text', () => {
    for (const s of SWITCH_CATALOG) {
      const text = `${s.label} ${s.helpText} ${Object.values(s.keptValueHelp ?? {}).map((h) => `${h.label} ${h.meaning}`).join(' ')}`;
      expect(text, s.key).not.toMatch(/stripe|twilio|supabase|\brender\b|ctm|calltracking|quickbooks/i);
      // "resend" the verb (resend an invoice) is ordinary copy; the capitalised vendor name is not.
      expect(text, s.key).not.toMatch(/\bResend\b/);
    }
  });

  it('names the Owner of a lead, never an assignee, in the Data Scope help and the kept value\'s meaning', () => {
    const scopes = SWITCH_CATALOG.filter((s) => s.key.endsWith('_scope') && s.kind === 'choice' && s.module === 'Data Scope');
    expect(scopes.length).toBeGreaterThan(0);
    for (const s of scopes) {
      const text = `${s.helpText} ${Object.values(s.keptValueHelp ?? {}).map((h) => h.meaning).join(' ')}`;
      expect(text, s.key).not.toMatch(/assignee|assigned/i);
    }
    // Who counts as attached, as the PRD lists it: a lead's Owner, Dispatcher and walkthrough crew; a job's crew on any visit, Sold By and Dispatcher.
    const help = (key: string) => SWITCH_CATALOG.find((s) => s.key === key)!.helpText;
    expect(help('leads_scope')).toMatch(/Owner/);
    expect(help('leads_scope')).toMatch(/Dispatcher/);
    expect(help('leads_scope')).toMatch(/walkthrough crew/);
    expect(help('jobs_scope')).toMatch(/crew/);
    expect(help('jobs_scope')).toMatch(/any visit/);
    expect(help('jobs_scope')).toMatch(/Sold By/);
    expect(help('jobs_scope')).toMatch(/Dispatcher/);
    for (const key of ['jobs_scope', 'estimates_scope', 'invoices_scope']) {
      const kept = SWITCH_CATALOG.find((s) => s.key === key)!.keptValueHelp!['through_own_leads']!;
      expect(kept.meaning, key).toMatch(/lead you are the Owner of/);
    }
  });

  describe('each survey switch sits in the group and under the parent the placement table names', () => {
    // [switch key, group, parents it Requires]
    const placement: Array<[string, string, string[]]> = [
      ['change_lead_status_by_hand', 'Leads', ['edit_leads']],
      ['see_everyones_timesheets', 'Time tracking', []],
      ['inventory_view', 'Stock', []],
      ['see_all_assets', 'Stock', ['view_stock']],
      ['office_phone_in_browser', 'Communication', ['contact_customers']],
      ['add_notes', 'Notes', []],
      ['delete_others_notes', 'Notes', []],
      ['start_and_finish_visits', 'Jobs', ['view_jobs']],
      ['change_customer_created_date', 'Customers', ['edit_customers']],
      ['edit_others_logged_communications', 'Communication', ['log_past_communications']],
    ];

    for (const [key, group, parents] of placement) {
      it(`${key}: ${group}${parents.length ? `, under ${parents.join(' and ')}` : ''}`, () => {
        const entry = findSwitch(key);
        expect(entry, key).toBeDefined();
        expect(entry!.module).toBe(group);
        for (const parent of parents) expect(entry!.requires, key).toContain(parent);
      });
    }

    it('makes Inventory view a choice between Counter and Field', () => {
      expect(findSwitch('inventory_view')).toMatchObject({ kind: 'choice', choices: ['counter', 'field'] });
    });

    it('keeps See everyone\'s timesheets the only switch in the Time tracking group', () => {
      expect(SWITCH_CATALOG.filter((s) => s.module === 'Time tracking').map((s) => s.key)).toEqual(['see_everyones_timesheets']);
    });

    it('merges Mark Work Completed into Start and finish visits: no switch of that name remains', () => {
      expect(SWITCH_CATALOG.map((s) => s.label.toLowerCase())).not.toContain('mark work completed');
      expect(findSwitch('start_and_finish_visits')!.label).toBe('Start and finish visits');
    });
  });
});

describe('every built-in preset passes validation', () => {
  it('passes for Admin, Sales, Dispatcher and Technician', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });

  it('holds Technician with Customers View off and Copy customer email on', () => {
    const technician = presetSwitchSet('TECHNICIAN');
    expect(technician.view_customers).toBe(false);
    expect(technician.copy_customer_email).toBe(true);
    expect(validateSwitchSet(technician)).toEqual([]);
  });

  it('holds Technician with Invoices View off and Record payments and Send payment links on', () => {
    const technician = presetSwitchSet('TECHNICIAN');
    expect(technician.view_invoices).toBe(false);
    expect(technician.record_payments).toBe(true);
    expect(technician.send_payment_links).toBe(true);
    expect(validateSwitchSet(technician)).toEqual([]);
  });

  it('holds Sales with View users off and the eligibility switches it carries on', () => {
    const sales = presetSwitchSet('SALES');
    expect(sales.view_users).toBe(false);
    expect(sales.can_own_leads).toBe(true);
    expect(sales.can_be_on_crew).toBe(true);
    expect(validateSwitchSet(sales)).toEqual([]);
  });
});

describe('the route-level enforcement table accounts for every switch', () => {
  it('gives every switch a server check, or says who builds it or why it has none', () => {
    for (const s of SWITCH_CATALOG) {
      expect(s.serverChecks.length > 0 || Boolean(s.pending), s.key).toBe(true);
    }
  });

  it('names, for every check tagged to a later slice or PRD, who builds it', () => {
    const owner = /S\d{2}\.\d+|PRD \d+|Display only|Not a check of its own|no server|built in the browser|button/i;
    for (const s of SWITCH_CATALOG.filter((x) => x.serverChecks.length === 0)) {
      expect(s.pending, s.key).toMatch(owner);
    }
  });

  it('lists each pending check against the PRD or slice that builds it', () => {
    const pendingFor = (tag: string) => SWITCH_CATALOG.filter((s) => s.serverChecks.length === 0 && s.pending?.includes(tag)).map((s) => s.key);
    // Alerts, locks and the close-out moves are PRD 4 and PRD 6; the section checks are PRD 8; the exports are S01.23 (built).
    // S06.16 built the Reopen check; Reopen Done jobs is not pending any more.
    expect(pendingFor('PRD 6')).not.toContain('reopen_done_jobs');
    // S06.15 built the two cancel checks (single and bulk); Cancel jobs is not pending any more.
    expect(pendingFor('PRD 6')).not.toContain('cancel_jobs');
    // S06.8 built the review panel's check; Office review is not pending any more.
    expect(pendingFor('PRD 6')).not.toContain('office_review');
    // S06.13 built the two Mark Done checks; Close jobs and Close jobs with money owed are not pending any more.
    expect(pendingFor('PRD 6')).not.toContain('close_jobs');
    expect(pendingFor('PRD 6')).not.toContain('close_jobs_with_money_owed');
    expect(pendingFor('PRD 8')).toEqual(expect.arrayContaining(['download_transcript']));
    // S08.11 built the two recording checks, S08.12 the transcript check and S08.13 the call insights checks, S08.15 the Phone numbers tab and usage bar checks and S08.16 the four org-gated tabs; none of
    // the ten is pending any more. Download transcript stays pending on purpose: no transcript download is built.
    for (const built of ['play_recording', 'download_recording', 'view_transcript', 'see_call_insights', 'phone_numbers_tab', 'phone_usage_bar', 'call_flows_tab', 'call_groups_tab', 'training_tab', 'blocked_callers_tab']) expect(pendingFor('PRD 8')).not.toContain(built);
    // S06.29: the four "Alert me about every ..." switches are read by every alert chain now; none waits for a PRD any more.
    for (const key of ['alert_every_lead', 'alert_every_job', 'alert_every_estimate', 'alert_every_invoice']) {
      const entry = SWITCH_CATALOG.find((s) => s.key === key)!;
      expect(entry.pending, key).not.toMatch(/PRD \d/);
      expect(pendingFor('PRD 4'), key).not.toContain(key);
      expect(pendingFor('PRD 6'), key).not.toContain(key);
    }
    // S01.23 built the four exports and the five renumber checks; none is pending any more.
    expect(pendingFor('S01.23')).toEqual([]);
  });

  it('has a row for every switch with a server check in the database suites that run the table', () => {
    const dir = __dirname;
    const tables = readdirSync(dir)
      .filter((f) => /^permission-.*-db\.test\.ts$/.test(f))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    // A suite names the switch it drives (view_jobs), or runs a whole group's switches from the catalog.
    const missing = SWITCH_CATALOG
      .filter((s) => s.serverChecks.length > 0 && !new RegExp(`\\b${s.key}\\b`).test(tables) && !tables.includes(`'${s.module}'`))
      .map((s) => s.key);
    expect(missing).toEqual([]);
  });
});
