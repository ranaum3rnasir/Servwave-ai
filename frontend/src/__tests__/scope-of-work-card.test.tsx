/**
 * ScopeOfWorkCard — shared multi-block Scope of Work card (Batch 3).
 * Pure presentational component (no fetching/mutation) — tests exercise it directly with
 * mocked callback props, mirroring how LineItemsTable's row-level behaviors would be tested
 * in isolation (no jobId/invoiceId wiring involved at this layer).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScopeOfWorkCard } from '@/components/jobs/items/ScopeOfWorkCard';
import type { Scope } from '@/lib/api/jobs';

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));
import { toast } from '@/components/ui/use-toast';

const SCOPE_A: Scope = {
  id: 'scope-1',
  title: 'Demo & haul-away',
  body: 'Remove old unit and dispose responsibly.',
  flat_price: 250,
  is_taxable: true,
  internal_cost: 100,
};

const SCOPE_B: Scope = {
  id: 'scope-2',
  title: 'Permit filing',
  body: '',
  flat_price: null,
  is_taxable: false,
  internal_cost: null,
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

describe('ScopeOfWorkCard — empty state', () => {
  it('always renders the SectionCard header band (title + count badge) with the "+ Add scope of work" CTA in it, even with no blocks', () => {
    render(<ScopeOfWorkCard scopes={[]} {...baseProps()} />);

    // v12 SECTION 01 never shows a naked full-width button with no chrome around it — the
    // header band (title + "(0)" count) must render even when there are zero blocks.
    expect(screen.getByText('Scope of Work')).toBeInTheDocument();
    expect(screen.getByText('(0)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add scope of work/i })).toBeInTheDocument();
    // Only the body (block list) is omitted — there is nothing to list.
    expect(screen.queryAllByTestId('scope-block')).toHaveLength(0);
  });

  it('still renders the header band with no Add button when canEdit is false and there are no blocks', () => {
    render(<ScopeOfWorkCard scopes={[]} {...baseProps()} canEdit={false} />);

    // Chrome always renders...
    expect(screen.getByText('Scope of Work')).toBeInTheDocument();
    expect(screen.getByText('(0)')).toBeInTheDocument();
    // ...but the add affordance is gated on canAddDelete (defaults to canEdit).
    expect(screen.queryByRole('button', { name: /add scope of work/i })).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('scope-block')).toHaveLength(0);
  });
});

describe('ScopeOfWorkCard — rendering blocks', () => {
  it('shows the header title with a count badge and one block per scope', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A, SCOPE_B]} {...baseProps()} />);

    expect(screen.getByText('Scope of Work')).toBeInTheDocument();
    expect(screen.getByText('(2)')).toBeInTheDocument();
    expect(screen.getAllByTestId('scope-block')).toHaveLength(2);
    expect(screen.getByDisplayValue('Demo & haul-away')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Permit filing')).toBeInTheDocument();
  });

  it('renders read-only text (no inputs, no trash, no add button) when canEdit is false', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} canEdit={false} />);

    expect(screen.getByText('Demo & haul-away')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add scope of work/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete scope 1/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/title for scope 1/i)).not.toBeInTheDocument();
  });

  it('treats locked=true as inert even when canEdit is true', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} locked />);

    expect(screen.queryByRole('button', { name: /add scope of work/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete scope 1/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/title for scope 1/i)).not.toBeInTheDocument();
  });
});

describe('ScopeOfWorkCard — add a block', () => {
  it('opens an inline add form and calls onAdd with the entered title/body', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));

    const form = within(screen.getByTestId('scope-add-form'));
    await userEvent.type(form.getByLabelText(/new scope title/i), 'Rough-in inspection');
    await userEvent.type(form.getByLabelText(/new scope description/i), 'Coordinate with city inspector.');
    await userEvent.click(form.getByRole('button', { name: /^add$/i }));

    // `is_taxable` rides along from the Taxable pill, which defaults to Yes (matching the
    // backend's own default). No `flat_price` key when the price field is left blank — that
    // stays a legitimate "not priced yet" block rather than being pinned to 0.
    expect(props.onAdd).toHaveBeenCalledWith({
      title: 'Rough-in inspection',
      body: 'Coordinate with city inspector.',
      is_taxable: true,
    });
    expect(screen.queryByTestId('scope-add-form')).not.toBeInTheDocument();
  });

  it('sends the flat price and a toggled-off Taxable in the SAME onAdd call', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));
    await userEvent.type(form.getByLabelText(/new scope title/i), 'Demo & haul-away');
    await userEvent.type(form.getByLabelText(/new scope flat price/i), '450.50');
    await userEvent.click(form.getByRole('switch', { name: /taxable for new scope/i }));
    await userEvent.click(form.getByRole('button', { name: /^add$/i }));

    // One call, fully priced — the whole point of collecting these at create time rather than
    // making the user save the block and then edit its footer.
    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onAdd).toHaveBeenCalledWith({
      title: 'Demo & haul-away',
      body: '',
      is_taxable: false,
      flat_price: 450.5,
    });
  });

  it('blocks Add on a negative price and explains why, instead of silently dropping it', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));
    await userEvent.type(form.getByLabelText(/new scope title/i), 'Demo');
    await userEvent.type(form.getByLabelText(/new scope flat price/i), '-5');

    expect(form.getByText(/flat price must be a non-negative number/i)).toBeInTheDocument();
    expect(form.getByRole('button', { name: /^add$/i })).toBeDisabled();
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it('offers the price field even when canSeePricing is false (it gates COST, not sell price)', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[]} {...props} canSeePricing={false} />);

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));

    // canSeePricing is `read Pricing`, the org's "See financial data" switch, deliberately
    // decoupled from record capability. Gating a customer-facing SELL price on it would stop a
    // dispatcher with that switch off from pricing a scope — and the saved block's own footer
    // price input has never been gated on it either.
    expect(form.getByLabelText(/new scope flat price/i)).toBeInTheDocument();
  });

  it('does not call onAdd when the title is left blank', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));
    expect(form.getByRole('button', { name: /^add$/i })).toBeDisabled();
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it('closes the add form on Cancel without calling onAdd', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByTestId('scope-add-form')).not.toBeInTheDocument();
    expect(props.onAdd).not.toHaveBeenCalled();
  });
});

describe('ScopeOfWorkCard — edit a block', () => {
  it('commits a title change through onUpdate on blur', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} />);

    const titleInput = screen.getByLabelText(/title for scope 1/i);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, 'Demo & disposal');
    await userEvent.tab();

    expect(props.onUpdate).toHaveBeenCalledWith(0, { title: 'Demo & disposal' });
  });

  it('does not call onUpdate when the title is unchanged', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} />);

    const titleInput = screen.getByLabelText(/title for scope 1/i);
    await userEvent.click(titleInput);
    await userEvent.tab();

    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it('commits a body/description change through onUpdate on blur', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} />);

    const bodyInput = screen.getByLabelText(/description for scope 1/i);
    await userEvent.clear(bodyInput);
    await userEvent.type(bodyInput, 'Updated notes.');
    await userEvent.tab();

    expect(props.onUpdate).toHaveBeenCalledWith(0, { body: 'Updated notes.' });
  });
});

describe('ScopeOfWorkCard — taxable pill', () => {
  it('toggles is_taxable through onUpdate when interactive', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} />);

    await userEvent.click(screen.getByRole('switch', { name: /taxable for scope 1/i }));

    expect(props.onUpdate).toHaveBeenCalledWith(0, { is_taxable: false });
  });

  it('renders a static Yes/No pill (no button) when read-only', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A, SCOPE_B]} {...baseProps()} canEdit={false} />);

    expect(screen.getByText('Taxable: Yes')).toBeInTheDocument();
    expect(screen.getByText('Taxable: No')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /taxable for scope/i })).not.toBeInTheDocument();
  });

  it('editable ON: renders a checked switch with visible "Taxable: Yes" text', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} />);

    const toggle = screen.getByRole('switch', { name: /taxable for scope 1/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAttribute('data-state', 'checked');
    expect(screen.getByText('Taxable: Yes')).toBeInTheDocument();
  });

  it('editable OFF: renders an unchecked switch with visible "Taxable: No" text', () => {
    const offScope: Scope = { ...SCOPE_A, is_taxable: false };
    render(<ScopeOfWorkCard scopes={[offScope]} {...baseProps()} />);

    const toggle = screen.getByRole('switch', { name: /taxable for scope 1/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toHaveAttribute('data-state', 'unchecked');
    expect(screen.getByText('Taxable: No')).toBeInTheDocument();
  });

  it('locked/read-only: renders the static badge span, no switch role, no click handler', async () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} canEdit locked />);

    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    const badge = screen.getByText('Taxable: Yes');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).not.toHaveAttribute('onclick');
  });

  it('add form: toggling the switch feeds is_taxable: false into the single onAdd payload', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));
    const toggle = form.getByRole('switch', { name: /taxable for new scope/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    await userEvent.type(form.getByLabelText(/new scope title/i), 'Replace flue');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(form.getByRole('button', { name: /^add$/i }));

    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Replace flue', is_taxable: false }),
    );
  });
});

describe('ScopeOfWorkCard — flat-price affordance (PRD EC-4: null vs 0)', () => {
  it('shows the dashed "+ Flat price" affordance when flat_price is null', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_B]} {...baseProps()} />);

    expect(screen.getByRole('button', { name: /flat price/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/flat price for scope 1/i)).not.toBeInTheDocument();
  });

  it('reveals an editable input after clicking the affordance and commits on blur', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_B]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /flat price/i }));
    const priceInput = screen.getByLabelText(/flat price for scope 1/i);
    await userEvent.type(priceInput, '175');
    await userEvent.tab();

    expect(props.onUpdate).toHaveBeenCalledWith(0, { flat_price: 175 });
  });

  it('renders flat_price=0 as an editable price input, NOT the "+ Flat price" affordance', () => {
    const zeroPriced: Scope = { ...SCOPE_A, flat_price: 0 };
    render(<ScopeOfWorkCard scopes={[zeroPriced]} {...baseProps()} />);

    expect(screen.getByLabelText(/flat price for scope 1/i)).toHaveValue(0);
    expect(screen.queryByRole('button', { name: /flat price/i })).not.toBeInTheDocument();
  });

  it('shows a read-only formatted price when not interactive', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} canEdit={false} />);

    expect(screen.getByText('$250.00')).toBeInTheDocument();
  });
});

describe('ScopeOfWorkCard — internal_cost gating', () => {
  it('hides internal_cost when canSeePricing is false, even though flat_price is set', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} canSeePricing={false} />);

    expect(screen.queryByLabelText(/internal cost for scope 1/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/internal cost/i)).not.toBeInTheDocument();
  });

  it('hides internal_cost when flat_price is null even though canSeePricing is true (PRD EC-20)', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_B]} {...baseProps()} canSeePricing />);

    expect(screen.queryByLabelText(/internal cost for scope 1/i)).not.toBeInTheDocument();
  });

  it('shows an editable internal_cost input when canSeePricing is true and flat_price is set', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} canSeePricing />);

    const costInput = screen.getByLabelText(/internal cost for scope 1/i);
    expect(costInput).toHaveValue(100);
    await userEvent.clear(costInput);
    await userEvent.type(costInput, '120');
    await userEvent.tab();

    expect(props.onUpdate).toHaveBeenCalledWith(0, { internal_cost: 120 });
  });
});

describe('ScopeOfWorkCard — delete with Undo', () => {
  it('deletes immediately with no confirm dialog', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /delete scope 1/i }));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(props.onDelete).toHaveBeenCalledWith(0);
  });

  it('shows an Undo toast whose action re-creates the block via onAdd', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} canSeePricing />);

    await userEvent.click(screen.getByRole('button', { name: /delete scope 1/i }));

    expect(toast).toHaveBeenCalledTimes(1);
    const toastArg = vi.mocked(toast).mock.calls[0][0] as {
      title: string;
      action: { props: { onClick: () => void } };
    };
    expect(toastArg.title).toMatch(/removed/i);

    toastArg.action.props.onClick();

    expect(props.onAdd).toHaveBeenCalledWith({
      title: 'Demo & haul-away',
      body: 'Remove old unit and dispose responsibly.',
      flat_price: 250,
      is_taxable: true,
      internal_cost: 100,
    });
  });

  it('omits internal_cost from the Undo restore payload when canSeePricing is false', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} canSeePricing={false} />);

    await userEvent.click(screen.getByRole('button', { name: /delete scope 1/i }));

    const toastArg = vi.mocked(toast).mock.calls[0][0] as { action: { props: { onClick: () => void } } };
    toastArg.action.props.onClick();

    expect(props.onAdd).toHaveBeenCalledWith({
      title: 'Demo & haul-away',
      body: 'Remove old unit and dispose responsibly.',
      flat_price: 250,
      is_taxable: true,
    });
  });
});

describe('ScopeOfWorkCard — move up/down reorder', () => {
  it('does not render move buttons when there is only one block', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} />);

    expect(screen.queryByRole('button', { name: /move scope 1/i })).not.toBeInTheDocument();
  });

  it('calls onReorder with the full swapped array when Move down is clicked', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A, SCOPE_B]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /move scope 1 down/i }));

    expect(props.onReorder).toHaveBeenCalledWith([SCOPE_B, SCOPE_A]);
  });

  it('calls onReorder with the full swapped array when Move up is clicked', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A, SCOPE_B]} {...props} />);

    await userEvent.click(screen.getByRole('button', { name: /move scope 2 up/i }));

    expect(props.onReorder).toHaveBeenCalledWith([SCOPE_B, SCOPE_A]);
  });

  it('disables Move up on the first block and Move down on the last block', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A, SCOPE_B]} {...baseProps()} />);

    expect(screen.getByRole('button', { name: /move scope 1 up/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /move scope 2 down/i })).toBeDisabled();
  });
});

describe('ScopeOfWorkCard — split canEdit (update) vs canAddDelete (manage_lines)', () => {
  it('shows Add + Delete but hides inline edit/reorder when canAddDelete is true and canEdit is false', () => {
    render(
      <ScopeOfWorkCard scopes={[SCOPE_A, SCOPE_B]} {...baseProps()} canEdit={false} canAddDelete />,
    );

    expect(screen.getByRole('button', { name: /add scope of work/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete scope 1/i })).toBeInTheDocument();

    expect(screen.queryByLabelText(/title for scope 1/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/description for scope 1/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /taxable for scope 1/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /move scope 1 down/i })).not.toBeInTheDocument();
  });

  it('shows inline edit/reorder but hides Add + Delete when canEdit is true and canAddDelete is false', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A, SCOPE_B]} {...baseProps()} canAddDelete={false} />);

    expect(screen.queryByRole('button', { name: /add scope of work/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete scope 1/i })).not.toBeInTheDocument();

    expect(screen.getByLabelText(/title for scope 1/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /move scope 1 down/i })).toBeInTheDocument();
  });

  it('locked=true still suppresses Add/Delete even when canAddDelete is true', () => {
    render(
      <ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} canEdit={false} canAddDelete locked />,
    );

    expect(screen.queryByRole('button', { name: /add scope of work/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete scope 1/i })).not.toBeInTheDocument();
  });
});

describe('ScopeOfWorkCard — busy disables controls', () => {
  it('disables the delete button and taxable pill while busy', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} busy />);

    expect(screen.getByRole('button', { name: /delete scope 1/i })).toBeDisabled();
    expect(screen.getByRole('switch', { name: /taxable for scope 1/i })).toBeDisabled();
  });

  it('disables the add button while busy', () => {
    render(<ScopeOfWorkCard scopes={[]} {...baseProps()} busy />);

    // Add button itself isn't disabled (it only opens the form) — but the form's Save is.
    expect(screen.getByRole('button', { name: /add scope of work/i })).not.toBeDisabled();
  });
});

/**
 * canSeeSellPrice is the Job-only axis: job-lines.controller.ts strips flat_price from the
 * response AND drops it from the write body for a requester without `read Pricing`, so every
 * price affordance there is either lying about a value it wasn't sent or offering a write the
 * server discards. Estimate and Invoice never pass the prop — the default keeps them unchanged.
 */
