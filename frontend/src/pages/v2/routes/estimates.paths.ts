/**
 * Module 4 - Estimates. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 *
 * `/estimates/:id/edit` does not exist: estimates are create=edit, so
 * `/estimates/new` eagerly creates an empty DRAFT and redirects to the
 * workspace at `/estimates/:id`, which IS the editor. See App.tsx.
 *
 * `/estimates/:id/versions/:version` (#2030) is a past version, read-only. Its
 * own path rather than a mode flag on the workspace, so read-only is
 * structural: nothing routed here can write.
 */
export const ESTIMATES_V2_PATHS = [
  '/estimates',
  '/estimates/new',
  '/estimates/:id',
  '/estimates/:id/versions/:version',
] as const;

/**
 * The URL of one past version. A helper rather than a template literal at the call site, so the
 * shape of the path is written once, next to the pattern that declares it — a link that drifts
 * from its route is a 404 nobody notices until a customer asks about a version.
 *
 * `paths.ts`'s collector ignores anything that is not an array of strings, so exporting a
 * function alongside the path list registers nothing extra.
 */
export function estimateVersionPath(estimateId: string, version: number | string): string {
  return `/estimates/${estimateId}/versions/${version}`;
}
