/* =============================================================================
   Text entry size guard (mobile slice 14, rubric KB-01) - zero tolerance.

   iOS zooms the page when a focused text field's text is under 16 px. Every
   text entry primitive adds the touch floor `mobile:!text-base`
   (src/ui-kit/lib/textEntry.ts), so on a phone or tablet it is 16 px whatever size a
   call site asks for, while md-and-up with a fine pointer keeps the call
   site's own size, unchanged:

     <Input className="h-8 text-sm" />                     pass (Input floors it)
     <SelectField className="text-xs" />                   pass (wraps SelectTrigger)
     <input className="text-sm mobile:!text-base" />       pass (floored here)
     <input className="text-sm" />                         FAIL - a raw field
     <input className="text-base md:text-sm" />           FAIL - an iPad is md
     <Input className="mobile:text-sm" />                  FAIL - beats the floor
     <MyInput className="text-xs" />                       FAIL when MyInput passes
                                                           its className to a raw
                                                           field with no floor

   The primitives' own rendered classes are covered by input-primitives.test.tsx.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { discoverTextEntryComponents, findSmallTextEntrySizes, scanTree, sourceFiles, type EntryMap } from './scan';

/** Files the guard does not read, each with the reason. Keep this short. */
const EXEMPT: Record<string, string> = {
  // The AI copilot is off limits to this programme (its pill, panel and
  // composer are owned elsewhere); its composer is measured by the gate.
  'components/copilot/Composer.tsx': 'copilot is out of scope for the mobile programme',
};

const FLOORED: EntryMap = new Map([
  ['Input', 'floored'],
  ['SelectTrigger', 'floored'],
  ['SelectField', 'floored'],
]);
const tokens = (src: string, known: EntryMap = FLOORED) => findSmallTextEntrySizes(src, known).map((o) => o.token);

