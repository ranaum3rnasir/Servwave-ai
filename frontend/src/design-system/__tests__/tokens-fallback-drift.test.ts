/* =============================================================================
   ServWave Design System — FALLBACKS drift guard
   -----------------------------------------------------------------------------
   `tokens.css` is the single source of truth for token VALUES, but `tokens.ts`
   keeps a static hex `FALLBACKS` map so `token()` never returns an empty string
   in jsdom/SSR (where there is no computed style to read). That is a second copy
   of the same values, and a second copy can drift silently: someone retunes
   `--primary` in the CSS, the app re-themes, and every test/SSR render keeps
   painting the OLD hex.

   This test parses tokens.css, resolves the `var()` indirection chain down to
   raw RGB channels, converts to hex, and asserts every FALLBACKS entry matches.
   It reads ONLY the `:root` block - `.dark` deliberately redefines a few tokens,
   and FALLBACKS mirrors the light theme. tokens-v2.css's `:root` is read too:
   the scheduler's event palette offers its `--status-*` hues, so FALLBACKS
   mirrors those, and a mirror nothing checks is the drift this file exists for.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = resolve(HERE, '..', 'tokens.css');
const CSS_V2 = resolve(HERE, '..', 'tokens-v2.css');
const TS = resolve(HERE, '..', 'tokens.ts');

/** Extract the `:root { ... }` block only (excludes the `.dark` overrides). */
function rootBlock(css: string): string {
  const start = css.indexOf(':root');
  const open = css.indexOf('{', start);
  const close = css.indexOf('\n}', open);
  return css.slice(open + 1, close);
}

/** `--name: value;` pairs, comments stripped. */
function parseDecls(block: string): Map<string, string> {
  const noComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, string>();
  for (const m of noComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const [, name, value] = m;
    if (name && value) out.set(name, value.trim());
  }
  return out;
}

/** Follow `var(--x)` indirection until a literal value is reached. */
function resolveVar(name: string, decls: Map<string, string>, seen = new Set<string>()): string | null {
  if (seen.has(name)) return null; // cycle guard
  seen.add(name);
  const raw = decls.get(name);
  if (!raw) return null;
  const varMatch = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  const inner = varMatch?.[1];
  if (inner) return resolveVar(inner, decls, seen);
  return raw;
}

/** `"12 45 58"` -> `"#0c2d3a"`. Returns null for non-channel values. */
function channelsToHex(value: string): string | null {
  const m = value.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})$/);
  if (!m) return null;
  const channels = [m[1], m[2], m[3]];
  if (channels.some((c) => c === undefined)) return null;
  return (
    '#' +
    channels.map((n) => Number(n).toString(16).padStart(2, '0')).join('')
  );
}

/** Pull the FALLBACKS literal out of tokens.ts without importing the module. */
function parseFallbacks(ts: string): Map<string, string> {
  const start = ts.indexOf('const FALLBACKS');
  const open = ts.indexOf('{', start);
  const close = ts.indexOf('\n};', open);
  const body = ts.slice(open + 1, close).replace(/\/\/.*$/gm, '');
  const out = new Map<string, string>();
  for (const m of body.matchAll(/'(--[\w-]+)'\s*:\s*'(#[0-9a-fA-F]{6})'/g)) {
    const [, name, hex] = m;
    if (name && hex) out.set(name, hex.toLowerCase());
  }
  return out;
}

describe('design-system FALLBACKS drift guard', () => {
  // tokens.css wins on a name both sheets define, matching what FALLBACKS has always mirrored.
  const decls = new Map([
    ...parseDecls(rootBlock(readFileSync(CSS_V2, 'utf8'))),
    ...parseDecls(rootBlock(readFileSync(CSS, 'utf8'))),
  ]);
  const fallbacks = parseFallbacks(readFileSync(TS, 'utf8'));

  it('parses both sources non-trivially', () => {
    expect(decls.size).toBeGreaterThan(20);
    expect(fallbacks.size).toBeGreaterThan(20);
  });

  it('every FALLBACKS token exists in a token sheet :root', () => {
    const missing = [...fallbacks.keys()].filter((k) => !decls.has(k));
    expect(missing).toEqual([]);
  });

  it('every FALLBACKS hex matches the resolved tokens.css value', () => {
    const drifted: string[] = [];
    for (const [name, hex] of fallbacks) {
      const resolved = resolveVar(name, decls);
      if (resolved === null) continue; // unresolvable -> covered by the test above
      const actual = channelsToHex(resolved);
      if (actual === null) continue; // not a channel triple (e.g. a raw hex)
      if (actual !== hex) drifted.push(`${name}: tokens.ts has ${hex}, tokens.css resolves to ${actual}`);
    }
    expect(drifted).toEqual([]);
  });
});
