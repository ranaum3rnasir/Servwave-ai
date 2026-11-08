import { Fragment, type ReactNode } from 'react';

/**
 * Collects every module's `<Route>` block into the v2 route tree.
 *
 * Auto-discovered for the same reason as `paths.ts`: a module registers by
 * adding `<module>.routes.tsx` and `<module>.paths.ts`, and edits no shared
 * file. Fourteen parallel branches therefore never conflict over registration.
 *
 * Ordering across modules does not matter - module route prefixes are distinct,
 * so no module's pattern can swallow another's. Ordering WITHIN a module does
 * matter (`/leads/:id/edit` before `/leads/:id`) and stays inside that module's
 * own file, where it is visible next to the routes it constrains.
 */

type RoutesModule = Record<string, unknown>;

const routeModules = import.meta.glob<RoutesModule>('./*.routes.tsx', { eager: true });

type RoutesFactory = () => ReactNode;

function isRoutesFactory(value: unknown): value is RoutesFactory {
  return typeof value === 'function';
}

/**
 * Every module's routes, as one array of elements.
 *
 * Keyed by file path rather than array index so React's reconciler is not
 * asked to match up children whose position shifts every time a module lands.
 */
export function moduleV2Routes(): ReactNode[] {
  const blocks: ReactNode[] = [];

  for (const file of Object.keys(routeModules).sort()) {
    const exports = routeModules[file]!;
    const factories = Object.entries(exports).filter(([, value]) => isRoutesFactory(value));

    if (factories.length === 0) {
      throw new Error(
        `${file} exports no routes function. A v2 *.routes.tsx file must export a function returning its <Route> block, e.g. export function leadsV2Routes() { return <Route ... />; }`,
      );
    }

    for (const [name, factory] of factories) {
      blocks.push(<Fragment key={`${file}#${name}`}>{(factory as RoutesFactory)()}</Fragment>);
    }
  }

  return blocks;
}
