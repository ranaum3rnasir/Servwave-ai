/**
 * FormField adoption on the estimate deposit money surfaces - phase 11b/11d.
 *
 * Held to the same rigor as components/patterns/__tests__/FormField.test.tsx,
 * for three separate reasons.
 *
 * 1. THE WIRING IS THE POINT, and half of it did not exist before. The two
 *    RecordEstimatePaymentDialog fields asserted below already typed their id
 *    twice by hand (`<Label htmlFor="rp-amount">` next to `<Input
 *    id="rp-amount">`, two literals that can drift); RefundDepositDialog's
 *    Reason details had NO wiring at all - a bare `<Label>` above an id-less
 *    Textarea, i.e. one of the 316 unwired labels FormField exists to retire.
 *    Every assertion here reads the id off the CONTROL and compares it to the
 *    label's `for`, so it fails if the two ever stop being the same fact.
 *
 * 2. THE CLASS STRINGS ARE ASSERTED BYTE-EXACT, NOT WITH toHaveClass. This is
 *    a structural refactor whose bar is zero unexplained visual diff, and
 *    toHaveClass passes on a superset - it cannot catch a class the pattern
 *    added. `toBe` on the whole attribute can. The control's own class string
 *    is compared against the same primitive rendered bare, which proves
 *    cloneElement injected ids and aria only, never appearance.
 *
 * 3. THE DEFERRALS ARE PINNED TOO. Both SelectField-backed fields (Payment
 *    method, Reason category) stay hand-rolled on purpose: SelectField's props
 *    are a closed list with no id/aria-* passthrough, so FormField's generated
 *    id would be dropped and the label would point at nothing. Asserting that
 *    those labels carry no `for` today keeps the deferral visible - if someone
 *    wires them, that is a SelectField change and this test has to be updated
 *    deliberately rather than drifting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { RecordEstimatePaymentDialog } from '@/components/estimates/RecordEstimatePaymentDialog';
import { RefundDepositDialog } from '@/components/estimates/RefundDepositDialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/** The rendered root of a FormField at the pattern's default gap. */
const FIELD_ROOT_CLASS = 'flex flex-col gap-1.5';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.get).mockImplementation(async (url: string) => {
    if (url === '/api/organization') {
      return {
        data: { deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50 },
      };
    }
    return { data: {} };
  });
});

/** The label element whose text is exactly `text`. */
function labelFor(text: string): HTMLLabelElement {
  return screen.getByText(text) as HTMLLabelElement;
}

/** The class attribute a primitive renders with no props at all. */
function bareClassOf(node: React.ReactElement): string {
  const { container, unmount } = render(node);
  const cls = (container.firstElementChild as HTMLElement).getAttribute('class');
  unmount();
  return cls ?? '';
}

describe('RecordEstimatePaymentDialog - FormField adoption', () => {
  const renderDialog = () =>
    renderWithProviders(
      <RecordEstimatePaymentDialog
        open
        onOpenChange={() => {}}
        estimateId="est-1"
        estimateNumber="C00002-1"
        totalAmount={1000}
      />,
    );

  it.each([
    ['Deposit %', 'rp-pct'],
    ['Deposit amount *', 'rp-amount'],
    ['Date received *', 'rp-date'],
    ['Reference number', 'rp-ref'],
    ['Notes', 'rp-notes'],
  ])('wires %s to its control under the id the call site already used (%s)', async (text, id) => {
    renderDialog();

    const control = await screen.findByLabelText(text);
    const label = labelFor(text);

    expect(control).toHaveAttribute('id', id);
    expect(label.getAttribute('for')).toBe(control.id);
  });

  it('renders each converted field root as exactly the default-gap Stack, no extra class', async () => {
    renderDialog();
    await screen.findByLabelText('Deposit %');

    for (const text of ['Deposit %', 'Deposit amount *', 'Date received *', 'Reference number', 'Notes']) {
      expect(labelFor(text).parentElement?.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
    }
  });

  it('adds ids and aria only - the control keeps the exact class string it renders bare', async () => {
    renderDialog();

    const amount = await screen.findByLabelText('Deposit amount *');
    const notes = await screen.findByLabelText('Notes');

    expect(amount.getAttribute('class')).toBe(bareClassOf(<Input type="number" />));
    expect(notes.getAttribute('class')).toBe(bareClassOf(<Textarea rows={2} />));
  });

  it('renders the deposit hint with the same two appearance tokens the raw paragraph carried, wired via aria-describedby', async () => {
    renderDialog();

    const amount = await screen.findByLabelText('Deposit amount *');
    const hint = screen.getByText('Total estimate: $1,000.00');

    // Was `<p className="text-xs text-text-secondary mt-1">`; the mt-1 seam is
    // now the field root's own gap, the two appearance tokens are unchanged.
    expect(hint.tagName).toBe('P');
    expect(hint.getAttribute('class')).toBe('text-xs text-text-secondary');
    expect(hint).toHaveAttribute('id', 'rp-amount-hint');
    expect(amount).toHaveAttribute('aria-describedby', 'rp-amount-hint');
    expect(amount).not.toHaveAttribute('aria-invalid');
  });

  it('leaves a field with no hint and no error free of aria-describedby', async () => {
    renderDialog();

    expect(await screen.findByLabelText('Reference number')).not.toHaveAttribute('aria-describedby');
  });

  it('deliberately leaves the SelectField-backed Payment method field hand-rolled and unwired', async () => {
    renderDialog();
    await screen.findByLabelText('Deposit %');

    const label = labelFor('Payment method *');
    expect(label).not.toHaveAttribute('for');
    expect(label).toHaveAttribute('id', 'rp-method-label');
  });
});

describe('RefundDepositDialog - FormField adoption', () => {
  const renderDialog = () =>
    renderWithProviders(
      <RefundDepositDialog
        open
        onOpenChange={() => {}}
        estimateId="est-1"
        depositInvoiceId="inv-dep-1"
        depositAmount={500}
        hasStripePayment
      />,
    );

  it('wires Reason details to the Textarea with a generated id - the label had no htmlFor at all before', async () => {
    renderDialog();

    const textarea = await screen.findByLabelText('Reason details *');
    const label = labelFor('Reason details *');

    expect(textarea.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(textarea.id);
    expect(label.parentElement?.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
    expect(textarea.getAttribute('class')).toBe(bareClassOf(<Textarea rows={3} />));
    expect(textarea).not.toHaveAttribute('aria-describedby');
  });

  it('deliberately leaves the SelectField-backed Reason category field hand-rolled and unwired', async () => {
    renderDialog();
    await screen.findByLabelText('Reason details *');

    expect(labelFor('Reason category *')).not.toHaveAttribute('for');
  });

  it('keeps the submit test ids the dialog is driven by', async () => {
    renderDialog();

    expect(await screen.findByTestId('refund-deposit-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('refund-deposit-submit')).toBeInTheDocument();
  });
});
