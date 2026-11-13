/* =============================================================================
   #3473: every way a notification row is written for a person rings the bell on the live line, and nothing else does.

   Read from the source, so a writer added later that skips the message fails here:
     - every create of a person's notification row (notificationRecipient.create / createMany / createManyAndReturn /
       upsert, raw INSERTs, nested `recipients: { create }`) sits in one of the listed functions;
     - the two that notify the bell (emit, emitMany) send the bell message AFTER their write and never from inside a
       transaction; the one that writes Spider's red-frame record (recordFramesOnly) writes a verb hidden from the bell;
     - no caller hands emit / emitMany its own transaction (`tx`): there is no "after commit" to wait for inside it, so
       emit sends nothing for one, and a caller that started to would ring no bell;
     - none of the files that send on the line imports the database (a read per message, even one nobody waits for, is what the line must never do).
   Not listed, on purpose: the writes that only mark a person's existing rows read, acted or dismissed (the notification
   controller's PATCH/POST routes, resolveNotifications.ts, unapplied-capture.ts): they change what the person themself
   did, on a screen that already reads the bell after it.
   ========================================================================== */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { BELL_HIDDEN_VERBS, SPIDER_ALERT_VERB, SPIDER_FRAME_VERB } from '../services/notifications/bellHiddenVerbs';

const SRC = join(__dirname, '..');

const sourceFilesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFilesUnder(full);
    return /\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name) ? [full] : [];
  });

/** The code with comments blanked out (same length, so positions still point at the same line). */
const codeOf = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

interface Source {
  path: string;
  code: string;
}

const allSources = (): Source[] => sourceFilesUnder(SRC).map((f) => ({ path: relative(SRC, f), code: codeOf(readFileSync(f, 'utf8')) }));

const DECL = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/gm;

/** The top-level function a position sits in, by the nearest declaration at column 0 above it. */
function enclosingFunction(code: string, at: number): string {
  const decls = [...code.slice(0, at).matchAll(DECL)];
  const last = decls[decls.length - 1];
  return last ? (last[1] ?? last[2]!) : '(top level)';
}

