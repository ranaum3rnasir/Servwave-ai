/* =============================================================================
   Roles & Permissions security (tickets 36 and 36b) - reads what guards each route out of the route files.

   Not a test file and no database: it parses the route sources with the TypeScript compiler and answers, for every route of
   every route file, the names of the guards it carries (`canDo:update:Organization`, `canDoAny:...`, `requireAdmin`,
   `requireAdminTo`, or a bare identifier). The guards that say who may change the company's settings are checked against this,
   so a route added later with the wrong (or no) guard fails a test instead of passing unnoticed.
   ========================================================================== */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';

const ROUTES_DIR = join(__dirname, '..', 'routes');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

export interface FoundRoute {
  file: string;
  method: string;
  path: string;
  /** `file: METHOD path`, the name a test lists a route by. */
  key: string;
  asks: string[];
}

export function scanRouteFiles(): FoundRoute[] {
  return readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.routes.ts')).flatMap((file) => {
    const source = ts.createSourceFile(file, readFileSync(join(ROUTES_DIR, file), 'utf8'), ts.ScriptTarget.Latest, true);
    const found: FoundRoute[] = [];
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
          const method = node.expression.name.text.toUpperCase();
          found.push({ file, method, path: path.text, key: `${file}: ${method} ${path.text}`, asks });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
}

export const isAdminChecked = (r: Pick<FoundRoute, 'asks'>): boolean =>
  r.asks.some((a) => a === 'requireAdmin' || a.startsWith('requireAdminTo'));

/** True when a guard asks the ability for `update` on the company or on app settings: the check the retired switch held. */
export const asksCompanySettingsGrant = (r: Pick<FoundRoute, 'asks'>): boolean =>
  r.asks.some((a) => a === 'canDo:update:Organization' || a === 'canDo:update:AppSetting' ||
    (a.startsWith('canDoAny:') && (a.includes("'update','Organization'") || a.includes("'update','AppSetting'"))));
