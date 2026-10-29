/* =============================================================================
   Field kind guard (mobile slice 23, KB-03 and the search half of KB-05).

   Callers say what a field holds and nothing else:

     <Input kind="email" />                         pass
     <input {...fieldKindProps('search')} />        pass (a raw field)
     <Input type="email" />                         FAIL - hand-set type
     <Input kind="email" inputMode="text" />        FAIL - kind beside a keyboard
     <Input placeholder="ZIP" />                    FAIL - a ZIP field with no kind
     <Input autoComplete="one-time-code" />         FAIL - hand-set autofill

   The kind table itself is tested in field-kind.test.tsx.
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { sourceFiles } from './scan';
import { findFieldKindOffences } from './field-kind-scan';

/** Files the guard does not read, each with the reason. Keep this short. */
const EXEMPT: Record<string, string> = {
  'components/copilot/Composer.tsx': 'copilot is out of scope for the mobile programme',
};

const tokens = (src: string) => findFieldKindOffences(src).map((o) => o.token);

function scan(files: ReadonlyArray<readonly [string, string]> = sourceFiles()): string[] {
  const out: string[] = [];
  for (const [file, src] of files) {
    if (!file.endsWith('.tsx') || file in EXEMPT) continue;
    for (const o of findFieldKindOffences(src)) out.push(`${file}:${o.line} ${o.token}`);
  }
  return out;
}

