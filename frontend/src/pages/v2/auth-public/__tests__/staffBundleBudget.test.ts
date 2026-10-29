/**
 * Mobile slice 61 (PRD module 7, PERF-01 / PERF-02): the build-time checks for the STAFF app's
 * first download and for font loading, added to scripts/check-public-bundle-budget.mjs.
 *
 * The staff budget is "about 350 KB gzipped, excluding the copilot's own code". The copilot is
 * out of scope for the programme and stays as it is, so the check subtracts its share of each
 * chunk, measured from the build's own source maps, instead of asking anyone to move it. Each
 * failure mode is provoked on a small fake build output.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  COPILOT_SOURCE,
  STAFF_BUDGET_BYTES,
  STAFF_CEILING_BYTES,
  checkFontLoading,
  checkPublicBundle,
  hasSourceMaps,
  measureInitialJs,
  stripCopilot,
} from '../../../../../scripts/check-public-bundle-budget.mjs';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const noise = (bytes: number) => randomBytes(bytes).toString('base64');

const FAKE_VERCEL = {
  rewrites: [
    { source: '/p/(.*)', destination: '/public.html' },
    { source: '/(.*)', destination: '/index.html' },
  ],
};
const PUBLIC_HTML = '<html><head><script type="module" src="/assets/pub.js"></script></head></html>';
const STAFF_HTML = '<html><head><script type="module" src="/assets/staff.js"></script></head></html>';

/** A two-line chunk and a source map that attributes line 1 to `first` and line 2 to `second`. */
function twoPartChunk(first: { source: string; code: string }, second: { source: string; code: string }) {
  const code = `${first.code}\n${second.code}`;
  const map = JSON.stringify({
    version: 3,
    sources: [first.source, second.source],
    names: [],
    // line 1: segment at column 0 -> source 0; line 2: segment at column 0 -> source 1
    mappings: 'AAAA;ACAA',
  });
  return { code, map };
}

function fakeDist(staffFiles: Record<string, string>, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'staff-bundle-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'public.html'), PUBLIC_HTML);
  writeFileSync(join(dir, 'assets', 'pub.js'), 'export const p=1;');
  writeFileSync(join(dir, 'index.html'), STAFF_HTML);
  for (const [name, body] of Object.entries({ ...staffFiles, ...extra })) {
    writeFileSync(join(dir, 'assets', name), body);
  }
  return dir;
}

const CEILING_KB = (STAFF_CEILING_BYTES / 1000).toFixed(0);
const REGISTER ='navigator.serviceWorker.register("/sw.js");';

