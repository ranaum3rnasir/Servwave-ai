/**
 * Mobile slice 47 (PRD module 7, PUB-03 / PERF-01): the build-time check that keeps the public
 * estimate and invoice pages light, and the facts it rests on.
 *
 * The check itself (`scripts/check-public-bundle-budget.mjs`) is exercised on small fake build
 * outputs so each failure mode is provoked on purpose; the last block reads the repo's real
 * `vercel.json`, which is what decides whether a customer's link is served the light page.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import { gzipSync } from 'node:zlib';
import {
  PUBLIC_BUDGET_BYTES,
  checkPublicBundle,
  hostBanner,
  htmlForPath,
  measureInitialJs,
} from '../../../../../scripts/check-public-bundle-budget.mjs';

const FRONTEND = resolve(__dirname, '../../../../..');
const VERCEL = JSON.parse(readFileSync(join(FRONTEND, 'vercel.json'), 'utf8')) as {
  rewrites: { source: string; destination: string }[];
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Incompressible bytes, so the gzip size is about the byte size. */
const noise = (bytes: number) => randomBytes(bytes).toString('base64');

interface FakeBuild {
  publicHtml?: string;
  publicChunks?: Record<string, string>;
  staffChunks?: Record<string, string>;
}

function fakeDist({ publicHtml, publicChunks = {}, staffChunks = {} }: FakeBuild) {
  const dir = mkdtempSync(join(tmpdir(), 'public-bundle-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  for (const [name, code] of Object.entries({ ...publicChunks, ...staffChunks })) {
    writeFileSync(join(dir, 'assets', name), code);
  }
  writeFileSync(
    join(dir, 'index.html'),
    '<html><head><script type="module" crossorigin src="/assets/staff.js"></script></head></html>',
  );
  if (publicHtml !== undefined) writeFileSync(join(dir, 'public.html'), publicHtml);
  return dir;
}

const PUBLIC_HTML =
  '<html><head><script type="module" crossorigin src="/assets/pub.js"></script>' +
  '<link rel="modulepreload" crossorigin href="/assets/react.js"></head></html>';

const FAKE_VERCEL = {
  rewrites: [
    { source: '/p/(.*)', destination: '/public.html' },
    { source: '/(.*)', destination: '/index.html' },
  ],
};

const STAFF_REGISTERS = { 'staff.js': 'navigator.serviceWorker.register("/sw.js");' };

describe('htmlForPath', () => {
  it('applies rewrites in file order, first match wins', () => {
    expect(htmlForPath(FAKE_VERCEL, '/p/invoices/abc')).toBe('public.html');
    expect(htmlForPath(FAKE_VERCEL, '/jobs/12')).toBe('index.html');
    expect(htmlForPath(FAKE_VERCEL, '/')).toBe('index.html');
  });

  it('returns null when nothing serves the path', () => {
    expect(htmlForPath({ rewrites: [] }, '/p/x')).toBeNull();
  });
});

describe('measureInitialJs', () => {
  it('counts the entry, its modulepreloads and their static imports, once each', () => {
    const dir = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: {
        'pub.js': `import{a}from"./react.js";import"./shared.js";export{a};${noise(2000)}`,
        'react.js': `export const a=1;${noise(2000)}`,
        'shared.js': `export const s=1;${noise(2000)}`,
      },
    });
    const m = measureInitialJs(dir, 'public.html');
    expect(m.files.map((f) => f.file).sort()).toEqual(['assets/pub.js', 'assets/react.js', 'assets/shared.js']);
    expect(m.gzipTotal).toBeGreaterThan(5000);
  });

  it('does not count a lazy chunk reached only by import()', () => {
    const dir = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: {
        'pub.js': `const p=()=>import("./lazy.js");${noise(1000)}`,
        'react.js': 'export const a=1;',
        'lazy.js': noise(400_000),
      },
    });
    const m = measureInitialJs(dir, 'public.html');
    expect(m.files.map((f) => f.file)).not.toContain('assets/lazy.js');
    expect(m.gzipTotal).toBeLessThan(5000);
  });
});

