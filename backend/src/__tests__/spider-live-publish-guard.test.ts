/* =============================================================================
   #3472: every way the server changes what Spider's pop-up, red frame or summary card shows sends its live message.

   Read from the source, so a way added later is seen here:
     - the pop-up and red-frame records: every write to a person's notification row in Spider's code, and every emitMany
       call, sits in one of the listed sweep steps (the check, tick.ts, writes and ends through the same steps, #3469),
       and the step that writes or ends them sends the message;
     - the settings: every write to spider_settings from a request handler sits in a handler that sends the message (and
       tells Spider's check, tick.ts, and ends at once what a narrowing save no longer covers, #3469 / #3456);
     - the summary: the one place a summary becomes READY (summaryRuns.ts markReady) is called from one step, which sends;
     - and the messages themselves: publishSpiderLive is called from exactly the listed places, and the line's transport
       (deliverLive) only from services/spider/liveMessages.ts.
   Not listed, on purpose: the sweep's own trigger bookkeeping in spider_settings (summary_trigger_*), which no screen
   shows, and the bell's generic PATCH /api/notifications/:id/read|act|dismiss, which no Spider screen calls (the pop-up
   leaves alerts unread, D4); a screen with a line open still re-checks every 5 minutes.
   ========================================================================== */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

const sourceFilesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : sourceFilesUnder(full);
    return /\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name) ? [full] : [];
  });

/** The code with comments blanked out (same length, so positions still point at the same line). */
function codeOf(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
}

interface Source {
  path: string;
  code: string;
}

const allSources = (): Source[] =>
  sourceFilesUnder(SRC).map((f) => ({ path: relative(SRC, f), code: codeOf(readFileSync(f, 'utf8')) }));

/** The top-level function (or exported const arrow) a position sits in, by the nearest declaration at column 0 above it. */
function enclosingFunction(code: string, at: number): string {
  const before = code.slice(0, at);
  const decls = [...before.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/gm)];
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