describe('the staff budget', () => {
  it('has a target of 350 KB gzipped, in the same 1000-byte kilobytes as the public budget', () => {
    expect(STAFF_BUDGET_BYTES).toBe(350_000);
  });

  it('enforces a ceiling at or above the target, and no looser than the target now that the target is met', () => {
    expect(STAFF_CEILING_BYTES).toBeGreaterThanOrEqual(STAFF_BUDGET_BYTES);
    // The ceiling was 363 KB while the entry measured 361.6 KB; slice 61 round 2 brought the entry to
    // 348.8 KB, so the build now holds the target itself. A ceiling above it would let the entry grow
    // back over 350 KB without anyone being told.
    expect(STAFF_CEILING_BYTES).toBe(STAFF_BUDGET_BYTES);
  });

  it('passes between the target and the ceiling, with a note naming the gap', () => {
    const dir = fakeDist({ 'staff.js': `${REGISTER}${noise(STAFF_BUDGET_BYTES * 0.85)}` });
    const r = checkPublicBundle({
      distDir: dir,
      vercelConfig: FAKE_VERCEL,
      staffTargetBytes: 200_000,
      staffCeilingBytes: STAFF_CEILING_BYTES,
    });
    expect(r.problems).toEqual([]);
    expect(r.notes.join('\n')).toMatch(/KB over the 200 KB target/);
  });

  it('fails a staff first download over the budget, naming the budget and the biggest files', () => {
    const dir = fakeDist({ 'staff.js': `${REGISTER}${noise(STAFF_CEILING_BYTES * 1.4)}` });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(
      new RegExp(`staff app \\(index\\.html\\).*KB gzipped.*ceiling is ${CEILING_KB} KB.*target is 350 KB.*assets/staff\\.js`),
    );
  });

  it('passes a staff first download under the budget', () => {
    const dir = fakeDist({ 'staff.js': `${REGISTER}${noise(STAFF_BUDGET_BYTES * 0.5)}` });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.problems).toEqual([]);
  });

  it('does not count the copilot: a chunk that is over the budget only because of it passes', () => {
    const { code, map } = twoPartChunk(
      { source: '../../src/components/copilot/CopilotPanel.tsx', code: `${REGISTER}${noise(STAFF_BUDGET_BYTES * 1.2)}` },
      { source: '../../src/pages/v2/V2AppLayout.tsx', code: noise(STAFF_BUDGET_BYTES * 0.3) },
    );
    const dir = fakeDist({ 'staff.js': code, 'staff.js.map': map });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.problems).toEqual([]);

    const m = measureInitialJs(dir, 'index.html');
    expect(m.gzipTotal).toBeGreaterThan(STAFF_BUDGET_BYTES);
    expect(m.gzipExcludingCopilot).toBeLessThan(STAFF_BUDGET_BYTES);
    expect(m.copilotGzip).toBeGreaterThan(STAFF_BUDGET_BYTES);
  });

  it('counts the rest of a chunk in full: the copilot share is only the copilot lines', () => {
    const { code, map } = twoPartChunk(
      { source: '../../src/components/copilot/CopilotPanel.tsx', code: `${REGISTER}${noise(STAFF_BUDGET_BYTES * 0.2)}` },
      { source: '../../src/pages/v2/V2AppLayout.tsx', code: noise(STAFF_CEILING_BYTES * 1.4) },
    );
    const dir = fakeDist({ 'staff.js': code, 'staff.js.map': map });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain(`ceiling is ${CEILING_KB} KB`);
  });

  it('does not let a chunk without a source map claim any copilot share', () => {
    const dir = fakeDist({ 'staff.js': `${REGISTER}${noise(STAFF_CEILING_BYTES * 1.4)}` });
    const m = measureInitialJs(dir, 'index.html');
    expect(m.copilotGzip).toBe(0);
    expect(m.gzipExcludingCopilot).toBe(m.gzipTotal);
  });

  it('recognises the copilot by its folder, its store, its helpers and its voice SDK with that SDK\'s retry dependency, and nothing else', () => {
    for (const s of [
      '../../src/components/copilot/voice/liveSession.ts',
      '../../src/stores/copilotStore.ts',
      '../../src/lib/copilot/format.ts',
      '../../node_modules/@google/genai/dist/web/index.mjs',
      '../../node_modules/p-retry/index.js',
    ]) {
      expect(COPILOT_SOURCE.test(s), s).toBe(true);
    }
    for (const s of [
      '../../src/components/layout/Header.tsx',
      '../../src/components/ai-center/AiCenterModal.tsx',
      '../../src/lib/communication/ctmSoftphone.ts',
      '../../node_modules/@sentry/browser/build/index.js',
      '../../node_modules/@tanstack/react-query/build/index.js',
      '../../src/lib/retry-policy.ts',
    ]) {
      expect(COPILOT_SOURCE.test(s), s).toBe(false);
    }
  });
});