describe('checkPublicBundle', () => {
  it('passes a light public page that is served its own HTML, while the staff page registers a worker', () => {
    const dir = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: { 'pub.js': noise(5000), 'react.js': noise(5000) },
      staffChunks: STAFF_REGISTERS,
    });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails when the public initial JavaScript is over budget', () => {
    const dir = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: { 'pub.js': noise(PUBLIC_BUDGET_BYTES * 1.4), 'react.js': 'export const a=1;' },
      staffChunks: STAFF_REGISTERS,
    });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/KB gzipped; the budget is 200 KB/);
  });

  it('fails when the public page fragments into many small scripts, however light they are in total (slice 61)', () => {
    // Each script is a request round on a phone line, and Lighthouse's mobile run models six at a
    // time: 37 small files measured 3.5 s for 183 KB; the same page as 3 files measures 2.3 s.
    const chunks: Record<string, string> = { 'react.js': 'export const a=1;' };
    const imports: string[] = [];
    for (let i = 0; i < 12; i++) {
      chunks[`part${i}.js`] = `export const p${i}=${i};`;
      imports.push(`import"./part${i}.js";`);
    }
    chunks['pub.js'] = `${imports.join('')}${noise(3000)}`;
    const dir = fakeDist({ publicHtml: PUBLIC_HTML, publicChunks: chunks, staffChunks: STAFF_REGISTERS });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/loads 14 scripts up front; the ceiling is 8/);
    // The same files pass when the ceiling allows them: it is the count that fails, not the bytes.
    expect(checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL, maxPublicFiles: 20 }).problems).toEqual([]);
  });

  it('fails when the public URL is served the staff page', () => {
    const dir = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: { 'pub.js': 'x', 'react.js': 'x' },
      staffChunks: { 'staff.js': `navigator.serviceWorker.register("/sw.js");${noise(PUBLIC_BUDGET_BYTES * 1.4)}` },
    });
    const everythingToStaff = { rewrites: [{ source: '/(.*)', destination: '/index.html' }] };
    const r = checkPublicBundle({ distDir: dir, vercelConfig: everythingToStaff });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/index\.html/);
  });

  it('fails when the public page registers a service worker, from its HTML or from its scripts', () => {
    const viaHtml = fakeDist({
      publicHtml: PUBLIC_HTML.replace('</head>', '<script src="/registerSW.js"></script></head>'),
      publicChunks: { 'pub.js': 'x', 'react.js': 'x' },
      staffChunks: STAFF_REGISTERS,
    });
    writeFileSync(join(viaHtml, 'registerSW.js'), 'navigator.serviceWorker.register("/sw.js")');
    expect(checkPublicBundle({ distDir: viaHtml, vercelConfig: FAKE_VERCEL }).problems.join('\n')).toMatch(
      /registers a service worker/,
    );

    const viaScript = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: {
        'pub.js': 'window.addEventListener("load",()=>{navigator.serviceWorker.register("/sw.js")})',
        'react.js': 'x',
      },
      staffChunks: STAFF_REGISTERS,
    });
    expect(checkPublicBundle({ distDir: viaScript, vercelConfig: FAKE_VERCEL }).problems.join('\n')).toMatch(
      /registers a service worker/,
    );
  });

  it('fails when a file the page loads is named after a vendor, public or staff', () => {
    const dir = fakeDist({
      publicHtml: PUBLIC_HTML.replace('react.js', 'supabase-AbC123.js'),
      publicChunks: { 'pub.js': 'x', 'supabase-AbC123.js': 'x' },
      staffChunks: STAFF_REGISTERS,
    });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/named after a vendor: assets\/supabase-AbC123\.js/);

    const staffNamed = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: { 'pub.js': 'x', 'react.js': 'x' },
      staffChunks: STAFF_REGISTERS,
    });
    writeFileSync(
      join(staffNamed, 'index.html'),
      '<html><head><script type="module" src="/assets/staff.js"></script><link rel="modulepreload" href="/assets/stripe-1.js"></head></html>',
    );
    writeFileSync(join(staffNamed, 'assets', 'stripe-1.js'), 'x');
    expect(checkPublicBundle({ distDir: staffNamed, vercelConfig: FAKE_VERCEL }).problems.join('\n')).toMatch(
      /index\.html loads files named after a vendor/,
    );
  });

  it('fails when the staff page stops registering the worker (the offline app must not silently vanish)', () => {
    const dir = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: { 'pub.js': 'x', 'react.js': 'x' },
      staffChunks: { 'staff.js': 'console.log(1)' },
    });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/staff app .* no longer registers/i);
  });
});

