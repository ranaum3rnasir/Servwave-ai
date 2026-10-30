/**
 * Payments go-live slice 23: every public pay test exercises the page customers actually reach.
 *
 * Several payment suites once passed against `pages/PublicInvoicePage.tsx`, a v1 page that no route
 * rendered, so the behaviour they pinned was never what a customer saw. Two guards keep that from
 * happening again:
 *
 *  1. Every `/p/` route, in the public entry (`PublicApp.tsx`) AND in the staff route table, renders
 *     a page module that lives under `pages/v2/`. The import behind each route's element is
 *     resolved from the route file's own source, static or `lazy()`, so re-pointing a route at an
 *     older page fails here.
 *  2. No `Public*Page` module exists outside `pages/v2/`, so there is no unrouted copy for a test to
 *     import by mistake.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { routeSourceFiles } from '@/pages/v2/__tests__/routeTable';

const SRC = resolve(__dirname, '..');

/** The module a component name is imported from in `source`, static or `lazy(() => import())`. */
function importSpecifierOf(source: string, name: string): string | null {
  const staticImport = source.match(new RegExp(`import\\s+${name}\\s+from\\s+['"]([^'"]+)['"]`));
  if (staticImport) return staticImport[1]!;
  const lazyImport = source.match(
    new RegExp(`const\\s+${name}\\s*=\\s*lazy\\(\\s*\\(\\)\\s*=>\\s*import\\(\\s*['"]([^'"]+)['"]`),
  );
  return lazyImport ? lazyImport[1]! : null;
}

/** A specifier as a path relative to `src/`, with the extension the file really has. */
function resolveToSrc(specifier: string, fromFile: string): string {
  const base = specifier.startsWith('@/')
    ? join(SRC, specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  const file = ['', '.tsx', '.ts'].map((ext) => base + ext).find((p) => existsSync(p) && statSync(p).isFile());
  return relative(SRC, file ?? base);
}

interface PublicRoute {
  file: string;
  path: string;
  page: string;
}

function publicRoutesIn(file: string): PublicRoute[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/<Route\s+path="(\/p\/[^"]+)"\s+element=\{<\s*([A-Za-z]\w*)/g)].map((m) => {
    const specifier = importSpecifierOf(source, m[2]!);
    return {
      file: relative(SRC, file),
      path: m[1]!,
      page: specifier ? resolveToSrc(specifier, file) : `<no import found for ${m[2]}>`,
    };
  });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('the public routes render the v2 pages', () => {
  const routes = [join(SRC, 'PublicApp.tsx'), ...routeSourceFiles()].flatMap(publicRoutesIn);

  it('finds both public routes in both the public entry and the staff route table', () => {
    expect(routes.map((r) => `${r.file} ${r.path}`).sort()).toEqual([
      'PublicApp.tsx /p/estimates/:id',
      'PublicApp.tsx /p/invoices/:id',
      'pages/v2/routes/auth-public.routes.tsx /p/estimates/:id',
      'pages/v2/routes/auth-public.routes.tsx /p/invoices/:id',
    ]);
  });

  it('points every public route at a page under pages/v2/', () => {
    const offenders = routes
      .filter((r) => !r.page.startsWith('pages/v2/'))
      .map((r) => `${r.file} routes ${r.path} to ${r.page}`);
    expect(offenders).toEqual([]);
  });
});

describe('no public page exists outside pages/v2', () => {
  it('leaves no unrouted Public*Page module for a test to import', () => {
    const pagesDir = join(SRC, 'pages');
    const stray = walk(pagesDir)
      .map((f) => relative(SRC, f))
      .filter((f) => !f.startsWith('pages/v2/') && /(^|\/)Public\w*Page\.tsx$/.test(f));
    expect(stray).toEqual([]);
  });
});
