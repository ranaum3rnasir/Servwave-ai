/* =============================================================================
   Field kinds (mobile slice 23, KB-03 and the search half of KB-05).

   1. The pure function: every kind yields the expected type, keyboard mode,
      autofill token, capitalisation, spell-check and action key.
   2. The primitives: the kit Input, the legacy Input, SearchInput and the
      command-menu input render those attributes from `kind` alone.
   ============================================================================= */
import * as React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FIELD_KINDS, fieldKindAttributes, fieldKindProps, type FieldKind } from '@/ui-kit/lib/fieldKind';
import { Input as KitInput } from '@/ui-kit/components/ui/input';
import { Input as LegacyInput } from '@/components/ui/input';
import { SearchInput } from '@/ui-kit/components/form/searchInput';
import { Command, CommandInput } from '@/ui-kit/components/ui/command';

type Row = [FieldKind, string, string, string, string, boolean, string | undefined];

//  kind             type      inputMode  autoComplete      autoCapitalize spellCheck enterKeyHint
const EXPECTED: Row[] = [
  ['email',         'email',  'email',   'email',          'none',  false, undefined],
  ['search',        'search', 'search',  'off',            'none',  false, 'search'],
  ['one-time-code', 'text',   'numeric', 'one-time-code',  'none',  false, 'done'],
  ['name',          'text',   'text',    'name',           'words', false, undefined],
  ['given-name',    'text',   'text',    'given-name',     'words', false, undefined],
  ['family-name',   'text',   'text',    'family-name',    'words', false, undefined],
  ['organization',  'text',   'text',    'organization',   'words', false, undefined],
  ['street',       'text',   'text',    'address-line1',  'words', false, undefined],
  ['address-line2', 'text',   'text',    'address-line2',  'words', false, undefined],
  ['city',          'text',   'text',    'address-level2', 'words', false, undefined],
  ['state',         'text',   'text',    'address-level1', 'characters', false, undefined],
  ['postal-code',   'text',   'numeric', 'postal-code',    'none',  false, undefined],
  // Mobile slice 36: the phone input's kind, and the extension box beside it.
  ['phone',         'tel',    'tel',     'tel',            'none',  false, undefined],
  ['phone-extension', 'text', 'numeric', 'tel-extension',  'none',  false, undefined],
  // Mobile slice 37: number kinds are text inputs (no spinner, no scroll-to-change).
  ['money',         'text',   'decimal', 'off',            'none',  false, undefined],
  ['quantity',      'text',   'decimal', 'off',            'none',  false, undefined],
  ['percent',       'text',   'decimal', 'off',            'none',  false, undefined],
  ['count',         'text',   'numeric', 'off',            'none',  false, undefined],
];

describe('fieldKindAttributes (mobile slice 23)', () => {
  it('covers every kind in the table', () => {
    expect(EXPECTED.map(([k]) => k).sort()).toEqual([...FIELD_KINDS].sort());
  });

  it.each(EXPECTED)('%s -> type %s, keyboard %s, autofill %s, capitalise %s, spell-check %s, action key %s', (kind, type, inputMode, autoComplete, autoCapitalize, spellCheck, enterKeyHint) => {
    expect(fieldKindAttributes(kind)).toEqual({ type, inputMode, autoComplete, autoCapitalize, autoCorrect: 'off', spellCheck, enterKeyHint });
  });

  it('a third party\'s details: personal autofill off, type and keyboard kept', () => {
    for (const kind of ['email', 'name', 'given-name', 'family-name', 'organization', 'street', 'address-line2', 'city', 'state', 'postal-code', 'phone', 'phone-extension'] as const) {
      const on = fieldKindAttributes(kind);
      const off = fieldKindAttributes(kind, { personalAutofill: false });
      expect(off, kind).toEqual({ ...on, autoComplete: 'off' });
    }
  });

  it('search and one-time code are not personal data, so the option leaves them alone', () => {
    expect(fieldKindAttributes('search', { personalAutofill: false })).toEqual(fieldKindAttributes('search'));
    expect(fieldKindAttributes('one-time-code', { personalAutofill: false })).toEqual(fieldKindAttributes('one-time-code'));
  });

  it('fieldKindProps: nothing for no kind, and no empty action key', () => {
    expect(fieldKindProps(undefined)).toEqual({});
    expect('enterKeyHint' in fieldKindProps('email')).toBe(false);
    expect(fieldKindProps('search').enterKeyHint).toBe('search');
  });
});

function attrs(el: Element | null) {
  if (!el) throw new Error('no field rendered');
  const pick = (n: string) => el.getAttribute(n);
  return {
    type: pick('type'),
    inputmode: pick('inputmode'),
    autocomplete: pick('autocomplete'),
    autocapitalize: pick('autocapitalize'),
    spellcheck: pick('spellcheck'),
    enterkeyhint: pick('enterkeyhint'),
  };
}

describe('primitives take a field kind (mobile slice 23)', () => {
  const email = { type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: null };
  const search = { type: 'search', inputmode: 'search', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', enterkeyhint: 'search' };

  it('kit Input renders the kind', () => {
    const { container } = render(<KitInput kind="email" />);
    expect(attrs(container.querySelector('input'))).toEqual(email);
  });

  it('legacy Input renders the kind', () => {
    const { container } = render(<LegacyInput kind="email" />);
    expect(attrs(container.querySelector('input'))).toEqual(email);
  });

  it('personalAutofill={false} keeps the email keyboard and drops personal autofill', () => {
    const { container } = render(<LegacyInput kind="email" personalAutofill={false} />);
    expect(attrs(container.querySelector('input'))).toEqual({ ...email, autocomplete: 'off' });
    const kit = render(<KitInput kind="postal-code" personalAutofill={false} />);
    expect(attrs(kit.container.querySelector('input'))).toMatchObject({ type: 'text', inputmode: 'numeric', autocomplete: 'off' });
  });

  it('a field with no kind renders exactly what it did before (no kind attributes)', () => {
    const { container } = render(<KitInput />);
    const a = attrs(container.querySelector('input'));
    expect(a).toEqual({ type: null, inputmode: null, autocomplete: null, autocapitalize: null, spellcheck: null, enterkeyhint: null });
  });

  it('SearchInput is a search field with the Search action key by default', () => {
    const { container } = render(<SearchInput value="" onValueChange={() => {}} />);
    expect(attrs(container.querySelector('input'))).toEqual(search);
  });

  it('the command-menu input is a search field with the Search action key', () => {
    const { container } = render(
      <Command>
        <CommandInput placeholder="Search people..." />
      </Command>,
    );
    expect(attrs(container.querySelector('input'))).toMatchObject({ inputmode: 'search', enterkeyhint: 'search', autocapitalize: 'none', spellcheck: 'false' });
  });
});
