/**
 * Guard: no native <input type="date" | "time" | "datetime-local"> anywhere.
 *
 * All three render their clock and their field ORDER from the BROWSER locale,
 * so a non-US locale showed a 24-hour picker (21:00) and an ambiguous
 * 04/08/2026 in a product sold only to US contractors. DatePicker,
 * TimeCombobox and DateTimePicker render their own text and options, so the
 * US format is unconditional. Their value contracts are identical
 * ('YYYY-MM-DD' / 'HH:MM' / 'YYYY-MM-DDTHH:MM'), so adopting one is a swap,
 * never a data change.
 *
 * #1240 converted most of these; this guard is what stops the rest - and any
 * future one - from coming back. It is deliberately a whole-src scan rather
 * than a per-file assertion: the sites that regress are the ones nobody
 * remembered to look at.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');
const BANNED = /type=["']\{?\s*(date|time|datetime-local)\s*\}?["']/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === 'node_modules' ? [] : walk(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

describe('native date/time inputs are banned (US formatting is not the browser locale to decide)', () => {
  it('has no <input type="date" | "time" | "datetime-local"> anywhere in src', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith('no-native-time-inputs.test.ts'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .map((line, i) => ({ file: file.slice(SRC.length + 1), line: i + 1, text: line }))
          // Comment lines naming the banned inputs are how the swap is EXPLAINED
          // — the ban is on rendering one, not on writing its name down.
          .filter(({ text }) => BANNED.test(text) && !/^\s*(\/\/|\/?\*)/.test(text)),
      )
      .map(({ file, line, text }) => `${file}:${line} ${text.trim()}`);

    expect(offenders).toEqual([]);
  });
});
