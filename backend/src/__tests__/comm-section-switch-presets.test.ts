/**
 * Roles & Permissions, PRD 8, S08.17 - a new person on any built-in preset has Access Communication and the three
 * Show switches (Phone, Text, Email) on, so every preset sees the section and the Communication menu; what is inside
 * is scoped to the person (Communication scope), not hidden by these.
 *
 * "A new person" is a person whose role has no stored row: their value for each switch is the catalog's preset for
 * their built-in role, read here through the same resolution a request uses, and the section gate compiles from it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { BUILT_IN_ROLES, SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';
import { compileSwitchGrants, resolveRoleSwitchValues } from '../lib/permissions/switches/store';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const byLabel = (label: string) => {
  const entry = SWITCH_CATALOG.find((s) => s.label === label);
  expect(entry, `a switch labelled "${label}"`).toBeDefined();
  return entry!;
};

const SECTION_SWITCHES = ['Access Communication', 'Show Phone', 'Show Text', 'Show Email'].map(byLabel);

beforeEach(() => {
  mockPrisma.permissionRoleSwitch.findMany.mockResolvedValue([]);
});

describe('Access Communication and the three Show switches for a new person on each built-in preset', () => {
  it.each(BUILT_IN_ROLES)('are on for %s, and that is the catalog preset', async (role) => {
    const values = await resolveRoleSwitchValues('org-1', role, role);

    for (const entry of SECTION_SWITCHES) {
      expect(entry.kind, entry.label).toBe('toggle');
      expect(findSwitch(entry.key)!.presets[role], `${entry.label} preset for ${role}`).toBe(true);
      expect(values[entry.key], `${entry.label} for a new ${role}`).toBe(true);
    }
  });

  it.each(BUILT_IN_ROLES)('open the section gate on the server for %s', async (role) => {
    const grants = compileSwitchGrants(await resolveRoleSwitchValues('org-1', role, role));

    expect(grants).toContainEqual(expect.objectContaining({ action: 'access_inbox', subject: 'Communication' }));
  });

  it('depend on Access Communication, so the Shows cannot be on without the section', () => {
    const access = byLabel('Access Communication');
    for (const label of ['Show Phone', 'Show Text', 'Show Email']) {
      expect(byLabel(label).requires, label).toEqual([access.key]);
    }
  });
});
