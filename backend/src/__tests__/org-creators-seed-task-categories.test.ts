/**
 * Every code path that creates an organization also seeds the starter task categories
 * (visits-and-task-categories slice 08; fix pass for the dev seed scripts).
 *
 * The migration backfilled the starters into every org that existed when it ran. An org created
 * AFTER it gets them only if its creator asks: the production paths (create-org, the e2e org, the
 * ops SQL) did, the dev seeds and the payment-verification fixture did not, so a freshly seeded
 * local org had an empty category list. A static guard, like the other source guards here: a file
 * that creates an organization must name the starter seeding helper or its SQL twin.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const BACKEND = resolve(__dirname, '../..');
const ROOTS = ['src', 'scripts'].map((d) => join(BACKEND, d));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

const CREATES_ORG = /organization\.(create|upsert|createMany)\(|INSERT INTO "?organizations/;
const SEEDS_STARTERS = /seedStarterTaskCategories|starterTaskCategoriesSql/;

describe('organization creators seed the starter task categories', () => {
  const creators = ROOTS.flatMap(sourceFiles).filter((f) => CREATES_ORG.test(readFileSync(f, 'utf8')));

  it('finds the organization creators (the guard is looking at something)', () => {
    expect(creators.length).toBeGreaterThanOrEqual(5);
  });

  it('every one of them seeds the starters', () => {
    const missing = creators
      .filter((f) => !SEEDS_STARTERS.test(readFileSync(f, 'utf8')))
      .map((f) => relative(BACKEND, f));
    expect(missing).toEqual([]);
  });
});
