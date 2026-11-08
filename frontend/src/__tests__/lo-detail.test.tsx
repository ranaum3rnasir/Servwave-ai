// LO-3 — LODetailSheet (the one LO detail/editor, which is also the standalone create screen).
//
// Contract under test:
//   • ONE primary action per state and permission (§12 rec 1):
//       DRAFT + grant holder (approve+process) → single "Process" (fast-forward)
//       DRAFT + submitter                       → "Submit for approval"
//       PENDING_APPROVAL + approver             → "Approve"
//       APPROVED + processor                    → "Process"
//       PROCESSED                               → no lifecycle CTA; a dirty edit surfaces "Save changes"
//       CANCELLED / RETURNED                    → read-only, no CTA, picker disabled
//   • Editing a PROCESSED order previews the stock delta before commit ("Returns 2 to Main Warehouse").
//   • The three-action happy path: create → add line → Process runs create then process in one flow.
//   • 409 SHORTAGE (per-line) and 409 STALE_STATUS render as an in-sheet banner via extractLoError.
//   • Cancel takes an OPTIONAL reason — the confirm stays enabled with the field empty (asymmetry).
//
// The LO hooks are mocked (mutateAsync spies on `h`); extractLoError stays REAL — it is the code path
// under test for the error banners. useLocations / useOrganization are stubbed for the picker + delta
// location names, and `api` is the setup.ts global mock (item-stock fetch resolves empty).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { LODetailSheet } from '@/components/inventory/lo/LODetailSheet';
import { buildAbility } from '@/lib/ability';
import type { LogisticOrderDetail } from '@/lib/api/logisticOrders';

const h = vi.hoisted(() => ({
  LOC_MAIN: 'aaaaaaa1-0000-4000-8000-000000000001',
  LOC_VAN: 'aaaaaaa2-0000-4000-8000-000000000002',
  detail: null as LogisticOrderDetail | null,
  createImpl: vi.fn(),
  updateImpl: vi.fn(),
  submitImpl: vi.fn(),
  approveImpl: vi.fn(),
  processImpl: vi.fn(),
  cancelImpl: vi.fn(),
  deleteImpl: vi.fn(),
}));

vi.mock('@/lib/api/logisticOrders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/logisticOrders')>();
  return {
    ...actual, // extractLoError stays real — it is the error-banner code path under test
    useLogisticOrder: () => ({ data: h.detail, isLoading: false, isError: false }),
    useCreateLogisticOrder: () => ({ mutateAsync: h.createImpl, isPending: false }),
    useUpdateLogisticOrder: () => ({ mutateAsync: h.updateImpl, isPending: false }),
    useSubmitLo: () => ({ mutateAsync: h.submitImpl, isPending: false }),
    useApproveLo: () => ({ mutateAsync: h.approveImpl, isPending: false }),
    useProcessLo: () => ({ mutateAsync: h.processImpl, isPending: false }),
    useCancelLo: () => ({ mutateAsync: h.cancelImpl, isPending: false }),
    useDeleteLo: () => ({ mutateAsync: h.deleteImpl, isPending: false }),
  };
});

vi.mock('@/lib/api/inventory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/inventory')>();
  return {
    ...actual,
    useLocations: () => ({
      data: [
        { id: h.LOC_MAIN, name: 'Main Warehouse', type: 'warehouse', branch: 'HQ' },
        { id: h.LOC_VAN, name: 'Van 12', type: 'truck', branch: 'HQ' },
      ],
      isLoading: false,
      isError: false,
    }),
  };
});

vi.mock('@/lib/api/organization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/organization')>();
  return {
    ...actual,
    useOrganization: () => ({
      data: { id: 'org-1', default_inventory_location_id: h.LOC_MAIN },
      isLoading: false,
      isError: false,
    }),
  };
});

vi.mock('@/lib/api/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/invoices')>();
  return {
    ...actual,
    listPriceBookItems: vi.fn().mockResolvedValue([
      { id: 'item1', name: 'Filter 20x20', sku: 'SKU1', type: 'MATERIAL', unit_price: 0, taxable: false, track_inventory: true },
    ]),
  };
});