describe('text entry size guard (mobile slice 14, KB-01)', () => {
  it('fires on a raw field under 16 px with no touch floor', () => {
    expect(tokens('<input className="h-8 text-sm" />')).toEqual(['<input> text-sm']);
    expect(tokens('<textarea\n  rows={3}\n  className="min-h-16 text-[13px]"\n/>')).toEqual(['<textarea> text-[13px]']);
    expect(tokens('<textarea className="text-[0.8125rem]" />')).toEqual(['<textarea> text-[0.8125rem]']);
    // md: is not a desktop gate: an iPad Mini is 768 wide and has a coarse pointer.
    expect(tokens('<input className="text-base md:text-sm" />')).toEqual(['<input> md:text-sm']);
    expect(tokens("<input className={cn('w-full', dense ? 'text-xs' : 'text-sm')} />")).toEqual(['<input> text-xs', '<input> text-sm']);
    expect(tokens('<CommandPrimitive.Input className="text-sm" />')).toEqual(['<CommandPrimitive.Input> text-sm']);
    expect(tokens('<select className="text-xs">')).toEqual(['<select> text-xs']);
    expect(tokens('<input type="email" className="text-sm" />')).toEqual(['<input> text-sm']);
  });

  it('fires on a size behind a touch variant on any text entry element, floored ones included', () => {
    expect(tokens('<Input className="mobile:text-sm" />')).toEqual(['<Input> mobile:text-sm']);
    expect(tokens('<SelectField className="touch:text-xs" />')).toEqual(['<SelectField> touch:text-xs']);
    expect(tokens('<SelectTrigger className="max-md:text-[13px]" />')).toEqual(['<SelectTrigger> max-md:text-[13px]']);
    expect(tokens('<input className="text-sm mobile:!text-base max-md:text-xs" />')).toEqual(['<input> max-md:text-xs']);
  });

  it('fires on a large own size beside a small breakpoint size: the floor is left out for it', () => {
    expect(tokens('<Input className="text-2xl md:text-sm" />')).toEqual(['<Input> md:text-sm']);
  });

  it('stays quiet on floored elements, 16 px and up, and classes that are not the field text', () => {
    expect(tokens('<Input className="h-8 text-sm" />')).toEqual([]);
    expect(tokens('<SelectField className="h-7 w-auto px-1 text-xs" />')).toEqual([]);
    expect(tokens('<input className="text-sm mobile:!text-base" />')).toEqual([]);
    // Not important: md:/lg: come later in the stylesheet and beat it on an iPad.
    expect(tokens('<input className="md:text-sm mobile:text-base" />')).toEqual(['<input> md:text-sm']);
    expect(tokens('<textarea className="text-[16px] text-lg" />')).toEqual([]);
    expect(tokens('<input className="text-[15.5px]" />')).toEqual(['<input> text-[15.5px]']);
    expect(tokens('<input className="file:text-sm placeholder:text-xs" />')).toEqual([]);
    expect(tokens(`<input className="text-text-primary ${'text-sm'}-foo" />`)).toEqual([]);
    // Nested JSX handed through a prop is not the field's class.
    expect(tokens('<Input label={<span className="text-xs">CC</span>} />')).toEqual([]);
    expect(tokens('<input\n  type="file"\n  className="text-xs file:text-xs"\n/>')).toEqual([]);
    expect(tokens('<input type="checkbox" className="text-sm" />')).toEqual([]);
    // Not a text entry element.
    expect(tokens('<InputGroup className="text-sm" /><span className="text-xs" />')).toEqual([]);
    expect(tokens('// <input className="text-sm"> used to zoom')).toEqual([]);
  });

  it('discovers wrappers: a component that hands its className to a raw field with no floor is reported at its call sites', () => {
    const files = [
      ['components/MyInput.tsx', 'export function MyInput({ className }: P) {\n  return <input className={cn("h-8 w-full", className)} />;\n}\n'],
      ['components/MyFloored.tsx', 'export function MyFloored({ className }: P) {\n  return <input className={cn("h-8", "mobile:!text-base", className)} />;\n}\n'],
      ['components/Outer.tsx', 'export const Outer = ({ className }: P) => <MyInput className={cn("px-2", className)} />;\n'],
      ['pages/Uses.tsx', '<MyInput className="text-xs" />\n<MyFloored className="text-xs" />\n<Outer className="text-sm" />\n'],
    ] as const;
    const known = discoverTextEntryComponents(files);
    expect(known.get('MyInput')).toBe('raw');
    expect(known.get('MyFloored')).toBe('floored');
    expect(known.get('Outer')).toBe('raw');
    expect(scanTree(findSmallTextEntrySizes, {}, files)).toEqual(['pages/Uses.tsx:1 <MyInput> text-xs', 'pages/Uses.tsx:3 <Outer> text-sm']);
  });

  it('knows the shipped primitives and their wrappers as floored', () => {
    const known = discoverTextEntryComponents();
    for (const name of ['Input', 'Textarea', 'SelectTrigger', 'CommandInput', 'SelectField', 'Combobox', 'DateFieldDate', 'DateFieldRange', 'AutoGrowTextarea', 'TimeFieldInput', 'PhoneInput']) {
      expect(known.get(name), name).toBe('floored');
    }
  });

  it('scanned the source tree', () => {
    expect(sourceFiles().length).toBeGreaterThan(500);
  });

  it('no text field under 16 px on a phone or a tablet, anywhere in the app', () => {
    const offenders = scanTree(findSmallTextEntrySizes, EXEMPT);
    expect(
      offenders,
      `iOS zooms on these fields. Use a text entry primitive (it adds the touch floor), or add "mobile:!text-base" beside the small size:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('a deliberately added 14 px input is reported', () => {
    const planted = [...sourceFiles(), ['pages/Planted.tsx', '<input className="w-full text-sm" />'] as const];
    expect(scanTree(findSmallTextEntrySizes, EXEMPT, planted)).toContain('pages/Planted.tsx:1 <input> text-sm');
  });

  it('every exempt file exists', () => {
    const files = new Set(sourceFiles().map(([f]) => f));
    for (const f of Object.keys(EXEMPT)) expect(files.has(f), f).toBe(true);
  });
});
