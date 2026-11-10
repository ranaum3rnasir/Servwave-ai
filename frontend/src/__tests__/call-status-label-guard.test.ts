/**
 * #3025 (parent #3013): an outbound call that never reached anyone reads "Not connected" wherever the call history words
 * a call's outcome. The words live in one place, `callStatusLabel` (components/communication/phone/shared.tsx), proven by
 * call-history-not-connected.test.tsx. This guard lists every screen that draws a call row, and says how each words the
 * outcome: through `callStatusLabel`, or with an icon only (no word at all). A new screen that draws a call row, or a
 * second table of status words, fails here until it is listed.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|stories)\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** The source without its comments. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/** Every screen that draws a call row (the call's direction-and-outcome icon), and how it words the outcome. */
const CALL_ROWS: Readonly<Record<string, 'label' | 'icon only'>> = {
  'components/communication/phone/CallsView.tsx': 'label', // the call log's card and the call's detail panel
  'components/communication/phone/DispatchView.tsx': 'label', // the callback queue (demo company only)
  'components/communication/phone/CallsTable.tsx': 'icon only', // the call tracking report's table: the status column is the icon
  'components/communication/phone/Dialer.tsx': 'icon only', // the dialer's call history for a customer: date, time, disposition
  'components/communication/phone/PerformanceView.tsx': 'icon only', // an agent's calls; each opens the detail panel
};

const FILES = sourceFiles(SRC).map((f) => ({ path: relative(SRC, f), src: code(f) }));

/** A table of words keyed by a call's status. */
const STATUS_WORDS_TABLE = /Record<\s*(?:CallSession\[\s*["']status["']\s*\]|CallStatus)\s*,\s*string\s*>/;
/** A call's raw status drawn as text, or used to look a word up. */
const RAW_STATUS_WORD = /\{\s*(?:c|call|row|item)\.status\s*\}|\[\s*(?:c|call|row|item)\.status\s*\]/;

describe('every call row words its outcome through callStatusLabel (guard)', () => {
  it('every screen that draws a call row is listed', () => {
    const rows = FILES.filter((f) => /<DirIcon\b/.test(f.src)).map((f) => f.path).sort();
    expect(rows).toEqual(Object.keys(CALL_ROWS).sort());
  });

  it('a listed screen that words the outcome does it through callStatusLabel, and none draws the raw status', () => {
    const how = Object.fromEntries(
      FILES.filter((f) => f.path in CALL_ROWS).map((f) => [
        f.path,
        RAW_STATUS_WORD.test(f.src) ? 'raw status' : /\bcallStatusLabel\s*\(/.test(f.src) ? 'label' : 'icon only',
      ]),
    );
    expect(how).toEqual(CALL_ROWS);
  });

  it('the one table of call status words is the one behind callStatusLabel', () => {
    const tables = FILES.filter((f) => STATUS_WORDS_TABLE.test(f.src)).map((f) => f.path);
    expect(tables).toEqual(['components/communication/phone/shared.tsx']);
  });
});
