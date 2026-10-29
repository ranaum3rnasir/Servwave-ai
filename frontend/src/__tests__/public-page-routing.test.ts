/**
 * Mobile slice 47: in `vite dev` and `vite preview` a customer's link must get `public.html`, as
 * `vercel.json` does on the host. Otherwise a local run (and the mobile gate, which runs against
 * the dev server) would exercise the staff entry and say nothing about the light one.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { publicPageRewrite, servePublicPage } from '../../public-page-routing';

const FRONTEND = resolve(__dirname, '../..');

describe('publicPageRewrite', () => {
  it.each([
    ['/p/estimates/abc?token=t', '/public.html?token=t'],
    ['/p/invoices/abc', '/public.html'],
    ['/p/anything/else?x=1&y=2', '/public.html?x=1&y=2'],
  ])('sends %s to the public page, keeping the query string', (url, want) => {
    expect(publicPageRewrite(url)).toBe(want);
  });

  it.each(['/', '/jobs', '/login', '/plans', '/pay/1', '/src/main.tsx', '/assets/p/x.js', '/@vite/client', '/p'])(
    'leaves %s alone',
    (url) => {
      expect(publicPageRewrite(url)).toBeNull();
    },
  );

  it('leaves a missing url alone', () => {
    expect(publicPageRewrite(undefined)).toBeNull();
  });
});

describe('servePublicPage plugin', () => {
  function run(hook: 'configureServer' | 'configurePreviewServer', url: string) {
    const stack: ((req: { url?: string }, res: unknown, next: () => void) => void)[] = [];
    const server = { middlewares: { use: (fn: (typeof stack)[number]) => stack.push(fn) } };
    const plugin = servePublicPage() as unknown as Record<string, (s: unknown) => void>;
    plugin[hook]!(server);
    const req = { url };
    let nexted = false;
    stack[0]!(req, {}, () => {
      nexted = true;
    });
    return { url: req.url, nexted };
  }

  it.each(['configureServer', 'configurePreviewServer'] as const)('%s rewrites a /p/ request and continues', (hook) => {
    expect(run(hook, '/p/invoices/1?token=z')).toEqual({ url: '/public.html?token=z', nexted: true });
    expect(run(hook, '/jobs')).toEqual({ url: '/jobs', nexted: true });
  });
});

describe('the wiring in vite.config.ts', () => {
  const config = readFileSync(resolve(FRONTEND, 'vite.config.ts'), 'utf8');

  it('builds both pages and turns the plugin off for the injected service-worker script', () => {
    // The staff app in the main build, the customer's page in the nested build that follows it
    // (public-entry-build.ts, mobile slice 61).
    const nested = readFileSync(resolve(FRONTEND, 'public-entry-build.ts'), 'utf8');
    expect(nested).toMatch(/public:\s*path\.resolve\(resolved\.root,\s*'public\.html'\)/);
    expect(config).toMatch(/main:\s*path\.resolve\(__dirname,\s*'index\.html'\)/);
    expect(config).toMatch(/publicEntryBuild\(/);
    expect(config).toMatch(/injectRegister:\s*false/);
    expect(config).toMatch(/servePublicPage\(\)/);
  });
});