/** Where each match of `pattern` sits: "file > function" -> how many. */
function sitesOf(sources: readonly Source[], pattern: RegExp, filter: (path: string) => boolean = () => true): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of sources) {
    if (!filter(s.path)) continue;
    for (const m of s.code.matchAll(pattern)) {
      const key = `${s.path} > ${enclosingFunction(s.code, m.index!)}`;
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}

/** The body of a top-level function, from its declaration to the next declaration at column 0 (or the end). */
function bodyOf(source: Source, fn: string): string {
  const start = source.code.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\b`, 'm'));
  expect(start, `${source.path} > ${fn}`).toBeGreaterThanOrEqual(0);
  const rest = source.code.slice(start + 1);
  const next = rest.search(/^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?const\s+\w+\s*=|^(?:export\s+)?interface\s/m);
  return source.code.slice(start, next < 0 ? undefined : start + 1 + next);
}

/** The text between the brackets of every call of `fn(`: its arguments. */
function callArguments(code: string, fn: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(new RegExp(`(?<![.\\w])${fn}\\s*\\(`, 'g'))) {
    let depth = 0;
    for (let i = m.index! + m[0].length - 1; i < code.length; i++) {
      if ('([{'.includes(code[i]!)) depth += 1;
      else if (')]}'.includes(code[i]!)) depth -= 1;
      if (depth === 0) {
        out.push(code.slice(m.index! + m[0].length, i));
        break;
      }
    }
  }
  return out;
}

const SERVICE = 'services/notifications/notificationService.ts';
const SENDS_BELL = /\bpublishBellChanged\s*\(/;

/** Every write that creates a person's notification row, and why it needs no more than it has. */
const ROW_CREATORS: Record<string, number> = {
  // Rings the bell after its insert (and not for a caller's own transaction).
  [`${SERVICE} > emit`]: 1,
  // Rings the bell after its one insert, one message per person for the whole write.
  [`${SERVICE} > emitMany`]: 1,
  // Spider's red-frame-only record: its verb is hidden from the bell (BELL_HIDDEN_VERBS), so nothing rings.
  'services/spider/sweep.ts > recordFramesOnly': 1,
};
const ROW_CREATE = /\bnotificationRecipient\.(create|createMany|createManyAndReturn|upsert)\b|\bINSERT\s+INTO\s+"?notification_recipients\b|\brecipients\s*:\s*\{\s*(create|createMany|connectOrCreate)\b/gi;

describe('the bell rings wherever a notification row is written for a person (#3473)', () => {
  const sources = allSources();
  const source = (path: string) => sources.find((s) => s.path === path)!;

  it('the scan can fail: it finds a write, names its function, ignores comments, and reads a call\'s arguments', () => {
    const planted: Source[] = [
      {
        path: 'x.ts',
        code: codeOf('async function sneak() {\n  await prisma.notificationRecipient.createMany({});\n}\n// prisma.notificationRecipient.create({})\nasync function raw() {\n  await prisma.$executeRaw`INSERT INTO notification_recipients (id) VALUES (1)`;\n}\n'),
      },
    ];
    expect(sitesOf(planted, ROW_CREATE)).toEqual({ 'x.ts > sneak': 1, 'x.ts > raw': 1 });
    expect(callArguments('emit({ a: f(1), tx })\nemitMany([x])\nthing.emit(tx)', 'emit')).toEqual(['{ a: f(1), tx }']);
    expect(sources.length).toBeGreaterThan(100);
  });

  it('a person\'s notification row is created from exactly the listed functions', () => {
    expect(sitesOf(sources, ROW_CREATE)).toEqual(ROW_CREATORS);
  });

  it('emit and emitMany send the bell message after their write, and not inside a transaction', () => {
    const service = source(SERVICE);
    for (const [fn, write] of [['emit', /\bnotificationRecipient\.createMany\b/], ['emitMany', /\bnotificationRecipient\.createManyAndReturn\b/]] as const) {
      const body = bodyOf(service, fn);
      const wrote = body.search(write);
      const rang = body.search(SENDS_BELL);
      expect(wrote, `${fn} writes the rows`).toBeGreaterThanOrEqual(0);
      expect(rang, `${fn} rings the bell`).toBeGreaterThan(wrote);
      expect(body, `${fn} opens no transaction of its own`).not.toMatch(/\$transaction/);
    }
    // A caller's own transaction has not committed when emit returns: it rings nothing for one.
    expect(bodyOf(service, 'emit')).toMatch(/if\s*\(\s*!args\.tx\s*\)\s*publishBellChanged\s*\(/);
  });

  it("Spider's red-frame-only record is written with a verb the bell never shows", () => {
    expect(BELL_HIDDEN_VERBS).toEqual(expect.arrayContaining([SPIDER_ALERT_VERB, SPIDER_FRAME_VERB]));
    const body = bodyOf(source('services/spider/sweep.ts'), 'recordFramesOnly');
    expect(body).toMatch(/verb:\s*SPIDER_FRAME_VERB\b/);
    expect(body).not.toMatch(/\bverb:\s*['"`]/);
  });

  it('no caller hands emit or emitMany a transaction', () => {
    const offenders: string[] = [];
    for (const s of sources) {
      if (s.path === SERVICE) continue;
      for (const fn of ['emit', 'emitMany']) {
        if (!new RegExp(`(?<![.\\w])${fn}\\s*\\(`).test(s.code)) continue;
        // Only files that really call the notification service's emit (not an unrelated `emit(`, e.g. an event emitter's).
        if (!/from\s+['"][^'"]*notifications\/notificationService['"]|from\s+['"]\.\/notificationService['"]/.test(s.code)) continue;
        for (const args of callArguments(s.code, fn)) if (/\btx\b/.test(args)) offenders.push(`${s.path} > ${fn}(...)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the files that send on the live line read no database (#3473, #3472; who may call deliverLive: spider-live-publish-guard)', () => {
  const sources = allSources();

  it('the line, and both publish functions, import no database client (a read per message, awaited or not, is what the line must never do)', () => {
    for (const path of ['services/live/liveLines.ts', 'services/spider/liveMessages.ts', 'services/notifications/bellLive.ts']) {
      const code = sources.find((s) => s.path === path)!.code;
      const imports = [...code.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gms)].map((m) => m[1]!);
      expect(imports.filter((i) => /prisma|supabase|\/db$|pg$/i.test(i)), path).toEqual([]);
      expect(code, path).not.toMatch(/\bprisma\w*\./i);
    }
  });
});
