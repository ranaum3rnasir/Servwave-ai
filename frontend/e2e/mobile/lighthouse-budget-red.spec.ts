/**
 * Proof that the Lighthouse budget can fail (mobile slice 62). A budget that has never been seen
 * red is not trusted, so this serves deliberately bad pages to the same Lighthouse run and the
 * same budget decision the sweep uses, and requires each to be refused for the right reason:
 *
 *   - a lean page passes (the budget can pass);
 *   - a page that blocks on a 5 MB script fails on LCP;
 *   - a page whose content jumps down after it paints fails on CLS;
 *   - the REAL production build (frontend/dist) with that 5 MB script injected into its public
 *     page, which is the "deliberately bloated build": it fails on LCP. Skipped, loudly, when no
 *     build exists (the sweep always builds first).
 *
 * No servers, no staging, no org: `npm run test:mobile:lighthouse:selftest`.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { measurePage } from './lighthouse-run';
import { DEFAULT_BUDGET, evaluateBudget } from '../../scripts/mobile-sweep-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', '..', 'dist');

const BLOAT = 'x'.repeat(5_000_000); // 5 MB of script that blocks rendering on slow 4G

const PAGE = (extraHead: string, extraBody = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fixture</title>${extraHead}</head>
<body style="margin:0;font:16px sans-serif"><main style="padding:16px"><h1>Quote ready</h1>
<p>${'This paragraph is the main content of the page. '.repeat(12)}</p>${extraBody}</main></body></html>`;

const FIXTURES: Record<string, string> = {
  '/lean': PAGE(''),
  // Blocks the first paint on a 5 MB script.
  '/heavy': PAGE('<script src="/bloat.js"></script>'),
  // Paints at once, then a banner is inserted above the content: a big layout shift.
  '/shifty': PAGE('', `<script>setTimeout(function(){var d=document.createElement('div');d.style.cssText='height:320px;background:#fde68a';d.textContent='Banner';document.querySelector('main').prepend(d)},700)</script>`),
};

function serve(root: string | null) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/bloat.js') {
      res.writeHead(200, { 'content-type': 'application/javascript', 'content-length': BLOAT.length });
      res.end(BLOAT);
      return;
    }
    if (root === null) {
      const body = FIXTURES[url.pathname];
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
      res.end(body ?? 'not found');
      return;
    }
    // A copy of the real build: /p/* is the public page, as on the host.
    let file = url.pathname.startsWith('/p/') ? 'public.html' : url.pathname.replace(/^\//, '') || 'index.html';
    const full = path.join(root, file);
    if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(full).pipe(res);
  });
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }));
  });
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60_000);

test('the budget passes a lean page', async () => {
  const s = await serve(null);
  try {
    const { measured } = await measurePage({ url: `${s.url}/lean` }, 1);
    console.log(`[lighthouse selftest] lean: ${JSON.stringify(measured)}`);
    expect(evaluateBudget(measured, DEFAULT_BUDGET), JSON.stringify(measured)).toEqual({ ok: true, failures: [] });
  } finally { s.close(); }
});

test('the budget fails a page that blocks on a 5 MB script (LCP)', async () => {
  const s = await serve(null);
  try {
    const { measured } = await measurePage({ url: `${s.url}/heavy` }, 1);
    console.log(`[lighthouse selftest] heavy: ${JSON.stringify(measured)}`);
    const verdict = evaluateBudget(measured, DEFAULT_BUDGET);
    expect(verdict.ok, `expected LCP over budget, measured ${JSON.stringify(measured)}`).toBe(false);
    expect(verdict.failures.join(' ')).toMatch(/LCP/);
  } finally { s.close(); }
});

test('the budget fails a page whose content jumps after it paints (CLS)', async () => {
  const s = await serve(null);
  try {
    const { measured } = await measurePage({ url: `${s.url}/shifty` }, 1);
    console.log(`[lighthouse selftest] shifty: ${JSON.stringify(measured)}`);
    const verdict = evaluateBudget(measured, DEFAULT_BUDGET);
    expect(verdict.ok, `expected CLS over budget, measured ${JSON.stringify(measured)}`).toBe(false);
    expect(verdict.failures.join(' ')).toMatch(/CLS/);
  } finally { s.close(); }
});

test('the budget fails the real production build with a 5 MB script injected (a bloated build)', async () => {
  test.skip(!fs.existsSync(path.join(DIST, 'public.html')), `no production build at ${DIST}: run \`npx vite build\` in frontend/ (the sweep does)`);
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'bloated-build-'));
  try {
    fs.cpSync(DIST, copy, { recursive: true });
    const html = fs.readFileSync(path.join(copy, 'public.html'), 'utf8');
    expect(html, 'public.html has a <head> to inject into').toMatch(/<head[^>]*>/);
    fs.writeFileSync(path.join(copy, 'public.html'), html.replace(/<head[^>]*>/, (m) => `${m}<script src="/bloat.js"></script>`));
    const s = await serve(copy);
    try {
      const { measured } = await measurePage({ url: `${s.url}/p/estimates/00000000-0000-0000-0000-000000000000` }, 1);
      console.log(`[lighthouse selftest] bloated real build: ${JSON.stringify(measured)}`);
      const verdict = evaluateBudget(measured, DEFAULT_BUDGET);
      expect(verdict.ok, `expected the bloated build over budget, measured ${JSON.stringify(measured)}`).toBe(false);
      expect(verdict.failures.join(' ')).toMatch(/LCP/);
    } finally { s.close(); }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
});
