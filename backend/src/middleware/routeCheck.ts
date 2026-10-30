/**
 * The marks the route test reads (Roles & Permissions M5, ticket 37, spec story 65).
 *
 * Every mounted route either checks who may use it or is a named, reasoned exception, and a route added without a check
 * fails CI (src/__tests__/permission-every-route-checked.test.ts). That test walks the live router, so it has to recognise
 * a check by the function it finds there. A step that decides whether this person may use the route is marked here once,
 * where it is defined:
 *  - 'permission': refuses a person by their switches, the Admin flag or the Owner (canDo, canDoAny, requireAdmin,
 *    requireAdminTo, requireSpiderAdmin, requireOwner, and the named in-route switch guards). The role-name gate `authorize`
 *    is not marked: it decides by the role's name, not the Admin flag (P15), and no route uses it;
 *  - 'closed': a parked route that answers 404 or 410 to everyone and touches nothing (featureDisabled, a moved route's 410,
 *    a router's own "not found" for the paths it owns);
 *  - 'gate': a step that only lets a request on or turns it away for the company's plan (requireFeature, requireDemoOrg).
 *    Not a permission check; marked so the test knows it from an unknown step mounted at a path, which is how a handler or a
 *    wrapped router could slip past the walk (re-audit N14).
 *  - 'step': a step that only passes the request on and serves nothing (a body parser, the security headers, cross-origin
 *    rules), for the library-made ones the test cannot know by importing them (re-audit pass 2, P2-5: no step is trusted by
 *    the name it carries).
 * A mark changes nothing at run time: the function is returned as it was given.
 */
export type RouteCheck = 'permission' | 'closed' | 'gate' | 'step';

const marks = new WeakMap<object, RouteCheck>();

export function markRouteCheck<T extends object>(kind: RouteCheck, fn: T): T {
  marks.set(fn, kind);
  return fn;
}

/** The mark of a route step, if it carries one. */
export function routeCheckOf(handle: unknown): RouteCheck | undefined {
  return typeof handle === 'function' ? marks.get(handle) : undefined;
}
