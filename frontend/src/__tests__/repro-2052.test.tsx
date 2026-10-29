/**
 * repro-2052 — the Scope of Work "Taxable" pill on an EDITABLE estimate renders as a `<button>`
 * (already interactive per onUpdate) but carries no `role="switch"` / `aria-checked`, so nothing
 * announces it as a toggle to assistive tech and (per Ran's decision on #2052) it must look and
 * behave like one: `role="switch"`, `aria-checked`, keyboard Space/Enter, visible ON/OFF.
 *
 * Reuses the render/mock pattern of `frontend/src/__tests__/scope-of-work-card.test.tsx`
 * (direct render of the presentational `ScopeOfWorkCard` with mocked callback props — no
 * fetching/mutation lives in this component, the parent's `onUpdate` IS the PATCH
 * `is_taxable` write path per `frontend/src/lib/api/estimates.ts` `updateEstimateScope`).
 *
 * Frozen per bfd-reproduce Pass B — do not edit after the `frozen` push.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScopeOfWorkCard } from '@/components/jobs/items/ScopeOfWorkCard';
import type { Scope } from '@/lib/api/jobs';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

const SCOPE_A: Scope = {
  id: 'scope-1',
  title: 'Demo & haul-away',
  body: 'Remove old unit and dispose responsibly.',
  flat_price: 250,
  is_taxable: true,
  internal_cost: 100,
};

function baseProps() {
  return {
    canEdit: true,
    canSeePricing: true,
    onAdd: vi.fn(),
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onReorder: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('repro-2052 — Taxable pill on an editable (unlocked) estimate scope block', () => {
  it('exposes role="switch" with aria-checked reflecting is_taxable, and Space/Enter/click all toggle it (the estimate write path)', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} locked={false} />);

    const block = within(screen.getAllByTestId('scope-block')[0]!);

    // This is the reported defect: today the Taxable control renders as a plain <button> with
    // no role="switch"/aria-checked, so it is announced as a generic button, not a toggle.
    const toggle = block.getByRole('switch', { name: /taxable for scope 1/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Click still drives the same onUpdate call that PATCHes is_taxable
    // (EstimateLineItemsEditor's updateMutation -> updateEstimateScope -> PATCH
    // /api/estimates/:id/scopes/:idx -> recomputeAndPersist).
    await userEvent.click(toggle);
    expect(props.onUpdate).toHaveBeenCalledWith(0, { is_taxable: false });

    // Keyboard: a switch must be operable with Space and Enter, not just a mouse click.
    props.onUpdate.mockClear();
    toggle.focus();
    await userEvent.keyboard(' ');
    expect(props.onUpdate).toHaveBeenCalledWith(0, { is_taxable: false });

    props.onUpdate.mockClear();
    await userEvent.keyboard('{Enter}');
    expect(props.onUpdate).toHaveBeenCalledWith(0, { is_taxable: false });
  });

  it('reflects aria-checked=false and visible "Taxable: No" once toggled off', () => {
    const offScope: Scope = { ...SCOPE_A, is_taxable: false };
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[offScope]} {...props} locked={false} />);

    const block = within(screen.getAllByTestId('scope-block')[0]!);
    const toggle = block.getByRole('switch', { name: /taxable for scope 1/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(block.getByText('Taxable: No')).toBeInTheDocument();
  });

  it('REGRESSION GUARD (already green today): on a locked estimate there is no switch role in the block, only the static read-only badge', () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} canEdit locked />);

    const block = within(screen.getAllByTestId('scope-block')[0]!);
    expect(block.queryByRole('switch')).not.toBeInTheDocument();
    expect(block.getByText('Taxable: Yes')).toBeInTheDocument();
  });
});
