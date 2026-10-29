/**
 * Collects every module's v2 path list into one registry.
 *
 * Auto-discovered with `import.meta.glob` rather than a hand-maintained import
 * list. Fourteen module branches are built in parallel off one base; a shared
 * index file would be edited by every one of them, on the same lines, and would
 * conflict on every merge. A module registers by ADDING ITS OWN FILES and
 * touching nothing shared.
 *
 * Only `.paths.ts` files are globbed here, never `.routes.tsx`. See the comment
 * in `leads.paths.ts` for why that separation is load-bearing (import cycle).
 */

/** A module's path file must export exactly one array of route patterns. */
type PathsModule = Record<string, unknown>;

const pathModules = import.meta.glob<PathsModule>('./*.paths.ts', { eager: true });

function isPathList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function collect(): string[] {
  const all: string[] = [];

  // Sorted so the registry order is deterministic across machines and OSes -
  // glob key order is not guaranteed to be stable otherwise, and a registry
  // that reorders itself makes snapshot diffs noisy for no reason.
  for (const file of Object.keys(pathModules).sort()) {
    const exports = pathModules[file]!;
    const lists = Object.entries(exports).filter(([, value]) => isPathList(value));

    // Loud rather than lenient. A module whose export is misnamed or reshaped
    // would otherwise register nothing at all, and the symptom would surface
    // far away: the legacy path stops redirecting, the v2 page looks "not
    // built yet", and nothing points back at this file. The route-registry
    // test covers this, so a mistake fails in CI, never in a browser.
    if (lists.length === 0) {
      throw new Error(
        `${file} exports no path list. A v2 *.paths.ts file must export an array of route patterns, e.g. export const LEADS_V2_PATHS = ['/leads'] as const;`,
      );
    }

    for (const [, list] of lists) {
      all.push(...(list as readonly string[]));
    }
  }

  return all;
}

/** Legacy paths that have a v2 counterpart. Route patterns, not live URLs. */
export const V2_ROUTES: readonly string[] = collect();
