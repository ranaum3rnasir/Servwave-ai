/* =============================================================================
   Roles & Permissions security, M5 (ticket 37, spec story 65): every mounted route checks who may use it.

   Pure: no database. The real Express app is loaded and its router stack is walked, so the list of routes is the one the
   server actually serves, never a list written by hand. A route passes when, on its way to the handler (the router-level
   `router.use(...)` steps that apply to it, then its own steps), it meets a permission check, or it is a parked route that
   answers 404/410 to everyone. A permission check is a step the codebase marks as one (middleware/routeCheck.ts): the switch
   gates `canDo` and `canDoAny`, the Admin-flag gates `requireAdmin` and `requireAdminTo`, `requireSpiderAdmin`, the Owner gate
   `requireOwner`, and the two named in-route switch guards (the customer picker's, the vendor upsert's). The role-name gate
   `authorize` is not marked: it decides by the role's name, not the Admin flag (P15), and no route uses it.

   Anything else is a failure, unless it is on ALLOWED below: one reason per group, each route named exactly. A route added
   later with no check fails here until it gets one, or until a reviewer accepts a reason for it. Each entry must still be a
   mounted route and must still have no check, so the list cannot rot or hide a route that is already covered.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import express from 'express';
import app from '../app';
import { authenticate } from '../middleware/authenticate';
import { routeCheckOf } from '../middleware/routeCheck';
import { canDo, gatePairsOf } from '../middleware/canGuard';
import { attachAbility } from '../middleware/attachAbility';
import { unscopedRequest } from '../middleware/unscopedRequest';
import { realtimePingScope } from '../middleware/realtimePingScope';
import { reviewAttentionScope } from '../middleware/reviewAttentionScope';
import { attachCustomerScope } from '../lib/permissions/customerScope';
import { omitPricesFromAnswers } from '../lib/permissions/prices';
import { FIXED_GRANTS } from '../lib/permissions/fixedGrants';
import { originVerify } from '../middleware/originVerify';
import { auditAccessDenied } from '../middleware/auditAccessDenied';
import { requestLogger } from '../middleware/requestLogger';
import { generalLimiter, expensiveLimiter } from '../middleware/rate-limit';
import { isCanonicalIdsStep, refuseNonCanonicalIds } from '../middleware/canonicalIds';

type Layer = {
  name: string;
  handle: unknown;
  method?: string;
  regexp: RegExp & { fast_slash?: boolean };
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] };
};

interface MountedRoute {
  key: string;
  /** Every step the request meets on its way, in order: router-level steps that apply to the route, then its own for this method. */
  steps: unknown[];
}

