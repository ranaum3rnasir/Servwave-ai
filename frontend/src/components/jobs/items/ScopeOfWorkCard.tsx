/**
 * ScopeOfWorkCard — shared multi-block "Scope of Work" card for the Job Items tab and the
 * Invoice Line Items tab (Batch 3). A block is a flat-priced, non-line-item chunk of work —
 * `{title, body, flat_price, is_taxable, internal_cost}` (see `backend/src/lib/scopes.ts`'s
 * `ScopeOfWork`, mirrored by the `Scope` type in `@/lib/api/jobs`). Purely presentational: owns
 * no fetching/mutation logic, mirroring `LineItemsTable`'s shared-component placement — the
 * parent (Job's `LineItemsEditor`, Invoice's `InvoiceLineItemsEditor`) owns the actual scope API
 * calls and threads them down as onAdd/onUpdate/onDelete/onReorder.
 *
 * - The `SectionCard` header band (title "Scope of Work (N)" + header actions) ALWAYS renders,
 *   even at 0 blocks — v12 SECTION 01 never shows a naked full-width button with no chrome
 *   around it. Only the *body* (block list + inline add form) is omitted when there are 0
 *   blocks and no add form is open, matching `SectionCard`'s own "omit children to render just
 *   the header band" convention.
 * - `onUsePreset`/`onSaveAsPreset` are optional handler props for the header "Use preset" chip
 *   and each block's footer "Save as preset" link (v12 SECTION 01). Both render ONLY when the
 *   parent supplies the handler — absent today means no button at all (never a disabled/fake
 *   one), until a later slice wires the `ScopePreset` picker/save flow (plan §5 "ship functional
 *   now" / §2d backend fix).
 * - Delete is immediate — no confirm dialog, matching the existing line-item delete UX — plus an
 *   Undo toast that RE-CREATES the block via `onAdd` from a pre-delete snapshot. This is a
 *   recreate, not a true positional undo: the restored block reappears at the end of the list.
 * - `internal_cost` is staff-only (`canSeePricing`) AND only meaningful once a `flat_price` is
 *   set (PRD EC-20) — hidden whenever either gate fails.
 * - `flat_price === 0` is a real, deliberately-set price and renders the editable price input,
 *   same as any other number; only `flat_price == null` shows the dashed "+ Flat price"
 *   affordance (PRD EC-4).
 * - Price + Taxable are settable at CREATE time in `AddScopeForm`, not only afterwards on a saved
 *   block's footer row. Both ride the same `interactive` grant the footer's own price input and
 *   taxable pill use — NOT `canSeePricing`, which governs cost/margin only.
 * - Whether the SELL price (`flat_price`) exists at all on this surface is a separate axis,
 *   `canSeeSellPrice` — see that prop's doc. Cost/margin (`canSeePricing`) and sell price are two
 *   different grants and the three host entities answer them differently.
 * - Move up/down mirrors `LineItemRow.tsx`'s existing pattern (ChevronUp/ChevronDown, disabled
 *   while busy) — no drag-and-drop, this is a short block list, not a large table.
 * - `busy` mirrors `LineItemRow`'s shared flag (parent ORs its add/update/delete/reorder
 *   mutations together) — every interactive control disables itself while true; there is no
 *   page-wide spinner.
 */
import { useEffect, useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Bookmark } from 'lucide-react';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/patterns/FormField';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { AutoGrowTextarea } from '@/components/ui/autoGrowTextarea';
import { Text } from '@/components/ui/text';
import { ToastAction } from '@/components/ui/toast';
import { toast } from '@/components/ui/use-toast';
import { cn, formatCurrency } from '@/lib/utils';
import { ClampedDescription } from './ClampedDescription';
import type { Scope } from '@/lib/api/jobs';

// What the customer did with the offer, or null while there is nothing to report. Reads from
// `locked`/`isSelected` and NOTHING else (OQ3/AC12). "Not included" rather than "Declined" on
// purpose - see LineItemRow.tsx's own note. 2026-09-18 revision, decision 3.
function answerTagFor(isSelected: boolean, locked: boolean): string | null {
  if (!locked) return null;
  return isSelected ? 'Included' : 'Not included';
}

// The whole state in one word, for a surface that has no Optional switch of its own to name the
// property: a read-only block here, and every row in LineItemRow.tsx. An EDITABLE block does have
// that switch, so it uses `answerTagFor` instead and lets the switch keep its own label.
function optionalTagFor(isSelected: boolean, locked: boolean): string {
  return answerTagFor(isSelected, locked) ?? 'Optional';
}

