/**
 * Roles & Permissions security, ticket 36b (M17), finding M2: a screen never points a person at a Settings page they cannot open.
 *
 * The setup of the company, people and roles, and the phone service are the Admin flag's alone, so the pages behind "add in
 * Settings", "Go to Settings -> ..." and "managed in Settings -> ..." render nothing for anyone else. Pure: reads the source. Every
 * file that spells such a pointer either asks `useIsAdmin` / `useNoOptionsLabel` (so only an Admin is shown it), or is a declared
 * pointer to a page everyone with its own switch can open. A pointer added later fails here until it is one or the other.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');
const POINTER = /\bin (Organization )?Settings\b|Go to Settings|Settings\s*(→|->|>)\s*\w|\bSettings → |managed under Settings/;

/** Pointers to a page that is not Admin-only: Locations, which has its own switch and a read for everyone who may see locations. */
const OPEN_PAGES: Record<string, string> = {
  'components/inventory/NoInventoryLocationDialog.tsx': 'Settings -> Locations (its own switch)',
  'components/inventory/PODetailDialog.tsx': 'Settings -> Locations (its own switch)',
  'pages/v2/inventory/components/poReceive.ts': 'Settings -> Locations (its own switch)',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : walk(full);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.tsx?$/.test(name) ? [full] : [];
  });
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line);
/** A file's code lines: block comments (JSX ones included) and whole-line `//` comments taken out. */
const codeLines = (text: string): string[] => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).split('\n').filter((l) => !isComment(l));

describe('pointers to Settings pages', () => {
  const hits = walk(SRC)
    .map((f) => ({ rel: relative(SRC, f).split('\\').join('/'), text: readFileSync(f, 'utf8') }))
    // The Settings pages themselves are Admin-only (or carry their own door): what they say about each other is for their readers.
    .filter(({ rel }) => !rel.startsWith('pages/v2/settings/') && !rel.startsWith('pages/settings/'))
    .map((f) => ({ ...f, lines: codeLines(f.text).filter((l) => POINTER.test(l)) }))
    .filter((f) => f.lines.length > 0);

  it('finds the pointers (guards against a scan that reads nothing and so passes)', () => {
    expect(hits.length).toBeGreaterThan(5);
  });

  it('shows each pointer to an Admin only, unless it names a page everyone with its switch can open', () => {
    const unguarded = hits
      .filter(({ rel, text }) => !(rel in OPEN_PAGES) && !/useIsAdmin\(|useNoOptionsLabel\(/.test(text) && !/is_admin/.test(text))
      .map(({ rel, lines }) => `${rel}: ${lines[0]!.trim()}`);
    expect(unguarded).toEqual([]);
  });

  it('spells no empty option list as a literal that names Settings: it goes through useNoOptionsLabel', () => {
    const literal = walk(SRC)
      .filter((f) => !relative(SRC, f).startsWith('pages/v2/settings/') && !relative(SRC, f).startsWith('pages/settings/'))
      .flatMap((f) => codeLines(readFileSync(f, 'utf8')).filter((l) => /No options - add/.test(l) && !/ability\.can\('update', 'Organization'\) \? 'No options - add below'/.test(l)).map((l) => `${relative(SRC, f)}: ${l.trim()}`));
    expect(literal).toEqual([]);
  });

  it('declares only open pages that still carry a pointer', () => {
    expect(Object.keys(OPEN_PAGES).filter((rel) => !hits.some((h) => h.rel === rel))).toEqual([]);
  });
});
