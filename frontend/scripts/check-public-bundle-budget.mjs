#!/usr/bin/env node
/**
 * Public-page bundle budget (mobile slice 47, PUB-03 / PERF-01).
 *
 * A customer opening a public estimate or invoice on a phone downloads the page that Vercel
 * serves for that URL and every script that page loads before it can paint. That has to stay
 * small, so this runs at the end of `npm run build` and fails the build when:
 *
 *   1. the page served for a public URL (resolved from vercel.json's rewrites, the same way the
 *      host resolves it) has an initial JavaScript graph above the budget, gzipped; or
 *   2. that page registers a service worker (the staff app's offline cache has no business on a
 *      customer's phone), either by a registration script in the HTML or by registration code
 *      anywhere in its initial graph.
 *
 * Mobile slice 61 adds two more:
 *
 *   3. the STAFF app's initial JavaScript, gzipped, excluding the copilot's own code, is over
 *      STAFF_CEILING_BYTES. The PRD's target (module 7: "about 350 KB") is STAFF_BUDGET_BYTES; the
 *      ceiling is where the build stands today, so it can only ratchet down (see below); and
 *   4. a page's head or stylesheet blocks the first paint on a font: a stylesheet from another
 *      origin, an @import of one, a preconnect to a font host, or a font preload that cannot work
 *      (no crossorigin, or a file that did not ship). See `checkFontLoading`.
 *
 * "Initial JavaScript" is the page's own module scripts, its modulepreloads, and everything
 * those import statically, transitively. Lazy chunks reached by `import()` are not initial and
 * are not counted; they load only when the customer does something that needs them. Sizes are of
 * the files as the host ships them, error-reporting stamp included (see `hostBanner`).
 *
 *   node scripts/check-public-bundle-budget.mjs            # after `vite build`
 *   node scripts/check-public-bundle-budget.mjs --json
 *   node scripts/check-public-bundle-budget.mjs --dist <dir>   # measure another build output
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(HERE, '..');

/** 200 KB, gzipped (PRD module 7). Kilobytes here are 1000 bytes, the stricter reading. */
export const PUBLIC_BUDGET_BYTES = 200_000;

/**
 * The most scripts the public page may load up front (mobile slice 61, PERF-03). Built alongside
 * the staff app it loaded 37, and Lighthouse's mobile run (a plain HTTP/1.1 connection, six
 * requests at a time) spent about 0.6 s of its first paint on the request rounds alone; built on
 * its own (public-entry-build.ts) it loads 3. The ceiling leaves room for a split or two and fails
 * the build if the page ever fragments again.
 */
export const PUBLIC_MAX_FILES = 8;

/**
 * The TARGET: 350 KB, gzipped (PRD module 7: "about 350 KB"), for the staff app's initial
 * JavaScript EXCLUDING the copilot's own code (mobile slice 61). The copilot stays as it is by
 * decision; its text is measured and taken out, never moved. Same 1000-byte kilobytes as the
 * public budget. The build reports the gap to this number on every run.
 */
export const STAFF_BUDGET_BYTES = 350_000;

/**
 * What the build ENFORCES: the target itself, since round 2 of slice 61 met it. The staff entry
 * measured 361.6 KB excluding the copilot after round 1, and the database, file-storage and
 * functions clients that the auth/realtime umbrella package builds eagerly (and the app never
 * calls; about 12 KB gzipped) are now inert stand-ins (src/shims/unused-data-clients-shim.ts), which
 * brought it to 348.8 KB. What is left is mostly code the first screen uses: react and the router
 * (85 KB), the auth and realtime client (about 47), error reporting (about 65, tracing included),
 * the menu and popover primitives (about 35), the query client (12.6), the http client (17), the
 * toaster (10), the icon set (8). A change that pushes the entry back over the target has to take
 * the same amount out somewhere else, or be raised with Ran as a budget change.
 */
export const STAFF_CEILING_BYTES = 350_000;

/**
 * The copilot's own code, as a build source-map path names it: its folder, its store, its helpers,
 * the voice SDK that only it imports, and that SDK's own retry dependency. The text these produced
 * in a chunk is what "excluding the copilot" takes out.
 */
export const COPILOT_SOURCE =
  /\/src\/components\/copilot\/|\/src\/stores\/copilotStore|\/src\/lib\/copilot\/|\/node_modules\/(?:@google\/genai|p-retry|retry)\//;

