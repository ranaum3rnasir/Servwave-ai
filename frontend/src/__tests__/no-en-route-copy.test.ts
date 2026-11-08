import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Scheduling-notifications slice 07: the visit milestone is called "On the way" everywhere a
// user reads it. The phrase "en route" had spread across a button, a status chip, a report
// status, a roles toggle and an automation phrase, each renamed separately and each able to
// come back separately - so this guard is on the WORDS, across the whole client tree, rather
// than on any one component.
//
// What stays: the enum value EN_ROUTE, the ability `en_route`, the toggle key `enRouteJobs`
// and the route segment `/en-route` are identifiers, not copy. The regex below cannot match
// an underscore or a camelCase join, and the two remaining shapes of the hyphenated token
// (a bare quoted literal such as `'en-route'`, and a URL segment such as `/en-route`) are
// allowed explicitly. Comments are stripped first, so a note that explains a rename may still
// name the old word.
//
// Path resolution via fileURLToPath(string) + dirname, the pattern csv-export-guard.test.ts
// documents for this repo's jsdom environment.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    if (e.name === '__tests__' || e.name === '__snapshots__') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** A comment becomes as many newlines as it spanned, so an offender's reported line stays true. */
function blank(comment: string): string {
  return comment.replace(/[^\n]/g, '');
}

/** Drop `{/* … *\/}`, `/* … *\/` and `// …` so explanatory notes do not trip the guard. */
function stripComments(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/(?<=\s)\/\/.*$/gm, '');
}

const PHRASE = /en[ -]route/gi;

/** The two identifier shapes of the hyphenated token that are not copy. */
function isIdentifierUse(text: string, start: number, end: number): boolean {
  const before = text[start - 1];
  const after = text[end];
  if (before === '/') return true; // a route segment: `/en-route`
  const quoted = (before === "'" || before === '"' || before === '`') && after === before;
  return quoted && text.slice(start, end) === 'en-route'; // the bare action token
}

function offendersIn(file: string): string[] {
  const text = stripComments(readFileSync(file, 'utf8'));
  const out: string[] = [];
  for (const m of text.matchAll(PHRASE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (isIdentifierUse(text, start, end)) continue;
    const line = text.slice(0, start).split('\n').length;
    out.push(`${relative(SRC, file)}:${line} - ${text.slice(Math.max(0, start - 20), end + 20).replace(/\s+/g, ' ').trim()}`);
  }
  return out;
}

describe('no "en route" in rendered copy', () => {
  const files = walk(SRC);

  it('scans a realistic number of source files', () => {
    // Guards the guard: a broken walk() that returns nothing would pass silently.
    expect(files.length).toBeGreaterThan(300);
  });

  it('lets the identifier shapes through', () => {
    expect(isIdentifierUse("x = '/en-route'", 6, 14)).toBe(true);
    expect(isIdentifierUse("a === 'en-route'", 7, 15)).toBe(true);
    expect(isIdentifierUse("label: 'En route'", 8, 16)).toBe(false);
    expect(isIdentifierUse("label: 'en-route visit'", 8, 16)).toBe(false);
  });

  it('no shipped string says "en route" or "en-route"', () => {
    const offenders = files.flatMap(offendersIn);
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
