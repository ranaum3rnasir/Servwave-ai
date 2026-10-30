/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.12 - the Users, Departments and Locations groups of the switch
   catalog, including Invite users, Manage roles and permissions and the three eligibility switches.

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

const USER_ROWS: Record<string, Row> = {
  'View users': [true, false, true, true],
  'Create users': [true, false, false, false],
  'Invite users': [true, false, false, false],
  'Edit users': [true, false, false, false],
  'Delete users': [true, false, false, false],
  'Show Users & Teams page': [true, false, false, false],
  'Manage roles and permissions': [true, false, false, false],
  'Can own leads / be Sold By': [true, true, false, true],
  'Can be a dispatcher': [true, false, true, false],
  'Can be on a crew': [true, true, false, true],
};
const DEPARTMENT_ROWS: Record<string, Row> = {
  'View departments': [true, true, true, true],
  'Create departments': [true, false, false, false],
  'Edit departments': [true, false, false, false],
  'Delete departments': [true, false, false, false],
};
const LOCATION_ROWS: Record<string, Row> = {
  'View locations': [true, false, true, false],
  'Create locations': [true, false, false, false],
  'Edit locations': [true, false, false, false],
  'Delete locations': [true, false, false, false],
};
const GROUPS: Record<string, Record<string, Row>> = {
  Users: USER_ROWS,
  Departments: DEPARTMENT_ROWS,
  Locations: LOCATION_ROWS,
};

const keyOfLabel = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)?.key;
const entryOf = (label: string) => {
  const key = keyOfLabel(label);
  expect(key, `a switch labelled "${label}"`).toBeDefined();
  return findSwitch(key!)!;
};
const pairs = (label: string) => entryOf(label).grants.map((g) => `${g.action}:${g.subject}`);

describe('the Users, Departments and Locations rows of the switch catalog', () => {
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

  it('turns Invite users on in the Admin preset only', () => {
    const invite = entryOf('Invite users');
    const on = BUILT_IN_ROLES.filter((role) => invite.presets[role] === true);
    expect(on).toEqual(['ADMIN']);
  });
});

describe('Requires in the Users, Departments and Locations groups', () => {
  it('puts every other Users switch that acts on a person, and the invite and role switches, under View users', () => {
    for (const label of [
      'Create users', 'Invite users', 'Edit users', 'Delete users', 'Show Users & Teams page', 'Manage roles and permissions',
    ]) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View users')]);
    }
  });

  it('needs nothing for the three eligibility switches: they say who may fill a slot, not what a person may open', () => {
    for (const label of ['Can own leads / be Sold By', 'Can be a dispatcher', 'Can be on a crew']) {
      expect(entryOf(label).requires, label).toEqual([]);
    }
    const noView = { ...presetSwitchSet('ADMIN'), view_users: false };
    const refused = validateSwitchSet(noView).map((v) => v.switchKey);
    for (const label of ['Can own leads / be Sold By', 'Can be a dispatcher', 'Can be on a crew']) {
      expect(refused).not.toContain(keyOfLabel(label));
    }
  });

  it('puts create, edit and delete of departments and of locations under their View', () => {
    for (const label of ['Create departments', 'Edit departments', 'Delete departments']) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View departments')]);
    }
    for (const label of ['Create locations', 'Edit locations', 'Delete locations']) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View locations')]);
    }
  });

  it('refuses Invite users and Manage roles and permissions on with View users off', () => {
    const set = { ...presetSwitchSet('ADMIN'), view_users: false };
    const refused = validateSwitchSet(set).map((v) => v.switchKey);
    expect(refused).toContain(keyOfLabel('Invite users'));
    expect(refused).toContain(keyOfLabel('Manage roles and permissions'));
  });
});

describe('what these switches compile into', () => {
  it('maps the user switches onto the User subject, with Invite users as an action of its own', () => {
    expect(pairs('View users')).toEqual(['read:User']);
    expect(pairs('Create users')).toEqual(['create:User']);
    expect(pairs('Invite users')).toEqual(['invite:User']);
    expect(pairs('Edit users')).toEqual(['update:User']);
    expect(pairs('Delete users')).toEqual(['delete:User']);
    expect(pairs('Show Users & Teams page')).toEqual([]);
  });

  it('gives Manage roles and permissions an action of its own on Role, and carries the role read and edit grants the role routes still guard on', () => {
    expect(pairs('Manage roles and permissions')).toEqual(['manage_roles:Role', 'read:Role', 'update:Role']);
  });

  it('leaves the eligibility switches to PRD 3', () => {
    for (const label of ['Can own leads / be Sold By', 'Can be a dispatcher', 'Can be on a crew']) {
      expect(entryOf(label).pending, label).toMatch(/PRD 3/);
      expect(pairs(label), label).toEqual([]);
    }
  });

  it('maps the department and location switches onto their subjects', () => {
    expect(pairs('View departments')).toEqual(['read:Department']);
    expect(pairs('Create departments')).toEqual(['create:Department']);
    expect(pairs('Edit departments')).toEqual(['update:Department']);
    expect(pairs('Delete departments')).toEqual(['delete:Department']);
    expect(pairs('View locations')).toEqual(['read:Location']);
    expect(pairs('Create locations')).toEqual(['create:Location']);
    expect(pairs('Edit locations')).toEqual(['update:Location']);
    expect(pairs('Delete locations')).toEqual(['delete:Location']);
  });

  it('compiles the Dispatcher preset into reading users and locations but no user write, invite or role management', () => {
    const grants = compileSwitchGrants(presetSwitchSet('DISPATCHER')).map((g) => `${g.action}:${g.subject}`);
    expect(grants).toEqual(expect.arrayContaining(['read:User', 'read:Location', 'read:Department']));
    for (const never of ['create:User', 'invite:User', 'update:User', 'delete:User', 'manage_roles:Role', 'create:Location']) {
      expect(grants, never).not.toContain(never);
    }
  });

  it('compiles the Admin preset into every Users switch', () => {
    const grants = compileSwitchGrants(presetSwitchSet('ADMIN')).map((g) => `${g.action}:${g.subject}`);
    expect(grants).toEqual(expect.arrayContaining(['create:User', 'invite:User', 'update:User', 'delete:User', 'manage_roles:Role']));
  });
});
