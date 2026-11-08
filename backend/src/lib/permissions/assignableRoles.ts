// Eligibility is a fixed code constant in v1 (no per-org table — analysis Decision #4).
// Future constant→per-org upgrade is clean-additive.
// #366 (product decision): the assignable pool = ALL active users of the org — every
// Role enum value is included, mirroring the #431/#434 task Owner/Watchers pool
// (which is implemented in user.controller.ts list() by omitting the role filter).
// isAssignable/isOwnerEligible still reject corrupt/unknown role values.
export const ASSIGNABLE_ROLES = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const;   // job crew + walkthrough performers (unified)
export const OWNER_ELIGIBLE_ROLES = ASSIGNABLE_ROLES;                        // commission owner (off-board picker)
// #291 — job dispatcher: only Dispatcher-role users and Admins are selectable.
export const DISPATCHER_ELIGIBLE_ROLES = ['ADMIN', 'DISPATCHER'] as const;

export function isDispatcherEligible(role: string): boolean {
  return (DISPATCHER_ELIGIBLE_ROLES as readonly string[]).includes(role);
}

export function isAssignable(role: string): boolean {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(role);
}
export function isOwnerEligible(role: string): boolean {
  return (OWNER_ELIGIBLE_ROLES as readonly string[]).includes(role);
}
