/* =============================================================================
   Security finding H2 (ticket 22): the door table is driven from the source.

   A revoked or deactivated person must be refused at every way in, so every way in must be in the real-database door table
   (permission-revoke-locks-out-db.test.ts, from revoke-doors.ts). This guard reads the source:
     - every route in auth.routes.ts that runs without `authenticate` is a listed sign-in door or listed as not a door;
     - every listed door and non-door is still a route;
     - nothing outside the listed files calls the identity provider to make or accept a session.
   No database.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SIGN_IN_DOORS, NOT_A_DOOR, SESSION_CALL_SITES, SESSION_CALLS } from './revoke-doors';

const SRC = path.resolve(__dirname, '..');

/** Each `router.<method>('<path>', ...handlers)` of a route file, with whether `authenticate` is among its handlers. */
function routesOf(source: string): { route: string; authenticated: boolean }[] {
  const routerWide = /router\.use\(\s*authenticate\b/.test(source);
  const out: { route: string; authenticated: boolean }[] = [];
  const re = /router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]\s*,([\s\S]*?)\);[ \t]*(?:\/\/[^\n]*)?$/gm;
  for (const m of source.matchAll(re)) {
    out.push({ route: `${m[1]!.toUpperCase()} ${m[2]}`, authenticated: routerWide || /\bauthenticate\b/.test(m[3]!) });
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('H2 (ticket 22): every way in is in the door table', () => {
  const authRoutes = routesOf(fs.readFileSync(path.join(SRC, 'routes/auth.routes.ts'), 'utf8'));

  it('reads the auth routes (the parser finds them)', () => {
    expect(authRoutes.length).toBeGreaterThan(10);
    expect(authRoutes).toContainEqual({ route: 'POST /login', authenticated: false });
    expect(authRoutes).toContainEqual({ route: 'GET /me', authenticated: true });
  });

  it('the parser reads an inline handler with statements in it as one unauthenticated route', () => {
    const sample = [
      "router.post('/inline', unscopedRequest, (req, res) => { const a = 1; res.json({ a }); });",
      "router.get('/safe', authenticate, ctrl.safe);",
    ].join('\n');
    expect(routesOf(sample)).toEqual([
      { route: 'POST /inline', authenticated: false },
      { route: 'GET /safe', authenticated: true },
    ]);
  });

  it('every unauthenticated auth route is a sign-in door or listed as not a door', () => {
    const unlisted = authRoutes
      .filter((r) => !r.authenticated)
      .map((r) => r.route)
      .filter((route) => !(SIGN_IN_DOORS as readonly string[]).includes(route) && !(route in NOT_A_DOOR));
    expect(unlisted, 'add the route to SIGN_IN_DOORS (and a row in the door table) or to NOT_A_DOOR with why').toEqual([]);
  });

  it('every listed door and non-door is still an unauthenticated auth route', () => {
    const open = new Set(authRoutes.filter((r) => !r.authenticated).map((r) => r.route));
    for (const route of [...SIGN_IN_DOORS, ...Object.keys(NOT_A_DOOR)]) expect(open.has(route), route).toBe(true);
  });

  it('no other route file serves a sign-in without authenticate', () => {
    // A sign-in route elsewhere would be one the door table never sees: every route that calls a sign-in controller is here.
    const offenders: string[] = [];
    for (const file of fs.readdirSync(path.join(SRC, 'routes')).filter((f) => f.endsWith('.ts') && f !== 'auth.routes.ts')) {
      const source = fs.readFileSync(path.join(SRC, 'routes', file), 'utf8');
      const routerWide = /router\.use\(\s*authenticate\b/.test(source);
      for (const m of source.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]\s*,([\s\S]*?)\);[ \t]*(?:\/\/[^\n]*)?$/gm)) {
        const handlers = m[3]!;
        if (/authController\.|passwordResetController\./.test(handlers) && !routerWide && !/\bauthenticate\b/.test(handlers)) {
          offenders.push(`${file}: ${m[1]!.toUpperCase()} ${m[2]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing outside the listed files makes or accepts a session with the identity provider', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel.startsWith('seed') || rel.startsWith('services/copilot/')) continue; // seed scripts; the copilot is not live
      const source = fs.readFileSync(file, 'utf8');
      const calls = SESSION_CALLS.filter((c) => source.includes(c));
      if (calls.length && !(rel in SESSION_CALL_SITES)) offenders.push(`${rel}: ${calls.join(', ')}`);
    }
    expect(offenders, 'a new way in: add its door to revoke-doors.ts and the door table').toEqual([]);
  });
});
