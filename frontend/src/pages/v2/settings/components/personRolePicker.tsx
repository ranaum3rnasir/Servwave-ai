import { useMemo } from 'react';

import type { RoleSummary } from '@/lib/api/roles';
import { SelectField } from '@/ui-kit/components/form/selectField';

import { roleOptions } from './roleOrder';

/**
 * The picker that gives a person a role: Users & Teams, and the invite dialog.
 *
 * It lists every active role by name, the built-in roles first and then the custom roles by name, in the one order the
 * Roles page uses. The design system's select rule makes it a searchable picker once the list is long, so a company
 * with a hundred roles finds one by typing part of its name; a short list stays a plain select.
 */
export function PersonRolePicker({
  roles,
  value,
  onValueChange,
  className,
  disabled,
  adminRolesOff = false,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
}: {
  roles: RoleSummary[];
  /** The key of the role the person holds. */
  value: string;
  onValueChange: (role: string) => void;
  className?: string;
  disabled?: boolean;
  /** Keep the roles that make their holder an Admin listed but off: making an Admin is the Owner's alone (ticket 26). */
  adminRolesOff?: boolean;
  'aria-label': string;
  'aria-describedby'?: string;
}) {
  const options = useMemo(() => {
    const all = roleOptions(roles);
    if (!adminRolesOff) return all;
    const makesAdmin = new Set(roles.filter((r) => r.fullAccess).map((r) => r.role));
    return all.map((o) => (makesAdmin.has(o.value) ? { ...o, disabled: true } : o));
  }, [roles, adminRolesOff]);
  return (
    <SelectField
      aria-label={ariaLabel}
      aria-describedby={describedBy}
      className={className}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      options={options}
      placeholder="Choose a role"
      searchPlaceholder="Search roles"
      emptyMessage="No role matches."
    />
  );
}
