/* =============================================================================
   Roles & Permissions, PRD 8, slice S08.27 - reads the Communication routes' gates out of the route files.

   Not a test file and no database: it parses the route sources with the TypeScript compiler and answers, for every
   route, which grants its `canDo` guards ask the ability about and which catalog switch emits each of them. The
   route-level table (permission-communication-route-rows.ts) is checked against this, so a route that gains or loses
   a switch without a row changing fails a test instead of passing unnoticed.
   ========================================================================== */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { grantOwners } from '../lib/permissions/switches/ownership';

export interface RouteGate {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** The full path as the browser calls it, with `:param` placeholders as the route file spells them. */
  path: string;
  /** `action:Subject` for every canDo guard on the route, in order. */
  grants: string[];
  /** The catalog switches that emit those grants, de-duplicated. A grant no switch emits is left out. */
  switches: string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

/** Every `router.<method>(path, ...guards)` in one route file's text. */
export function scanRouteGates(source: string, mount: string): RouteGate[] {
  const owners = grantOwners();
  const file = ts.createSourceFile('routes.ts', source, ts.ScriptTarget.Latest, true);
  const found: RouteGate[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'router' &&
      (METHODS as readonly string[]).includes(node.expression.name.text)
    ) {
      const [path, ...guards] = node.arguments;
      if (path && ts.isStringLiteral(path)) {
        const grants = guards
          .filter((g): g is ts.CallExpression => ts.isCallExpression(g) && g.expression.getText(file) === 'canDo')
          .map((g) => g.arguments.map((a) => (ts.isStringLiteral(a) ? a.text : '?')).join(':'));
        const switches = [...new Set(grants.flatMap((g) => owners.get(g) ?? []))];
        found.push({ method: node.expression.name.text as RouteGate['method'], path: `${mount}${path.text}`, grants, switches });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const ROUTES_DIR = join(__dirname, '..', 'routes');

/** True for a route a Communication switch gates: the table must carry it. */
export function isCommunicationGated(gate: RouteGate): boolean {
  const communication = new Set(SWITCH_CATALOG.filter((s) => s.module === 'Communication').map((s) => s.key));
  return gate.switches.some((key) => communication.has(key));
}

/** The gates of every route in the Communication section and of the Communication tabs on a job, lead and customer. */
export function communicationRouteGates(): RouteGate[] {
  const section = readdirSync(ROUTES_DIR)
    .filter((f) => /^comm-.*\.routes\.ts$/.test(f))
    .flatMap((f) => scanRouteGates(readFileSync(join(ROUTES_DIR, f), 'utf8'), '/api/communication'));
  const tabs = ([['job.routes.ts', '/api/jobs'], ['lead.routes.ts', '/api/leads'], ['customer.routes.ts', '/api/customers']] as const)
    .flatMap(([f, mount]) => scanRouteGates(readFileSync(join(ROUTES_DIR, f), 'utf8'), mount))
    .filter((g) => g.path.endsWith('/:id/communications'));
  return [...section, ...tabs].filter(isCommunicationGated);
}
