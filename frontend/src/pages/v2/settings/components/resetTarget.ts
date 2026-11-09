import type { RoleSummary } from '@/lib/api/roles';
import type { RoleSwitchSet } from '@/lib/api/shared/switchTypes';

/** What a reset gives the role, in the words the confirm uses: "the Dispatcher preset", or "all off" for a role made from blank. */
export function resetTarget(set: Pick<RoleSwitchSet, 'base_role' | 'made_from_blank'>, roles: RoleSummary[]): string {
  if (set.made_from_blank) return 'all off';
  const base = roles.find((r) => r.role === set.base_role);
  return `the ${base?.label ?? 'starting'} preset`;
}