/** The path a `use` layer was mounted at, read back from the regexp Express 4 compiled for it ('' for the root). */
function mountPathOf(re: RegExp): string {
  const s = re.source;
  if (s === '^\\/?$' || s === '^\\/?(?=\\/|$)') return '';
  return s.replace(/^\^/, '').replace(/\\\/\?\(\?=\\\/\|\$\)$/, '').replace(/\\\/\?\$$/, '').replace(/\\\//g, '/');
}

const keyOf = (method: string, path: string) => {
  const p = path.length > 1 ? path.replace(/\/$/, '') : path;
  return `${method === '_all' ? 'ALL' : method.toUpperCase()} ${p}`;
};

/**
 * Steps mounted with `use` that are not routers must carry a mark (permission, closed, gate, or 'step' for the library-made
 * pass-through steps app.ts marks) or be one of these, known by identity: each passes the request on and serves nothing.
 * Anything else, at a path or at the root, could serve a request the walk never sees (a plain handler, a router reached
 * through a wrapper function), so it fails the test (re-audit N14). Nothing is trusted by the name it carries (pass 2, P2-5).
 */
const KNOWN_STEPS = new Set<unknown>([
  authenticate, attachAbility, attachCustomerScope, unscopedRequest, realtimePingScope, reviewAttentionScope, omitPricesFromAnswers,
  originVerify, auditAccessDenied, requestLogger, generalLimiter, expensiveLimiter,
]);

/** The two steps Express itself puts first in every app's router (it reads the query string, and sets up req and res). */
const isExpressOwnStep = (layer: Layer, index: number, prefix: string): boolean =>
  prefix === '' && index < 2 && (layer.name === 'query' || layer.name === 'expressInit');

/** Where the walk met something it cannot see into: an `express()` sub-app, or an unknown step mounted at a path. */
interface Stray { at: string; what: string }

/** Every route mounted on `stack`, one per method and per path, with the steps that run before its handler. */
function mountedRoutes(stack: Layer[], prefix = '', inherited: unknown[] = [], strays: Stray[] = []): MountedRoute[] {
  const out: MountedRoute[] = [];
  const uses: Layer[] = [];
  for (const [index, layer] of stack.entries()) {
    if (layer.route) {
      // An array path is one route per path, each with the router-level steps that apply to that path alone.
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) {
        const applies = uses.filter((u) => u.regexp.test(path)).map((u) => u.handle);
        for (const method of Object.keys(layer.route.methods)) {
          // A method's own steps: those registered for it, and those registered for every method (`route.all`), in order.
          const own = layer.route.stack.filter((l) => l.method === undefined || l.method === method || (method === '_all' && !l.method));
          out.push({ key: keyOf(method, prefix + path), steps: [...inherited, ...applies, ...own.map((l) => l.handle)] });
        }
      }
    } else if (layer.name === 'router') {
      const mount = mountPathOf(layer.regexp);
      const applies = uses.filter((u) => u.regexp.test(mount || '/')).map((u) => u.handle);
      out.push(...mountedRoutes((layer.handle as { stack: Layer[] }).stack, prefix + mount, [...inherited, ...applies], strays));
    } else if (layer.name === 'mounted_app') {
      strays.push({ at: prefix + mountPathOf(layer.regexp), what: 'an express() sub-app' });
    } else {
      // An error handler (four arguments) runs only after a step failed; it never serves a request of its own.
      if ((layer.handle as { length: number }).length > 3) continue;
      const atAPath = layer.regexp.fast_slash !== true;
      const known = routeCheckOf(layer.handle) !== undefined || KNOWN_STEPS.has(layer.handle) || isExpressOwnStep(layer, index, prefix);
      if (!known) strays.push({ at: prefix + mountPathOf(layer.regexp) || '/', what: `an unknown step "${layer.name || 'anonymous'}"` });
      uses.push(layer);
      // A "not found" for every path ends the walk of this level: nothing after it is ever reached.
      if (!atAPath && routeCheckOf(layer.handle) === 'closed') break;
    }
  }
  return out;
}

const appStrays: Stray[] = [];
const appRoutes = (): MountedRoute[] => mountedRoutes((app as unknown as { _router: { stack: Layer[] } })._router.stack, '', [], appStrays);

type Bucket = 'permission' | 'closed' | 'test door' | 'allowed' | 'unchecked';

/** The test-only doors under /api/test/: never mounted in production, and assertNoTestRoutesInProduction refuses to boot if they are. */
const TEST_DOOR = /^POST \/api\/test\//;

/** A grant every signed-in person holds with no condition: a gate on it lets everyone through, so it checks nothing (N14). */
const HELD_BY_EVERYONE = new Set(FIXED_GRANTS.filter((g) => !g.conditions).map((g) => `${g.action}:${g.subject}`));

/** Whether this step is a permission check anybody can fail: a marked check, other than a gate on a grant everyone holds. */
function isRealCheck(step: unknown): boolean {
  if (routeCheckOf(step) !== 'permission') return false;
  const pairs = gatePairsOf(step);
  return !pairs || !pairs.some(([action, subject]) => HELD_BY_EVERYONE.has(`${action}:${subject}`));
}

function bucketOf(route: MountedRoute, allowed: ReadonlySet<string>): Bucket {
  // A check counts only BEFORE the handler, the route's last step: a check after it never runs for the request it serves. The
  // app's id-spelling step (middleware/canonicalIds.ts) is put in after a route's last permission gate, so on a route whose gate
  // follows the handler it lands last; it is known by its own mark, never by where it sits, and is not the handler.
  const steps = route.steps.filter((s) => !isCanonicalIdsStep(s));
  const before = steps.slice(0, -1);
  if (before.some(isRealCheck)) return 'permission';
  if (route.steps.some((s) => routeCheckOf(s) === 'closed')) return 'closed';
  if (TEST_DOOR.test(route.key)) return 'test door';
  if (allowed.has(route.key)) return 'allowed';
  return 'unchecked';
}

interface AllowedGroup {
  reason: string;
  /** Whether a person must be signed in (the route carries `authenticate`); false for a door that runs before any sign-in. */
  signedIn: boolean;
  routes: string[];
}

