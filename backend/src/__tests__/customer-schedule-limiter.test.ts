/**
 * GET /api/customers/:id/schedule is unpaged: it reads every visit of every job and lead of the
 * customer. It sits behind the house `expensiveLimiter` (security review, info finding), the same
 * way the category delete route and the exports do, and ahead of the handler.
 *
 * The limiters are passthroughs when Redis is off (tests, local), and every one of them is then the
 * SAME function, so they are mocked to distinct markers here to tell them apart on the route stack.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../middleware/rate-limit', () => {
  const marker = (name: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { limiterName: name });
  return {
    generalLimiter: marker('general'),
    expensiveLimiter: marker('expensive'),
    publicReadLimiter: marker('publicRead'),
    publicActionLimiter: marker('publicAction'),
    publicSelectionLimiter: marker('publicSelection'),
    authLimiter: marker('auth'),
  };
});

import customerRouter from '../routes/customer.routes';
import { expensiveLimiter } from '../middleware/rate-limit';
import { getSchedule, listJobs } from '../controllers/customer.controller';

type Layer = { handle: unknown; route?: { path: string; methods: Record<string, boolean>; stack: Layer[] } };

function routeHandles(method: string, path: string): unknown[] {
  const layer = (customerRouter as unknown as { stack: Layer[] }).stack.find(
    (l) => l.route?.path === path && l.route?.methods?.[method] === true,
  );
  if (!layer?.route) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

describe('customer routes: the unpaged schedule feed is rate limited as expensive', () => {
  it('GET /:id/schedule runs expensiveLimiter before the handler', () => {
    const handles = routeHandles('get', '/:id/schedule');
    expect(handles).toContain(expensiveLimiter);
    expect(handles.indexOf(expensiveLimiter)).toBeLessThan(handles.indexOf(getSchedule));
  });

  it('the paged Jobs tab endpoint stays on the general limiter only (it fires on every page turn)', () => {
    const handles = routeHandles('get', '/:id/jobs');
    expect(handles).toContain(listJobs);
    expect(handles).not.toContain(expensiveLimiter);
  });
});
