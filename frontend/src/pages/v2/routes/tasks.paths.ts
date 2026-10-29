/**
 * Module 8 - Tasks. Legacy paths that have a v2 counterpart.
 *
 * Paths live in their own `.paths.ts` file, separate from the `.routes.tsx`
 * that declares the JSX, because `uiV2.ts` reads the collected paths and is
 * itself imported by every v2 page. If the collector pulled in the route files
 * it would pull in the pages, and the pages import `uiV2` - an import cycle.
 *
 * These are LEGACY paths, without the `/v2` prefix. `v2Path` adds it.
 *
 * ONE path. Tasks is a single hub route with no children and no params: the six
 * views are tabs held in component-local state, not routes, and the task detail
 * is a drawer driven by a store rather than a URL. There is nothing else to
 * register.
 */
export const TASKS_V2_PATHS = [
  '/tasks',
] as const;
