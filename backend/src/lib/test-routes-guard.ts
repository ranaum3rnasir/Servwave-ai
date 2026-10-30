import type { Express } from 'express';

const TEST_ROUTE_PREFIX = '/api/test/';

type Layer = {
  name: string;
  handle: unknown;
  regexp: RegExp & { fast_slash?: boolean };
  route?: { path: string | string[] };
};

/** The path a `use` layer was mounted at, read back from the regexp Express 4 compiled for it ('' for the root). */
function mountPathOf(re: RegExp): string {
  const s = re.source;
  if (s === '^\\/?$' || s === '^\\/?(?=\\/|$)') return '';
  return s.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\/\?\$$/, '').replace(/\\\//g, '/');
}

const isTestPath = (path: string) => `${path}/`.startsWith(TEST_ROUTE_PREFIX);

/**
 * Every test door the app serves: a route at /api/test/..., at any depth (an app-level route, or one inside a router), and
 * any router, sub-app or handler mounted under /api/test (re-audit N14: the old check read app-level
 * routes only, so a test router mounted in production went unseen).
 */
function testDoorsIn(stack: Layer[], prefix = ''): string[] {
  const found: string[] = [];
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) if (typeof p === 'string' && isTestPath(prefix + p)) found.push(prefix + p);
      continue;
    }
    const at = prefix + mountPathOf(layer.regexp);
    if (layer.regexp.fast_slash !== true && isTestPath(at)) {
      found.push(`${at} (${layer.name || 'handler'})`);
      continue;
    }
    // An express() sub-app's routes are out of reach here (Express keeps the sub-app in a closure); the route test fails on any.
    if (layer.name === 'router') found.push(...testDoorsIn((layer.handle as { stack: Layer[] }).stack, at));
  }
  return found;
}

export function assertNoTestRoutesInProduction(app: Express): void {
  if (process.env.NODE_ENV !== 'production') return;

  const stack: Layer[] = (app as unknown as { _router?: { stack: Layer[] } })._router?.stack ?? [];
  const testRoutes = testDoorsIn(stack);

  if (testRoutes.length > 0) {
    throw new Error(
      `Refusing to boot: ${testRoutes.length} test route(s) registered in production: ${testRoutes.join(', ')}`,
    );
  }
}