describe('ScopeOfWorkCard — canSeeSellPrice (sell price withheld by the surface)', () => {
  // The scope the server actually hands a price-blind Job requester: flat_price stripped, so the
  // key is absent rather than null. Cast because Scope types it as required.
  const SCOPE_STRIPPED = { id: 'scope-3', title: 'Replace flue', body: '', is_taxable: true } as unknown as Scope;

  it('renders no price affordance at all on a saved block — not the input, the "+ Flat price" CTA, or the "No flat price" text', () => {
    render(<ScopeOfWorkCard scopes={[SCOPE_STRIPPED]} {...baseProps()} canSeeSellPrice={false} />);

    expect(screen.getByLabelText(/title for scope 1/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/flat price for scope 1/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /flat price/i })).not.toBeInTheDocument();
    // "No flat price" would be an assertion about a block that may well be priced.
    expect(screen.queryByText(/no flat price/i)).not.toBeInTheDocument();
    // Taxable is not money and stays.
    expect(screen.getByRole('switch', { name: /taxable for scope 1/i })).toBeInTheDocument();
  });

  it('hides the read-only formatted price too, not just the editable input', () => {
    render(
      <ScopeOfWorkCard scopes={[SCOPE_A]} {...baseProps()} canEdit={false} canSeeSellPrice={false} />,
    );

    expect(screen.getByText('Demo & haul-away')).toBeInTheDocument();
    expect(screen.queryByText('$250.00')).not.toBeInTheDocument();
  });

  it('omits the price field from the add form but keeps Taxable, and posts no flat_price', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[]} {...props} canSeeSellPrice={false} />);

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));

    expect(form.queryByLabelText(/new scope flat price/i)).not.toBeInTheDocument();
    expect(form.getByRole('switch', { name: /taxable for new scope/i })).toBeInTheDocument();

    await userEvent.type(form.getByLabelText(/new scope title/i), 'Replace flue');
    await userEvent.click(form.getByRole('button', { name: /^add$/i }));

    // No flat_price key at all — not `flat_price: null`, which would read as a deliberate unprice.
    expect(props.onAdd).toHaveBeenCalledTimes(1);
    expect(props.onAdd).toHaveBeenCalledWith({ title: 'Replace flue', body: '', is_taxable: true });
  });

  it('omits flat_price from the Undo restore payload, so a re-created block carries no price claim', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_STRIPPED]} {...props} canSeeSellPrice={false} />);

    await userEvent.click(screen.getByRole('button', { name: /delete scope 1/i }));
    const toastArg = vi.mocked(toast).mock.calls[0][0] as { action: { props: { onClick: () => void } } };
    toastArg.action.props.onClick();

    expect(props.onAdd).toHaveBeenCalledWith({ title: 'Replace flue', body: '', is_taxable: true });
  });

  it('defaults to true when the prop is omitted, leaving Estimate/Invoice untouched', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} />);

    // The regression guard for the two surfaces that never pass the prop: their price stays
    // editable for everyone, which is the whole point of the per-surface split.
    expect(screen.getByLabelText(/flat price for scope 1/i)).toHaveValue(250);
  });
});

