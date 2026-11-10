/* =============================================================================
   #3025 (parent #3013): every place that decides a call's status is the call ingest.

   A source guard. The call ingest (`ingestCall`, lib/ctm/ingest.ts) reads the phone service's status of a call and stores
   it: "no answer" and "failed" as missed, an outbound call that never connected as missed, and a text's start or end as
   no call at all. call-statuses-tell-truth-db.test.ts proves that on a real database through the webhook route. This guard
   lists every other door, so a new one cannot store a status the ingest would not:
   - every caller of the call ingest (each gets the same statuses and the same text skip);
   - every file that reads the phone service's status fields;
   - every file that writes a call row, and whether it writes the status.
   A new file in any of these fails here until it is listed with its reason.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..', '..');
const DIRS = ['src', 'scripts'];

/** Every caller of the call ingest. */
const INGEST_CALLERS: Readonly<Record<string, string>> = {
  'src/controllers/ctm-webhook.controller.ts': 'the phone service webhook (and the E2E door in app.ts, which reuses its processing)',
  'scripts/ctm-backfill.ts': 'the history import: each past call goes through the ingest as an end',
};

/** Every file that reads a call's status fields by the phone service's names. */
const STATUS_READERS: Readonly<Record<string, string>> = {
  'src/lib/ctm/ingest.ts': 'the call ingest: the one classification of a call\'s status',
  'src/services/notifications/conversationAlertFallback.ts':
    'the missed-call alert\'s own data (the status the ingest stored, under the same name), never the phone service\'s',
};

/** Every file that writes a call row, and whether that write may set its status. */
const CALL_WRITERS: Readonly<Record<string, { status: boolean; why: string }>> = {
  'src/lib/ctm/ingest.ts': { status: true, why: 'the call ingest: stores the status it classified' },
  'src/controllers/comm-calls.controller.ts': {
    status: true,
    why: 'a call logged by hand keeps the status the person gives; the placed call writes no row; the re-tie routes write the filing only',
  },
  'src/lib/ctm/recordings.ts': { status: false, why: 'the recording key only' },
  'src/lib/call-tracking/process.ts': { status: false, why: 'the marketing vendor\'s attribution only' },
  'scripts/ctm-reattribute.ts': { status: false, why: 'who answered only' },
  'scripts/phone-history-repair.ts': {
    status: false,
    why: 'the repair (#3028): re-files an incoming call on a shared number by the fixed order (the filing only), and deletes the ringing calls a text made',
  },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The source without its comments, so a comment that names a function is not a call of it. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** The argument text of each call that starts at a match of `pattern` (which must end at the opening parenthesis). */
function callArguments(src: string, pattern: RegExp): string[] {
  const args: string[] = [];
  for (const m of src.matchAll(pattern)) {
    let depth = 0;
    const start = m.index! + m[0].length - 1;
    for (let i = start; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          args.push(src.slice(start + 1, i));
          break;
        }
      }
    }
  }
  return args;
}

const FILES = DIRS.flatMap((d) => sourceFiles(join(ROOT, d))).map((f) => ({ path: relative(ROOT, f), src: code(f) }));

const CALLS_INGEST = /\bingestCall\s*\(/;
const DEFINES_INGEST = /function\s+ingestCall\s*\(/g;
const READS_PROVIDER_STATUS = /(?:\.\s*|\[\s*['"`])(?:dial_status|call_status)\b/;
const WRITES_CALL = /\bcallSession\s*\.\s*(?:create|createMany|upsert|update|updateMany)\s*\(/g;
const RAW_CALL_WRITE = /(?:update|insert\s+into|delete\s+from)\s+(?:"?public"?\s*\.\s*)?"?call_sessions\b/i;
const STATUS_KEY = /\bstatus\b\s*[:,}]/;

describe('every place that decides a call\'s status is the call ingest', () => {
  it('every caller of the call ingest is listed', () => {
    const callers = FILES.filter((f) => CALLS_INGEST.test(f.src.replace(DEFINES_INGEST, ''))).map((f) => f.path).sort();
    expect(callers).toEqual(Object.keys(INGEST_CALLERS).sort());
  });

  it('every file that reads a call\'s status by the phone service\'s names is listed', () => {
    const readers = FILES.filter((f) => READS_PROVIDER_STATUS.test(f.src)).map((f) => f.path).sort();
    expect(readers).toEqual(Object.keys(STATUS_READERS).sort());
  });

  it('every file that writes a call row is listed, and only the listed ones write its status', () => {
    const writers = FILES.filter((f) => new RegExp(WRITES_CALL.source).test(f.src)).map((f) => f.path).sort();
    expect(writers).toEqual(Object.keys(CALL_WRITERS).sort());

    const writesStatus = Object.fromEntries(
      FILES.filter((f) => f.path in CALL_WRITERS).map((f) => [
        f.path,
        callArguments(f.src, WRITES_CALL).some((args) => STATUS_KEY.test(args)) || CALL_WRITERS[f.path]!.status,
      ]),
    );
    expect(writesStatus).toEqual(Object.fromEntries(Object.entries(CALL_WRITERS).map(([p, w]) => [p, w.status])));
  });

  it('no raw query writes a call row', () => {
    expect(FILES.filter((f) => RAW_CALL_WRITE.test(f.src)).map((f) => f.path)).toEqual([]);
  });
});