describe('checkFontLoading', () => {
  const fontDist = (indexHtml: string, files: string[] = ['/fonts/manrope-latin-5.3.0.woff2'], css = 'a{color:red}') => {
    const dir = mkdtempSync(join(tmpdir(), 'fonts-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'assets'));
    mkdirSync(join(dir, 'fonts'));
    writeFileSync(join(dir, 'index.html'), indexHtml);
    writeFileSync(join(dir, 'assets', 'index-abc.css'), css);
    for (const f of files) writeFileSync(join(dir, f.replace(/^\//, '')), 'font');
    return dir;
  };
  const head = (inner: string) =>
    `<html><head>${inner}<link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head></html>`;
  const PRELOAD = '<link rel="preload" href="/fonts/manrope-latin-5.3.0.woff2" as="font" type="font/woff2" crossorigin>';

  it('passes a head whose stylesheet is ours and whose font is preloaded from a file that shipped', () => {
    expect(checkFontLoading({ distDir: fontDist(head(PRELOAD)), htmlFiles: ['index.html'] })).toEqual([]);
  });

  it('fails a render-blocking stylesheet from another origin', () => {
    const html = head(`${PRELOAD}<link href="https://fonts.example.com/css2?family=X" rel="stylesheet">`);
    expect(checkFontLoading({ distDir: fontDist(html), htmlFiles: ['index.html'] }).join('\n')).toMatch(
      /stylesheet from another origin/,
    );
  });

  it('fails a preconnect to a font host', () => {
    const html = head(`${PRELOAD}<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>`);
    expect(checkFontLoading({ distDir: fontDist(html), htmlFiles: ['index.html'] }).join('\n')).toMatch(/preconnect/);
  });

  it('fails a font preload without crossorigin (the file would be fetched twice)', () => {
    const html = head(PRELOAD.replace(' crossorigin', ''));
    expect(checkFontLoading({ distDir: fontDist(html), htmlFiles: ['index.html'] }).join('\n')).toMatch(/crossorigin/);
  });

  it('fails a font preload whose file did not ship', () => {
    expect(checkFontLoading({ distDir: fontDist(head(PRELOAD), []), htmlFiles: ['index.html'] }).join('\n')).toMatch(
      /manrope-latin-5\.3\.0\.woff2.*not in/,
    );
  });

  it('fails a page that preloads no font at all', () => {
    expect(checkFontLoading({ distDir: fontDist(head('')), htmlFiles: ['index.html'] }).join('\n')).toMatch(
      /preloads no font/,
    );
  });

  it('fails a stylesheet that @imports from another origin', () => {
    const css = '@import url("https://fonts.example.com/css2?family=X");a{color:red}';
    expect(checkFontLoading({ distDir: fontDist(head(PRELOAD), undefined, css), htmlFiles: ['index.html'] }).join('\n')).toMatch(
      /@import/,
    );
  });
});

describe('how the copilot is taken out', () => {
  it('measures what is left after removing its text, not a size-proportional share', () => {
    // The copilot's text here is perfectly repetitive (it compresses to almost nothing); the rest is
    // noise. A proportional share would hand the copilot most of the gzip size, because most of the
    // characters are its; the honest answer is that it costs almost nothing and the rest costs all.
    const repetitive = 'const a=1;'.repeat(60_000);
    const { code, map } = twoPartChunk(
      { source: '../../src/components/copilot/CopilotPanel.tsx', code: `${REGISTER}${repetitive}` },
      { source: '../../src/pages/v2/V2AppLayout.tsx', code: noise(STAFF_BUDGET_BYTES * 0.9) },
    );
    const dir = fakeDist({ 'staff.js': code, 'staff.js.map': map });
    const m = measureInitialJs(dir, 'index.html');
    expect(m.copilotGzip).toBeLessThan(m.gzipTotal * 0.1);
    expect(m.gzipExcludingCopilot).toBeGreaterThan(STAFF_BUDGET_BYTES * 0.85);
  });

  it('keeps every character of a line that no copilot segment touches', () => {
    const { code, map } = twoPartChunk(
      { source: '../../src/components/copilot/CopilotPanel.tsx', code: 'AAAA' },
      { source: '../../src/pages/v2/V2AppLayout.tsx', code: 'BBBB' },
    );
    expect(stripCopilot(code, map)).toBe('\nBBBB');
    expect(stripCopilot(code, '{not json')).toBe(code);
  });
});

describe('a build without source maps', () => {
  it('is recognised, so the staff check can be skipped there instead of failing on a number it cannot compute', () => {
    const bare = fakeDist({ 'staff.js': `${REGISTER}${noise(1000)}` });
    expect(hasSourceMaps(bare)).toBe(false);
    const withMap = fakeDist({ 'staff.js': `${REGISTER}${noise(1000)}`, 'staff.js.map': '{}' });
    expect(hasSourceMaps(withMap)).toBe(true);
  });

  it('reports the skipped staff budget as a note and fails nothing for it', () => {
    const dir = fakeDist({ 'staff.js': `${REGISTER}${noise(STAFF_CEILING_BYTES * 1.4)}` });
    const r = checkPublicBundle({ distDir: dir, vercelConfig: FAKE_VERCEL, enforceStaffBudget: false });
    expect(r.problems).toEqual([]);
    expect(r.notes.join('\n')).toMatch(/size budget was NOT checked.*no source maps/);
  });
});