describe('field kind guard (mobile slice 23)', () => {
  it('fires on a hand-set email or search type, or a hand-set autofill token', () => {
    expect(tokens('<Input type="email" />')).toEqual(['<Input> type="email" (use kind)']);
    expect(tokens('<input type="search" placeholder="Find" />')).toEqual(['<input> type="search" (use kind)']);
    expect(tokens('<Input autoComplete="one-time-code" />')).toEqual(['<Input> autoComplete="one-time-code" (use kind)', '<Input> one-time-code field without kind']);
    expect(tokens('<Input autoComplete="postal-code" />')).toEqual(['<Input> autoComplete="postal-code" (use kind)']);
  });

  it('fires on kind beside a hand-set type, keyboard or autofill', () => {
    expect(tokens('<Input kind="email" inputMode="text" />')).toEqual(['<Input> kind beside inputMode']);
    expect(tokens('<Input kind="search" type="text" autoComplete="off" />')).toEqual(['<Input> kind beside type', '<Input> kind beside autoComplete']);
  });

  it('fires on an email, search, ZIP, name or address field with no kind', () => {
    expect(tokens('<Input {...form.register("email")} />')).toEqual(['<Input> email field without kind']);
    expect(tokens('<Input id="email" placeholder="Email" />')).toEqual(['<Input> email field without kind']);
    expect(tokens('<Input placeholder="ZIP" {...form.register("zip")} />')).toEqual(['<Input> postal-code field without kind']);
    expect(tokens('<input placeholder="Search calls…" />')).toEqual(['<input> search field without kind']);
    expect(tokens('<Input placeholder={searchPlaceholder} />')).toEqual(['<Input> search field without kind']);
    expect(tokens('<Input {...register("first_name")} />')).toEqual(['<Input> given-name field without kind']);
    expect(tokens('<Input {...register("last_name")} />')).toEqual(['<Input> family-name field without kind']);
    expect(tokens('<Input {...register("street")} />')).toEqual(['<Input> street field without kind']);
    expect(tokens('<Input {...register("billing.city")} />')).toEqual(['<Input> city field without kind']);
    expect(tokens('<Input {...register("state")} />')).toEqual(['<Input> state field without kind']);
    expect(tokens('<Input {...register("address_line2")} />')).toEqual(['<Input> address-line2 field without kind']);
    expect(tokens('<Input id="mfa-code" maxLength={6} />')).toEqual(['<Input> one-time-code field without kind']);
    // The customer block's typeahead fields hold a name and an email, whatever the placeholder says.
    expect(tokens('<Input id="v2-first-name" placeholder="Search..." value={fields.first_name} />')).toEqual(['<Input> given-name field without kind']);
    expect(tokens('<Input placeholder="Search..." value={fields.email} />')).toEqual(['<Input> email field without kind']);
    expect(tokens('<Input placeholder="Search..." value={fields.company_name} />')).toEqual(['<Input> organization field without kind']);
    expect(tokens('<Input value={search} placeholder="Name, email, phone, or company..." />')).toEqual(['<Input> search field without kind']);
  });

  it('reads wrapper fields (a component named *Input or *Field) that pass type through', () => {
    expect(tokens('<LabeledInput label="Email" type="email" />')).toEqual(['<LabeledInput> type="email" (use kind)']);
    expect(tokens('<TextField type="search" />')).toEqual(['<TextField> type="search" (use kind)']);
    expect(tokens('<LabeledInput kind="email" type="text" />')).toEqual(['<LabeledInput> kind beside type']);
    expect(tokens('<LabeledInput label="Email" kind="email" personalAutofill={false} />')).toEqual([]);
    // A table cell that shows an email is not a field.
    expect(tokens('<ContactCell type="email" value={row.email} />')).toEqual([]);
  });

  it('reads a bound value with a fallback, and a camelCase search state', () => {
    expect(tokens("<Input value={address.zip || ''} />")).toEqual(['<Input> postal-code field without kind']);
    expect(tokens("<Input value={address.city ?? ''} />")).toEqual(['<Input> city field without kind']);
    expect(tokens("<Input maxLength={2} value={address.state || ''} />")).toEqual(['<Input> state field without kind']);
    expect(tokens("<Input value={address.address_line2 || ''} />")).toEqual(['<Input> address-line2 field without kind']);
    expect(tokens('<Input value={poSearch} placeholder="Type PO #, vendor, job, customer…" />')).toEqual(['<Input> search field without kind']);
    expect(tokens('<Input value={jobSearch} />')).toEqual(['<Input> search field without kind']);
    expect(tokens('<Input {...fieldProps} value={searchValue} placeholder={placeholder} />')).toEqual(['<Input> search field without kind']);
    expect(tokens('<Input value={searchTerm} />')).toEqual(['<Input> search field without kind']);
    // Not a search: a saved search's name.
    expect(tokens('<Input value={searchName} />')).toEqual([]);
  });

  it('leaves phone fields to slice 36, and an email subject or sender local part alone', () => {
    expect(tokens('<Input id="phone" placeholder="Search..." inputMode="tel" />')).toEqual([]);
    expect(tokens('<Input id="email-subject" {...subjectReg} />')).toEqual([]);
    expect(tokens('<Input id="email-sender-local-part" value={value} />')).toEqual([]);
  });

  it('stays quiet on kinded fields, spreads, non-text inputs and unrelated fields', () => {
    expect(tokens('<Input kind="email" personalAutofill={false} />')).toEqual([]);
    expect(tokens('<input {...fieldKindProps("search")} placeholder="Search" />')).toEqual([]);
    expect(tokens('<input type="checkbox" aria-label="Email me" />')).toEqual([]);
    expect(tokens('<Input placeholder="Job title" />')).toEqual([]);
    expect(tokens('<Input autoComplete="off" />')).toEqual([]);
    expect(tokens('<Input label={<span placeholder="Search">x</span>} />')).toEqual([]);
    expect(tokens('// <Input type="email" />')).toEqual([]);
  });

  it('every email, search, ZIP, name and address field in the app states its kind and nothing else', () => {
    const offenders = scan();
    expect(offenders, `State the field's kind (src/ui-kit/lib/fieldKind.ts) instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('a deliberately added hand-typed email field is reported', () => {
    const planted = [...sourceFiles(), ['pages/Planted.tsx', '<Input type="email" />'] as const];
    expect(scan(planted)).toContain('pages/Planted.tsx:1 <Input> type="email" (use kind)');
  });

  it('every exempt file exists', () => {
    const files = new Set(sourceFiles().map(([f]) => f));
    for (const f of Object.keys(EXEMPT)) expect(files.has(f), f).toBe(true);
  });
});
