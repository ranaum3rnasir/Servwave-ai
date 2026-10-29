/**
 * Mobile slice 06: what an installed ServWave looks like before any of the app
 * runs - the document head and the web app manifest.
 *
 * Rubric PWA-01 (manifest id/scope/icons + apple-touch-icon), PWA-06 (theme
 * colour and body background match the header, colour scheme declared so a
 * forced dark mode does not invert the UI) and A11Y-01 (orientation never
 * locked).
 *
 * The header colour is READ from the design tokens (`--app` in the light
 * scope of tokens-v2.css, which the shell's `.app` and `.topbar` paint), not
 * restated here, so a token change that leaves the head behind turns this red.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { pwaManifest } from '../../pwa-manifest';

const FRONTEND = path.resolve(__dirname, '../..');
const PUBLIC = path.join(FRONTEND, 'public');

const indexHtml = readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const doc = new DOMParser().parseFromString(indexHtml, 'text/html');

/** `--app` in the first (light, :root) scope of tokens-v2.css, as #rrggbb. */
function headerColourFromTokens(): string {
  const css = readFileSync(path.join(FRONTEND, 'src/design-system/tokens-v2.css'), 'utf8');
  const m = css.match(/--app:\s*(\d+)\s+(\d+)\s+(\d+)\s*;/);
  if (!m) throw new Error('--app token not found in tokens-v2.css');
  return (
    '#' +
    [m[1], m[2], m[3]]
      .map((n) => Number(n).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Width, height and colour type straight from a PNG's IHDR chunk. */
function pngInfo(publicPath: string): { width: number; height: number; colourType: number } {
  const file = path.join(PUBLIC, publicPath.replace(/^\//, ''));
  const buf = readFileSync(file);
  const signature = buf.subarray(0, 8).toString('hex');
  expect(signature, `${publicPath} is not a PNG`).toBe('89504e470d0a1a0a');
  expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colourType: buf.readUInt8(25),
  };
}

// PNG colour types 2 (RGB) and 0 (grey) carry no alpha channel. iOS paints a
// transparent apple-touch-icon pixel black, and a maskable icon is cropped by
// the launcher's own shape, so both must be fully opaque by construction.
const OPAQUE_COLOUR_TYPES = [0, 2];

// Vendor terms that must never surface in anything a user or the browser's
// install UI can see. The manifest and head are both shown by the OS.
const VENDOR_TERMS = [
  /\bCTM\b/i,
  /CallTrackingMetrics/i,
  /supabase/i,
  /\brender\b/i,
  /vercel/i,
  /twilio/i,
  /resend/i,
  /stripe/i,
  /sentry/i,
  /workbox/i,
  /\bvite\b/i,
];

describe('installed app: document head', () => {
  const headerColour = headerColourFromTokens();

  it('declares a theme colour that matches the header', () => {
    const meta = doc.querySelector('meta[name="theme-color"]');
    expect(meta, 'no <meta name="theme-color">').not.toBeNull();
    expect(meta!.getAttribute('content')?.toLowerCase()).toBe(headerColour);
  });

  it('declares a light-only colour scheme so forced dark modes leave the UI alone', () => {
    const meta = doc.querySelector('meta[name="color-scheme"]');
    expect(meta, 'no <meta name="color-scheme">').not.toBeNull();
    // `only light` is the spec's opt-out from a UA-forced dark scheme; a bare
    // `light` still lets Chrome's auto-dark invert the page.
    expect(meta!.getAttribute('content')).toBe('only light');
  });

  it('paints the body with the header colour (the --app token), so the toolbar tint matches', () => {
    const classes = (doc.body.getAttribute('class') ?? '').split(/\s+/);
    expect(classes).toContain('bg-app');
    expect(classes).not.toContain('bg-background-light');
  });

  it('links a 180 px opaque apple-touch-icon that exists in public/', () => {
    const link = doc.querySelector('link[rel="apple-touch-icon"]');
    expect(link, 'no <link rel="apple-touch-icon">').not.toBeNull();
    const href = link!.getAttribute('href')!;
    expect(href.startsWith('/')).toBe(true);
    expect(existsSync(path.join(PUBLIC, href.slice(1))), `${href} missing from public/`).toBe(true);
    const info = pngInfo(href);
    expect(info.width).toBe(180);
    expect(info.height).toBe(180);
    expect(OPAQUE_COLOUR_TYPES).toContain(info.colourType);
  });

  it('carries no vendor name in its title, metas or icon links', () => {
    const visible = [
      doc.title,
      ...Array.from(doc.querySelectorAll('meta[name]')).map((m) => m.getAttribute('content') ?? ''),
      ...Array.from(doc.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')).map(
        (l) => l.getAttribute('href') ?? '',
      ),
    ].join('\n');
    for (const term of VENDOR_TERMS) expect(visible).not.toMatch(term);
  });

  it('names no manual chunk after a vendor (the build preloads them from the head)', () => {
    // `vite build` writes every manualChunks entry the entry imports into the
    // served head as <link rel="modulepreload" href="/assets/<name>-<hash>.js">.
    // The function lives in vendor-chunks.ts (mobile slice 61); the chunk names are what it returns.
    const chunkSource = readFileSync(path.join(FRONTEND, 'vendor-chunks.ts'), 'utf8');
    const block = chunkSource.match(/export function vendorChunk\(id: string\)[^{]*\{([\s\S]*?)\n\}/);
    expect(block, 'vendorChunk function not found in vendor-chunks.ts').not.toBeNull();
    const names = [...block![1]!.matchAll(/return '([^']+)'/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) for (const term of VENDOR_TERMS) expect(name).not.toMatch(term);
  });
});

describe('installed app: web app manifest', () => {
  const headerColour = headerColourFromTokens();
  const icons = pwaManifest.icons ?? [];

  it('has an id and a scope rooted at the app', () => {
    expect(pwaManifest.id).toBe('/');
    expect(pwaManifest.scope).toBe('/');
    expect(pwaManifest.start_url).toBe('/');
    expect(pwaManifest.display).toBe('standalone');
  });

  it('never locks the orientation', () => {
    expect('orientation' in pwaManifest).toBe(false);
  });

  it('uses the header colour as its theme colour', () => {
    expect(pwaManifest.theme_color?.toLowerCase()).toBe(headerColour);
  });

  it.each([
    ['192x192', 'any'],
    ['512x512', 'any'],
    ['512x512', 'maskable'],
  ])('ships a %s %s PNG icon that exists in public/ at that size', (sizes, purpose) => {
    const icon = icons.find((i) => i.sizes === sizes && (i.purpose ?? 'any') === purpose);
    expect(icon, `no ${sizes} ${purpose} icon`).toBeDefined();
    expect(icon!.type).toBe('image/png');
    const [w, h] = sizes.split('x').map(Number);
    const info = pngInfo(icon!.src);
    expect(info.width).toBe(w);
    expect(info.height).toBe(h);
    if (purpose === 'maskable') expect(OPAQUE_COLOUR_TYPES).toContain(info.colourType);
  });

  it('carries no vendor name anywhere', () => {
    const json = JSON.stringify(pwaManifest);
    for (const term of VENDOR_TERMS) expect(json).not.toMatch(term);
  });
});
