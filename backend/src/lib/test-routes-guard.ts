import type { Express } from 'express';

const TEST_ROUTE_PREFIX = '/api/test/';

export function assertNoTestRoutesInProduction(app: Express): void {
  if (process.env.NODE_ENV !== 'production') return;

  const stack: Array<{ route?: { path?: string } }> = (app as any)._router?.stack ?? [];
  const testRoutes = stack
    .map((layer) => layer.route?.path)
    .filter((p): p is string => typeof p === 'string' && p.startsWith(TEST_ROUTE_PREFIX));

  if (testRoutes.length > 0) {
    throw new Error(
      `Refusing to boot: ${testRoutes.length} test route(s) registered in production: ${testRoutes.join(', ')}`,
    );
  }
}
