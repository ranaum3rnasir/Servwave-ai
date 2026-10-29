import { describe, it, expect } from 'vitest';
import { generateEstimatePdf, generateStatementPdf } from '../index';
import { PREVIEW_ESTIMATE_FIXTURE } from '../preview-fixture';

const FIXTURE_ORG = {
  name: 'Alpha Doors & Security INC.',
  address_line1: '1001 Willow Avenue',
  address_line2: null,
  city: 'Hoboken',
  state: 'NJ',
  postal_code: '07030',
  email: 'info@alphasecurityus.com',
  phone: null,
  website: 'https://alphadoorsnewjersey.com/',
  logo_url: null,
  brand_color: '#E11D2E',
  estimate_terms: 'Sample terms.',
  estimate_notes: '- Note A\n- Note B',
  estimate_payment_terms: '- 70% on acceptance',
};

describe('generateEstimatePdf', () => {
  it('returns a Buffer starting with %PDF', async () => {
    const buffer = await generateEstimatePdf(PREVIEW_ESTIMATE_FIXTURE, FIXTURE_ORG);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(100);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('throws an error for an invalid template key', async () => {
    await expect(
      generateEstimatePdf(PREVIEW_ESTIMATE_FIXTURE, FIXTURE_ORG, 'invalid-template' as any),
    ).rejects.toThrow('Unknown template key: invalid-template');
  });

  it('renders without the logo when the logo host is not allowlisted (never throws)', async () => {
    // Repro of the prod outage: after a DB clone, organizations.logo_url points at a
    // foreign Supabase project, so the SSRF host allowlist (F-16) rejects the fetch.
    // A bad/unreachable logo must degrade to a logo-less PDF, never fail the whole doc.
    const orgWithForeignLogo = { ...FIXTURE_ORG, logo_url: 'https://not-our-project.example.com/logo.jpg' };
    const buffer = await generateEstimatePdf(PREVIEW_ESTIMATE_FIXTURE, orgWithForeignLogo);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('generateStatementPdf', () => {
  const STATEMENT_FIXTURE = {
    scope: 'customer' as const,
    title: 'Account Statement',
    party: { name: 'Jane Doe', email: 'jane.doe@example.com' },
    lines: [],
    totals: { billed: 0, paid: 0, refunded: 0, credited: 0, balance: 0 },
  };

  it('renders without the logo when the logo host is not allowlisted (never throws)', async () => {
    const org = { name: 'Test Org', logo_url: 'https://not-our-project.example.com/logo.jpg' };
    const buffer = await generateStatementPdf(STATEMENT_FIXTURE, org);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
