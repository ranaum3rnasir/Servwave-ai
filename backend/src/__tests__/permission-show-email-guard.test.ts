/* =============================================================================
   Roles & Permissions security, M7 (ticket 36): Show Email is a permission, not a hidden button.

   Pure: no database. Reads the route files and proves that the Email page's mail routes ask for the Show Email switch beside
   the section, whichever file declares them, so a mail route added later without it fails here. A route the job, lead and
   customer tabs also use asks for neither, and is declared below with its reason (a new one must be declared too). The
   behaviour (a 403 for a person with the switch off, a normal answer with it on) is proven against a real database by
   permission-show-email-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { findSwitch } from '../lib/permissions/switches/catalog';
import { scanRouteGates } from './permission-communication-routes-scan';
import { RECORD_TAB_ROUTES } from './permission-show-email-routes';

const ROUTES_DIR = join(__dirname, '..', 'routes');
const MAIL_ROUTER = 'comm-email.routes.ts';
/** The first segment of every path the mail routers own (a mailbox, a message, a group, a rule, the sender identity). */
const MAIL_SEGMENT = /^\/(emails|mailboxes|my-mailbox|email-groups|forward-rules|sending-identity)(\/|$)/;

const routesOf = (file: string) => scanRouteGates(readFileSync(join(ROUTES_DIR, file), 'utf8'), '/api/communication');
const keyOf = (r: { method: string; path: string }) => `${r.method.toUpperCase()} ${r.path}`;
const asksSection = (r: { grants: string[] }) => r.grants.includes('access_inbox:Communication');
const asksShowEmail = (r: { switches: string[] }) => r.switches.includes('show_email');

/** The routes that break the rule: the section without Show Email, or neither without being a declared record-tab route. */
const undecided = (routes: ReturnType<typeof routesOf>) =>
  routes.filter((r) => (asksSection(r) ? !asksShowEmail(r) : !asksShowEmail(r) && !(keyOf(r) in RECORD_TAB_ROUTES))).map(keyOf);

describe('the Email page\'s mail routes ask for Show Email', () => {
  it('has a Show Email switch that compiles into a grant (it is no longer display only)', () => {
    const entry = findSwitch('show_email')!;
    expect(entry.grants.length).toBeGreaterThan(0);
    expect(entry.serverChecks.length).toBeGreaterThan(0);
    expect(entry.pending).toBeUndefined();
  });

  it('finds the routes (guards against a scan that reads nothing and so passes)', () => {
    const routes = routesOf(MAIL_ROUTER);
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.map(keyOf)).toEqual(expect.arrayContaining([
      'GET /api/communication/emails', 'POST /api/communication/emails', 'GET /api/communication/emails/:id',
      'GET /api/communication/mailboxes', 'GET /api/communication/my-mailbox',
      'GET /api/communication/emails/:id/attachments/:index', 'PATCH /api/communication/emails/threads/:id/assign',
    ]));
  });

  it('lists no route of the mail router that asks for the section and not Show Email, or for neither without a declared reason', () => {
    expect(undecided(routesOf(MAIL_ROUTER))).toEqual([]);
  });

  it('declares only record-tab routes that exist and that really ask for neither', () => {
    const routes = routesOf(MAIL_ROUTER);
    const real = new Map(routes.map((r) => [keyOf(r), r]));
    expect(Object.keys(RECORD_TAB_ROUTES).filter((k) => !real.has(k))).toEqual([]);
    expect(Object.keys(RECORD_TAB_ROUTES).filter((k) => asksSection(real.get(k)!) || asksShowEmail(real.get(k)!))).toEqual([]);
  });

  it('has no mail path in any other route file that breaks the rule', () => {
    const others = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith('.routes.ts') && f !== MAIL_ROUTER)
      .flatMap((f) => routesOf(f).map((r) => ({ file: f, r })))
      .filter(({ r }) => MAIL_SEGMENT.test(r.path.replace('/api/communication', '')))
      .map(({ file, r }) => `${file}: ${keyOf(r)}`);
    expect(others).toEqual([]);
  });

  it('makes a reply, or a send that names no record, ask for Show Email as well as the section', () => {
    const text = readFileSync(join(__dirname, '..', 'controllers', 'comm-whatsapp-email.controller.ts'), 'utf8');
    const body = text.slice(text.indexOf('export async function sendEmail('));
    const line = body.slice(body.indexOf('(req.body.thread_id || !fromARecordTab)'), body.indexOf('res.status(403)'));
    expect(line).toContain("'access_inbox'");
    expect(line).toContain("'show_email'");
  });

  describe('the check itself', () => {
    it('fails on a planted mail route that asks for the section and not Show Email', () => {
      const planted = scanRouteGates(`router.get('/emails/export', canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), h);`, '/api/communication');
      expect(undecided(planted)).toEqual(['GET /api/communication/emails/export']);
    });
    it('fails on a planted mail route that asks for neither and is not declared', () => {
      const planted = scanRouteGates(`router.get('/emails/export', canDo('read', 'Communication'), h);`, '/api/communication');
      expect(undecided(planted)).toEqual(['GET /api/communication/emails/export']);
    });
    it('passes a planted route that asks for both', () => {
      const planted = scanRouteGates(
        `router.get('/emails/export', canDo('show_email', 'Communication'), canDo('read', 'Communication'), canDo('access_inbox', 'Communication'), h);`,
        '/api/communication',
      );
      expect(undecided(planted)).toEqual([]);
    });
  });
});
