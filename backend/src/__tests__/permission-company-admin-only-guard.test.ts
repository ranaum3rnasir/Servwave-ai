/* =============================================================================
   Roles & Permissions security, M8 / D3 (ticket 36): payment instructions, main-mailbox readers and phone numbers are
   Admin-only. Since 36b (M17) the rest of Company settings is too, and the switch is retired: the whole of it is checked by
   permission-company-settings-guard.test.ts. This file keeps the ticket 36 list: each route in it carries the Admin check.

   Pure: no database. The behaviour is proven against a real database by permission-company-admin-only-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const ROUTES_DIR = join(__dirname, '..', 'routes');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

interface Found { file: string; key: string; asks: string[] }

/** Every route of every route file with the names of the guards it carries (`canDo:update:Organization`, `requireAdmin`, ...). */
function routes(): Found[] {
  return readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.ts')).flatMap((file) => {
    const source = ts.createSourceFile(file, readFileSync(join(ROUTES_DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const found: Found[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'router' &&
        METHODS.includes(node.expression.name.text)
      ) {
        const [path, ...guards] = node.arguments;
        if (path && ts.isStringLiteral(path)) {
          const asks = guards.flatMap((g): string[] => {
            if (ts.isIdentifier(g)) return [g.text];
            if (!ts.isCallExpression(g)) return [];
            const name = g.expression.getText(source);
            if (name === 'canDo') return [`canDo:${g.arguments.map((a) => (ts.isStringLiteral(a) ? a.text : '?')).join(':')}`];
            if (name === 'canDoAny') return [`canDoAny:${g.getText(source).replace(/\s+/g, '')}`];
            return [name];
          });
          found.push({ file, key: `${file}: ${node.expression.name.text.toUpperCase()} ${path.text}`, asks });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
}

const ALL = routes();
const adminChecked = (r: Found) => r.asks.some((a) => a === 'requireAdmin' || a.startsWith('requireAdminTo'));

/** Payment instructions, main-mailbox readers and phone numbers: Admin-only (D3). Each carries the Admin check. */
const ADMIN_ONLY = [
  // Main-mailbox readers: who is added or removed, and the list of people who could be.
  'organization.routes.ts: PUT /email-sender/readers/:userId',
  'organization.routes.ts: DELETE /email-sender/readers/:userId',
  'organization.routes.ts: GET /email-sender/readers/candidates',
  // The phone service connection and its numbers: connect, texting approval, disconnect (and the older addresses of the same).
  'organization.routes.ts: POST /phone/connect',
  'organization.routes.ts: POST /phone/check-texting-approval',
  'organization.routes.ts: POST /phone/disconnect',
  'organization.routes.ts: POST /connect-ctm',
  'organization.routes.ts: POST /connect-ctm/check-a2p',
  'organization.routes.ts: POST /disconnect-ctm',
  // Buying, registering, syncing and releasing numbers.
  'comm-numbers.routes.ts: POST /numbers/search',
  'comm-numbers.routes.ts: POST /numbers/buy',
  'comm-numbers.routes.ts: POST /numbers/register-byo',
  'comm-numbers.routes.ts: POST /numbers/refresh',
  'comm-numbers.routes.ts: DELETE /numbers/:id',
  // Who presents which number: the assignments, the company's default and each person's default (caller ID).
  'comm-number-assignments.routes.ts: GET /number-assignments',
  'comm-number-assignments.routes.ts: PUT /numbers/:id/assignments',
  'comm-number-assignments.routes.ts: PUT /numbers/:id/org-default',
  'comm-number-assignments.routes.ts: PUT /users/:userId/default-number',
];

describe('payment instructions, main-mailbox readers and phone numbers carry the Admin check', () => {
  it('finds the routes (guards against a scan that reads nothing and so passes)', () => {
    expect(ALL.map((r) => r.key)).toEqual(expect.arrayContaining(ADMIN_ONLY));
  });

  it('carries the Admin check on every route declared Admin-only', () => {
    const real = new Map(ALL.map((r) => [r.key, r]));
    expect(ADMIN_ONLY.filter((k) => !real.has(k))).toEqual([]);
    expect(ADMIN_ONLY.filter((k) => !adminChecked(real.get(k)!))).toEqual([]);
  });
});
