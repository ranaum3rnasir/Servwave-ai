import { PRESERVED_ON_RESET } from './defaultGrants';

/**
 * LEGACY (S01.22). The comparison the old drift checker made between the role-permission rows an organization holds and
 * the seeded default grants. Those rows no longer decide anyone's access (a person's switches do), and the drift checker
 * now compares stored role sets with the catalog presets (`scripts/check-role-permission-drift.ts`). This pure function
 * stays only because the tests that pin the historical condition-repoint migrations ask it the question.
 */
export type GrantRow = { role: string; action: string; subject: string; conditions?: unknown };

const grantKey = (g: { role: string; action: string; subject: string }) => `${g.role}::${g.action}::${g.subject}`;

export function diffGrants(defaults: GrantRow[], existing: GrantRow[]) {
  const existingByKey = new Map(existing.map((g) => [grantKey(g), g]));
  const defaultKeys = new Set(defaults.map(grantKey));
  const missing = defaults.filter((g) => !existingByKey.has(grantKey(g)));
  // A grant the platform deliberately stopped seeding is not drift on an organization that still holds it.
  const extra = existing.filter(
    (g) =>
      !defaultKeys.has(grantKey(g)) &&
      !PRESERVED_ON_RESET.some((p) => p.action === g.action && p.subject === g.subject),
  );
  // Same role, action and subject on both sides, but the condition JSON differs.
  const changed = defaults
    .filter((g) => existingByKey.has(grantKey(g)))
    .filter((g) => JSON.stringify(existingByKey.get(grantKey(g))!.conditions ?? null) !== JSON.stringify(g.conditions ?? null))
    .map((g) => ({ default: g, existing: existingByKey.get(grantKey(g))! }));
  return { missing, extra, changed };
}
