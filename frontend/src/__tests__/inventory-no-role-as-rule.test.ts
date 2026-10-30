/**
 * Roles & Permissions, PRD 7 - no inventory screen shows a role name as the rule for a control. What a person may do
 * is decided by their switches, so a line such as "Admin - edit or delete a location from its row" or "ask an
 * inventory admin" tells a person who holds the switch (and is no Admin) something untrue.
 *
 * Reads the routed inventory screens' own files (components and the v2 pages) as text and fails on the phrases that
 * named a role as a rule. It looks only at what a person reads: hover titles, descriptions, placeholders and prose.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = [join(__dirname, '../components/inventory'), join(__dirname, '../pages/v2/inventory')];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|stories)\./.test(name) ? [path] : [];
  });
}

// A role word used as who-may-do-it: in parentheses after an action, as "Admin ·", as "inventory admin", "or owner".
const ROLE_AS_RULE = /\((?:admin|owner|logistics manager)[^)]*\)|\badmin ·|\blogistics \/ admin|\binventory admin\b|\bor owner\b|\bask a (?:warehouse )?manager\b/i;

describe('inventory screens', () => {
  it('name no role as the rule for a control', () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(sourceFiles)) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const text = line.trim();
        if (/^(\/\/|\/?\*|\{\/\*)/.test(text)) return;
        if (ROLE_AS_RULE.test(text)) offenders.push(`${file.split('/src/')[1]}:${i + 1}  ${text}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
