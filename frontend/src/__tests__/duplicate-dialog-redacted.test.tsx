/**
 * #1996 slice 2 — AC5's copy/affordance assertions for the redacted-match branch, across all
 * three duplicate-customer dialogs. The frozen `repro-1996.test.tsx` only pins "does not crash"
 * and "no CTA"; this file pins the exact wording, the R4 negative (no stray "Edit email/phone"
 * button for a field that did not collide), and the kept controls (spec (d), Lead's default).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderWithProviders } from './helpers';

import {
  DuplicateCustomerDialog as LegacyDuplicateCustomerDialog,
  type ExistingCustomer,
} from '@/components/customers/DuplicateCustomerDialog';
import { DuplicateCustomerDialog as V2DuplicateCustomerDialog } from '@/pages/v2/customers/components/duplicateCustomerDialog';
import { PickCustomerFields } from '@/pages/v2/_shared/pickCustomer';

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

const noop = () => {};
const handlers = {
  onOpenExisting: vi.fn(),
  onEditField: vi.fn(),
  onCreateAnyway: vi.fn(),
  onClose: vi.fn(),
};

type Renderer = (existing: ExistingCustomer) => void;

const renderers: Array<{ name: string; render: Renderer }> = [
  {
    name: 'DuplicateCustomerDialog (legacy, frontend/src/components/customers)',
    render: (existing) => {
      render(<LegacyDuplicateCustomerDialog open existing={existing} {...handlers} />);
    },
  },
  {
    name: 'duplicateCustomerDialog.tsx (v2 Customer form)',
    render: (existing) => {
      render(<V2DuplicateCustomerDialog open existing={existing} {...handlers} />);
    },
  },
  {
    name: 'pickCustomer.tsx — PickCustomerFields (v2 Lead form)',
    render: (existing) => {
      renderWithProviders(
        <PickCustomerFields
          fields={{ first_name: '', last_name: '', company_name: '', phone: '', email: '' }}
          onFieldChange={noop}
          selectedCustomer={null}
          onSelectCustomer={noop}
          duplicate={existing}
          onUseExisting={noop}
          onCreateAnyway={noop}
          onEditField={noop}
          onDismissDuplicate={noop}
        />,
      );
    },
  },
];

describe.each(renderers)('#1996 redacted-branch contract — $name', ({ render: renderDialog }) => {
  it('F1: phone-only match reads "…this phone already exists…", no "in your organization"', () => {
    renderDialog({ id: 'c1', matched: { phone: true }, redacted: true });

    expect(
      screen.getByText(/A customer with this phone already exists\. Ask an admin or dispatcher to link it\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/in your organization/i)).not.toBeInTheDocument();
  });

  it('F2: email-only match reads "…this email already exists…"', () => {
    renderDialog({ id: 'c1', matched: { email: true }, redacted: true });

    expect(screen.getByText(/A customer with this email already exists/)).toBeInTheDocument();
  });

  it('F3: both fields collided reads "…this phone or email already exists…"', () => {
    renderDialog({ id: 'c1', matched: { email: true, phone: true }, redacted: true });

    expect(screen.getByText(/A customer with this phone or email already exists/)).toBeInTheDocument();
  });

  it('F4 (R4): { email: false, phone: true } shows only "Edit phone", never "Edit email"', () => {
    renderDialog({ id: 'c1', matched: { email: false, phone: true }, redacted: true });

    expect(screen.queryByRole('button', { name: /edit email/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit phone/i })).toBeInTheDocument();
    expect(screen.getByText(/A customer with this phone already exists/)).toBeInTheDocument();
  });

  it('F5 (R4 mirror): { email: true, phone: false } shows only "Edit email", never "Edit phone"', () => {
    renderDialog({ id: 'c1', matched: { email: true, phone: false }, redacted: true });

    expect(screen.queryByRole('button', { name: /edit phone/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit email/i })).toBeInTheDocument();
    expect(screen.getByText(/A customer with this email already exists/)).toBeInTheDocument();
  });

  it('F6: no record card, no "Open existing customer", render does not throw', () => {
    expect(() =>
      renderDialog({ id: 'c1', matched: { phone: true }, redacted: true }),
    ).not.toThrow();

    expect(screen.queryByRole('button', { name: /open existing customer/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^(Active|Archived)$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/C0\d{4}/)).not.toBeInTheDocument();
    expect(screen.queryByText('Existing Person')).not.toBeInTheDocument();
    expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Fixtureville/)).not.toBeInTheDocument();
  });

  it('F7: "Cancel" and "Create anyway" both stay present', () => {
    renderDialog({ id: 'c1', matched: { phone: true }, redacted: true });

    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create anyway/i })).toBeInTheDocument();
  });

  it('F8: the no-regression control — a full match still renders name, number, phone, Active, CTA', () => {
    renderDialog(FULL_MATCH);

    expect(screen.getByText('Existing Person')).toBeInTheDocument();
    expect(screen.getByText('C00042')).toBeInTheDocument();
    expect(screen.getByText(/\(555\) 199-6000/)).toBeInTheDocument();
    expect(screen.getByText(/^Active$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open existing customer/i })).toBeInTheDocument();
  });

  it('F9 (H18): a redacted match with no `matched` key at all does not crash and falls back to the neutral sentence, no Edit buttons', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const noMatched = { id: 'c1', redacted: true } as any;

    expect(() => renderDialog(noMatched)).not.toThrow();

    expect(
      screen.getByText(/A customer with these details already exists\. Ask an admin or dispatcher to link it\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit email/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit phone/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create anyway/i })).toBeInTheDocument();
  });

  it('F10 (H20): no PII litters the DOM — no img/badge affordance, no undefined/null/NaN/[object Object] artifact', () => {
    renderDialog({ id: 'c1', matched: { phone: true }, redacted: true });

    expect(document.body.querySelectorAll('img, [class*="badge" i]').length).toBe(0);
    expect(document.body.textContent).not.toMatch(/undefined|null|NaN|\[object Object\]/);
  });
});

// H15 — clicking "Create anyway" from a redacted dialog resubmits: the dialog is purely
// presentational (per its own docstring, "parent owns the payload"), so the contract this level
// can pin is that the click fires the callback exactly once; the pending-data resubmit itself is
// the caller's (CustomerForm/LeadForm/JobFormPage) responsibility, exercised elsewhere.
describe('#1996 H15 — "Create anyway" from a redacted dialog fires onCreateAnyway exactly once', () => {
  const REDACTED: ExistingCustomer = { id: 'c1', matched: { phone: true }, redacted: true };

  it('DuplicateCustomerDialog (legacy, frontend/src/components/customers)', () => {
    const onCreateAnyway = vi.fn();
    render(
      <LegacyDuplicateCustomerDialog
        open
        existing={REDACTED}
        onOpenExisting={noop}
        onEditField={noop}
        onCreateAnyway={onCreateAnyway}
        onClose={noop}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create anyway/i }));

    expect(onCreateAnyway).toHaveBeenCalledTimes(1);
  });

  it('duplicateCustomerDialog.tsx (v2 Customer form)', () => {
    const onCreateAnyway = vi.fn();
    render(
      <V2DuplicateCustomerDialog
        open
        existing={REDACTED}
        onOpenExisting={noop}
        onEditField={noop}
        onCreateAnyway={onCreateAnyway}
        onClose={noop}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create anyway/i }));

    expect(onCreateAnyway).toHaveBeenCalledTimes(1);
  });

  it('pickCustomer.tsx — PickCustomerFields (v2 Lead form)', () => {
    const onCreateAnyway = vi.fn();
    renderWithProviders(
      <PickCustomerFields
        fields={{ first_name: '', last_name: '', company_name: '', phone: '', email: '' }}
        onFieldChange={noop}
        selectedCustomer={null}
        onSelectCustomer={noop}
        duplicate={REDACTED}
        onUseExisting={noop}
        onCreateAnyway={onCreateAnyway}
        onEditField={noop}
        onDismissDuplicate={noop}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /create anyway/i }));

    expect(onCreateAnyway).toHaveBeenCalledTimes(1);
  });
});
