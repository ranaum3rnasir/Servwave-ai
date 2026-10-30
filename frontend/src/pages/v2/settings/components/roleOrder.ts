import type { RoleSummary } from '@/lib/api/roles';

/**
 * The one order every list of roles uses: the Roles page's list and the role pickers on Users & Teams.
 */

export const BUILT_IN = 'Built-in roles';
export const CUSTOM = 'Custom roles';

/** The built-in roles as the server lists them, then the custom roles by name (digits in a name count as numbers). */
export function orderRoles(roles: RoleSummary[]): { builtIn: RoleSummary[]; custom: RoleSummary[] } {
  return {
    builtIn: roles.filter((r) => r.type !== 'custom'),
    custom: roles.filter((r) => r.type === 'custom').sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' })),
  };
}

/** Every role as a picker option in that order, under its built-in or custom heading; `describe` writes the option's text. */
export function roleOptions(roles: RoleSummary[], describe: (role: RoleSummary) => string = (r) => r.label) {
  const { builtIn, custom } = orderRoles(roles);
  return [
    ...builtIn.map((r) => ({ value: r.role, label: describe(r), group: BUILT_IN })),
    ...custom.map((r) => ({ value: r.role, label: describe(r), group: CUSTOM })),
  ];
}