/**
 * The host builds with error-reporting upload on, which stamps every emitted script with a banner
 * (release id plus a random debug id) that does not compress. The 200 KB budget is about what a
 * customer downloads, so the check must see that banner on every machine: a build without it
 * (local, CI) passed at 194 KB while the host's own build measured 202 KB and was refused, and no
 * staging deploy of the slice ever went out.
 */
describe('the host banner', () => {
  const STAMPED =
    '(function(){try{var e=window;var t=new e.Error().stack;t&&(e._sentryDebugIds=e._sentryDebugIds||{},' +
    'e._sentryDebugIds[t]="00000000-0000-4000-8000-000000000000")}catch{}})();';

  it('is counted on a build that was made without it, so a local build measures what the host ships', () => {
    const dir = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: { 'pub.js': 'export const a=1;', 'react.js': 'export const b=2;' },
      staffChunks: STAFF_REGISTERS,
    });
    const m = measureInitialJs(dir, 'public.html');
    expect(m.files.every((f) => f.stamped === false)).toBe(true);
    // Each tiny file grows by a couple of hundred bytes of banner, far more than its own content.
    expect(m.files.every((f) => f.gzip > 200)).toBe(true);
    expect(hostBanner('assets/pub.js').length).toBeGreaterThan(300);
  });

  it('is not counted twice on a build that already carries it', () => {
    const dir = fakeDist({
      publicHtml: PUBLIC_HTML,
      publicChunks: { 'pub.js': `${STAMPED}export const a=1;`, 'react.js': `${STAMPED}export const b=2;` },
      staffChunks: STAFF_REGISTERS,
    });
    const m = measureInitialJs(dir, 'public.html');
    expect(m.files.every((f) => f.stamped === true)).toBe(true);
    expect(m.gzipTotal).toBeLessThan(1000);
  });

  it('fails a page that is under the budget bare and over it once the host stamps it', () => {
    // 34 files, as the real page has: just under the budget in content, plus a banner each.
    const publicChunks: Record<string, string> = {};
    const refs: string[] = [];
    for (let i = 0; i < 34; i++) {
      publicChunks[`c${i}.js`] = noise(Math.floor((PUBLIC_BUDGET_BYTES - 6_000) / 34));
      refs.push(`<script type="module" src="/assets/c${i}.js"></script>`);
    }
    const dir = fakeDist({
      publicHtml: `<html><head>${refs.join('')}</head></html>`,
      publicChunks,
      staffChunks: STAFF_REGISTERS,
    });
    const bare = Object.values(publicChunks).reduce((n, c) => n + gzipSync(c).length, 0);
    expect(bare).toBeLessThan(PUBLIC_BUDGET_BYTES);
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/KB gzipped; the budget is 200 KB/);
  });
});

describe("the repo's own vercel.json", () => {
  it.each(['/p/estimates/3f2c', '/p/invoices/3f2c'])(
    'serves %s from a page of its own, not the staff app shell',
    (path) => {
      expect(htmlForPath(VERCEL, path)).toBe('public.html');
    },
  );

  it.each(['/', '/jobs/12', '/login', '/accept-invite', '/auth/callback', '/settings/users', '/pricing'])(
    'still serves %s from the staff app shell',
    (path) => {
      expect(htmlForPath(VERCEL, path)).toBe('index.html');
    },
  );

  it('does not hand look-alikes such as /plans or /pay to the public page', () => {
    expect(htmlForPath(VERCEL, '/plans')).toBe('index.html');
    expect(htmlForPath(VERCEL, '/pay')).toBe('index.html');
  });
});