/**
 * The fields a caller can create/patch a block with — structurally identical to
 * `AddJobScopePayload`/`AddInvoiceScopePayload` (defined once here rather than importing one of
 * those two surface-specific payload types, since this card is shared by both).
 */
export interface ScopeDraft {
  title: string;
  body?: string;
  flat_price?: number | null;
  is_taxable?: boolean;
  internal_cost?: number | null;
  /** #2053 slice 1 — estimate-only; populated only when `showOptionalToggle` is true. */
  is_optional?: boolean;
  is_selected?: boolean;
}

export interface ScopeOfWorkCardProps {
  scopes: Scope[];
  /** Gates inline field editing (title/body/price/taxable/internal_cost) and move-up/down reorder. */
  canEdit: boolean;
  /**
   * Gates the "+ Add scope of work" CTA and per-block delete. Defaults to `canEdit` when omitted,
   * so callers that gate every scope mutation on one ability (e.g. Job, which gates add/update/
   * delete/reorder all on `update Job` — see JobScopeOfWorkCard) don't need to pass it explicitly.
   * Invoice's routes split this (POST/DELETE /scopes require only `manage_lines`; PATCH
   * /scopes/:idx + /scopes/reorder require only `update`), so InvoiceScopeOfWorkCard passes the
   * two grants separately instead of ANDing them into one flag.
   */
  canAddDelete?: boolean;
  /** Show the staff-only internal_cost field. Mirrors the backend's canSeePricing gate. */
  canSeePricing: boolean;
  /**
   * Whether the SELL price (`flat_price`) exists for this requester on this surface. Defaults to
   * true — only Job passes false, and only because Job's backend genuinely removes it: for a
   * requester without `read Pricing`, `job-lines.controller.ts` strips `flat_price` from every
   * scopes response (`stripScopeMoney`) AND drops it from the write body (`delete
   * body.flat_price`). Estimate and Invoice do neither, deliberately — they are customer-facing
   * priced documents where the sell price IS the content, and only margin is hidden. Rendering a
   * price control the server will never populate or accept is a lie either way round, so the
   * control is ABSENT rather than disabled, matching internal_cost's treatment above and
   * AddLineDialog's stated absent-not-disabled convention.
   *
   * Distinct from `canSeePricing` on purpose: that is cost/margin ("See financial data"), this is
   * the customer-facing price. On Job the two happen to be driven by the same ability; on the
   * other two surfaces they are not, which is exactly why this cannot be folded into that flag.
   */
  canSeeSellPrice?: boolean;
  /** Inert when true — no add/edit/delete affordances render; no confirm dialogs change as a result. */
  locked?: boolean;
  /** Shared in-flight flag (parent ORs its own mutations together) — disables every control. */
  busy?: boolean;
  onAdd: (payload: ScopeDraft) => void;
  onUpdate: (idx: number, patch: Partial<ScopeDraft>) => void;
  onDelete: (idx: number) => void;
  /** Full reordered array of Scope objects (not ids) — the caller derives whatever id/index list its API needs. */
  onReorder: (newOrder: Scope[]) => void;
  /**
   * Opens a preset picker (owned by the parent) that ultimately adds a block via `onAdd`.
   * Renders the header "Use preset" button ONLY when provided — no button at all (not a
   * disabled one) until a later slice wires the preset picker. Gated by the same
   * `canAddDelete`-equivalent grant as "+ Add scope of work", since it's an add action.
   */
  onUsePreset?: () => void;
  /**
   * Persists one block's title/body/flat_price/is_taxable/internal_cost as a reusable preset.
   * Renders the per-block "Save as preset" footer link ONLY when provided — no link at all
   * until a later slice wires scope presets (plan §5/§2d). Gated by the same `canEdit`-equivalent
   * grant as the block's inline field editing, since it's a block-level action.
   */
  onSaveAsPreset?: (scope: Scope) => void;
  /**
   * R5f — renders Estimate's per-block photo strip under a block's title/body. Omitted (the
   * default) for every other caller (Job/Invoice have no scope-photo endpoint), so their cards
   * stay unchanged.
   */
  renderPhotos?: (scope: Scope) => React.ReactNode;
  /**
   * #2053 slice 1 — reveal the Optional switch (inline add form + a saved block's footer).
   * Default `false`, absent-not-disabled: Job/Invoice never pass this, so no control ever
   * renders and no key is ever put on an onAdd/onUpdate patch. Only `EstimateScopeOfWorkCard`
   * passes `true`. R6 — same prop name as AddLineDialog/LineItemsTable, so one grep proves the
   * gating.
   */
  showOptionalToggle?: boolean;
  /** #2088 — see `LineItemRowProps.selectionsLocked`. Default `false`. */
  selectionsLocked?: boolean;
}

function toNum(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isNaN(n) ? 0 : n;
}

