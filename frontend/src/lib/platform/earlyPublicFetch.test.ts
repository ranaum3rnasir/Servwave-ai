/**
 * Mobile slice 61 (PERF-03): the customer's document request starts before the page's scripts
 * have downloaded, and the page uses that request instead of making a second one.
 *
 * Three things are pinned: the plain script starts the right request (run exactly as shipped, so
 * the file cannot drift from what the two pages build), the page takes the early response once and
 * only for the same URL, and a failed early request falls back to an ordinary one.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publicEarlyScript, publicEarlyScriptPlugin } from '../../../public-early-script';
import { fetchPublicDocument, takeEarlyPublicResponse } from './earlyPublicFetch';

const FRONTEND = resolve(__dirname, '../../..');
const TEMPLATE = readFileSync(resolve(FRONTEND, 'public-early.template.js'), 'utf8');
const HTML = readFileSync(resolve(__dirname, '../../../public.html'), 'utf8');
const ESTIMATE_PAGE = readFileSync(resolve(__dirname, '../../pages/v2/auth-public/PublicEstimatePage.tsx'), 'utf8');
const INVOICE_PAGE = readFileSync(resolve(__dirname, '../../pages/v2/auth-public/PublicInvoicePage.tsx'), 'utf8');

const ID = '3f1c2a9e-1111-4222-8333-444455556666';

function runScript(location: { pathname: string; search: string }, apiBase: string | undefined, fetchImpl: typeof fetch) {
  const win = {
    location,
    fetch: fetchImpl,
  } as unknown as Window & { __earlyPublicFetch?: { url: string; response: Promise<Response> } };
  new Function('window', 'URLSearchParams', publicEarlyScript(TEMPLATE, apiBase))(win, URLSearchParams);
  return win;
}

describe('public-early.template.js', () => {
  const ok = () => Promise.resolve(new Response('{}'));

  it('starts the estimate request the page itself would make', () => {
    const fetchImpl = vi.fn(ok);
    const win = runScript({ pathname: `/p/estimates/${ID}`, search: '?token=abc%20def' }, 'https://api.example.test', fetchImpl as never);
    const expected = `https://api.example.test/api/estimates/${ID}/public?token=${encodeURIComponent('abc def')}`;
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(expected);
    expect(win.__earlyPublicFetch?.url).toBe(expected);
    // The page builds the same string.
    expect(ESTIMATE_PAGE).toContain('/api/estimates/${id}/public?token=${encodeURIComponent(token)}');
  });

  it('starts the invoice request the page itself would make', () => {
    const fetchImpl = vi.fn(ok);
    const win = runScript({ pathname: `/p/invoices/${ID}/`, search: '?token=t1' }, '', fetchImpl as never);
    expect(win.__earlyPublicFetch?.url).toBe(`/api/invoices/${ID}/public?token=t1`);
    expect(INVOICE_PAGE).toContain('/api/invoices/${id}/public?token=${encodeURIComponent(token)}');
  });

  it('reads no API address as "this origin", and fills the placeholder in exactly once as a string literal', () => {
    for (const base of ['', undefined]) {
      const win = runScript({ pathname: `/p/invoices/${ID}`, search: '?token=t1' }, base, vi.fn(ok) as never);
      expect(win.__earlyPublicFetch?.url).toBe(`/api/invoices/${ID}/public?token=t1`);
    }
    const filled = publicEarlyScript(TEMPLATE, 'https://api.example.test/"x');
    expect(filled).not.toContain('PUBLIC_API_BASE_PLACEHOLDER');
    expect(filled).toContain('var base = "https://api.example.test/\\"x";');
  });

  it('does nothing without a token or off the two public paths', () => {
    for (const loc of [
      { pathname: `/p/estimates/${ID}`, search: '' },
      { pathname: `/p/other/${ID}`, search: '?token=t' },
      { pathname: '/schedule', search: '?token=t' },
    ]) {
      const fetchImpl = vi.fn(ok);
      const win = runScript(loc, '', fetchImpl as never);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(win.__earlyPublicFetch).toBeUndefined();
    }
  });

  it('never throws, even when fetch itself does', () => {
    const boom = vi.fn(() => {
      throw new Error('no fetch');
    });
    expect(() => runScript({ pathname: `/p/estimates/${ID}`, search: '?token=t' }, '', boom as never)).not.toThrow();
  });

  it('is loaded by public.html as a same-origin async script, with no API address in the page itself', () => {
    expect(HTML).toMatch(/<script src="\/public-early\.js" async><\/script>/);
    expect(HTML).not.toMatch(/VITE_API_URL|api-base/);
  });
});

describe('the script plugin', () => {
  const run = (emit: boolean) => {
    const plugin = publicEarlyScriptPlugin({ root: FRONTEND, apiBase: 'https://api.example.test', emit }) as unknown as {
      generateBundle: (this: { emitFile: (f: unknown) => void }) => void;
      configureServer: (s: unknown) => void;
    };
    const emitted: unknown[] = [];
    plugin.generateBundle.call({ emitFile: (f) => emitted.push(f) });
    return { plugin, emitted };
  };

  it('writes public-early.js into the customer page build, and nothing into the staff build', () => {
    const { emitted } = run(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: 'asset', fileName: 'public-early.js' });
    expect((emitted[0] as { source: string }).source).toContain('"https://api.example.test"');
    expect(run(false).emitted).toEqual([]);
  });

  it('serves it from the dev and preview servers', () => {
    const { plugin } = run(false);
    let handler: ((req: { url?: string }, res: { setHeader: (k: string, v: string) => void; end: (b: string) => void }, next: () => void) => void) | undefined;
    plugin.configureServer({ middlewares: { use: (fn: typeof handler) => (handler = fn) } });
    let body = '';
    let nexted = false;
    handler!({ url: '/public-early.js?x=1' }, { setHeader: () => {}, end: (b) => (body = b) }, () => (nexted = true));
    expect(body).toContain('__earlyPublicFetch');
    expect(nexted).toBe(false);
    handler!({ url: '/other.js' }, { setHeader: () => {}, end: () => {} }, () => (nexted = true));
    expect(nexted).toBe(true);
  });
});

describe('fetchPublicDocument', () => {
  beforeEach(() => {
    delete window.__earlyPublicFetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__earlyPublicFetch;
  });

  it('hands over the early response once, and only for the same URL', async () => {
    const early = Promise.resolve(new Response('early'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('own')));
    window.__earlyPublicFetch = { url: '/api/estimates/1/public?token=t', response: early };

    expect(takeEarlyPublicResponse('/api/estimates/2/public?token=t')).toBeNull();
    expect(window.__earlyPublicFetch).toBeDefined(); // a different URL leaves it alone

    expect(await (await fetchPublicDocument('/api/estimates/1/public?token=t')).text()).toBe('early');
    expect(fetchSpy).not.toHaveBeenCalled();

    // Taken: a second read (a refresh after a payment return) is a real request.
    expect(await (await fetchPublicDocument('/api/estimates/1/public?token=t')).text()).toBe('own');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('makes its own request when no early one exists', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('own')));
    expect(await (await fetchPublicDocument('/api/invoices/1/public?token=t')).text()).toBe('own');
    expect(fetchSpy).toHaveBeenCalledWith('/api/invoices/1/public?token=t');
  });

  it('falls back to its own request when the early one failed', async () => {
    const failed = Promise.reject(new TypeError('network'));
    failed.catch(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response('own')));
    window.__earlyPublicFetch = { url: '/api/invoices/1/public?token=t', response: failed };
    expect(await (await fetchPublicDocument('/api/invoices/1/public?token=t')).text()).toBe('own');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('both pages load their document through it', () => {
    expect(ESTIMATE_PAGE).toMatch(/fetchPublicDocument\(\s*`\$\{import\.meta\.env\.VITE_API_URL \|\| ''\}\/api\/estimates\/\$\{id\}\/public\?/);
    expect(INVOICE_PAGE).toMatch(/fetchPublicDocument\(`\$\{import\.meta\.env\.VITE_API_URL \|\| ''\}\/api\/invoices\/\$\{id\}\/public\?/);
  });
});
