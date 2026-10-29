/* =============================================================================
   Named controls guard (mobile slice 25, rubric A11Y-03) - zero tolerance.

   Every icon-only button, checkbox, radio and switch has an accessible name.
   The kit/legacy `Button` enforce it for `size="icon"` at the type level; this
   guard covers raw `<button>` elements and the toggles:

     <button aria-label="Send"><Send /></button>               pass
     <button><Send /></button>                                 FAIL
     <Switch aria-label="View Customers" checked={v} />        pass
     <label><Checkbox checked={v} /> Taxable</label>           pass
     <Switch checked={v} />                                    FAIL
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { sourceFiles } from '../layout-guards/scan';
import { findUnnamedControls } from './scan';

/** Files the guard does not read, each with the reason. Keep this short. */
const EXEMPT: Record<string, string> = {
  // The search fields' clear buttons are mobile slice 33's (full-screen search on phones).
  'components/layout/GlobalSearch.tsx': 'search clear: mobile slice 33',
  'components/schedule/ScheduleSearch.tsx': 'search clear: mobile slice 33',
};

const tokens = (src: string) => findUnnamedControls(src).map((o) => o.token);
const LUCIDE = "import { Send, X, Mic, MicOff } from 'lucide-react';\n";

describe('named controls guard (mobile slice 25, A11Y-03)', () => {
  it('fires on a raw icon-only button with no name', () => {
    expect(tokens(`${LUCIDE}<button type="submit" className="p-2"><Send className="h-4 w-4" /></button>`)).toEqual(['<button> (icon only)']);
    expect(tokens(`${LUCIDE}<button\n  onClick={() => remove(tag.id)}\n>\n  <X className="h-3 w-3" />\n</button>`)).toEqual(['<button> (icon only)']);
    expect(tokens(`${LUCIDE}<button onClick={t}>{on ? <Mic /> : <MicOff />}</button>`)).toEqual(['<button> (icon only)']);
  });

  it('passes a named icon button, a text button and a button whose content is not an icon', () => {
    expect(tokens(`${LUCIDE}<button aria-label="Send"><Send /></button>`)).toEqual([]);
    expect(tokens(`${LUCIDE}<button aria-labelledby="t"><X /></button>`)).toEqual([]);
    expect(tokens(`${LUCIDE}<button><Send /> Send</button>`)).toEqual([]);
    expect(tokens(`${LUCIDE}<button><JobBadge job={label} /></button>`)).toEqual([]);
    expect(tokens(`${LUCIDE}<button aria-hidden="true" tabIndex={-1}><X /></button>`)).toEqual([]);
  });

  it('fires on a checkbox, switch or radio with no name', () => {
    expect(tokens('<Switch checked={v} onCheckedChange={set} />')).toEqual(['<Switch>']);
    expect(tokens('<Checkbox\n  checked={item.is_taxable}\n  onCheckedChange={(val) => update(val)}\n/>')).toEqual(['<Checkbox>']);
    expect(tokens('<input type="checkbox" checked={done} onChange={toggle} />')).toEqual(['<input type=checkbox|radio>']);
    expect(tokens('<input type="radio" name="x" />')).toEqual(['<input type=checkbox|radio>']);
  });

  it('passes a named, labelled-by-id, label-wrapped or hidden toggle, and ignores text inputs', () => {
    expect(tokens('<Switch aria-label="View Customers" checked={v} />')).toEqual([]);
    expect(tokens('<Checkbox id="taxable" checked={v} /><label htmlFor="taxable">Taxable</label>')).toEqual([]);
    expect(tokens('<label className="flex"><Checkbox checked={v} /> Taxable</label>')).toEqual([]);
    expect(tokens('<Checkbox checked={v} tabIndex={-1} aria-hidden="true" />')).toEqual([]);
    expect(tokens('<input type="text" value={q} />')).toEqual([]);
  });

  it('no file in src has an unnamed icon-only button, checkbox, radio or switch', () => {
    const found: string[] = [];
    for (const [file, src] of sourceFiles()) {
      if (!file.endsWith('.tsx') || EXEMPT[file]) continue;
      for (const o of findUnnamedControls(src)) found.push(`${file}:${o.line} ${o.token}`);
    }
    expect(found).toEqual([]);
  });

  it('every exemption still names a file that exists', () => {
    const files = new Set(sourceFiles().map(([f]) => f));
    expect(Object.keys(EXEMPT).filter((f) => !files.has(f))).toEqual([]);
  });
});
