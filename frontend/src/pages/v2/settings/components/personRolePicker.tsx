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
  'aria-label': ariaLabel,
}: {
  roles: RoleSummary[];
  /** The key of the role the person holds. */
  value: string;
  onValueChange: (role: string) => void;
  className?: string;
  'aria-label': string;
}) {
  const options = useMemo(() => roleOptions(roles), [roles]);
  return (
    <SelectField
      aria-label={ariaLabel}
      className={className}
      value={value}
      onValueChange={onValueChange}
      options={options}
      placeholder="Choose a role"
      searchPlaceholder="Search roles"
      emptyMessage="No role matches."
    />
  );
}
