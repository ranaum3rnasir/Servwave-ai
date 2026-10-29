/* =============================================================================
   Phone field guard (mobile slice 36, KB-02).

   Every phone field is a <PhoneInput>: the telephone keypad and phone autofill,
   and a stored international number shown and re-saved exactly as stored.

     <PhoneInput value={v} onValueChange={setV} />          pass
     <Input kind="phone-extension" value={ext} />           pass (the extension box)
     <Input inputMode="tel" value={phone} />                FAIL - a raw phone field
     <input placeholder="(555) 123-4567" />                 FAIL - a phone field on QWERTY
     <Input {...register('phone')} />                       FAIL
   ============================================================================= */
import { describe, it, expect } from 'vitest';
import { sourceFiles } from './scan';
import { findRawPhoneFields } from './phone-field-scan';

/**
 * Files the guard does not read, each with the reason. Keep this short.
 * The legacy pages are not routed: every path is declared by pages/v2/routes/
 * (see App.tsx and pages/v2/V2Routes.tsx), and these files are kept only because
 * older tests import them. Slice 36 counts live screens only.
 */
const NOT_ROUTED = 'legacy page: no route renders it (the route table is pages/v2/routes/); kept for older tests';
const EXEMPT: Record<string, string> = {
  'ui-kit/components/form/phoneInput.tsx': 'the phone input itself',
  'components/copilot/Composer.tsx': 'copilot is out of scope for the mobile programme',
  'pages/CustomerFormPage.tsx': NOT_ROUTED,
  'pages/settings/CompanyProfilePage.tsx': NOT_ROUTED,
  'pages/settings/LocationsPage.tsx': NOT_ROUTED,
  'pages/settings/UsersTeamsPage.tsx': NOT_ROUTED,
};

const tokens = (src: string) => findRawPhoneFields(src).map((o) => o.token);

function scan(files: ReadonlyArray<readonly [string, string]> = sourceFiles()): string[] {
  const out: string[] = [];
  for (const [file, src] of files) {
    if (!file.endsWith('.tsx') || file in EXEMPT) continue;
    for (const o of findRawPhoneFields(src)) out.push(`${file}:${o.line} ${o.token}`);
  }
  return out;
}

describe('phone field guard (mobile slice 36)', () => {
  it('fires on a telephone keypad, type, autofill or kind on a raw field', () => {
    expect(tokens('<Input inputMode="tel" value={x} />')).toEqual(['<Input> inputMode="tel" (use <PhoneInput>)']);
    expect(tokens('<Input type="tel" />')).toEqual(['<Input> type="tel" (use <PhoneInput>)']);
    expect(tokens('<input autoComplete="tel-national" />')).toEqual(['<input> autoComplete="tel-national" (use <PhoneInput>)']);
    expect(tokens('<Input kind="phone" />')).toEqual(['<Input> kind="phone" (use <PhoneInput>)']);
    expect(tokens('<input {...fieldKindProps("phone")} />')).toEqual(['<input> fieldKindProps("phone") (use <PhoneInput>)']);
  });

  it('fires on a field named, registered or bound as a phone number', () => {
    expect(tokens('<Input id="location-phone" value={x} />')).toEqual(['<Input> id="location-phone" (use <PhoneInput>)']);
    expect(tokens('<Input id="secondary_phone" />')).toEqual(['<Input> id="secondary_phone" (use <PhoneInput>)']);
    expect(tokens("<Input {...register('phone')} />")).toEqual(['<Input> register("phone") (use <PhoneInput>)']);
    expect(tokens('<Input {...form.register(`phones.${index}.phone`)} />')).toEqual(['<Input> register("phones.${index}.phone") (use <PhoneInput>)']);
    expect(tokens('<Input value={fields.phone} />')).toEqual(['<Input> value={...phone} (use <PhoneInput>)']);
    expect(tokens('<Input value={form.contactPhone} onChange={f} />')).toEqual(['<Input> value={...contactPhone} (use <PhoneInput>)']);
    expect(tokens('<Input value={c.phone ?? ""} />')).toEqual(['<Input> value={...phone} (use <PhoneInput>)']);
  });

  it('fires on a field whose placeholder or label says it is a phone number (the QWERTY ones)', () => {
    expect(tokens('<input value={number} placeholder="(212) 555-0123" />')).toEqual(['<input> placeholder="(212) 555-0123" (use <PhoneInput>)']);
    expect(tokens('<Input placeholder="Phone" value={invite.x} />')).toEqual(['<Input> placeholder="Phone" (use <PhoneInput>)']);
    expect(tokens('<input aria-label="To phone number" value={n} />')).toEqual(['<input> aria-label="To phone number" (use <PhoneInput>)']);
  });

  it('stays quiet on the phone input, the extension box, other kinds and non-text inputs', () => {
    expect(tokens('<PhoneInput id="phone" value={fields.phone} onValueChange={f} />')).toEqual([]);
    expect(tokens('<Input kind="phone-extension" id="phone_ext" value={fields.phone_ext} />')).toEqual([]);
    expect(tokens("<Input placeholder=\"Ext\" {...register('phone_ext')} />")).toEqual([]);
    expect(tokens('<Input aria-label="Phone extension" value={ext} />')).toEqual([]);
    expect(tokens('<Input kind="search" placeholder="Search name, company, phone, email" />')).toEqual([]);
    expect(tokens('<input {...fieldKindProps("search")} placeholder="Search by client or phone number" />')).toEqual([]);
    expect(tokens('<input type="checkbox" id="sms-phone" />')).toEqual([]);
    expect(tokens('<Input value={phoneSearch} />')).toEqual([]);
    expect(tokens('<Input placeholder="Group name" />')).toEqual([]);
    expect(tokens('// <Input inputMode="tel" />')).toEqual([]);
  });

  it('every live phone field in the app is a <PhoneInput>', () => {
    const offenders = scan();
    expect(offenders, `Use <PhoneInput> (src/ui-kit/components/form/phoneInput.tsx):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('a deliberately added raw phone field is reported', () => {
    const planted = [...sourceFiles(), ['pages/Planted.tsx', '<Input placeholder="(555) 123-4567" value={x} />'] as const];
    expect(scan(planted)).toContain('pages/Planted.tsx:1 <Input> placeholder="(555) 123-4567" (use <PhoneInput>)');
  });

  it('every exempt file exists', () => {
    const files = new Set(sourceFiles().map(([f]) => f));
    for (const f of Object.keys(EXEMPT)) expect(files.has(f), f).toBe(true);
  });
});
