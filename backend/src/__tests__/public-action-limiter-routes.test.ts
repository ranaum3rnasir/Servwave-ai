/**
 * Which limiter guards the customer's public doors (#2981), pinned on the route stack.
 *
 * The limiters are passthroughs when Redis is off (tests, local) and all the same function, so they are
 * mocked to distinct markers here to tell them apart. Approval and checkout carry the per-document
 * allowance; decline carries its own; nothing on a public link is left on the old shared 5-per-15-minutes
 * limiter. The route table is walked from the real routers so a public door added later is listed or fails.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../middleware/rate-limit', () => {
  const marker = (name: string) => Object.assign((_req: unknown, _res: unknown, next: () => void) => next(), { limiterName: name });
  return {
    generalLimiter: marker('general'),
    expensiveLimiter: marker('expensive'),
    publicReadLimiter: marker('publicRead'),
    publicDocumentActionLimiter: marker('publicDocumentAction'),
    publicDeclineLimiter: marker('publicDecline'),
    publicSelectionLimiter: marker('publicSelection'),
    authLimiter: marker('auth'),
  };
});

import estimateRouter from '../routes/estimate.routes';
import invoiceRouter from '../routes/invoice.routes';
import { publicDocumentActionLimiter, publicDeclineLimiter } from '../middleware/rate-limit';
import { approvePublic, declinePublic } from '../controllers/estimate.controller';
import { createPublicCheckout } from '../controllers/invoice.controller';

type Layer = { handle: unknown; route?: { path: string; methods: Record<string, boolean>; stack: Layer[] } };

function handlesOf(router: unknown, method: string, path: string): unknown[] {
  const layer = (router as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route?.methods?.[method] === true);
  if (!layer?.route) throw new Error(`route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

const limiterNames = (handles: unknown[]) =>
  handles.map((h) => (h as { limiterName?: string }).limiterName).filter((n): n is string => !!n);

describe('the public doors and the limiter in front of each', () => {
  it('POST /estimates/:id/approve: the per-document allowance, ahead of the handler', () => {
    const h = handlesOf(estimateRouter, 'post', '/:id/approve');
    expect(limiterNames(h)).toEqual(['publicDocumentAction']);
    expect(h.indexOf(publicDocumentActionLimiter)).toBeLessThan(h.indexOf(approvePublic));
  });

  it('POST /invoices/:id/public/checkout: the per-document allowance, ahead of the handler', () => {
    const h = handlesOf(invoiceRouter, 'post', '/:id/public/checkout');
    expect(limiterNames(h)).toEqual(['publicDocumentAction']);
    expect(h.indexOf(publicDocumentActionLimiter)).toBeLessThan(h.indexOf(createPublicCheckout));
  });

  it('POST /estimates/:id/decline: its own allowance, never the payment one', () => {
    const h = handlesOf(estimateRouter, 'post', '/:id/decline');
    expect(limiterNames(h)).toEqual(['publicDecline']);
    expect(h).not.toContain(publicDocumentActionLimiter);
    expect(h.indexOf(publicDeclineLimiter)).toBeLessThan(h.indexOf(declinePublic));
  });

  it('every other public write door keeps the limiter it had (selections: its own; the reads: the read limiter)', () => {
    expect(limiterNames(handlesOf(estimateRouter, 'patch', '/:id/public/selections'))).toEqual(['publicSelection']);
    expect(limiterNames(handlesOf(estimateRouter, 'get', '/:id/decline-reasons'))).toEqual(['publicRead']);
  });

  it('no route in either router is still on the old shared limiter, and each public write has exactly one of the two new ones', () => {
    const writes: string[] = [];
    for (const [name, router] of [['estimate', estimateRouter], ['invoice', invoiceRouter]] as const) {
      for (const layer of (router as unknown as { stack: Layer[] }).stack) {
        if (!layer.route) continue;
        const names = limiterNames(layer.route.stack.map((s) => s.handle));
        expect(names).not.toContain('publicAction');
        const hits = names.filter((n) => n === 'publicDocumentAction' || n === 'publicDecline');
        if (hits.length) writes.push(`${name} ${Object.keys(layer.route.methods).join(',')} ${layer.route.path} -> ${hits.join('+')}`);
      }
    }
    expect(writes.sort()).toEqual([
      'estimate post /:id/approve -> publicDocumentAction',
      'estimate post /:id/decline -> publicDecline',
      'invoice post /:id/public/checkout -> publicDocumentAction',
    ]);
  });
});
