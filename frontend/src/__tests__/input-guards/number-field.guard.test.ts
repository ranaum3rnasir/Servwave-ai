/* =============================================================================
   Number field guard (mobile slice 37, KB-04).

   A money, quantity, percent or count field says what it holds and is a text
   input with the right keypad (src/ui-kit/lib/numberField.ts):

     <Input kind="money" value={amount} />            pass
     <Input kind="count" {...register('days')} />      pass
     <Input type="number" value={amount} />            FAIL - spins under the wheel
     <input type="number" />                           FAIL
     <LabeledInput type="number" />                    FAIL - a wrapper passes it on
     <Input type={isMoney ? 'number' : 'text'} />      FAIL

   The behaviour itself is tested in number-field.test.tsx.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { sourceFiles } from './scan';
import { findNumberInputs } from './number-field-scan';

const tokens = (src: string) => findNumberInputs(src).map((o) => o.token);
const FAIL = (tag: string) => `<${tag}> type="number" (use kind="money" | "quantity" | "percent" | "count")`;

function scan(files: ReadonlyArray<readonly [string, string]> = sourceFiles()): string[] {
  const out: string[] = [];
  for (const [file, src] of files) {
    if (!file.endsWith('.tsx')) continue;
    for (const o of findNumberInputs(src)) out.push(`${file}:${o.line} ${o.token}`);
  }
  return out;
}

describe('number field guard (mobile slice 37)', () => {
  it('fires on a number input, written any way', () => {
    expect(tokens('<Input type="number" value={amount} />')).toEqual([FAIL('Input')]);
    expect(tokens('<input type="number" min={0} />')).toEqual([FAIL('input')]);
    expect(tokens("<Input type={'number'} />")).toEqual([FAIL('Input')]);
    expect(tokens('<Input\n  min={0}\n  type="number"\n/>')).toEqual([FAIL('Input')]);
    expect(tokens("<Input type={isMoney ? 'number' : 'text'} />")).toEqual([FAIL('Input')]);
    expect(tokens('<LabeledInput label="Price" type="number" />')).toEqual([FAIL('LabeledInput')]);
  });

  it('stays quiet on number kinds, other types, chart axes and comments', () => {
    expect(tokens('<Input kind="money" min={0} step={0.01} value={amount} />')).toEqual([]);
    expect(tokens('<Input kind="count" {...register("days", { valueAsNumber: true })} />')).toEqual([]);
    expect(tokens('<input {...fieldKindProps("quantity")} />')).toEqual([]);
    expect(tokens('<Input type="text" />')).toEqual([]);
    expect(tokens('<input type="checkbox" />')).toEqual([]);
    expect(tokens('<XAxis type="number" tickFormatter={money} />')).toEqual([]);
    expect(tokens('// <Input type="number" />')).toEqual([]);
    expect(tokens('/* <Input type="number" /> */')).toEqual([]);
  });

  it('no field in the app is a number input', () => {
    const offenders = scan();
    expect(offenders, `State the field's kind instead (src/ui-kit/lib/numberField.ts):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('a deliberately added number input is reported', () => {
    const planted = [...sourceFiles(), ['pages/Planted.tsx', 'export const P = () => <Input type="number" value={1} />;'] as const];
    expect(scan(planted)).toEqual([`pages/Planted.tsx:1 ${FAIL('Input')}`]);
  });
});
