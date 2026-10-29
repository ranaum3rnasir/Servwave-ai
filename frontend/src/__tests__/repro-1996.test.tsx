/**
 * #1996 — the duplicate-customer 409 leaks the full matched record to a requester who cannot
 * read that customer row. Frontend half: all three duplicate-customer dialogs render
 * `existing` verbatim (grep -rn redacted across the three files returns nothing — Pass A,
 * reproduce-a.md) — none has a branch for a redacted match.
 *
 * Given the backend's desired redacted 409 body (`{ id, matched, redacted: true }`, no
 * name/company/email/phone/address/customer_number/status keys — repro-1996.test.ts), each
 * dialog must render a NEUTRAL message with NO record card (no name, no Active/Archived
 * badge, no customer_number) and NO "Open existing customer" affordance — that button implies
 * a real, navigable record, which a redacted match is not (the requester cannot read it).
 *
 * Three call sites (Pass A, reproduce-a.md):
 *   1. frontend/src/components/customers/DuplicateCustomerDialog.tsx — the v1-style shared
 *      dialog, rendered by PickOrCreateCustomer (the routed v2 Job form's picker).
 *   2. frontend/src/pages/v2/customers/components/duplicateCustomerDialog.tsx — the v2
 *      Customer form's own copy (routed at /customers/new).
 *   3. frontend/src/pages/v2/_shared/pickCustomer.tsx — a third copy, used by the v2 Lead form
 *      (routed at /leads/new). Its own `DuplicateCustomerDialog` is NOT exported, so this site
 *      is exercised through the exported `PickCustomerFields`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';

import { DuplicateCustomerDialog as LegacyDuplicateCustomerDialog } from '@/components/customers/DuplicateCustomerDialog';
import { DuplicateCustomerDialog as V2DuplicateCustomerDialog } from '@/pages/v2/customers/components/duplicateCustomerDialog';
import { PickCustomerFields } from '@/pages/v2/_shared/pickCustomer';
import type { ExistingCustomer } from '@/components/customers/DuplicateCustomerDialog';

// Full, unredacted match — today's behaviour, must stay unchanged (green control).
const FULL_MATCH: ExistingCustomer = {
  id: 'c0000000-0000-0000-0000-0000000000ee',
  customer_number: 'C00042',
  first_name: 'Existing',
  last_name: 'Person',
  company_name: null,
  email: 'qa-1996-existing@example.com',
  phone: '5551996000',
  is_active: true,
  archived_at: null,
  primary_address: { line1: '1996 Fixture Ave', city: 'Fixtureville', state: 'CA' },
  matched: { email: null, phone: '5551996000' },
};

// Redacted match — the shape the backend fix is expected to send when the requester cannot
// read the matched row. Deliberately carries NO name/company/email/phone/address/
// customer_number/status keys — only `id`, a signal of which field(s) collided, and the flag.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REDACTED_MATCH: any = {
  id: 'c0000000-0000-0000-0000-0000000000ee',
  matched: { phone: true },
  redacted: true,
};

const noop = () => {};
const legacyHandlers = {
  onOpenExisting: vi.fn(),
  onEditField: vi.fn(),
  onCreateAnyway: vi.fn(),
  onClose: vi.fn(),
};

// ─── 1. Legacy shared dialog (JobFormPage's picker) ─────────────────────────────────────────
describe('#1996 (1) DuplicateCustomerDialog (frontend/src/components/customers) — routed by the v2 Job form', () => {
  it('green control: a full match renders the name, phone and an "Open existing customer" CTA', () => {
    render(<LegacyDuplicateCustomerDialog open existing={FULL_MATCH} {...legacyHandlers} />);

    expect(screen.getByText('Existing Person')).toBeInTheDocument();
    expect(screen.getByText('C00042')).toBeInTheDocument();
    expect(screen.getByText(/\(555\) 199-6000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open existing customer/i })).toBeInTheDocument();
    expect(screen.getByText(/^Active$/)).toBeInTheDocument();
  });

  it('RED — a redacted match crashes (matched.phone is a boolean signal, not a value — today formatPhone() gets fed a boolean because there is no redacted branch) or, once it renders, still offers "Open existing customer" and an Active/Archived record card; desired: a neutral message, no record card, no CTA, no crash', () => {
    // Today: neither dialog nor its callers check `existing.redacted` before treating `matched`
    // as real field values, so this throws before ever reaching the CTA/badge assertions below.
    expect(() =>
      render(<LegacyDuplicateCustomerDialog open existing={REDACTED_MATCH} {...legacyHandlers} />),
    ).not.toThrow();

    // No PII ever leaks through the redacted fixture itself (it carries none) — the real
    // defect is the surrounding chrome implying a real, navigable record exists.
    expect(screen.queryByRole('button', { name: /open existing customer/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Active|Archived)$/)).not.toBeInTheDocument();
  });
});

// ─── 2. v2 Customer form's own copy ─────────────────────────────────────────────────────────
describe('#1996 (2) duplicateCustomerDialog.tsx (v2 Customer form, /customers/new)', () => {
  it('green control: a full match renders the name, phone and an "Open existing customer" CTA', () => {
    render(<V2DuplicateCustomerDialog open existing={FULL_MATCH} {...legacyHandlers} />);

    expect(screen.getByText('Existing Person')).toBeInTheDocument();
    expect(screen.getByText('C00042')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open existing customer/i })).toBeInTheDocument();
    expect(screen.getByText(/^Active$/)).toBeInTheDocument();
  });

  it('RED — a redacted match crashes today (same missing-branch defect as site 1); desired: a neutral message, no record card, no CTA, no crash', () => {
    expect(() =>
      render(<V2DuplicateCustomerDialog open existing={REDACTED_MATCH} {...legacyHandlers} />),
    ).not.toThrow();

    expect(screen.queryByRole('button', { name: /open existing customer/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Active|Archived)$/)).not.toBeInTheDocument();
  });
});

// ─── 3. v2 Lead form's picker (its DuplicateCustomerDialog is private, so drive PickCustomerFields) ──
describe('#1996 (3) pickCustomer.tsx — PickCustomerFields (v2 Lead form, /leads/new)', () => {
  const fields = { first_name: '', last_name: '', company_name: '', phone: '', email: '' };

  it('green control: a full match renders the name, phone and an "Open existing customer" CTA', () => {
    renderWithProviders(
      <PickCustomerFields
        fields={fields}
        onFieldChange={noop}
        selectedCustomer={null}
        onSelectCustomer={noop}
        duplicate={FULL_MATCH}
        onUseExisting={noop}
        onCreateAnyway={noop}
        onEditField={noop}
        onDismissDuplicate={noop}
      />,
    );

    expect(screen.getByText('Existing Person')).toBeInTheDocument();
    expect(screen.getByText('C00042')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open existing customer/i })).toBeInTheDocument();
    expect(screen.getByText(/^Active$/)).toBeInTheDocument();
  });

  it('RED — a redacted match crashes today (same missing-branch defect as sites 1/2); desired: a neutral message, no record card, no CTA, no crash', () => {
    expect(() =>
      renderWithProviders(
        <PickCustomerFields
          fields={fields}
          onFieldChange={noop}
          selectedCustomer={null}
          onSelectCustomer={noop}
          duplicate={REDACTED_MATCH}
          onUseExisting={noop}
          onCreateAnyway={noop}
          onEditField={noop}
          onDismissDuplicate={noop}
        />,
      ),
    ).not.toThrow();

    expect(screen.queryByRole('button', { name: /open existing customer/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Active|Archived)$/)).not.toBeInTheDocument();
  });
});