const moveButtonClass =
  'flex h-5 w-5 items-center justify-center rounded text-text-secondary/50 hover:bg-background-light hover:text-text-secondary disabled:opacity-40';

/**
 * The "Taxable: Yes/No" affordance, in one place. Three sites render it — the add form, and a
 * saved block's footer in both its editable and read-only states — and they must not drift.
 * Left raw rather than built on `Badge`/`Chip`: this is a two-state toggle whose fill flips with
 * the state, and neither primitive mints a `rounded-full` + `sage` cell (see their own docs).
 * Passing `onToggle` makes it an interactive button; omitting it renders the static span.
 */
function TaxablePill({
  taxable,
  onToggle,
  disabled,
  label,
}: {
  taxable: boolean;
  onToggle?: () => void;
  disabled?: boolean;
  label: string;
}) {
  const text = `Taxable: ${taxable ? 'Yes' : 'No'}`;

  if (!onToggle) {
    const className = cn(
      'rounded-full px-2.5 py-1 text-xs font-semibold transition-colors',
      taxable ? 'bg-sage-700/10 text-sage-700' : 'bg-background-light text-text-secondary',
    );
    return <span className={className}>{text}</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <Switch checked={taxable} disabled={disabled} onCheckedChange={() => onToggle()} aria-label={label} />
      <span className="text-xs text-text-secondary">{text}</span>
    </div>
  );
}

/**
 * #2088 — the "Optional" affordance, next to `TaxablePill` at the same three sites (the inline
 * add form, and a saved block's footer in both its editable and read-only states) — same
 * interactive-vs-static branching as TaxablePill. `onToggleOptional` absent renders the static
 * branch: nothing at all for a non-optional block, the one state tag for one that is - the SAME
 * word the editable branch shows, so the read-only and editable blocks never disagree (this
 * replaces the old "Optional (not selected)" read-only twin - R11/H11). `onToggleSelected` drives
 * a row CHECKBOX, which a saved optional block keeps (#2088 §1, upheld by the 2026-09-18
 * revision): the salesperson may still pre-tick an item on the customer's behalf.
 *
 * Two different facts, two different places, never the same word twice (2026-09-18 revision,
 * decision 3):
 *   - "this block is optional" is a property the REP controls. On an editable block the switch
 *     names it, and that label stays the literal word "Optional" for ever, because a label must
 *     say what its control does and must match the accessible name a voice user would speak
 *     (WCAG 2.5.3). A read-only block has no switch, so there `tag` carries the property instead.
 *   - "the customer took it / left it" is an ANSWER. On an editable block it renders as its own
 *     `answerTag`, and only once there is an answer to report.
 *
 * The inline ADD form is a different thing again: `preSelectCaption` is the rep's pre-send
 * default, not a report of what the customer did, so that form keeps its own wording untouched.
 */