const ISO = '2026-07-18T10:00:00.000Z';
const mockApi = vi.mocked(api);

function makeDetail(over: Partial<LogisticOrderDetail> = {}): LogisticOrderDetail {
  return {
    id: 'lo1',
    number: 'LO00001',
    seq: null,
    status: 'DRAFT',
    notes: null,
    anchors: {},
    lines: [
      {
        id: 'line1',
        itemId: 'item1',
        itemSku: 'SKU1',
        itemName: 'Filter 20x20',
        qty: 5,
        fromLocationId: h.LOC_MAIN,
        fromLocationName: 'Main Warehouse',
        sequence: 0,
      },
    ],
    lineCount: 1,
    createdBy: { id: 'u1', name: 'Test Admin' },
    submittedBy: null,
    approvedBy: null,
    processedBy: null,
    submittedAt: null,
    approvedAt: null,
    processedAt: null,
    cancelledAt: null,
    cancelledReason: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

const grantHolder = () =>
  buildAbility([
    { action: 'approve', subject: 'LogisticOrder' },
    { action: 'process', subject: 'LogisticOrder' },
    { action: 'update', subject: 'LogisticOrder' },
    { action: 'create', subject: 'LogisticOrder' },
  ]);
const submitter = () =>
  buildAbility([
    { action: 'submit', subject: 'LogisticOrder' },
    { action: 'create', subject: 'LogisticOrder' },
    { action: 'update', subject: 'LogisticOrder' },
  ]);
const approver = () =>
  buildAbility([
    { action: 'approve', subject: 'LogisticOrder' },
    { action: 'update', subject: 'LogisticOrder' },
  ]);
const processor = () =>
  buildAbility([
    { action: 'process', subject: 'LogisticOrder' },
    { action: 'update', subject: 'LogisticOrder' },
  ]);
const updater = () => buildAbility([{ action: 'update', subject: 'LogisticOrder' }]);
// SALES default grants (backend defaultGrants.ts): read + create + submit on LogisticOrder, but NO
// update — they raise a material request and submit it, they do not edit an order after it exists.
const salesActor = () =>
  buildAbility([
    { action: 'read', subject: 'LogisticOrder' },
    { action: 'create', subject: 'LogisticOrder' },
    { action: 'submit', subject: 'LogisticOrder' },
  ]);

function renderSheet(
  detail: LogisticOrderDetail | null,
  ability: ReturnType<typeof buildAbility>,
  loId?: string | null,
) {
  h.detail = detail;
  const onOpenChange = vi.fn();
  const utils = renderWithProviders(
    <LODetailSheet
      open
      onOpenChange={onOpenChange}
      loId={loId !== undefined ? loId : (detail?.id ?? null)}
    />,
    { ability },
  );
  return { ...utils, onOpenChange };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.detail = null;
  h.createImpl = vi.fn().mockResolvedValue(makeDetail({ id: 'lo-new', status: 'DRAFT' }));
  h.updateImpl = vi.fn().mockResolvedValue(makeDetail());
  h.submitImpl = vi.fn().mockResolvedValue(makeDetail({ status: 'PENDING_APPROVAL' }));
  h.approveImpl = vi.fn().mockResolvedValue(makeDetail({ status: 'APPROVED' }));
  h.processImpl = vi
    .fn()
    .mockResolvedValue({ id: 'lo1', number: 'LO00001', status: 'PROCESSED', processedAt: ISO, lines: [], warnings: [] });
  h.cancelImpl = vi.fn().mockResolvedValue(makeDetail({ status: 'CANCELLED', cancelledAt: ISO }));
  h.deleteImpl = vi.fn().mockResolvedValue({ success: true });
  mockApi.get.mockResolvedValue({ data: { item: { id: 'item1', stock: [] } } });
});

// 409 SHORTAGE / STALE_STATUS axios error fixtures.
const shortageError = () => ({
  response: {
    status: 409,
    data: {
      error: 'SHORTAGE',
      message: 'Not enough stock',
      details: [
        {
          item_id: 'item1',
          item_sku: 'SKU1',
          item_name: 'Filter 20x20',
          location_id: h.LOC_MAIN,
          location_name: 'Main Warehouse',
          requested: 5,
          available: 2,
        },
      ],
    },
  },
});
const staleError = () => ({
  response: {
    status: 409,
    data: { error: 'STALE_STATUS', message: 'This order changed since you opened it', expected_status: ['DRAFT'] },
  },
});

describe('LODetailSheet — one primary action per state and permission', () => {
  it('DRAFT + grant holder → a single Process button (no Submit / Approve)', async () => {
    renderSheet(makeDetail({ status: 'DRAFT' }), grantHolder());
    expect(await screen.findByRole('button', { name: 'Process' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('DRAFT + submitter → Submit for approval (no Process / Approve)', async () => {
    renderSheet(makeDetail({ status: 'DRAFT' }), submitter());
    expect(await screen.findByRole('button', { name: 'Submit for approval' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Process' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('PENDING_APPROVAL + approver → Approve (no Process / Submit)', async () => {
    renderSheet(makeDetail({ status: 'PENDING_APPROVAL', submittedAt: ISO }), approver());
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Process' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
  });

  it('APPROVED + processor → Process (no Submit / Approve)', async () => {
    renderSheet(makeDetail({ status: 'APPROVED', approvedAt: ISO }), processor());
    expect(await screen.findByRole('button', { name: 'Process' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('PROCESSED → no lifecycle CTA, and no Save until an edit dirties the form', async () => {
    renderSheet(makeDetail({ status: 'PROCESSED', processedAt: ISO }), updater());
    await screen.findByText('LO00001');
    expect(screen.queryByRole('button', { name: 'Process' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for approval' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('CANCELLED → read-only: no actions, picker disabled (no search box)', async () => {
    renderSheet(makeDetail({ status: 'CANCELLED', cancelledAt: ISO }), grantHolder());
    await screen.findByText('LO00001');
    expect(screen.queryByRole('button', { name: 'Process' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByLabelText('Search tracked items')).toBeNull();
  });
});

describe('LODetailSheet — line editing is gated on `update`, the lifecycle CTA is not', () => {
  // Regression: `readOnly` only covers terminal statuses, so before the `canEditLines` gate a SALES
  // actor (create+submit, no update) could dirty an EXISTING non-terminal DRAFT and then Submit —
  // which persist()'d via PATCH → 403, killing the submit. Lines must be locked, but Submit must stay.
  it('SALES (no update) on an existing DRAFT: picker + notes locked, no Save, but Submit still shows', async () => {
    renderSheet(makeDetail({ status: 'DRAFT' }), salesActor());
    // The lifecycle footer is NOT gated on update — Submit for approval must still render.
    expect(await screen.findByRole('button', { name: 'Submit for approval' })).toBeEnabled();
    // …but there is no way to dirty the form: no search box, qty + notes disabled, no Save.
    expect(screen.queryByLabelText('Search tracked items')).toBeNull();
    expect(screen.getByLabelText('Quantity for Filter 20x20')).toBeDisabled();
    expect(screen.getByLabelText('Notes')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
  });

  it('an actor WITH update on an existing DRAFT can edit lines (search box present, qty enabled)', async () => {
    renderSheet(makeDetail({ status: 'DRAFT' }), submitter());
    expect(await screen.findByLabelText('Search tracked items')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity for Filter 20x20')).toBeEnabled();
    expect(screen.getByLabelText('Notes')).toBeEnabled();
  });

  it('create mode is always editable even without update (SALES sees the search box)', async () => {
    renderSheet(null, salesActor(), null);
    // isCreate short-circuits canEditLines: the search box + notes are live, and both the create-side
    // Save draft and the Submit CTA render — the create endpoint is gated on `create`, not `update`.
    expect(screen.getByLabelText('Search tracked items')).toBeInTheDocument();
    expect(screen.getByLabelText('Notes')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Submit for approval' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
  });
});

describe('LODetailSheet — PROCESSED edit delta hint', () => {
  it('previews the stock return before commit and reveals Save changes', async () => {
    renderSheet(makeDetail({ status: 'PROCESSED', processedAt: ISO }), updater());
    const qty = await screen.findByLabelText('Quantity for Filter 20x20');
    await userEvent.clear(qty);
    await userEvent.type(qty, '3');
    // 5 → 3 at Main Warehouse returns 2.
    expect(await screen.findByText(/Returns 2 to Main Warehouse/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});

describe('LODetailSheet — three-action happy path (standalone create)', () => {
  it('shows the create header with zero anchor UI and disables Process until a line exists', async () => {
    renderSheet(null, grantHolder(), null);
    expect(screen.getByText('New logistic order')).toBeInTheDocument();
    expect(screen.getByText(/Standalone — not linked to any record/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Process' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
  });

  it('create → add line → Process runs create then process in one flow', async () => {
    const { onOpenChange } = renderSheet(null, grantHolder(), null);
    await userEvent.type(screen.getByLabelText('Search tracked items'), 'filter');
    await userEvent.click(await screen.findByRole('button', { name: /Filter 20x20/ }));

    const process = screen.getByRole('button', { name: 'Process' });
    expect(process).toBeEnabled();
    await userEvent.click(process);

    await waitFor(() => expect(h.createImpl).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(h.processImpl).toHaveBeenCalledWith('lo-new'));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('LODetailSheet — Process on a clean DRAFT persists nothing extra', () => {
  it('processes the existing id directly (no update) and closes on success', async () => {
    const { onOpenChange } = renderSheet(makeDetail({ status: 'DRAFT' }), grantHolder());
    await userEvent.click(screen.getByRole('button', { name: 'Process' }));
    await waitFor(() => expect(h.processImpl).toHaveBeenCalledWith('lo1'));
    expect(h.updateImpl).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe('LODetailSheet — error banners', () => {
  it('renders the per-line 409 SHORTAGE detail', async () => {
    h.processImpl = vi.fn().mockRejectedValue(shortageError());
    renderSheet(makeDetail({ status: 'DRAFT' }), grantHolder());
    await userEvent.click(screen.getByRole('button', { name: 'Process' }));
    expect(
      await screen.findByText(/Filter 20x20.*needs 5, 2 available at Main Warehouse/),
    ).toBeInTheDocument();
  });

  it('renders the 409 STALE_STATUS message', async () => {
    h.processImpl = vi.fn().mockRejectedValue(staleError());
    renderSheet(makeDetail({ status: 'DRAFT' }), grantHolder());
    await userEvent.click(screen.getByRole('button', { name: 'Process' }));
    expect(await screen.findByText(/This order changed since you opened it/)).toBeInTheDocument();
    expect(screen.getByText(/Close and reopen/)).toBeInTheDocument();
  });
});

describe('LODetailSheet — stock activity link', () => {
  it('a PROCESSED order links to its stock activity; a DRAFT does not', async () => {
    renderSheet(makeDetail({ status: 'PROCESSED', processedAt: ISO }), updater());
    const link = await screen.findByRole('link', { name: /view stock activity/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/inventory/activity?lo='));
  });

  it('a DRAFT order has posted no movements, so no stock-activity link renders', async () => {
    renderSheet(makeDetail({ status: 'DRAFT' }), updater());
    await screen.findByText('LO00001');
    expect(screen.queryByRole('link', { name: /view stock activity/i })).toBeNull();
  });
});

describe('LODetailSheet — cancel takes an optional reason', () => {
  it('confirms a cancellation with an empty reason (asymmetry vs required adjustment reason)', async () => {
    const ability = buildAbility([
      { action: 'cancel', subject: 'LogisticOrder' },
      { action: 'update', subject: 'LogisticOrder' },
    ]);
    const { onOpenChange } = renderSheet(makeDetail({ status: 'DRAFT' }), ability);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(screen.getByText(/Reason \(optional\)/)).toBeInTheDocument();

    const confirm = screen.getByRole('button', { name: 'Cancel order' });
    expect(confirm).toBeEnabled(); // empty reason does NOT block the confirm
    await userEvent.click(confirm);

    await waitFor(() =>
      expect(h.cancelImpl).toHaveBeenCalledWith({ id: 'lo1', cancelled_reason: null }),
    );
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// --- FormField adoption (phase 11b) ------------------------------------------------
//
// The two label+control pairs in this sheet render through the FormField pattern
// rather than a hand-wired <Label htmlFor> / <Textarea id> pair. Both halves are
// pinned here, at the same rigor as components/patterns/__tests__/FormField.test.tsx:
//
//   1. THE WIRING. The id the label points at and the id on the control are one
//      generated fact, not two literals that can drift. Both of these fields kept
//      their pre-conversion explicit ids (`lo-notes`, `lo-cancel-reason`), so the
//      assertion is that the LABEL now reaches them - it is the label end that was
//      already correct here and must stay correct, and the control end that must
//      not silently lose the id when the `id` prop moved off the Textarea.
//   2. THE RENDERED CLASS STRINGS, byte-exact. This is a structural refactor with
//      no intended visual change, so the pattern's own wrapper and the Label's own
//      class string are pinned literally: the wrapper is Stack's default 1.5 gap
//      and nothing else, and the Label renders exactly what it rendered before the
//      conversion (no tone/size/weight prop is passed at either call site).
const LABEL_CLASS_UNCHANGED =
  'text-sm leading-none transition-colors duration-300 hover:text-text-primary ' +
  'has-[+input:is(:hover,:focus)]:text-text-primary ' +
  'has-[+textarea:is(:hover,:focus)]:text-text-primary ' +
  'peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-text-secondary font-bold';

describe('LODetailSheet - FormField adoption (phase 11b)', () => {
  it('wires the Notes label to the textarea and renders the pattern wrapper byte-exactly', async () => {
    renderSheet(makeDetail({ status: 'DRAFT' }), updater());

    const textarea = await screen.findByLabelText('Notes');
    const label = screen.getByText('Notes', { selector: 'label' });

    expect(textarea).toHaveAttribute('id', 'lo-notes');
    expect(label).toHaveAttribute('for', 'lo-notes');
    // No hint and no error on this field, so the pattern adds no description and
    // does not assert a validity state the form never computed.
    expect(textarea).not.toHaveAttribute('aria-describedby');
    expect(textarea).not.toHaveAttribute('aria-invalid');

    expect(label.parentElement?.getAttribute('class')).toBe('flex flex-col gap-1.5');
    expect(label.getAttribute('class')).toBe(LABEL_CLASS_UNCHANGED);
    // The label's adjacent-sibling hover rule (has-[+textarea:...]) only fires while
    // the textarea is still the label's immediate next sibling - the pattern must not
    // have inserted anything between them.
    expect(label.nextElementSibling).toBe(textarea);
  });

  it('wires the cancel Reason label to its textarea and keeps the label text one node', async () => {
    const ability = buildAbility([
      { action: 'cancel', subject: 'LogisticOrder' },
      { action: 'update', subject: 'LogisticOrder' },
    ]);
    renderSheet(makeDetail({ status: 'DRAFT' }), ability);

    await userEvent.click(screen.getByRole('button', { name: 'Cancel order' }));

    const textarea = screen.getByLabelText('Reason (optional)');
    const label = screen.getByText('Reason (optional)', { selector: 'label' });

    expect(textarea).toHaveAttribute('id', 'lo-cancel-reason');
    expect(label).toHaveAttribute('for', 'lo-cancel-reason');
    expect(textarea).not.toHaveAttribute('aria-describedby');
    expect(textarea).not.toHaveAttribute('aria-invalid');

    // FormField's `optional` flag is deliberately NOT used here: it would split
    // "Reason (optional)" across a <Text> span, changing the label's DOM text
    // structure for no painted difference. One text node, as it shipped.
    expect(label.childNodes).toHaveLength(1);
    expect(label.childNodes[0]!.nodeType).toBe(Node.TEXT_NODE);

    expect(label.parentElement?.getAttribute('class')).toBe('flex flex-col gap-1.5');
    expect(label.getAttribute('class')).toBe(LABEL_CLASS_UNCHANGED);
  });
});