/**
 * The routes that carry no permission check, by reason. Adding a route here is a decision to make in review: it must say why
 * any caller who reaches it (anyone at all, or anyone signed in) may use it, and where the check it does need is made.
 */
const ALLOWED: AllowedGroup[] = [
  {
    reason: 'Webhooks: no person signs in. Each handler checks the sender before it reads anything: the payment and mail providers\' '
      + 'signatures, the phone service\'s token, the secret address of a call-tracking or web-form integration.',
    signedIn: false,
    routes: [
      'POST /api/webhooks/stripe', 'POST /api/webhooks/ctm/:position', 'POST /api/webhooks/resend',
      'POST /api/webhooks/call-tracking/:provider/:urlToken/:phase?', 'POST /api/webhooks/web-form/:provider/:urlToken',
    ],
  },
  {
    reason: 'Health and API info: say only that the server is up, or whether the database answers. No company data.',
    signedIn: false,
    routes: ['GET /health', 'GET /health/deep', 'GET /api'],
  },
  {
    reason: 'Signing in and its links: nobody is signed in yet. Each takes a password, a refresh token, a sign-in code, or a single-use '
      + 'link token (invite, Owner approval, password reset), and acts only on the account that proves it.',
    signedIn: false,
    routes: [
      'POST /api/auth/login', 'POST /api/auth/refresh', 'POST /api/auth/google/finalize', 'POST /api/auth/invite',
      'POST /api/auth/accept-invite', 'POST /api/auth/accept-invite/terms', 'POST /api/auth/owner-approval',
      'POST /api/auth/owner-approval/approve', 'POST /api/auth/password/forgot', 'POST /api/auth/password/reset',
      'POST /api/auth/mfa/verify', 'POST /api/auth/mfa/resend',
    ],
  },
  {
    reason: 'A customer\'s own estimate or invoice link: nobody is signed in. The record\'s private link token is the check, and only '
      + 'that one record is answered.',
    signedIn: false,
    routes: [
      'GET /api/estimates/:id/public', 'GET /api/estimates/:id/public/pdf', 'PATCH /api/estimates/:id/public/selections',
      'POST /api/estimates/:id/approve', 'GET /api/estimates/:id/decline-reasons', 'POST /api/estimates/:id/decline',
      'GET /api/invoices/:id/public', 'GET /api/invoices/:id/public/pdf', 'POST /api/invoices/:id/public/checkout',
    ],
  },
  {
    reason: 'The signed-in person\'s own account and screens: their sign-in, two-step setting, profile, password, photo, own switches, '
      + 'saved table views, dashboard layout and own time punch. Each acts only on the person asking, never on an id from the request.',
    signedIn: true,
    routes: [
      'POST /api/auth/logout', 'GET /api/auth/me', 'POST /api/auth/mfa/setup', 'POST /api/auth/mfa/enable',
      'POST /api/auth/mfa/disable', 'GET /api/auth/mfa/status', 'PATCH /api/users/me', 'POST /api/users/me/password',
      'GET /api/users/me/password-status', 'POST /api/users/me/password/email-link', 'POST /api/users/me/avatar',
      'DELETE /api/users/me/avatar', 'GET /api/permission-switches/me', 'GET /api/me/table-views/:tableKey',
      'PUT /api/me/table-views/:tableKey', 'GET /api/dashboard/layout', 'PUT /api/dashboard/layout',
      'POST /api/dashboard/layout/reset', 'POST /api/dashboard/layout/carry-over', 'POST /api/timeclock/punches',
    ],
  },
  {
    reason: 'Reference data every signed-in person\'s forms fill from: the switch catalog, accepted payment methods, tax rates, job '
      + 'sub-statuses and cancel reasons, the company name and preferences, the app version. No customer record and no money; '
      + 'changing any of it is checked on its own route (36b, M17).',
    signedIn: true,
    routes: [
      'GET /api/permission-switches/catalog', 'GET /api/permission-switches/accepted-payment-methods', 'GET /api/state-tax-rates',
      'GET /api/org-tax-rates', 'GET /api/job-sub-statuses', 'GET /api/job-cancel-reasons', 'GET /api/version',
    ],
  },
  {
    // Re-audit N14: these carry a `canDo` on a grant every signed-in person holds (lib/permissions/fixedGrants.ts), which nobody
    // can fail, so the gate is not counted as a check. They are open to every signed-in person by that decision.
    reason: 'Behind a grant every signed-in person holds, so open to all of them: the company\'s tags, custom-field definitions '
      + 'and task categories that its forms and pickers fill from (names and settings, no customer record, no money); a sample '
      + 'document in the company\'s branding with made-up content (preview-pdf); and a company setting by key, which for '
      + '"bank_transfer_instructions" returns the company\'s bank-transfer text: part of the parked low finding L3 (SRVW-394). '
      + 'Changing any of them is checked on its own route.',
    signedIn: true,
    routes: [
      'GET /api/tags', 'GET /api/custom-field-definitions', 'GET /api/task-categories', 'GET /api/organization/preview-pdf',
      'GET /api/settings/:key',
    ],
  },
  {
    // Re-audit N20: this reason used to say "the company name and preferences", which is not all the answer carries.
    reason: 'The company\'s own record, read by every signed-in screen to fill its forms and documents: its name, addresses, '
      + 'contact details, branding, document wording, numbering, defaults and preferences. It ALSO carries the company\'s tax id, '
      + 'billing email, bank-transfer instructions and payment-account status to every signed-in person: the parked low finding L3 '
      + '(SRVW-394), still open. No customer record; the cost model is left out without See costs; changing any of it is Admin-only '
      + 'on its own routes (36b, M17).',
    signedIn: true,
    routes: ['GET /api/organization'],
  },
  {
    reason: 'Lists whose answer the handler narrows to the person\'s reach, where a 403 would be wrong: with View off the list is '
      + 'empty (scopeWhereForReq, fail-closed); search, the review-queue count, the assignee picker, the dashboard, timesheets '
      + 'and job stages answer only what the person\'s switches and scope reach, and refuse the wider view in the handler.',
    signedIn: true,
    routes: [
      'GET /api/leads', 'GET /api/estimates', 'GET /api/jobs', 'GET /api/invoices', 'GET /api/jobs/review-queue', 'GET /api/search',
      'GET /api/users/assignable', 'GET /api/dashboard', 'GET /api/timeclock/punches', 'GET /api/timeclock/ot-reviews',
      'GET /api/inventory/job-stages', 'GET /api/inventory/job-stages/:id',
    ],
  },
  {
    reason: 'Checked in the handler against the record or the surface the request names, because the switch depends on it: a '
      + 'file follows the read or edit reach of the record it hangs on (attachment.controller canAccessRow), an overtime decision '
      + 'needs the Admin flag or the person\'s own "can approve clock overrides" flag (timeclock.controller canApprove), the '
      + 'payout screen needs Manage payout account or View payments by surface.',
    signedIn: true,
    routes: [
      'GET /api/attachments/:entityType/:entityId', 'POST /api/attachments/:entityType/:entityId',
      'POST /api/attachments/:entityType/:entityId/direct-upload', 'POST /api/attachments/:entityType/:entityId/direct-upload/complete',
      'PATCH /api/attachments/:entityType/:entityId/:attachmentId', 'DELETE /api/attachments/:entityType/:entityId/:attachmentId',
      'POST /api/timeclock/ot-reviews', 'POST /api/organization/stripe/account-session',
    ],
  },
  {
    reason: 'Open to every signed-in person by decision: asking ServWave for a plan or booking a call (no company data is read), '
      + 'and Spider\'s on/off status and the person\'s own unread alerts behind the Spider gate (Admin-only settings are checked '
      + 'by requireSpiderAdmin, decided 28 Sep). Also the person\'s own Spider starting summary (#2794): only the leads they '
      + 'were told about, narrowed again to their lead reach (scopeWhereForReq), names only and no money; the company-wide '
      + 'summary is checked by requireSpiderAdmin.',
    signedIn: true,
    routes: [
      'POST /api/support/sales-request', 'POST /api/ai-farm/bookings', 'GET /api/ai-farm/spider/status',
      'GET /api/ai-farm/spider/alerts/unread', 'GET /api/ai-farm/spider/summary',
    ],
  },
  {
    reason: 'The AI copilot: no user reaches it today, and its code is out of this run (Servy is not being worked on). Each '
      + 'conversation is the asking person\'s own.',
    signedIn: true,
    routes: [
      'POST /api/copilot/generate', 'POST /api/copilot/transcribe', 'POST /api/copilot/token', 'GET /api/copilot/conversations',
      'POST /api/copilot/conversations', 'GET /api/copilot/conversations/:id', 'DELETE /api/copilot/conversations/:id',
      'POST /api/copilot/turns', 'POST /api/copilot/feedback',
    ],
  },
];