/** The real public URLs, as a customer's link carries them. */
export const PUBLIC_PATHS = ['/p/estimates/00000000-0000-0000-0000-000000000000', '/p/invoices/00000000-0000-0000-0000-000000000000'];

/** vercel.json `source` (path-to-regexp subset) to an anchored RegExp. */
function sourceToRegExp(source) {
  const body = source
    .split('(.*)')
    .map((part) =>
      part
        .replace(/[.+?^${}|[\]\\]/g, '\\$&')
        .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+'),
    )
    .join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * Which built HTML file the host serves for a URL path: the first rewrite that matches, in file
 * order, exactly as Vercel applies them. Returns the file name relative to dist (no slash).
 */
export function htmlForPath(vercelConfig, urlPath) {
  for (const rule of vercelConfig.rewrites ?? []) {
    if (sourceToRegExp(rule.source).test(urlPath)) return String(rule.destination).replace(/^\//, '');
  }
  return null;
}

/**
 * Names that must not appear in anything a page's head loads: those URLs are visible to the user
 * (and in the browser's network tab), and no vendor may be named there (mobile slice 06). The
 * bundler names shared chunks after a module in them, so this is checked on the built head rather
 * than trusted to the config. Same terms as `installed-app-head-and-manifest.test.ts`.
 */
export const VENDOR_NAME_IN_URL = /(^|[^a-z])(ctm|calltrackingmetrics|supabase|twilio|resend|stripe|vercel|onrender)([^a-z]|$)/i;

/**
 * What the host's build adds to every emitted script. Where error-reporting upload is on (the
 * deploy host sets its token; local and CI builds do not) the build plugin stamps each chunk with
 * a release id and a random per-file debug id. Random bytes do not compress, so the stamp costs
 * about 200 bytes gzipped per file: with 34 files that is 7 KB, enough to turn a page that
 * measured 194 KB on a laptop into 202 KB on the host, which failed this check there and left
 * the slice off staging. The customer downloads the stamped file, so that is what is measured:
 * when a build was made without the stamp, a stand-in of the same shape is added before gzipping.
 * The id is derived from the file name so a run is repeatable.
 */
export function hostBanner(file) {
  const hex = createHash('sha256').update(file).digest('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const release = createHash('sha1').update(file).digest('hex');
  return (
    '(function(){try{var e=typeof window<"u"?window:typeof global<"u"?global:typeof globalThis<"u"?globalThis:typeof self<"u"?self:{};' +
    `e.SENTRY_RELEASE={id:"${release}"};var t=new e.Error().stack;` +
    `t&&(e._sentryDebugIds=e._sentryDebugIds||{},e._sentryDebugIds[t]="${uuid}",e._sentryDebugIdIdentifier="sentry-dbid-${uuid}")}catch{}})();`
  );
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** One source-map segment (base64 VLQ) to its signed field values. */
function decodeVlq(segment) {
  const values = [];
  let shift = 0;
  let value = 0;
  for (const ch of segment) {
    const digit = B64_INDEX.get(ch);
    if (digit === undefined) return values;
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      values.push(value & 1 ? -(value >> 1) : value >> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

/**
 * `code` with the copilot's own text taken out, read off the build's source map. Each mapped
 * segment owns the text up to the next segment on its line (or the end of the line); unmapped
 * text, such as the host's banner, is not the copilot's. A missing or unreadable map takes out
 * nothing, so the check can only ever be stricter than the truth, never looser.
 */
export function stripCopilot(code, mapText) {
  let map;
  try {
    map = JSON.parse(mapText);
  } catch {
    return code;
  }
  if (!map || !Array.isArray(map.sources) || typeof map.mappings !== 'string') return code;
  const isCopilot = map.sources.map((src) => COPILOT_SOURCE.test(String(src)));
  if (!isCopilot.some(Boolean)) return code;
  const lines = code.split('\n');
  const mappingLines = map.mappings.split(';');
  let source = 0;
  const out = [];
  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    let col = 0;
    const segs = [];
    for (const raw of mappingLines[l] === undefined || mappingLines[l] === '' ? [] : mappingLines[l].split(',')) {
      const v = decodeVlq(raw);
      if (v.length === 0) continue;
      col += v[0];
      if (v.length >= 4) {
        source += v[1];
        segs.push({ col, source });
      } else {
        segs.push({ col, source: -1 });
      }
    }
    if (segs.length === 0) {
      out.push(line);
      continue;
    }
    // A segment's source index is a running delta across the whole file, so the loop above must
    // visit every mapped line in order; it does, because it runs for every line of the file.
    let kept = line.slice(0, segs[0].col);
    for (let i = 0; i < segs.length; i++) {
      const end = i + 1 < segs.length ? segs[i + 1].col : line.length;
      if (!(segs[i].source >= 0 && isCopilot[segs[i].source])) kept += line.slice(segs[i].col, end);
    }
    out.push(kept);
  }
  return out.join('\n');
}

const STATIC_IMPORT = /(?:\bimport|\bexport)\s*(?:[^'"`;()]*?\bfrom\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g;

function staticImports(code) {
  const out = [];
  for (const m of code.matchAll(STATIC_IMPORT)) out.push(m[1]);
  return out;
}

function htmlScriptRefs(html) {
  const refs = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+\.js)"[^>]*>/g)) refs.push(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+\.js)"[^>]*>/g)) refs.push(m[1]);
  return refs;
}

/**
 * The initial JavaScript of one built HTML page.
 * `gzipExcludingCopilot` is what the page costs without the copilot's own code: each chunk is
 * gzipped again with the text the build's source map attributes to the copilot taken out (see
 * `stripCopilot`), and `copilotGzip` is the difference. Gzip is not additive, so this is not the
 * same as a size-proportional share: the copilot's text (the voice SDK is large, repetitive
 * generated code) compresses better than the rest, so a proportional share would take out too much
 * and let the rest of the app look lighter than it is.
 * @returns {{ files: { file: string, gzip: number, copilotGzip: number }[], gzipTotal: number, copilotGzip: number, gzipExcludingCopilot: number, html: string, swRegistration: string[], vendorNamed: string[] }}
 */
export function measureInitialJs(distDir, htmlFile) {
  const htmlPath = join(distDir, htmlFile);
  if (!existsSync(htmlPath)) {
    throw new Error(`${htmlFile} is not in ${distDir}; did the build emit it?`);
  }
  const html = readFileSync(htmlPath, 'utf8');
  const seen = new Set();
  const queue = htmlScriptRefs(html).map((ref) => ref.replace(/^\//, ''));
  const files = [];
  const swRegistration = [];

  if (/registerSW|serviceWorker/.test(html)) swRegistration.push(`${htmlFile} (HTML)`);

  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const abs = join(distDir, file);
    if (!existsSync(abs)) throw new Error(`${htmlFile} references ${file}, which is not in ${distDir}`);
    const code = readFileSync(abs);
    const text = code.toString('utf8');
    const stamped = text.includes('_sentryDebugIds');
    const gzipOf = (buf) => gzipSync(stamped ? buf : Buffer.concat([Buffer.from(hostBanner(file)), buf])).length;
    const gzip = gzipOf(code);
    const mapPath = `${abs}.map`;
    let copilotGzip = 0;
    if (existsSync(mapPath) && text.length > 0) {
      const stripped = stripCopilot(text, readFileSync(mapPath, 'utf8'));
      if (stripped.length !== text.length) copilotGzip = Math.max(0, gzip - gzipOf(Buffer.from(stripped)));
    }
    files.push({ file, gzip, copilotGzip, stamped });
    if (/serviceWorker\s*\.\s*register\s*\(/.test(text)) swRegistration.push(file);
    for (const dep of staticImports(text)) {
      queue.push(join(dirname(file), dep).split('\\').join('/'));
    }
  }

  files.sort((a, b) => b.gzip - a.gzip);
  const vendorNamed = files.map((f) => f.file).filter((f) => VENDOR_NAME_IN_URL.test(f));
  const gzipTotal = files.reduce((n, f) => n + f.gzip, 0);
  const copilotGzip = files.reduce((n, f) => n + f.copilotGzip, 0);
  return { files, gzipTotal, copilotGzip, gzipExcludingCopilot: gzipTotal - copilotGzip, html: htmlFile, swRegistration, vendorNamed };
}

/**
 * Run the whole check. Returns `{ ok, problems, reports }`; the CLI prints and sets the exit code.
 */
export function checkPublicBundle({
  distDir,
  vercelConfig,
  paths = PUBLIC_PATHS,
  budgetBytes = PUBLIC_BUDGET_BYTES,
  maxPublicFiles = PUBLIC_MAX_FILES,
  staffCeilingBytes = STAFF_CEILING_BYTES,
  staffTargetBytes = STAFF_BUDGET_BYTES,
  enforceStaffBudget = true,
}) {
  const problems = [];
  const notes = [];
  const reports = [];
  const pages = new Map();
  for (const p of paths) {
    const html = htmlForPath(vercelConfig, p);
    if (!html) {
      problems.push(`${p}: no vercel.json rewrite serves this URL`);
      continue;
    }
    if (!pages.has(html)) pages.set(html, []);
    pages.get(html).push(p);
  }

  for (const [html, served] of pages) {
    let report;
    try {
      report = measureInitialJs(distDir, html);
    } catch (err) {
      problems.push(String(err.message ?? err));
      continue;
    }
    reports.push({ ...report, served });
    if (report.gzipTotal > budgetBytes) {
      problems.push(
        `${served.join(', ')} is served by ${html}, whose initial JavaScript is ` +
          `${(report.gzipTotal / 1000).toFixed(1)} KB gzipped; the budget is ${(budgetBytes / 1000).toFixed(0)} KB. ` +
          `Largest: ${report.files.slice(0, 4).map((f) => `${f.file} ${(f.gzip / 1000).toFixed(1)} KB`).join('; ')}`,
      );
    }
    if (report.files.length > maxPublicFiles) {
      problems.push(
        `${served.join(', ')} is served by ${html}, which loads ${report.files.length} scripts up front; the ceiling is ${maxPublicFiles}. ` +
          `Each one is a request round on a phone line; the page is built on its own (public-entry-build.ts) so it stays a few files.`,
      );
    }
    if (report.vendorNamed.length > 0) {
      problems.push(`${html} loads files named after a vendor: ${report.vendorNamed.join(', ')}`);
    }
    if (report.swRegistration.length > 0) {
      problems.push(
        `${served.join(', ')} is served by ${html}, which registers a service worker (${report.swRegistration.join(', ')}). ` +
          `Public pages must not register one.`,
      );
    }
  }

  // The other half of "public pages register nothing": the staff app must still register its
  // worker, or this slice would have silently turned the offline app off.
  const staffHtml = htmlForPath(vercelConfig, '/') ?? 'index.html';
  if (!pages.has(staffHtml)) {
    try {
      const staff = measureInitialJs(distDir, staffHtml);
      if (staff.swRegistration.length === 0) {
        problems.push(`The staff app (${staffHtml}) no longer registers its service worker.`);
      }
      if (staff.vendorNamed.length > 0) {
        problems.push(`${staffHtml} loads files named after a vendor: ${staff.vendorNamed.join(', ')}`);
      }
      reports.push({ ...staff, served: ['/'], staff: true, ceilingBytes: staffCeilingBytes, targetBytes: staffTargetBytes });
      if (!enforceStaffBudget) {
        notes.push(
          `The staff app's size budget was NOT checked: this build has no source maps, so the copilot's code cannot be taken out ` +
            `(${(staff.gzipTotal / 1000).toFixed(1)} KB gzipped with it). Builds that keep their source maps (CI and the host's, ` +
            `which set build.sourcemap) do check it.`,
        );
      } else if (staff.gzipExcludingCopilot > staffCeilingBytes) {
        problems.push(
          `The staff app (${staffHtml}) initial JavaScript is ${(staff.gzipExcludingCopilot / 1000).toFixed(1)} KB gzipped ` +
            `excluding the copilot (${(staff.gzipTotal / 1000).toFixed(1)} KB with it, of which about ${(staff.copilotGzip / 1000).toFixed(1)} KB is the copilot); ` +
            `the build's ceiling is ${(staffCeilingBytes / 1000).toFixed(0)} KB (the target is ${(staffTargetBytes / 1000).toFixed(0)} KB). ` +
            `Largest: ${staff.files.slice(0, 4).map((f) => `${f.file} ${(f.gzip / 1000).toFixed(1)} KB`).join('; ')}`,
        );
      } else if (staff.gzipExcludingCopilot > staffTargetBytes) {
        notes.push(
          `The staff app (${staffHtml}) is ${((staff.gzipExcludingCopilot - staffTargetBytes) / 1000).toFixed(1)} KB over the ` +
            `${(staffTargetBytes / 1000).toFixed(0)} KB target (${(staff.gzipExcludingCopilot / 1000).toFixed(1)} KB gzipped excluding the copilot).`,
        );
      }
    } catch (err) {
      problems.push(String(err.message ?? err));
    }
  }
  return { ok: problems.length === 0, problems, notes, reports };
}

/**
 * Whether the build kept its JavaScript source maps (`build.sourcemap` is 'hidden' in vite.config.ts,
 * so they sit beside the chunks without being referenced). The staff budget needs them to take the
 * copilot out; a build that has none (a hand-made `dist/`, or a host that deletes them after upload)
 * must not fail on a number it cannot compute, so the CLI skips that one check there and says so.
 */
export function hasSourceMaps(distDir) {
  const dir = join(distDir, 'assets');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f.endsWith('.js.map'));
}

const tagAttr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
const OTHER_ORIGIN = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i;

/**
 * Fonts must not stand between a phone and its first paint (mobile slice 61, PERF-02). For each
 * built page: no stylesheet from another origin, no stylesheet that @imports one, no preconnect or
 * DNS prefetch to a font host, at least one font preload, and every font preload is crossorigin
 * (fonts are always CORS requests; without it the file is fetched twice) and points at a file that
 * shipped. Returns the list of problems.
 */
export function checkFontLoading({ distDir, htmlFiles }) {
  const problems = [];
  for (const htmlFile of htmlFiles) {
    const htmlPath = join(distDir, htmlFile);
    if (!existsSync(htmlPath)) {
      problems.push(`${htmlFile} is not in ${distDir}; did the build emit it?`);
      continue;
    }
    const html = readFileSync(htmlPath, 'utf8');
    let preloads = 0;
    for (const tag of html.match(/<link\b[^>]*>/g) ?? []) {
      const rel = (tagAttr(tag, 'rel') ?? '').toLowerCase();
      const href = tagAttr(tag, 'href') ?? '';
      if (rel === 'stylesheet') {
        if (OTHER_ORIGIN.test(href)) {
          problems.push(`${htmlFile} loads a stylesheet from another origin (${href}); it blocks the first paint`);
        } else if (href) {
          const cssPath = join(distDir, href.replace(/^\//, ''));
          if (existsSync(cssPath) && /@import\s+(?:url\(\s*)?["']?(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(readFileSync(cssPath, 'utf8'))) {
            problems.push(`${href} (served by ${htmlFile}) has an @import from another origin; it blocks the first paint`);
          }
        }
      } else if ((rel === 'preconnect' || rel === 'dns-prefetch') && /fonts\.g/i.test(href)) {
        problems.push(`${htmlFile} has a ${rel} to a font host (${href}); fonts are served from our own origin`);
      } else if (rel === 'preload' && (tagAttr(tag, 'as') ?? '').toLowerCase() === 'font') {
        preloads++;
        if (!/\bcrossorigin\b/.test(tag)) {
          problems.push(`${htmlFile} preloads ${href} without crossorigin, so the browser fetches the font twice`);
        }
        if (!existsSync(join(distDir, href.replace(/^\//, '')))) {
          problems.push(`${htmlFile} preloads ${href}, which is not in ${distDir}`);
        }
      }
    }
    if (preloads === 0) problems.push(`${htmlFile} preloads no font, so text waits for the stylesheet and then the font`);
  }
  return problems;
}

function main() {
  const distFlag = process.argv.indexOf('--dist');
  const distDir = distFlag > -1 ? resolve(process.argv[distFlag + 1]) : join(FRONTEND, 'dist');
  const vercelConfig = JSON.parse(readFileSync(join(FRONTEND, 'vercel.json'), 'utf8'));
  const result = checkPublicBundle({ distDir, vercelConfig, enforceStaffBudget: hasSourceMaps(distDir) });
  const fontProblems = checkFontLoading({ distDir, htmlFiles: ['index.html', 'public.html'] });
  result.problems.push(...fontProblems);
  result.ok = result.problems.length === 0;
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const r of result.reports) {
      if (r.staff) {
        console.log(
          `staff bundle: ${r.html}: ${(r.gzipExcludingCopilot / 1000).toFixed(1)} KB gzipped initial JS excluding the copilot ` +
            `(${(r.gzipTotal / 1000).toFixed(1)} KB with it) in ${r.files.length} files (ceiling ${(r.ceilingBytes / 1000).toFixed(0)} KB, target ${(r.targetBytes / 1000).toFixed(0)} KB)`,
        );
      } else {
        console.log(`public bundle: ${r.html} serves ${r.served.join(', ')}: ${(r.gzipTotal / 1000).toFixed(1)} KB gzipped initial JS in ${r.files.length} files (budget ${(PUBLIC_BUDGET_BYTES / 1000).toFixed(0)} KB)`);
      }
    }
    for (const n of result.notes ?? []) console.log(`note: ${n}`);
    for (const p of result.problems) console.error(`FAIL: ${p}`);
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