// #2053 slice 1 — showOptionalToggle (default false, R6's shared prop name).
describe('ScopeOfWorkCard — showOptionalToggle (#2053)', () => {
  it('no Optional switch renders anywhere, and onAdd never carries the keys, when the prop is omitted (Job/Invoice)', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} />);

    expect(screen.queryByRole('switch', { name: /optional for scope 1/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));
    expect(form.queryByRole('switch', { name: /optional for new scope/i })).not.toBeInTheDocument();

    await userEvent.type(form.getByLabelText(/new scope title/i), 'Extra crew');
    await userEvent.click(form.getByRole('button', { name: /^add$/i }));
    expect(props.onAdd).toHaveBeenCalledWith({ title: 'Extra crew', body: '', is_taxable: true });
  });

  it('the add form shows a single Optional switch, and turning it on sends is_optional:true, is_selected:false — no Selected switch anywhere', async () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[]} {...props} showOptionalToggle />);

    await userEvent.click(screen.getByRole('button', { name: /add scope of work/i }));
    const form = within(screen.getByTestId('scope-add-form'));

    expect(form.getByRole('switch', { name: /optional for new scope/i })).toBeInTheDocument();
    expect(form.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();

    await userEvent.click(form.getByRole('switch', { name: /optional for new scope/i }));
    expect(form.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();

    await userEvent.type(form.getByLabelText(/new scope title/i), 'Extra crew');
    await userEvent.click(form.getByRole('button', { name: /^add$/i }));

    expect(props.onAdd).toHaveBeenCalledWith({
      title: 'Extra crew', body: '', is_taxable: true, is_optional: true, is_selected: false,
    });
  });

  it("a saved block's footer shows the Optional switch + an Include checkbox (#2088) — no Selected switch — and toggling Optional sends is_selected in the same PATCH", async () => {
    const props = baseProps();
    const optionalScope: Scope = { ...SCOPE_A, is_optional: true, is_selected: false };
    render(<ScopeOfWorkCard scopes={[optionalScope]} {...props} showOptionalToggle />);

    const optionalSwitch = screen.getByRole('switch', { name: /optional for scope 1/i });
    const includeCheckbox = screen.getByRole('checkbox', { name: /include scope 1/i });
    expect(optionalSwitch).toBeChecked();
    expect(includeCheckbox).not.toBeChecked();
    expect(screen.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();
    // 2026-09-18 revision, decision 3: the footer states the block's state ONCE. Unanswered, that
    // one word is "Optional" - the switch's own label - and there is no second readout beside the
    // checkbox saying "Not included" as there used to be.
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();

    await userEvent.click(includeCheckbox);
    expect(props.onUpdate).toHaveBeenCalledWith(0, { is_selected: true });

    await userEvent.click(optionalSwitch);
    expect(props.onUpdate).toHaveBeenCalledWith(0, { is_optional: false, is_selected: true });
  });

  it('an interactive non-optional block shows the Optional switch (to turn it on) but no Include checkbox and no Selected switch', () => {
    const props = baseProps();
    render(<ScopeOfWorkCard scopes={[SCOPE_A]} {...props} showOptionalToggle />);

    expect(screen.getByRole('switch', { name: /optional for scope 1/i })).not.toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /include /i })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /selected/i })).not.toBeInTheDocument();
  });

  it('read-only (non-interactive) renders the SAME single tag the editable block shows - never a switch or checkbox', () => {
    const props = baseProps();
    const optionalScope: Scope = { ...SCOPE_A, is_optional: true, is_selected: false };
    render(<ScopeOfWorkCard scopes={[optionalScope]} {...props} canEdit={false} showOptionalToggle />);

    // 2026-09-18 revision, decision 3: one tag, and unanswered it reads "Optional" in read-only
    // mode exactly as it does in editable mode.
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.queryByText('Not included')).not.toBeInTheDocument();
    expect(screen.queryByText('Optional (not selected)')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /optional for scope 1/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /include /i })).not.toBeInTheDocument();
  });
});
