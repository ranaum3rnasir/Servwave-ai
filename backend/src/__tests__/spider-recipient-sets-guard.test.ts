/* =============================================================================
   #3107, source guard: every way the people of a Spider alert are written, and every way they are read, goes through the
   recipient sets.

   The ways in, from a sweep of the source (names pinned are the files and the public names - the function, the column - never
   a local variable; what a writer actually stores, and what the Role filter finds, is proven against a real database):
   - WRITERS of alert-log rows (spider_alerts): alertLog.ts claimVisits (the per-lead alerts, called once, from sweep.ts)
     and summary.ts (the starting summary). Each stores the list through recipientSetIds (recipientSets.ts) BEFORE the
     insert that points at it; a new writer must be added here, with the same step, or this test fails.
   - READERS of a row's stored list: history.ts storedRecipients is the only code that reads `recipients` off an alert
     row (own copy for older rows, else the recipient set); History's select asks for both. The controller reads through
     it. The Role filter in historyWhere asks both places.
   The behaviour is proven against a real database in spider-recipient-sets-db.test.ts and
   spider-recipient-sets-history-db.test.ts.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const BACKEND = join(__dirname, '..', '..');
const SRC = join(BACKEND, 'src');
const SPIDER = join(SRC, 'services', 'spider');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** The source with comments blanked out, so prose that names a function is never counted as a call. */
const code = (path: string) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const rel = (path: string) => relative(BACKEND, path).split('\\').join('/');
const filesMatching = (re: RegExp) => sourceFiles(SRC).filter((f) => re.test(code(f))).map(rel).sort();

describe('Spider recipient sets: every writer and every reader of an alert row\'s people (source guard)', () => {
  it('alert-log rows are written only by claimVisits (alertLog.ts) and the starting summary', () => {
    expect(filesMatching(/spiderAlert\.(create|createMany|createManyAndReturn|upsert)\(|INSERT\s+INTO\s+"?spider_alerts/)).toEqual([
      'src/services/spider/alertLog.ts',
      'src/services/spider/summary.ts',
    ]);
    expect(filesMatching(/\bclaimVisits\(/).filter((f) => f !== 'src/services/spider/alertLog.ts')).toEqual(['src/services/spider/sweep.ts']);
  });

  it.each([
    ['the per-lead alerts', 'sweep.ts'],
    ['the starting summary', 'summary.ts'],
  ])('%s store the list through a recipient set, before any alert-log insert, and point the row at it', (_name, file) => {
    const src = code(join(SPIDER, file));
    const store = src.search(/\brecipientSetIds\(/);
    expect(store, 'recipientSetIds( in the writer').toBeGreaterThanOrEqual(0);
    // The first thing in the writer that inserts alert-log rows (claimVisits, or the starting summary's createMany).
    const insert = src.search(/\bclaimVisits\(|spiderAlert\.createMany\(/);
    expect(insert, 'the insert').toBeGreaterThanOrEqual(0);
    expect(store, 'stored before it is pointed at').toBeLessThan(insert);
    // The column the row points at the set with (a column name is the writer's contract, not a local name).
    expect(src).toMatch(/\brecipient_set_id\b/);
  });

  it('only History reads the stored list, from the row\'s set and its own column', () => {
    // `recipients: true` in a select is a read of the column; only History's row select has one.
    expect(filesMatching(/\brecipients:\s*true\b/)).toEqual(['src/services/spider/history.ts']);
    expect(code(join(SPIDER, 'history.ts'))).toMatch(/\brecipient_set\s*:/);
    // The controller names the people of older rows through History's reader, not by looking at the column itself.
    expect(code(join(SRC, 'controllers', 'spider.controller.ts'))).toMatch(/\bstoredRecipients\b/);
  });
});
