/**
 * Mobile slice 61 (PRD module 7, PERF-02 / PERF-03): fonts must not stand between a phone and its
 * first paint.
 *
 * Before: two CSS `@import`s of third-party font stylesheets (a chain: our stylesheet, then theirs,
 * then the font files) plus a third stylesheet link in the head, all render-blocking, all on a
 * host that can be slow or unreachable. After: the font files are ours, same origin, declared with
 * `font-display: swap`, the two faces that paint the first screen are preloaded, and a fallback
 * face with matching metrics keeps the swap from moving the page (CLS).
 *
 * These read the real source files, so they fail when someone puts a blocking font stylesheet back.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FRONTEND = resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(join(FRONTEND, p), 'utf8');
const exists = (p: string) => existsSync(join(FRONTEND, p));

const indexHtml = read('index.html');
const publicHtml = read('public.html');
const indexCss = read('src/index.css');
const fontsCss = exists('src/design-system/fonts.css') ? read('src/design-system/fonts.css') : '';
const shellCss = read('src/ui-kit/components/layout/shell.css');
const tailwindConfig = read('tailwind.config.js');
const vercel = JSON.parse(read('vercel.json')) as { headers: { source: string; headers: { key: string; value: string }[] }[] };

const links = (html: string) => [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

describe.each([
  ['index.html', indexHtml],
  ['public.html', publicHtml],
])('%s head', (_name, html) => {
  it('has no third-party stylesheet and no preconnect to a font host', () => {
    for (const tag of links(html)) {
      if (attr(tag, 'rel') === 'stylesheet') expect(attr(tag, 'href')).not.toMatch(/^(https?:)?\/\//);
      if (attr(tag, 'rel') === 'preconnect') expect(attr(tag, 'href')).not.toMatch(/fonts\.g/);
    }
  });

  it('preloads each font as a same-origin, crossorigin woff2 that exists', () => {
    const preloads = links(html).filter((t) => attr(t, 'rel') === 'preload' && attr(t, 'as') === 'font');
    expect(preloads.length).toBeGreaterThan(0);
    for (const tag of preloads) {
      expect(attr(tag, 'type')).toBe('font/woff2');
      // A font preload without `crossorigin` is fetched twice: fonts are always CORS requests.
      expect(tag).toMatch(/\bcrossorigin\b/);
      const href = attr(tag, 'href')!;
      expect(href).toMatch(/^\/fonts\//);
      expect(exists(`public${href}`)).toBe(true);
    }
  });
});

describe('which faces are preloaded', () => {
  const hrefs = (html: string) =>
    links(html)
      .filter((t) => attr(t, 'rel') === 'preload' && attr(t, 'as') === 'font')
      .map((t) => attr(t, 'href')!);

  it('the staff page preloads the app face and the body face (Latin only)', () => {
    const h = hrefs(indexHtml);
    expect(h.some((x) => /figtree-latin-\d/.test(x))).toBe(true);
    expect(h.some((x) => /manrope-latin-\d/.test(x))).toBe(true);
    expect(h.some((x) => /ext|caveat/.test(x))).toBe(false);
  });

  it('the public page preloads only the body face; it never shows the app face or the signature script', () => {
    const h = hrefs(publicHtml);
    expect(h.some((x) => /manrope-latin-\d/.test(x))).toBe(true);
    expect(h.some((x) => /figtree|ext|caveat/.test(x))).toBe(false);
  });
});

describe('the stylesheet', () => {
  it('does not @import anything from another origin', () => {
    expect(indexCss).not.toMatch(/@import\s+(url\()?["']?(https?:)?\/\//);
    expect(shellCss).not.toMatch(/@import\s+(url\()?["']?(https?:)?\/\//);
  });

  it('declares every font face with swap, from a file of ours that exists', () => {
    const faces = [...fontsCss.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1] ?? '').filter((f) => /url\(/.test(f));
    expect(faces.length).toBeGreaterThanOrEqual(6);
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap/);
      for (const m of face.matchAll(/url\(["']?([^)"']+)["']?\)/g)) {
        const href = m[1] ?? '';
        expect(href).toMatch(/^\/fonts\//);
        expect(exists(`public${href}`)).toBe(true);
      }
    }
  });

  it('defines the three families the app asks for', () => {
    for (const family of ['Manrope', 'Figtree', 'Caveat']) {
      expect(fontsCss).toMatch(new RegExp(`font-family:\\s*["']${family}["']`));
    }
  });

  it('defines a metric-matched fallback for each UI face and puts it right after the face', () => {
    for (const family of ['Manrope', 'Figtree']) {
      const re = new RegExp(`@font-face\\s*{[^}]*font-family:\\s*["']${family} Fallback["'][^}]*}`);
      const face = fontsCss.match(re)?.[0] ?? '';
      expect(face, `${family} Fallback`).toMatch(/size-adjust:/);
      expect(face).toMatch(/ascent-override:/);
      expect(face).toMatch(/src:\s*local\(/);
    }
    expect(tailwindConfig).toMatch(/sans:\s*\[\s*'Manrope',\s*'Manrope Fallback'/);
    expect(shellCss).toMatch(/font-family:\s*"Figtree",\s*"Figtree Fallback"/);
  });

  it('is pulled in by index.css, which both entries import', () => {
    expect(indexCss).toMatch(/@import\s+["']\.\/design-system\/fonts\.css["']/);
  });
});

describe('caching', () => {
  it('serves /fonts/ as immutable: the file names carry the package version', () => {
    const rule = vercel.headers.find((h) => h.source.startsWith('/fonts/'));
    expect(rule?.headers.find((h) => h.key === 'Cache-Control')?.value).toMatch(/immutable/);
  });
});
