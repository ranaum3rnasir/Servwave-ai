import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A very small JSX route reader, shared by the tests that assert things about
 * the route table as a whole.
 *
 * WHY SOURCE-TEXT PARSING rather than rendering the tree: the guard stack is a
 * nesting of pathless `<Route element={<Guard/>}>` wrappers, and rendering it
 * would need an auth store, an ability, an entitlements cache and an org for
 * every one of ~70 routes - a fixture surface far larger than the thing under
 * test, and one that would have to be widened by every module that lands. The
 * route files are static JSX with no conditionals, so their text IS their
 * structure.
 *
 * Lives in a `.ts` file that is not a `.test.ts`, so vitest's
 * `include: ['src/**\/*.test.{ts,tsx}']` does not try to run it as a suite. It
 * was extracted from `guardParity.test.ts` when a second test - route
 * uniqueness - needed the same reader; two copies of a parser drift, and the
 * copy that drifts is the one that stops catching anything.
 */

/**
 * The chrome wrappers, which are NOT guards. `AppLayout` and `V2AppLayout`
 * decide what frames a page; guards decide who may open it. Swapping the first
 * changes no permission, so it is not part of a route's guard stack. Everything
 * else wrapping a route is treated as a guard.
 */
const LAYOUTS = new Set(['AppLayout', 'V2AppLayout']);

/**
 * Comments must go before anything else looks for a `<Route`: several route
 * files quote route JSX inside their docstrings, and a scanner that read those
 * would invent routes that do not exist.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;

  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // A string keeps its contents verbatim, so a "//" inside one survives.
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i]! + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i]!;
        const done = src[i] === c;
        i++;
        if (done) break;
      }
      continue;
    }

    out += c;
    i++;
  }

  return out;
}

/** The `element={…}` expression, brace-balanced, or '' when there is none. */
function elementExpression(attrs: string): string {
  const at = attrs.indexOf('element={');
  if (at === -1) return '';

  let i = at + 'element={'.length;
  let depth = 1;
  const start = i;

  while (i < attrs.length && depth > 0) {
    const c = attrs[i]!;
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }

  return attrs.slice(start, i - 1);
}

/**
 * One guard as a comparable string.
 *
 * `ProtectedRoute` is normalised rather than compared verbatim because its two
 * meaningful axes are a role SET and a boolean: `allowedRoles` order carries no
 * meaning, so it is sorted, while `fallback` decides between the in-place "no
 * access" screen and a redirect to "/" and is therefore part of the identity.
 * `RequireFeature` is keyed by its entitlement. Anything else compares by name,
 * which is enough for `DemoOnlyRoute` and `RequireCommunicationCreate` - they
 * take no props that change who gets in.
 */