function OptionalPair({
  optional,
  selected,
  onToggleOptional,
  onToggleSelected,
  disabled,
  selectionsLocked = false,
  idPrefix,
  label,
  preSelectCaption,
  tag,
  answerTag,
}: {
  optional: boolean;
  /** What the checkbox shows: the rep's `rep_selected`, falling back to `is_selected`. */
  selected: boolean;
  onToggleOptional?: () => void;
  onToggleSelected?: (checked: boolean) => void;
  disabled?: boolean;
  /**
   * #2090 slice A3 - the customer has signed (`areSelectionsLocked`, WON and nothing else).
   * Disables the include checkbox ONLY, never the Optional switch beside it, which is a different
   * control and a different product question.
   */
  selectionsLocked?: boolean;
  /** HTML id prefix — hyphenated, e.g. `new-scope` or `scope-1`. */
  idPrefix: string;
  /** Human-readable aria-label suffix, e.g. "new scope" or "scope 1" — mirrors TaxablePill's own convention. */
  label: string;
  /** ADD FORM ONLY - the word beside the rep's pre-send default. A saved block passes nothing. */
  preSelectCaption?: string;
  /** READ-ONLY SAVED BLOCK ONLY - the whole state in one word, see `optionalTagFor` above. */
  tag?: string;
  /** EDITABLE SAVED BLOCK ONLY - the customer's answer, absent until they give one. */
  answerTag?: string | null;
}) {
  if (!onToggleOptional) {
    if (!optional) return null;
    return (
      <div className="flex items-center gap-2">
        <span
          data-testid="optional-state-tag"
          className="rounded-full bg-background-light px-2.5 py-1 text-xs font-semibold text-text-secondary"
        >
          {tag}
        </span>
      </div>
    );
  }
  return (
    <>
      <div className="flex items-center gap-2">
        <Switch id={`${idPrefix}-optional`} checked={optional} disabled={disabled} onCheckedChange={onToggleOptional} aria-label={`Optional for ${label}`} />
        {/* Names what the switch DOES, and says so whatever the customer has since decided. It
            must stay a substring of the aria-label above (WCAG 2.5.3). The customer's answer is
            the separate tag below, never this. */}
        <Label htmlFor={`${idPrefix}-optional`} className="cursor-pointer text-xs text-text-secondary">Optional</Label>
      </div>
      {optional && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={`${idPrefix}-selected`}
            checked={selected}
            disabled={selectionsLocked || disabled}
            onCheckedChange={(v) => onToggleSelected?.(v === true)}
            aria-label={`Include ${label}`}
          />
          {preSelectCaption && <span className="text-xs text-text-secondary">{preSelectCaption}</span>}
          {answerTag && (
            <span
              data-testid="optional-state-tag"
              className="rounded-full bg-background-light px-2.5 py-1 text-xs font-semibold text-text-secondary"
            >
              {answerTag}
            </span>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Inline "new block" form — no modal, mirrors the card's own inline-edit convention.
 *
 * Price + Taxable are collected HERE, at create time, rather than only afterwards on the saved
 * block's footer row: a scope of work is a flat-priced chunk of work, so "add it, then hunt for
 * the dashed + Flat price chip" made the pricing look unsupported. The footer row keeps working
 * exactly as before for later edits — this only removes the second step.
 *
 * Both fields ride the SAME `interactive` grant the footer's own price input and taxable pill
 * use, deliberately — NOT `canSeePricing`. `canSeePricing` is `read Pricing`, the org-level "See
 * financial data" switch, which `enforce.ts` documents as decoupled from record capability on
 * purpose; gating a customer-facing SELL price on it would stop a DISPATCHER whose org has that
 * switch off from pricing a scope at create time even on Estimate/Invoice, whose backends have no
 * write lock at all.
 *
 * The price field is omitted entirely when `canSeeSellPrice` is false — see that prop's doc on
 * `ScopeOfWorkCardProps`. Taxable stays: it is not money, the backend accepts it from any
 * requester, and it remains meaningful on a block someone else prices later.
 */
function AddScopeForm({
  busy,
  canSeeSellPrice,
  showOptionalToggle,
  onCancel,
  onSave,
}: {
  busy?: boolean;
  canSeeSellPrice: boolean;
  showOptionalToggle?: boolean;
  onCancel: () => void;
  onSave: (draft: ScopeDraft) => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [price, setPrice] = useState('');
  // Matches the backend's `is_taxable: z.boolean().optional().default(true)` so an untouched
  // form posts the same value the server would have defaulted to anyway.
  const [taxable, setTaxable] = useState(true);
  // #2053 slice 1 — only read/sent when showOptionalToggle is true.
  const [optional, setOptional] = useState(false);
  const [selected, setSelected] = useState(true);

  // A blank price is a legitimate "not priced yet" block (flat_price stays null and the saved
  // block shows its usual dashed "+ Flat price" chip). A NON-blank but unparseable/negative
  // price is a typo, and disables Add rather than being silently dropped to null — the block
  // footer's commitPrice can afford to revert to the last good value, but there is no previous
  // value to fall back to at create time.
  // When the price field isn't rendered there is nothing to parse or validate, and nothing to
  // send — a stale draft can't survive, since the field never mounts to collect one.
  const parsedPrice = !canSeeSellPrice || price.trim() === '' ? null : parseFloat(price);
  const priceInvalid = parsedPrice != null && (Number.isNaN(parsedPrice) || parsedPrice < 0);

  const save = () => {
    const trimmed = title.trim();
    if (!trimmed || priceInvalid) return;
    onSave({
      title: trimmed,
      body: body.trim(),
      is_taxable: taxable,
      // Only send flat_price when the user actually set one — omitting it leaves the new block
      // unpriced instead of pinning it to 0, which EC-4 treats as a real, deliberate price.
      ...(parsedPrice != null && { flat_price: parsedPrice }),
      // #2053 slice 1 — keys omitted entirely when the toggle is off (Job/Invoice payloads stay
      // byte-identical to today).
      ...(showOptionalToggle ? { is_optional: optional, is_selected: optional ? selected : true } : {}),
    });
  };

  return (
    <div
      className="rounded-card border border-dashed border-primary/40 bg-primary-subtle/30 p-4"
      data-testid="scope-add-form"
    >
      <FormField label="Title" htmlFor="new-scope-title" gap={0.5}>
        <Input
          aria-label="New scope title"
          value={title}
          disabled={busy}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Demo & haul-away"
          className="mb-2"
        />
      </FormField>
      <FormField label="Description (optional)" htmlFor="new-scope-body" gap={0.5}>
        <AutoGrowTextarea
          aria-label="New scope description"
          value={body}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
          className="mb-3"
        />
      </FormField>

      <div className="mb-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
        {canSeeSellPrice && (
          <div className="flex items-center gap-1">
            {/* A span + `aria-label`, not a <label htmlFor>: mirrors the block footer's own
                price/cost affixes exactly, and the component-api-guard raw-<label> ratchet is
                may-only-decrease. The input is still named for assistive tech. */}
            <span className="text-xs text-text-secondary">Flat price $</span>
            <Input
              aria-label="New scope flat price"
              aria-invalid={priceInvalid || undefined}
              aria-describedby={priceInvalid ? 'new-scope-price-error' : undefined}
              type="number"
              min={0}
              step={0.01}
              value={price}
              disabled={busy}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              size="xs"
              className="w-28"
            />
          </div>
        )}
        <TaxablePill
          taxable={taxable}
          onToggle={() => setTaxable((t) => !t)}
          disabled={busy}
          label="Taxable for new scope"
        />
        {showOptionalToggle && (
          <OptionalPair
            optional={optional}
            selected={selected}
            onToggleOptional={() => {
              // #2088 §1 — Optional on implies not-selected (the total drops at once); Optional
              // off implies selected. Same rule as AddLineDialog's Optional switch.
              setOptional((o) => {
                const next = !o;
                setSelected(!next);
                return next;
              });
            }}
            onToggleSelected={(checked) => setSelected(checked)}
            disabled={busy}
            idPrefix="new-scope"
            label="new scope"
            preSelectCaption={selected ? 'Included' : 'Not included'}
          />
        )}
      </div>
      {priceInvalid && (
        <Text id="new-scope-price-error" as="p" size="xs" tone="danger" className="mb-3">
          Flat price must be a non-negative number, or left blank.
        </Text>
      )}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="solid"
          tone="business"
          size="sm"
          onClick={save}
          disabled={busy || !title.trim() || priceInvalid}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

interface ScopeBlockProps {
  scope: Scope;
  idx: number;
  count: number;
  /** Gates inline field editing + move-up/down (the `update`-equivalent grant). */
  interactive: boolean;
  /** Gates the delete button (the `manage_lines`-equivalent grant) — independent of `interactive`. */
  canDelete: boolean;
  canSeePricing: boolean;
  /** See `ScopeOfWorkCardProps.canSeeSellPrice` — resolved to a definite boolean by the parent. */
  canSeeSellPrice: boolean;
  busy?: boolean;
  onUpdate: (patch: Partial<ScopeDraft>) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  /** Pre-bound to this block's `Scope` by the parent. Renders the footer link only when set. */
  onSaveAsPreset?: () => void;
  /** R5f — pre-resolved by the parent (`renderPhotos?.(scope)`); renders under title/body when set. */
  photosSlot?: React.ReactNode;
  /** #2053 slice 1 — see `ScopeOfWorkCardProps.showOptionalToggle`. */
  showOptionalToggle?: boolean;
  /** #2088 — see `ScopeOfWorkCardProps.selectionsLocked`. */
  selectionsLocked?: boolean;
}

function ScopeBlock({
  scope,
  idx,
  count,
  interactive,
  canDelete,
  canSeePricing,
  canSeeSellPrice,
  busy,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
  onSaveAsPreset,
  photosSlot,
  showOptionalToggle,
  selectionsLocked = false,
}: ScopeBlockProps) {
  const [title, setTitle] = useState(scope.title);
  const [body, setBody] = useState(scope.body ?? '');
  const [priceDraft, setPriceDraft] = useState(scope.flat_price != null ? String(scope.flat_price) : '');
  const [addingPrice, setAddingPrice] = useState(false);
  const [costDraft, setCostDraft] = useState(scope.internal_cost != null ? String(scope.internal_cost) : '');

  useEffect(() => setTitle(scope.title), [scope.title]);
  useEffect(() => setBody(scope.body ?? ''), [scope.body]);
  useEffect(
    () => setPriceDraft(scope.flat_price != null ? String(scope.flat_price) : ''),
    [scope.flat_price],
  );
  useEffect(
    () => setCostDraft(scope.internal_cost != null ? String(scope.internal_cost) : ''),
    [scope.internal_cost],
  );

  const commitTitle = () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setTitle(scope.title); // title is required — never allow blanking it out
      return;
    }
    if (trimmed !== scope.title) onUpdate({ title: trimmed });
  };
  const commitBody = () => {
    if (body !== (scope.body ?? '')) onUpdate({ body });
  };
  const commitPrice = () => {
    const n = parseFloat(priceDraft);
    if (!Number.isNaN(n) && n >= 0) {
      if (n !== scope.flat_price) onUpdate({ flat_price: n });
    } else {
      setPriceDraft(scope.flat_price != null ? String(scope.flat_price) : '');
    }
    setAddingPrice(false);
  };
  const commitCost = () => {
    const n = parseFloat(costDraft);
    if (!Number.isNaN(n) && n >= 0) {
      if (n !== scope.internal_cost) onUpdate({ internal_cost: n });
    } else {
      setCostDraft(scope.internal_cost != null ? String(scope.internal_cost) : '');
    }
  };

  // Staff-only AND only meaningful once a flat price exists (PRD EC-20).
  const showInternalCost = canSeePricing && scope.flat_price != null;

  return (
    <div className="rounded-card border border-border bg-surface-light p-4" data-testid="scope-block">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {interactive ? (
            <Input
              value={title}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              aria-label={`Title for scope ${idx + 1}`}
              // Deferred: no Input size/tone rung sets font-weight - font-semibold has no
              // prop equivalent.
              className="mb-2 font-semibold"
            />
          ) : (
            <p className="mb-1 font-semibold text-text-primary">{scope.title}</p>
          )}

          {interactive ? (
            <AutoGrowTextarea
              value={body}
              disabled={busy}
              onChange={(e) => setBody(e.target.value)}
              onBlur={commitBody}
              aria-label={`Description for scope ${idx + 1}`}
              placeholder="Optional description…"
            />
          ) : (
            <ClampedDescription text={scope.body} lines={3} />
          )}
          {photosSlot}
        </div>

        {(interactive || canDelete) && (
          <div className="flex shrink-0 flex-col items-center gap-0.5">
            {interactive && count > 1 && (
              <>
                {/* Left raw (both chevrons): idle text-text-secondary/50, hover targets
                    full-opacity text-text-secondary - matches LineItemRow.tsx's identical
                    Move up/down pair; no minted cell reproduces this idle/hover pair
                    (see that file's comment for the full reasoning). */}
                <button
                  type="button"
                  onClick={onMoveUp}
                  disabled={busy || idx === 0}
                  aria-label={`Move scope ${idx + 1} up`}
                  className={moveButtonClass}
                >
                  <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={onMoveDown}
                  disabled={busy || idx === count - 1}
                  aria-label={`Move scope ${idx + 1} down`}
                  className={moveButtonClass}
                >
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </button>
              </>
            )}
            {canDelete && (
              <Button
                type="button"
                variant="ghost"
                tone="danger"
                size="icon"
                onClick={onDelete}
                disabled={busy}
                className="mt-0.5 h-8 w-8"
                aria-label={`Delete scope ${idx + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
        {/* Flat price — null shows the dashed "+ Flat price" affordance; 0 is a real set price
            and renders the editable input like any other number (PRD EC-4). Omitted wholesale
            when the surface has no sell price for this requester: `flat_price` is absent from the
            response there, so the null branch would assert "No flat price" about a block that may
            well be priced, and the "+ Flat price" branch would offer a write the server drops. */}
        {!canSeeSellPrice ? null : scope.flat_price == null ? (
          interactive ? (
            addingPrice ? (
              <Input
                type="number"
                min={0}
                step={0.01}
                autoFocus
                value={priceDraft}
                disabled={busy}
                onChange={(e) => setPriceDraft(e.target.value)}
                onBlur={commitPrice}
                onKeyDown={(e) => e.key === 'Enter' && commitPrice()}
                aria-label={`Flat price for scope ${idx + 1}`}
                size="xs"
                className="w-28"
              />
            ) : (
              // Left raw: dashed "+ Flat price" CTA - a distinct family with no matching
              // Button cell (same shape as this program's other dashed-CTA deferrals).
              <button
                type="button"
                onClick={() => setAddingPrice(true)}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded border border-dashed border-border px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:border-primary hover:bg-primary-subtle disabled:opacity-50"
              >
                <Plus className="h-3 w-3" aria-hidden /> Flat price
              </button>
            )
          ) : (
            <span className="text-xs text-text-secondary">No flat price</span>
          )
        ) : interactive ? (
          <div className="flex items-center gap-1">
            <span className="text-xs text-text-secondary">$</span>
            <Input
              type="number"
              min={0}
              step={0.01}
              value={priceDraft}
              disabled={busy}
              onChange={(e) => setPriceDraft(e.target.value)}
              onBlur={commitPrice}
              onKeyDown={(e) => e.key === 'Enter' && commitPrice()}
              aria-label={`Flat price for scope ${idx + 1}`}
              size="xs"
              className="w-24"
            />
          </div>
        ) : (
          <span className="text-sm font-semibold tabular-nums text-text-primary">
            {formatCurrency(toNum(scope.flat_price))}
          </span>
        )}

        <TaxablePill
          taxable={scope.is_taxable}
          onToggle={interactive ? () => onUpdate({ is_taxable: !scope.is_taxable }) : undefined}
          disabled={busy}
          label={`Taxable for scope ${idx + 1}`}
        />

        {showOptionalToggle && (
          <OptionalPair
            optional={scope.is_optional ?? false}
            // #2090 slice A3: the checkbox is the REP's control, so it shows the REP's
            // recommendation at every status, never the customer's live answer.
            // `?? (is_selected ?? true)` is the no-backfill fallback for a block written before
            // this key existed - it renders exactly what it rendered before rather than inventing
            // a recommendation.
            //
            // THIS IS THE ONLY READ of the scope half of that value anywhere, and the reason the
            // rename needed a data migration rather than a tolerance branch here. A scope block
            // is not a row: it is one object inside the `estimates.scopes` JSONB array, and JSONB
            // carries no schema, so a blob written under the previous key does NOT rename itself
            // when this field does. Reading only the new key would make every scope block sent on
            // staging before the rename fall through to `is_selected` - the CUSTOMER's live
            // answer - which is precisely the bug the freeze exists to prevent, and this slice
            // promised no behaviour change. So migration 20260919140000 rewrites the stored key
            // in place, and this site reads one name.
            //
            // Reading both keys was the alternative and was rejected twice over: it would keep
            // the retired name alive in the code forever, when having exactly one name is the
            // entire point of this slice; and A2 inverts what this value MEANS, at which point a
            // tolerance branch would be silently attaching the new meaning to blobs written under
            // the old one. Migrating keeps the JSONB half and the `rep_selected` column in
            // lockstep through that change instead of letting them drift.
            selected={scope.rep_selected ?? scope.is_selected ?? true}
            onToggleOptional={
              interactive
                ? // #2088 §1 - turning Optional ON sends is_selected:false in the same PATCH
                  // (the total drops at once); turning it OFF sends is_selected:true.
                  () =>
                    onUpdate({
                      is_optional: !(scope.is_optional ?? false),
                      is_selected: scope.is_optional ?? false,
                    })
                : undefined
            }
            onToggleSelected={interactive ? (checked) => onUpdate({ is_selected: checked }) : undefined}
            disabled={busy}
            selectionsLocked={selectionsLocked}
            idPrefix={`scope-${idx + 1}`}
            label={`scope ${idx + 1}`}
            tag={optionalTagFor(scope.is_selected ?? true, selectionsLocked)}
            answerTag={answerTagFor(scope.is_selected ?? true, selectionsLocked)}
          />
        )}

        {/* Internal cost — staff-only AND only once a flat price exists (EC-20). */}
        {showInternalCost &&
          (interactive ? (
            <div className="ml-auto flex items-center gap-1">
              <span className="text-xs text-text-secondary">Internal cost $</span>
              <Input
                type="number"
                min={0}
                step={0.01}
                value={costDraft}
                disabled={busy}
                onChange={(e) => setCostDraft(e.target.value)}
                onBlur={commitCost}
                onKeyDown={(e) => e.key === 'Enter' && commitCost()}
                aria-label={`Internal cost for scope ${idx + 1}`}
                size="xs"
                className="w-24"
              />
            </div>
          ) : (
            <span className="ml-auto text-xs text-text-secondary">
              Internal cost: {scope.internal_cost != null ? formatCurrency(toNum(scope.internal_cost)) : '—'}
            </span>
          ))}
      </div>

      {/* Save as preset — footer link, per-block (DDR §1b: presets are per-scope). Only renders
          once a later slice wires `onSaveAsPreset` (plan §5/§2d) — no button until then. */}
      {onSaveAsPreset && (
        <div className="mt-2 flex justify-end">
          {/* Left raw: idle text-text-secondary, hover text-primary (colour shift, no
              underline) - no minted cell reproduces this idle/hover pair (link/brand
              hovers via underline; ghost/subtle's hover targets text-text-primary, not
              the brand primary shade). */}
          <button
            type="button"
            onClick={onSaveAsPreset}
            disabled={busy}
            className="inline-flex items-center gap-1 text-xs font-semibold text-text-secondary transition-colors hover:text-primary disabled:opacity-50"
          >
            <Bookmark className="h-3 w-3" aria-hidden />
            Save as preset
          </button>
        </div>
      )}
    </div>
  );
}

export function ScopeOfWorkCard({
  scopes,
  canEdit,
  canAddDelete = canEdit,
  canSeePricing,
  canSeeSellPrice = true,
  locked = false,
  busy = false,
  onAdd,
  onUpdate,
  onDelete,
  onReorder,
  onUsePreset,
  onSaveAsPreset,
  renderPhotos,
  showOptionalToggle = false,
  selectionsLocked = false,
}: ScopeOfWorkCardProps) {
  const interactive = canEdit && !locked;
  const interactiveAddDelete = canAddDelete && !locked;
  const [adding, setAdding] = useState(false);

  // Immediate delete (no confirm dialog) + an Undo toast that re-creates the block via onAdd
  // from a pre-delete snapshot. internal_cost only rides along on the snapshot when the caller
  // can see pricing — restoring a block a pricing-restricted user just deleted should not
  // resurrect cost data they never had access to in the first place. flat_price is skipped on the
  // same grounds when the surface withholds it: the snapshot never carried a price to restore
  // (the response omits the key), and the server would drop it from the re-create anyway.
  const handleDelete = (idx: number) => {
    const snapshot = scopes[idx];
    onDelete(idx);
    if (!snapshot) return;

    const restore: ScopeDraft = {
      title: snapshot.title,
      body: snapshot.body,
      is_taxable: snapshot.is_taxable,
    };
    if (canSeeSellPrice) restore.flat_price = snapshot.flat_price;
    if (canSeePricing && snapshot.internal_cost != null) restore.internal_cost = snapshot.internal_cost;
    // #2053 slice 1 — the restored block keeps its optional/selected state too.
    if (showOptionalToggle) {
      restore.is_optional = snapshot.is_optional ?? false;
      restore.is_selected = snapshot.is_selected ?? true;
    }

    toast({
      title: 'Scope of work removed',
      description: snapshot.title || 'Untitled scope',
      action: (
        <ToastAction altText="Undo remove" onClick={() => onAdd(restore)}>
          Undo
        </ToastAction>
      ),
    });
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= scopes.length) return;
    const next = [...scopes];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    onReorder(next);
  };

  const addButton = interactiveAddDelete && !adding && (
    <Button type="button" variant="solid" tone="business" size="sm" onClick={() => setAdding(true)}>
      <Plus className="h-4 w-4" aria-hidden /> Add scope of work
    </Button>
  );

  // "Use preset" — same add-equivalent grant as "+ Add scope of work" (it ultimately calls
  // onAdd too), and only rendered once a parent supplies the handler (see prop doc).
  const usePresetButton = interactiveAddDelete && onUsePreset && (
    <Button type="button" variant="outline" size="sm" onClick={onUsePreset}>
      Use preset
    </Button>
  );

  const meta =
    usePresetButton || addButton ? (
      <>
        {usePresetButton}
        {addButton}
      </>
    ) : undefined;

  const addForm = adding && (
    <AddScopeForm
      busy={busy}
      canSeeSellPrice={canSeeSellPrice}
      showOptionalToggle={showOptionalToggle}
      onCancel={() => setAdding(false)}
      onSave={(draft) => {
        onAdd(draft);
        setAdding(false);
      }}
    />
  );

  // The SectionCard header band ALWAYS renders (title + header actions), even at 0 blocks — v12
  // never shows a naked full-width button. Only the body (block list + inline add form) is
  // omitted when there's nothing to show it for; `undefined` (not `false`) skips SectionCard's
  // body div entirely, matching its "omit children to render header-only" convention.
  const hasBody = scopes.length > 0 || adding;

  return (
    <SectionCard
      title="Scope of Work"
      titleSuffix={<span className="ml-1 font-normal text-text-secondary">({scopes.length})</span>}
      meta={meta}
    >
      {hasBody ? (
        <div className="flex flex-col gap-3">
          {scopes.map((scope, idx) => (
            <ScopeBlock
              key={scope.id}
              scope={scope}
              idx={idx}
              count={scopes.length}
              interactive={interactive}
              canDelete={interactiveAddDelete}
              canSeePricing={canSeePricing}
              canSeeSellPrice={canSeeSellPrice}
              busy={busy}
              showOptionalToggle={showOptionalToggle}
              selectionsLocked={selectionsLocked}
              onUpdate={(patch) => onUpdate(idx, patch)}
              onDelete={() => handleDelete(idx)}
              onMoveUp={() => move(idx, idx - 1)}
              onMoveDown={() => move(idx, idx + 1)}
              onSaveAsPreset={interactive && onSaveAsPreset ? () => onSaveAsPreset(scope) : undefined}
              photosSlot={renderPhotos?.(scope)}
            />
          ))}
          {addForm}
        </div>
      ) : undefined}
    </SectionCard>
  );
}