/** The body of a top-level function, from its declaration to the next declaration at column 0. */
function bodyOf(source: Source, fn: string): string {
  const start = source.code.search(new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${fn}\\b`, 'm'));
  expect(start, `${source.path} > ${fn}`).toBeGreaterThanOrEqual(0);
  const rest = source.code.slice(start + 1);
  const next = rest.search(/^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?const\s+\w+\s*=|^(?:export\s+)?interface\s/m);
  return source.code.slice(start, next < 0 ? undefined : start + 1 + next);
}

const PUBLISH = /\bpublishSpiderLive\s*\(/g;
/** The same, for one body (no `g`: a global pattern keeps its position between tests). */
const SENDS = /\bpublishSpiderLive\s*\(/;

/** Every place a Spider live message is sent from, and why. */
const PUBLISHED_FROM: Record<string, number> = {
  // The write step of the sweep and of the check (#3469): the new cards and red-frame records, once the switch check
  // after them passed.
  'services/spider/sweep.ts > writeAlertRecords': 1,
  // The sweep's ending steps: the records whose lead left the stage or the settings no longer alert (#3450), and every
  // other end (switch-off, outside the gate, a re-alert replacing a card, a switch-off during the run).
  'services/spider/sweep.ts > endFinishedAlerts': 1,
  // The ending of the people the saved recipients no longer cover (#3462): only their own rows, only their screens.
  'services/spider/sweep.ts > endUncoveredRecipientRows': 1,
  'services/spider/sweep.ts > endOpenSpiderRecords': 1,
  // The saves: Deactivate and Activate, the settings (the pop-up's Enable Notifications included), the excluded leads.
  'controllers/spider.controller.ts > setSpiderActive': 2,
  'controllers/spider.controller.ts > updateSpiderSettings': 1,
  'controllers/spider-picker.controller.ts > updateSpiderExclusions': 1,
  // The starting summary's READY step.
  'services/spider/summary.ts > attemptRun': 1,
};

/** The Spider steps that write or end a person's pop-up or red-frame row, and the one that sends for each. */
const RECORD_WRITERS: Record<string, { sentBy: string }> = {
  'services/spider/sweep.ts > writeAlertRecords': { sentBy: 'writeAlertRecords' }, // emitMany: the in-app alerts
  'services/spider/sweep.ts > recordFramesOnly': { sentBy: 'writeAlertRecords' }, // the red-frame-only records
  'services/spider/sweep.ts > endFinishedAlerts': { sentBy: 'endFinishedAlerts' },
  'services/spider/sweep.ts > endUncoveredRecipientRows': { sentBy: 'endUncoveredRecipientRows' },
  'services/spider/sweep.ts > endOpenSpiderRecords': { sentBy: 'endOpenSpiderRecords' },
};

const RECIPIENT_WRITE = /\bnotificationRecipient\.(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b|\bemitMany\s*\(/g;
const SETTINGS_WRITE = /\bspiderSettings\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\bUPDATE\s+spider_settings\b/gi;
const isSpiderCode = (p: string) => p.startsWith('services/spider/') || /^controllers\/spider[^/]*\.ts$/.test(p);

describe('Spider sends its live message wherever what the screen shows changes (#3472)', () => {
  const sources = allSources();
  const source = (path: string) => sources.find((s) => s.path === path)!;

  it('the scan can fail: it finds a call, names its function, and ignores comments', () => {
    const planted: Source[] = [
      { path: 'x.ts', code: codeOf('async function saveIt() {\n  await prisma.spiderSettings.update({});\n  publishSpiderLive(org, m);\n}\n// publishSpiderLive(org, m)\n') },
    ];
    expect(sitesOf(planted, PUBLISH)).toEqual({ 'x.ts > saveIt': 1 });
    expect(sitesOf(planted, SETTINGS_WRITE)).toEqual({ 'x.ts > saveIt': 1 });
    expect(sources.length).toBeGreaterThan(100);
  });

  it('sends from exactly the listed places', () => {
    expect(sitesOf(sources, PUBLISH, (p) => p !== 'services/spider/liveMessages.ts')).toEqual(PUBLISHED_FROM);
  });

  it("only Spider's one publish function (and the bell's, #3473) writes to the line", () => {
    expect(sitesOf(sources, /\bdeliverLive\s*\(/g, (p) => p !== 'services/live/liveLines.ts')).toEqual({
      'services/notifications/bellLive.ts > publishBellChanged': 1,
      'services/spider/liveMessages.ts > publishSpiderLive': 4,
    });
  });

  it("every write of a person's pop-up or red-frame row in Spider's code is a listed step, and its step sends", () => {
    const writers = sitesOf(sources, RECIPIENT_WRITE, isSpiderCode);
    expect(Object.keys(writers).sort()).toEqual(Object.keys(RECORD_WRITERS).sort());
    const sweep = source('services/spider/sweep.ts');
    for (const { sentBy } of Object.values(RECORD_WRITERS)) expect(bodyOf(sweep, sentBy), sentBy).toMatch(SENDS);
    // The red-frame-only records are written only by the step that then sends for them.
    expect(sitesOf(sources, /(?<!function\s+)\brecordFramesOnly\s*\(/g)).toEqual({ 'services/spider/sweep.ts > writeAlertRecords': 1 });
  });

  it('every request handler that writes the Spider settings sends', () => {
    const handlers = sitesOf(sources, SETTINGS_WRITE, (p) => p.startsWith('controllers/') || p.startsWith('routes/'));
    expect(Object.keys(handlers).sort()).toEqual([
      'controllers/spider-picker.controller.ts > updateSpiderExclusions',
      'controllers/spider.controller.ts > setSpiderActive',
      'controllers/spider.controller.ts > updateSpiderSettings',
    ]);
    for (const key of Object.keys(handlers)) {
      const [path, fn] = key.split(' > ') as [string, string];
      expect(bodyOf(source(path), fn), key).toMatch(SENDS);
    }
  });

  it("every request handler that writes the Spider settings tells the check (#3469), and every one that can narrow ends what it no longer covers (#3456)", () => {
    const handlers = Object.keys(sitesOf(sources, SETTINGS_WRITE, (p) => p.startsWith('controllers/') || p.startsWith('routes/')));
    // A limit lengthened, a stage switched off, a lead excluded: the alerts they no longer cover end in the same request.
    const NARROWING = ['controllers/spider-picker.controller.ts > updateSpiderExclusions', 'controllers/spider.controller.ts > updateSpiderSettings'];
    expect(handlers.filter((h) => NARROWING.includes(h)).sort()).toEqual(NARROWING);
    for (const key of handlers) {
      const [path, fn] = key.split(' > ') as [string, string];
      const body = bodyOf(source(path), fn);
      // The check runs at once (a crossing may be nearer), or, at Activate, watches the company's stays again first.
      expect(body, key).toMatch(/\b(wakeSpiderTick|rearmAfterActivate)\s*\(/);
      if (NARROWING.includes(key)) expect(body, key).toMatch(/\bendAlertsAfterNarrowingSave\s*\(/);
    }
    // A role or person taken out of the recipients ends their open alerts in the same request (#3462).
    expect(bodyOf(source('controllers/spider.controller.ts'), 'updateSpiderSettings')).toMatch(/\brecipientsNarrowed\s*\(/);
    // Activate watches the company's stays again, and rearmWatchedStays wakes the check.
    expect(bodyOf(source('services/spider/tick.ts'), 'rearmWatchedStays')).toMatch(/\bwakeSpiderTick\s*\(/);
  });

  it('a summary becomes READY in one step, and that step sends', () => {
    expect(sitesOf(sources, /\bmarkReady\s*\(/g, (p) => p !== 'services/spider/summaryRuns.ts')).toEqual({
      'services/spider/summary.ts > attemptRun': 1,
    });
    expect(bodyOf(source('services/spider/summary.ts'), 'attemptRun')).toMatch(SENDS);
  });
});

describe('the live line ends wherever the server lets go of it (#3472)', () => {
  const sources = allSources();
  const source = (path: string) => sources.find((s) => s.path === path)!;

  // A stopping server ending every line is pinned with the rest of the stop signal's wiring (graceful-stop.test.ts).
  it("throwing away a person's sign-in (or everyone's) closes their lines", () => {
    expect(bodyOf(source('middleware/authenticate.ts'), 'clearTokenCache')).toMatch(/\bcloseLiveLinesOf\s*\(\s*userId\s*\)/);
  });
});
