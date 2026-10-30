/**
 * Roles & Permissions, PRD 10, S10.25 - the two small rules the Users, Permissions and Roles pages share: whether a
 * name part can be one (the server's rule, applied as the admin types) and whether a set of switches closes the Email
 * page ("Can't read"). Expected values are written out by hand; the presets are read from the catalog fixture.
 */
import { describe, it, expect } from 'vitest';
import { emailPageClosed, type BuiltInRoleKey } from '@/lib/api/permissionSwitches';
import {
  NAME_PART_INVALID_MESSAGE, NAME_PART_RESERVED_MESSAGE, namePartProblem,
} from '@/lib/mailboxNamePart';
import { presetSet } from './support/permissionCatalogFixture';

const SUFFIX = '.acme@mail.test.com';

describe('namePartProblem', () => {
  it('has nothing to say about an empty field or a good name part', () => {
    expect(namePartProblem('', SUFFIX)).toBeNull();
    expect(namePartProblem('  ', SUFFIX)).toBeNull();
    expect(namePartProblem('jane.smith', SUFFIX)).toBeNull();
    expect(namePartProblem('Jane.Smith2', SUFFIX)).toBeNull();
  });

  it('explains anything but letters, digits and single dots between them', () => {
    for (const bad of ['jane smith', 'jane_smith', '.jane', 'jane.', 'jane..smith', 'jané', 'a@b']) {
      expect(namePartProblem(bad, SUFFIX), bad).toBe(NAME_PART_INVALID_MESSAGE);
    }
  });

  it('counts the fixed company part against the 64-character limit', () => {
    const room = 64 - 1 - 'acme'.length; // the dot and the company part come off
    expect(namePartProblem('a'.repeat(room), SUFFIX)).toBeNull();
    expect(namePartProblem('a'.repeat(room + 1), SUFFIX)).toBe(NAME_PART_INVALID_MESSAGE);
  });

  it('refuses a reserved name', () => {
    expect(namePartProblem('postmaster', SUFFIX)).toBe(NAME_PART_RESERVED_MESSAGE);
    expect(namePartProblem('Abuse', SUFFIX)).toBe(NAME_PART_RESERVED_MESSAGE);
  });
});

describe('emailPageClosed', () => {
  it.each<BuiltInRoleKey>(['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'])('is false on the %s preset', (role) => {
    expect(emailPageClosed(presetSet(role))).toBe(false);
  });

  it('is true with Show Email off, or Access Communication off, and false again with both on', () => {
    const base = presetSet('SALES');
    expect(emailPageClosed({ ...base, show_email: false })).toBe(true);
    expect(emailPageClosed({ ...base, access_communication: false })).toBe(true);
    expect(emailPageClosed({ ...base, show_email: true, access_communication: true })).toBe(false);
  });
});
