/* =============================================================================
   The organization seed must be safe to run and neutral to read.

   Two independent claims, neither of which needs a database (the DB-backed
   companion, seed-organization-db.test.ts, covers the CI path):

   1. CONTENT - the estimate boilerplate the seed writes is generic placeholder
      copy for any org, not one customer's legal text. The guard never names a
      customer (naming one here would re-introduce exactly what it exists to
      keep out); it asserts on the SHAPE that customer-specific branding takes:
      an ampersand-joined company name, an all-caps company shout, a domain, an
      email address. All four appeared in, or alongside, the text this file
      replaced.

   2. GUARD - the routine refuses to overwrite a demo organization. The seed's
      fixed target UUID is a bare stub row in CI, but the SAME id is the shared
      demo org on staging and production, whose estimate pages are served
      unauthenticated. `is_demo` is the only thing that tells those two apart,
      so the routine reads it and aborts before writing.
   ========================================================================== */

import { describe, it, expect, vi } from 'vitest';
import {
  ESTIMATE_TERMS,
  ESTIMATE_NOTES,
  ESTIMATE_PAYMENT_TERMS,
  DEFAULT_SEED_ORG_ID,
  parseAllowDemoOrg,
  seedOrganization,
  type SeedOrganizationClient,
} from '../seed-organization';

const SEED_COPY: Array<[string, string]> = [
  ['ESTIMATE_TERMS', ESTIMATE_TERMS],
  ['ESTIMATE_NOTES', ESTIMATE_NOTES],
  ['ESTIMATE_PAYMENT_TERMS', ESTIMATE_PAYMENT_TERMS],
];

/**
 * Shapes that a specific company's name or contact details take in prose.
 * Deliberately pattern-based, not a banned-word list: a list would have to
 * spell the customer out, and would go stale the moment the seed is re-branded
 * from some other org's paperwork.
 */
const BRANDING_SHAPES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'an ampersand-joined company name (e.g. "Something Widgets & Service")',
    pattern: /\b[A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,})*\s*&\s*[A-Z][A-Za-z]{2,}/,
  },
  {
    label: 'an all-caps company shout (e.g. "SOMETHING WIDGETS")',
    pattern: /\b[A-Z]{3,}\s+[A-Z]{3,}\b/,
  },
  {
    label: 'a domain name',
    pattern: /\b[a-z0-9-]+\.(?:com|net|org|io|co)\b/i,
  },
  {
    label: 'an email address',
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/,
  },
];

describe('seed-organization content', () => {
  it.each(SEED_COPY)('%s carries no customer-specific branding', (name, text) => {
    // First, that there IS text. `RegExp.test(undefined)` tests the string
    // "undefined" and matches none of the shapes below, so without this the
    // whole block would pass green against an export that does not exist.
    expect(typeof text, `${name} is not exported as a string`).toBe('string');
    expect(text.trim().length, `${name} is empty`).toBeGreaterThan(0);

    const hits = BRANDING_SHAPES.filter(({ pattern }) => pattern.test(text)).map(
      ({ label, pattern }) => `${label} -> ${JSON.stringify(text.match(pattern)?.[0])}`,
    );

    if (hits.length > 0) {
      expect.fail(
        `${name} reads as one company's paperwork, not neutral placeholder copy.\n` +
          `Matched:\n  ${hits.join('\n  ')}`,
      );
    }

    expect(hits).toEqual([]);
  });

  it('keeps all three fields non-empty so the estimate PDF has boilerplate to render', () => {
    for (const [name, text] of SEED_COPY) {
      expect(text.trim().length, `${name} is empty`).toBeGreaterThan(0);
    }
  });
});

describe('parseAllowDemoOrg', () => {
  /*
     The override is read from an environment variable, so it arrives as a
     STRING. Every string below except 'true' is truthy in JavaScript, which is
     the trap: a `Boolean(process.env.SEED_ALLOW_DEMO_ORG)` reading of it turns
     SEED_ALLOW_DEMO_ORG=false into permission to overwrite the public demo org.
     Parsing lives in its own exported function purely so this table can pin it.
  */
  it.each([
    ['true', true],
    ['false', false],
    ['0', false],
    ['1', false],
    ['TRUE', false],
    ['yes', false],
    ['', false],
    [' true', false],
    [undefined, false],
  ] as Array<[string | undefined, boolean]>)('%j -> %j', (raw, expected) => {
    expect(parseAllowDemoOrg(raw)).toBe(expected);
  });

  it('never returns a non-boolean, so a caller cannot get a truthy string back', () => {
    for (const raw of ['true', 'false', '0', '', undefined]) {
      expect(typeof parseAllowDemoOrg(raw)).toBe('boolean');
    }
  });
});

/** A client stub narrowed to the two calls the routine is allowed to make. */
function makeClient(org: { id: string; is_demo: boolean } | null) {
  const findUnique = vi.fn().mockResolvedValue(org);
  const update = vi.fn().mockResolvedValue({ id: org?.id });
  const client = { organization: { findUnique, update } };
  return {
    findUnique,
    update,
    client: client as unknown as SeedOrganizationClient,
  };
}

describe('seed-organization guard', () => {
  it('refuses to write to a demo organization', async () => {
    const { client, update } = makeClient({ id: DEFAULT_SEED_ORG_ID, is_demo: true });

    await expect(seedOrganization(client, DEFAULT_SEED_ORG_ID)).rejects.toThrow(/demo/i);

    expect(update).not.toHaveBeenCalled();
  });

  it('writes to a demo organization only when explicitly allowed', async () => {
    // CI seeds a throwaway Postgres, and migration 20260619000000_org_is_demo_flag
    // flips is_demo TRUE on this exact id, so the CI target is a demo org too.
    // The job opts in through SEED_ALLOW_DEMO_ORG; nothing else does.
    const { client, update } = makeClient({ id: DEFAULT_SEED_ORG_ID, is_demo: true });

    await expect(
      seedOrganization(client, DEFAULT_SEED_ORG_ID, { allowDemoOrg: true }),
    ).resolves.toBeUndefined();

    expect(update).toHaveBeenCalledTimes(1);
  });

  it('writes the three estimate fields to a non-demo organization', async () => {
    const { client, update, findUnique } = makeClient({
      id: DEFAULT_SEED_ORG_ID,
      is_demo: false,
    });

    await expect(seedOrganization(client, DEFAULT_SEED_ORG_ID)).resolves.toBeUndefined();

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: DEFAULT_SEED_ORG_ID },
      data: {
        estimate_terms: ESTIMATE_TERMS,
        estimate_notes: ESTIMATE_NOTES,
        estimate_payment_terms: ESTIMATE_PAYMENT_TERMS,
      },
    });
  });

  it('aborts with a readable message when the target organization does not exist', async () => {
    const { client, update } = makeClient(null);

    await expect(seedOrganization(client, DEFAULT_SEED_ORG_ID)).rejects.toThrow(
      /no organization/i,
    );

    expect(update).not.toHaveBeenCalled();
  });
});
