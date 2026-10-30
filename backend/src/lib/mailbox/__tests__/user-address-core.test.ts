/* =============================================================================
   Roles & Permissions, PRD 10, slice S10.3 - the register's pure core for a USER address:
   first.last.company. No database and no mocks. Expected strings are written out by hand from the PRD
   ("Name part"), never produced by the code under test.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  MAX_LOCAL_PART_LENGTH,
  buildUserLocalPart,
  buildUserNamePart,
  checkUserNamePart,
  namePartOfLocalPart,
  slugNamePart,
} from '../address-core';

describe('slugNamePart', () => {
  it('keeps lowercase letters and digits only', () => {
    expect(slugNamePart('Jane')).toBe('jane');
    expect(slugNamePart('Agent 007')).toBe('agent007');
  });

  it('drops hyphens, apostrophes, spaces and dots', () => {
    expect(slugNamePart("O'Brien")).toBe('obrien');
    expect(slugNamePart('Smith-Jones')).toBe('smithjones');
    expect(slugNamePart('  Mary  Ann ')).toBe('maryann');
    expect(slugNamePart('J.R.')).toBe('jr');
  });

  it('drops a letter with an accent rather than guessing at it, as the company part does', () => {
    expect(slugNamePart('José')).toBe('jos');
    expect(slugNamePart('Müller')).toBe('mller');
  });

  it('drops emoji and every non-Latin letter, so a name written in another script is nothing', () => {
    expect(slugNamePart('Jane 😀')).toBe('jane');
    expect(slugNamePart('山田')).toBe('');
    expect(slugNamePart('Иван')).toBe('');
    expect(slugNamePart('😀😀')).toBe('');
  });

  it('is not fooled by letters that lowercase into ASCII', () => {
    expect(slugNamePart('Kate')).toBe('ate'); // KELVIN SIGN
    expect(slugNamePart('İvan')).toBe('van'); // dotted capital I
  });

  it('lets no header-breaking character survive', () => {
    const evil = 'Jane\r\nBcc: attacker@example.com\n<script>"x"; (y),@z';
    const slug = slugNamePart(evil);
    expect(slug).toBe('janebccattackerexamplecomscriptxyz');
    expect(slug).toMatch(/^[a-z0-9]*$/);
  });

  it('is empty for null, undefined and blank', () => {
    expect(slugNamePart(null)).toBe('');
    expect(slugNamePart(undefined)).toBe('');
    expect(slugNamePart('   ')).toBe('');
  });
});

describe('buildUserNamePart', () => {
  it('is first, a dot, last', () => {
    expect(buildUserNamePart('Jane', 'Smith', 'acme')).toBe('jane.smith');
  });

  it('applies the allow-list to each name on its own', () => {
    expect(buildUserNamePart("Mary-Ann", "O'Neil", 'acme')).toBe('maryann.oneil');
  });

  it('gives the first name alone to a user with no usable last name', () => {
    expect(buildUserNamePart('Jane', '', 'acme')).toBe('jane');
    expect(buildUserNamePart('Jane', '山田', 'acme')).toBe('jane');
    expect(buildUserNamePart('Jane', null, 'acme')).toBe('jane');
  });

  it('gives the last name alone to a user with no usable first name', () => {
    expect(buildUserNamePart('', 'Smith', 'acme')).toBe('smith');
    expect(buildUserNamePart('😀', 'Smith', 'acme')).toBe('smith');
  });

  it('gives nothing to a user with neither', () => {
    expect(buildUserNamePart('', '', 'acme')).toBeNull();
    expect(buildUserNamePart('山田', '太郎', 'acme')).toBeNull();
    expect(buildUserNamePart('\r\n', '<>', 'acme')).toBeNull();
  });

  it('keeps the whole local part inside 64 characters, whatever the length of the name', () => {
    const long = 'a'.repeat(200);
    for (const company of ['acme', 'c'.repeat(40)]) {
      const part = buildUserNamePart(long, long, company)!;
      expect(`${part}.${company}`.length).toBeLessThanOrEqual(MAX_LOCAL_PART_LENGTH);
      expect(part.length).toBeGreaterThan(0);
    }
    expect(buildUserNamePart(long, '', 'c'.repeat(40))!.length).toBe(64 - 1 - 40);
  });

  it('shares a tight budget between the two names, keeping a short name whole', () => {
    // company part of 40 leaves 23 for "first.last": 22 characters of names.
    const company = 'c'.repeat(40);
    expect(buildUserNamePart('a'.repeat(30), 'b'.repeat(30), company)).toBe(`${'a'.repeat(11)}.${'b'.repeat(11)}`);
    // a short first name keeps all of itself, the long last name gets the rest
    expect(buildUserNamePart('jo', 'b'.repeat(60), company)).toBe(`jo.${'b'.repeat(20)}`);
    // a short last name keeps all of itself, the long first name gets the rest
    expect(buildUserNamePart('a'.repeat(60), 'li', company)).toBe(`${'a'.repeat(20)}.li`);
    // a long first name gives way until the short last name fits whole
    expect(buildUserNamePart('a'.repeat(23), 'smith', company)).toBe(`${'a'.repeat(17)}.smith`);
  });

  it('leaves a name that fits exactly as it is', () => {
    const company = 'c'.repeat(40);
    expect(buildUserNamePart('a'.repeat(11), 'b'.repeat(11), company)).toBe(`${'a'.repeat(11)}.${'b'.repeat(11)}`);
  });

  it('never carries a dot, an at sign, a space, a control character or an angle bracket', () => {
    const part = buildUserNamePart('Ja\r\nne <a@b>', 'Smi\tth "x"', 'acme')!;
    expect(part).toBe('janeab.smithx');
    expect(part).not.toMatch(/[\r\n\t<>@" ]/);
  });
});

describe('buildUserLocalPart and namePartOfLocalPart', () => {
  it('puts the company part last, after a dot', () => {
    expect(buildUserLocalPart('jane.smith', 'acme')).toBe('jane.smith.acme');
    expect(buildUserLocalPart('jane', 'acme')).toBe('jane.acme');
  });

  it('reads the name part back as everything before the last dot', () => {
    expect(namePartOfLocalPart('jane.smith.acme')).toBe('jane.smith');
    expect(namePartOfLocalPart('jane.acme')).toBe('jane');
  });

  it('has no name part for a main address, which carries no dot', () => {
    expect(namePartOfLocalPart('acme')).toBeNull();
  });
});

/* S10.25: the name part an admin types when setting or changing a user's address. */
describe('checkUserNamePart', () => {
  it('accepts first.last, a single word and digits, in lowercase', () => {
    expect(checkUserNamePart('jane.smith', 'acme')).toEqual({ ok: true, namePart: 'jane.smith' });
    expect(checkUserNamePart('jsmith', 'acme')).toEqual({ ok: true, namePart: 'jsmith' });
    expect(checkUserNamePart('jane.smith2', 'acme')).toEqual({ ok: true, namePart: 'jane.smith2' });
  });

  it('trims the ends and lowercases, so Jane.Smith is jane.smith', () => {
    expect(checkUserNamePart('  Jane.Smith ', 'acme')).toEqual({ ok: true, namePart: 'jane.smith' });
  });

  it('refuses an empty name part', () => {
    expect(checkUserNamePart('', 'acme')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkUserNamePart('   ', 'acme')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses every character outside letters, digits and single dots between them', () => {
    for (const bad of ['jane smith', 'jane_smith', 'jane-smith', 'jane@smith', '.jane', 'jane.', 'jane..smith', 'jané', 'jane\r\nBcc: x@y.z', 'jane<x>', 'jane,smith', '山田']) {
      expect(checkUserNamePart(bad, 'acme'), JSON.stringify(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('keeps the whole local part inside 64 characters, counting the dot and the company part', () => {
    const company = 'acme'; // 4
    const longest = 'a'.repeat(MAX_LOCAL_PART_LENGTH - 1 - company.length); // 59 -> local part of exactly 64
    expect(checkUserNamePart(longest, company)).toEqual({ ok: true, namePart: longest });
    expect(checkUserNamePart(`${longest}a`, company)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a reserved local part', () => {
    expect(checkUserNamePart('postmaster', 'acme')).toEqual({ ok: false, reason: 'reserved' });
    expect(checkUserNamePart('Abuse', 'acme')).toEqual({ ok: false, reason: 'reserved' });
  });
});