const allowedKeys = new Set(ALLOWED.flatMap((g) => g.routes));

describe('every mounted route checks who may use it (M5)', () => {
  const routes = appRoutes();
  const byKey = new Map(routes.map((r) => [r.key, r]));

  it('reads the routes off the live app (guards against a walk that finds nothing and so passes)', () => {
    expect(routes.length).toBeGreaterThan(600);
    expect([...byKey.keys()]).toEqual(expect.arrayContaining([
      'GET /api/customers/:id', 'PUT /api/roles/:role/permissions', 'POST /api/webhooks/stripe', 'GET /health',
      'GET /api/inventory/items', 'POST /api/organization/phone/connect',
    ]));
    // Router-level steps are carried down: the Roles routes are checked by one `router.use(..., requireAdmin)`.
    expect(bucketOf(byKey.get('PUT /api/roles/:role/permissions')!, allowedKeys)).toBe('permission');
  });

  it('has no route without a permission check that is not on the allow-list', () => {
    const unchecked = routes.filter((r) => bucketOf(r, allowedKeys) === 'unchecked').map((r) => r.key);
    expect(unchecked, 'routes with no permission check: add the check, or a reasoned ALLOWED entry').toEqual([]);
  });

  it('meets nothing it cannot see into: no express() sub-app, no unknown step mounted at a path (N14)', () => {
    expect(appStrays, 'mount a router instead, or add a known pass-through step with its reason').toEqual([]);
  });

  it('serves each method and path from one route only, so a check on one cannot cover another of the same key (N14)', () => {
    const seen = new Map<string, number>();
    for (const r of routes) if (bucketOf(r, new Set()) !== 'closed') seen.set(r.key, (seen.get(r.key) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([k]) => k), 'two mounted routes share a key').toEqual([]);
  });

  it('names on the allow-list only routes that are mounted and still have no check, each once', () => {
    const all = ALLOWED.flatMap((g) => g.routes);
    expect(all.filter((k, i) => all.indexOf(k) !== i), 'allow-list keys named twice').toEqual([]);
    expect(all.length).toBe(allowedKeys.size);
    expect(all.filter((k) => !byKey.has(k)), 'allow-listed routes that are no longer mounted').toEqual([]);
    expect(all.filter((k) => byKey.has(k) && bucketOf(byKey.get(k)!, new Set()) !== 'unchecked'), 'allow-listed routes that now have a check').toEqual([]);
    for (const g of ALLOWED) expect(g.reason.length, g.routes[0]).toBeGreaterThan(20);
  });

  it('signs a person in on every allow-listed route that says so, and on none that says it runs before sign-in', () => {
    const wrong = ALLOWED.flatMap((g) => g.routes
      .filter((k) => byKey.has(k) && byKey.get(k)!.steps.includes(authenticate) !== g.signedIn)
      .map((k) => `${k} (signedIn: ${g.signedIn})`));
    expect(wrong).toEqual([]);
  });

  it('reports the buckets', () => {
    const counts: Record<Bucket, number> = { permission: 0, closed: 0, 'test door': 0, allowed: 0, unchecked: 0 };
    for (const r of routes) counts[bucketOf(r, allowedKeys)] += 1;
    // Printed for the record; the assertions above are what hold the line.
    console.info(`[M5 route buckets] ${JSON.stringify({ total: routes.length, ...counts, reasons: ALLOWED.length })}`);
    expect(counts.permission).toBeGreaterThan(counts.allowed);
  });

  it('would fail on a planted route with no check, and pass it once a check is added', () => {
    const planted = express();
    const router = express.Router();
    router.use(authenticate);
    router.get('/forgotten', (_req, res) => { res.json({}); });
    router.get('/guarded', canDo('read', 'Customer'), (_req, res) => { res.json({}); });
    planted.use('/api/planted', router);
    const found = mountedRoutes((planted as unknown as { _router: { stack: Layer[] } })._router.stack);
    const unchecked = found.filter((r) => bucketOf(r, allowedKeys) === 'unchecked').map((r) => r.key);
    expect(unchecked).toEqual(['GET /api/planted/forgotten']);
  });

  it('would fail on each way a check can look present and not be (N14)', () => {
    const planted = express();
    const router = express.Router();
    router.use(authenticate);
    const ok = (_req: express.Request, res: express.Response) => { res.json({}); };
    // A check on one method of a route does not cover the route's other methods.
    router.route('/one-method').get(canDo('read', 'Customer'), ok).post(ok);
    // A check after the handler never runs for the request the handler serves.
    router.get('/late', ok, canDo('read', 'Customer'));
    // A router-level check that covers one path of an array path does not cover the other.
    router.use('/covered', canDo('read', 'Customer'));
    router.get(['/covered', '/uncovered'], ok);
    // A gate on a grant every signed-in person holds lets everyone through.
    router.get('/everyone', canDo('read', 'Tag'), ok);
    planted.use('/api/planted', router);
    // A plain handler at a path, a router reached through a wrapper function, and a sub-app are things the walk cannot see into.
    planted.use('/api/plain', (_req, res) => { res.json({}); });
    const inner = express.Router();
    inner.get('/x', ok);
    planted.use('/api/wrapped', (req, res, next) => inner(req, res, next));
    const sub = express();
    sub.get('/x', ok);
    planted.use('/api/sub', sub);

    const strays: Stray[] = [];
    const found = mountedRoutes((planted as unknown as { _router: { stack: Layer[] } })._router.stack, '', [], strays);
    const unchecked = found.filter((r) => bucketOf(r, allowedKeys) === 'unchecked').map((r) => r.key).sort();
    expect(unchecked).toEqual([
      'GET /api/planted/everyone', 'GET /api/planted/late', 'GET /api/planted/uncovered', 'POST /api/planted/one-method',
    ]);
    expect(found.filter((r) => bucketOf(r, allowedKeys) === 'permission').map((r) => r.key).sort())
      .toEqual(['GET /api/planted/covered', 'GET /api/planted/one-method']);
    expect(strays.map((x) => x.at).sort()).toEqual(['/api/plain', '/api/sub', '/api/wrapped']);
  });

  it('would fail on a handler array with the check last, a handler at the root, and a handler that borrows a known name (P2-5)', () => {
    const planted = express();
    // A handler at the root, mounted with no path, would answer every request the routes below it never see.
    planted.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (_req.path === '/api/root-served') { res.json({ served: true }); return; }
      next();
    });
    // A handler that carries the name of a step the walk knows serves a request all the same.
    const passthrough = (_req: express.Request, res: express.Response) => { res.json({}); };
    planted.use('/api/named', passthrough);
    const router = express.Router();
    router.use(authenticate);
    const ok = (_req: express.Request, res: express.Response) => { res.json({}); };
    // A handler array is the same steps in a row: a check last in it never runs for the request the handler serves.
    router.get('/array', [ok, canDo('read', 'Customer')]);
    planted.use('/api/planted', router);
    refuseNonCanonicalIds(planted);

    const strays: Stray[] = [];
    const found = mountedRoutes((planted as unknown as { _router: { stack: Layer[] } })._router.stack, '', [], strays);
    expect(found.filter((r) => bucketOf(r, allowedKeys) === 'unchecked').map((r) => r.key)).toEqual(['GET /api/planted/array']);
    expect(strays.map((x) => x.at).sort()).toEqual(['/', '/api/named']);
  });

  it('still finds a check after the handler once the id-spelling step is put in, as the real app puts it in (N14, V3)', () => {
    // The app puts its id-spelling step after a route's last permission gate (middleware/canonicalIds.ts). On a route whose
    // gate comes after the handler, that step lands last, where the handler should be: it is not the handler.
    const planted = express();
    const router = express.Router();
    router.use(authenticate);
    const ok = (_req: express.Request, res: express.Response) => { res.json({}); };
    router.get('/late', ok, canDo('read', 'Customer'));
    router.get('/late/:id', ok, canDo('read', 'Customer'));
    router.get('/guarded/:id', canDo('read', 'Customer'), ok);
    planted.use('/api/planted', router);
    refuseNonCanonicalIds(planted);

    const found = mountedRoutes((planted as unknown as { _router: { stack: Layer[] } })._router.stack);
    expect(Object.fromEntries(found.map((r) => [r.key, bucketOf(r, allowedKeys)]))).toEqual({
      'GET /api/planted/late': 'unchecked',
      'GET /api/planted/late/:id': 'unchecked',
      'GET /api/planted/guarded/:id': 'permission',
    });
  });
});