function guardOf(expression: string): string | null {
  const name = expression.match(/<\s*([A-Za-z]\w*)/)?.[1];
  if (!name || LAYOUTS.has(name)) return null;

  if (name === 'ProtectedRoute') {
    const roles = [...expression.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
    const fallback = /\bfallback\b/.test(expression);
    return `ProtectedRoute(roles=${roles.length ? roles.join('|') : 'ANY'}, fallback=${fallback})`;
  }
  if (name === 'RequireFeature') {
    return `RequireFeature(${expression.match(/feature="([^"]+)"/)?.[1] ?? '?'})`;
  }

  return name;
}

export interface ParsedRoute {
  path: string;
  guards: string[];
  /** Declaration order across the whole file set, for the ordering check. */
  order: number;
  /** The file the route was declared in, so a failure names somewhere to look. */
  file: string;
}

function joinPath(parent: string, child: string): string {
  if (child.startsWith('/')) return child;
  return `${parent === '/' ? '' : parent}/${child}`;
}

/**
 * Every path-bearing `<Route>` in `src`, with the guards wrapping it.
 *
 * Handles the two shapes the tree uses: pathless wrapper routes that contribute
 * a guard, and nested children that inherit a parent's path segment (a child
 * written `path="company"` under `path="/settings"` resolves to
 * `/settings/company`, the same full path a child written absolute resolves to).
 */
export function parseRoutes(src: string, from: number, file: string): ParsedRoute[] {
  const text = stripComments(src);
  const found: ParsedRoute[] = [];
  const stack: { path: string | null; guard: string | null }[] = [];
  let i = 0;
  let order = from;

  while (i < text.length) {
    if (text.startsWith('</Route>', i)) {
      stack.pop();
      i += '</Route>'.length;
      continue;
    }
    if (!text.startsWith('<Route', i) || /[A-Za-z0-9_]/.test(text[i + '<Route'.length] ?? '')) {
      i++;
      continue;
    }

    // Walk to the `>` that closes this opening tag. Any `<` or `>` belonging to
    // a nested element sits inside `element={…}`, so brace depth is enough to
    // tell a prop's angle bracket from the tag's own.
    let j = i + '<Route'.length;
    let depth = 0;
    let selfClosing = false;

    while (j < text.length) {
      const c = text[j]!;
      if (c === '"' || c === "'" || c === '`') {
        j++;
        while (j < text.length && text[j] !== c) {
          if (text[j] === '\\') j++;
          j++;
        }
        j++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) {
        selfClosing = text[j - 1] === '/';
        break;
      }
      j++;
    }

    const attrs = text.slice(i + '<Route'.length, selfClosing ? j - 1 : j);
    const declared = attrs.match(/\bpath="([^"]*)"/)?.[1];
    const guard = declared === undefined ? guardOf(elementExpression(attrs)) : null;

    const parent = [...stack].reverse().find((entry) => entry.path !== null)?.path ?? '/';
    const full = declared === undefined ? null : joinPath(parent, declared);

    // `path="*"` is the catch-all, not a page. `index` routes carry no path of
    // their own and are covered by the parent they redirect from.
    if (full !== null && declared !== '*') {
      found.push({
        path: full.length > 1 ? full.replace(/\/$/, '') : full,
        guards: stack.map((entry) => entry.guard).filter((g): g is string => g !== null),
        order: order++,
        file,
      });
    }

    if (!selfClosing) stack.push({ path: full, guard });
    i = j + 1;
  }

  return found;
}

const V2_DIR = join(__dirname, '..');
const ROUTES_DIR = join(V2_DIR, 'routes');
const APP_TSX = join(V2_DIR, '..', '..', 'App.tsx');

/**
 * Every file that may declare a `<Route path="…">`.
 *
 * Read from the directory rather than from a list, because the whole point of
 * the auto-discovery in `routes/index.tsx` is that a module registers without
 * editing a shared file. A test that named the files explicitly would go stale
 * on the first new module and quietly stop guarding anything.
 *
 * App.tsx is in the list, and that is load-bearing for the uniqueness check: it
 * declares no page route today, and a re-added one there claiming a path a
 * module already owns is exactly the collision worth failing on.
 */
export function routeSourceFiles(): string[] {
  return [
    APP_TSX,
    join(V2_DIR, 'V2Routes.tsx'),
    ...readdirSync(ROUTES_DIR)
      .filter((name) => name.endsWith('.routes.tsx'))
      .sort()
      .map((name) => join(ROUTES_DIR, name)),
  ];
}

/** Every routed path in the app, in declaration order. */
export function allRoutes(): ParsedRoute[] {
  const routes: ParsedRoute[] = [];
  for (const file of routeSourceFiles()) {
    routes.push(...parseRoutes(readFileSync(file, 'utf8'), routes.length, file));
  }
  return routes;
}

/**
 * Two patterns that a single concrete URL can match, so declaration order
 * decides which one serves it.
 */
export function overlaps(a: string, b: string): boolean {
  const left = a.split('/');
  const right = b.split('/');
  if (left.length !== right.length) return false;
  return left.every((segment, k) => {
    const other = right[k]!;
    return segment.startsWith(':') || other.startsWith(':')
      || segment.toLowerCase() === other.toLowerCase();
  });
}

/** How many `:param` segments a pattern has - its looseness. */
export function paramCount(pattern: string): number {
  return pattern.split('/').filter((segment) => segment.startsWith(':')).length;
}
