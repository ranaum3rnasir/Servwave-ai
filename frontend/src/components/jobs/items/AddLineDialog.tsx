/**
 * AddLineDialog — add a line item via a single "find-or-create" search (like creating a
 * customer from a lead); also doubles as the EDIT dialog for an existing line (Stage 4).
 *
 *   1. Type in the search box → matching price-book items appear (with thumbnails).
 *   2. Pick one → confirm quantity → Add (snapshots the catalog item onto the invoice).
 *   3. If nothing matches → "Add new item: <text>" → a compact new-item form (Name / Description /
 *      Quantity / Selling price / Markup % / Unit cost / Type / Taxable). By default the new item
 *      is invoice-only (price_book_item_id stays null — the price book is untouched). Admin/
 *      Dispatcher may toggle "Save to price book" to persist a reusable catalog item.
 *
 * Markup %/Unit cost sync (both the new-item form AND the edit form below): Unit price and
 * Markup % are both freely editable. WHILE Markup % holds a valid value (> -100, avoiding a
 * divide-by-zero/negative-cost blowup), Unit cost is DERIVED — unit_cost = unit_price / (1 +
 * markup_percent / 100) — and its input is disabled with a "Synced from markup" hint. Once
 * Markup % is cleared (or holds an unusable value), Unit cost reverts to a normal, freely-
 * editable input. This mirrors — but is NOT the same computation as — LineItemRow's per-row
 * margin sub-line (margin % = (price − cost) / price × 100): both are legitimate readouts of
 * the same three numbers (price/cost/markup), read in different directions.
 *
 * The 4-up grid (Quantity · Selling price · Markup % · Unit cost) always renders all four
 * columns in BOTH forms (v12 SECTION 04 shows them unconditionally) — `canSeePricing` no longer
 * removes the Markup %/Unit cost columns outright (that was the anti-pattern the v12 plan named
 * for replacement: collapsing to a 2-column grid and hiding the whole row for non-pricing
 * users). Instead, only the sensitive VALUES are masked when `canSeePricing` is false: both
 * inputs render disabled with a blank, placeholder value, so the layout never shifts between
 * roles and a non-pricing user can neither read nor blind-set cost data (the backend already
 * strips `unit_cost`/`markup_percent` from such a user's own line data, so this is UI-layer
 * masking on top of a real server-side gate, not the only thing standing between them and the
 * numbers). Submitting also validates them when visible (mirrors Quantity/Selling price's
 * existing validate-then-setError pattern): Markup % must land in the backend's accepted
 * [0, 100000] range, and Unit cost (when not derived) must be non-negative — a blank field is
 * always valid, and on the edit form specifically means "leave the previous value alone"
 * rather than silently nulling it out on save.
 *
 * EDIT mode (`editingLine` set): the dialog bypasses the search/selected/creatingNew flow
 * entirely and opens directly into an edit form pre-filled from the line (no "pick from price
 * book" step). Submitting calls `onUpdate(editingLine.id, patch)` with a DIFF patch — only the
 * fields whose value actually changed relative to `editingLine`. The add-flow (search / selected /
 * creatingNew) is untouched and unreachable while `editingLine` is set.
 *
 * Description (v12): both forms carry a Description textarea in addition to Name — the two are
 * joined the same way `LineItemRow`'s `splitDescription()` reads them back apart (`name\ndetail`)
 * so a filled-in Description actually shows up in the table instead of the row rendering blank.
 *
 * Save to price book (both forms): a toggle that creates a fresh, standalone `PriceBookItem` from
 * the form's current Name/Type/Price/Taxable — gated on `canSaveToPriceBook`, default OFF, no
 * caption. On the EDIT form this only ADDS a new catalog entry; it never rewrites the line's own
 * `price_book_item_id` (that link is set once at creation and is immutable here — editing a line's
 * fields never silently re-points it at a different catalog row).
 *
 * Delete (edit form only): a left-aligned ghost-danger footer button that confirms via
 * `useConfirm()`/`deleteLineItemPrompt` (SRVW-248) before calling the optional `onDelete(lineId)`
 * prop - same shared prompt `LineItemRow.tsx`'s own trash icon uses. Rendered ONLY when a caller
 * actually supplies `onDelete` - absent, not disabled, until a wiring wave threads a real delete
 * handler through (mirrors this file's existing `canSeePricing`/`canSaveToPriceBook`
 * absent-not-disabled gating philosophy).
 *
 * On submit (add flow), calls onAdd(payload) with the AddLineItemPayload for
 * POST /api/invoices/:id/line-items. The dialog stays open if the parent rejects — it closes on
 * success (driven by the parent clearing addOpen/editingLine, mirroring the existing convention).
 *
 * Estimate extensions (v12 Wave 3) — all optional, all default OFF, so Job/Invoice (which never
 * pass them) render byte-for-byte the same as before:
 *   - `initialQuery` — jumps straight into the creatingNew form pre-filled with this text (same
 *     state `startCreate()` would set) instead of opening on the blank search screen. This is
 *     what lets `PriceBookPicker`'s "Add new item: <query>" card hand its typed query straight
 *     through to this modal rather than reopening blank (the deferred gap noted in that file).
 *   - `extraCreateContent` — an opaque slot rendered inside the create form only (right under
 *     Description), so Estimate can drop in its existing, real `AiImagePanel` (image suggestions
 *     already backed by `getAiImageSuggestions`) without this file importing anything estimate-
 *     specific. Deliberately NOT offered on the edit form or paired with any "Polish" affordance —
 *     the old estimate dialog's text "Polish"/"Write" buttons were preview-only/unbacked by a real
 *     model, which this program's no-fake-button rule excludes from the new shared modal entirely.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Search, Loader2, Plus, Package, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AutoGrowTextarea } from '@/components/ui/autoGrowTextarea';
import { LINE_DESCRIPTION_MAX, combineDescription } from '@/lib/lineItems';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn, extractApiError, formatCurrency } from '@/lib/utils';
import { ProductThumb } from './ProductThumb';
import { toNum } from './money';
import { useConfirm } from '@/hooks/useConfirm';
import { deleteLineItemPrompt } from '@/lib/confirmPrompts';
import {
  searchPriceBookItems,
  listPriceBookItems,
  createPriceBookItem,
  type AddLineItemPayload,
  type UpdateLineItemPayload,
  type PriceBookItem,
} from '@/lib/api/invoices';
import type { InvoiceLineItem } from '@/lib/api/jobs';

// #2053 slice 1 — is_optional/is_selected are estimate-only (backend/src/controllers/
// estimate.controller.ts's lineItemObjectSchema); widened locally, same precedent as
// `description` below, rather than editing the shared Job/Invoice payload types. Exported so a
// caller like `EstimateLineItemsEditor` can type its own `onAdd`/`onUpdate` handlers against the
// same wider shape without an unsafe cast. Only ever populated when `showOptionalToggle` is true.
export type LineAddPayload = AddLineItemPayload & { is_optional?: boolean; is_selected?: boolean };
export type LineUpdatePatch = UpdateLineItemPayload & { description?: string; is_optional?: boolean; is_selected?: boolean };

export interface AddLineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (payload: LineAddPayload) => Promise<void> | void;
  loading?: boolean;
  /** When true, the "Also save to price book" option is offered (Admin/Dispatcher). */
  canSaveToPriceBook?: boolean;
  /**
   * Reveal the Markup %/Unit cost VALUES (both the new-item form and the edit form). Mirrors the
   * backend's canSeePricing gate. The two fields' columns always render (v12 SECTION 04 — the
   * 4-up grid never collapses); when this is false, the fields themselves render disabled with
   * their value masked blank rather than being removed from the layout. Defaults to false
   * (fail-closed) so a caller that forgets to thread this through never over-shows pricing.
   */
  canSeePricing?: boolean;
  /**
   * When set, the dialog opens DIRECTLY into an edit form pre-filled from this existing line —
   * the search/selected/creatingNew flow is bypassed entirely (no "pick from price book" step).
   */
  editingLine?: InvoiceLineItem | null;
  /** Called instead of onAdd when editingLine is set — receives a diff patch (changed fields only). */
  onUpdate?: (lineId: string, patch: LineUpdatePatch) => Promise<void> | void;
  /**
   * Deletes the line currently being edited. Only meaningful with `editingLine` set. The
   * edit-mode footer's Delete button renders ONLY when this is provided (absent, not disabled,
   * until a wiring wave threads a real delete handler through — v12 SECTION 04).
   */
  onDelete?: (lineId: string) => Promise<void> | void;
  /**
   * When set (and `editingLine` is not), the dialog skips the blank search screen and opens
   * DIRECTLY into the creatingNew form pre-filled with this text as the new item's Name (search
   * box is pre-filled too, so "Back to search" still shows matching results for it). This is how
   * `PriceBookPicker`'s "Add new item: <query>" card hands its typed query through to this same
   * modal instead of it reopening blank. Ignored while `editingLine` is set. Defaults to
   * undefined (off) — omitting it keeps today's Job/Invoice "open on blank search" behavior.
   */
  initialQuery?: string;
  /**
   * Opaque content rendered inside the create form only, directly under Description — a slot for
   * Estimate to inject its own existing `AiImagePanel` (real image suggestions) without this file
   * importing estimate code. Not offered on the edit form. No AI "Polish" affordance belongs here
   * — that stayed unbacked-by-a-real-model in the legacy estimate dialog and is excluded here.
   */
  extraCreateContent?: ReactNode;
  /**
   * SRVW-221: called instead of just closing when the create form was reached via `initialQuery`
   * (i.e. PriceBookPicker's "Add new item: <query>" hand-off, `initialQuery !== undefined`) and
   * the user backs out of it - "Back to price book", Cancel, Escape, the close X, or an overlay
   * click all route through this. The caller is expected to REOPEN its PriceBookPicker here
   * (flip its `open` prop back to true) - that picker keeps its tab/category/search/qtys intact
   * across the round trip (it skips its own reset-on-open for this one reopen; see
   * PriceBookPicker.tsx's `pendingReturnRef`), though not its scroll position, which is lost like
   * any other close/reopen. Ignored (falls back to a plain close) when omitted, or when the
   * create form was reached by typing into this dialog's own search box instead.
   */
  onBackToPicker?: () => void;
  /**
   * #2053 slice 1 — reveal the Optional/Selected switches (create + edit forms). Default
   * `false`, absent-not-disabled: Job/Invoice never pass this, so their switches never render and
   * their request bodies never carry the keys (byte-identical to today). Only
   * `EstimateLineItemsEditor` passes `true`. R6 — same prop name across AddLineDialog,
   * ScopeOfWorkCard and LineItemsTable/LineItemRow, so one grep proves the gating.
   */
  showOptionalToggle?: boolean;
}

/**
 * `UpdateLineItemPayload`/`AddLineItemPayload` (frontend/src/lib/api/invoices.ts) don't declare
 * `description` yet — Job's PATCH endpoint already accepts it (job-lines.controller.ts's
 * updateLineSchema), Invoice's doesn't yet (invoice-lines.controller.ts's updateLineSchema is
 * missing the field). Widening both payload types locally (rather than editing those shared
 * files, out of this component's scope) keeps the outgoing request correctly typed and lets
 * `description` flow through once the shared type/backend catch up. `LineAddPayload`/
 * `LineUpdatePatch` (is_optional/is_selected) are declared with the props above, since the
 * `onAdd`/`onUpdate` prop types need them too.
 */

/**
 * #2090 slice A4 — what the Optional switch's recommendation half is editing: the rep's own
 * `rep_selected`, with `?? is_selected` as the no-backfill fallback for a row that predates the
 * column. Byte-identical to `checkboxChecked` in LineItemRow.tsx on purpose — the row checkbox and
 * this switch are two controls over ONE value, and they must read it the same way or the dialog
 * shows the customer's answer while the row beside it shows the rep's.
 *
 * Only ever consulted when `showOptionalToggle` is true, so Job and Invoice are untouched.
 */
function repSelection(line: { is_selected?: boolean | null; rep_selected?: boolean | null }): boolean {
  return line.rep_selected ?? line.is_selected ?? true;
}

/** unit_cost = unit_price / (1 + markup_percent / 100). Caller guards markupPercent > -100. */
function deriveCostFromMarkup(unitPrice: number, markupPercent: number): number {
  return unitPrice / (1 + markupPercent / 100);
}

/**
 * The inverse of `deriveCostFromMarkup` — pre-fills the edit form's Markup % field from
 * unit_cost/unit_price when the line's own `markup_percent` column is null, so the field shows a
 * real number instead of a "0" placeholder that contradicts LineTotalBar's live margin readout.
 * Only derives when the result is a LEGAL markup (R3): `unitCost > 0` (never divide by a stored
 * zero cost) and `unitPrice >= unitCost` (a below-cost line would derive a negative markup, which
 * `validatePricingFields` always rejects, permanently blocking every other edit to that line).
 * Capped at 100000 for the same reason the backend's zod schema caps it there.
 */
function deriveMarkupFromCost(unitCost: number, unitPrice: number): number | null {
  if (!(unitCost > 0) || !(unitPrice >= unitCost)) return null;
  const derived = ((unitPrice - unitCost) / unitCost) * 100;
  if (!Number.isFinite(derived)) return null;
  return Math.min(100000, Math.max(0, derived));
}

/** Trims a derived markup to 2 decimals and strips any trailing zeros (345, not 345.00). */
function formatMarkup(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/**
 * The create/price-book-add payload's `unit_cost` (R4). `PriceBookItem.unit_cost` is typed
 * `string | number`; the API sends `null` for a cost-less catalog item. Guards null/empty AND a
 * non-finite conversion (`Number('abc')` → `NaN`, which the backend's zod schema would 400 on) —
 * a naive `!= null` check alone would still forward a malformed value instead of just omitting it.
 */
function priceBookCostForPayload(raw: string | number | null | undefined): number | undefined {
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Local mirror of LineItemRow.tsx's splitDescription — first line is the item name, rest is detail. */
function splitDescription(description: string): { name: string; detail: string } {
  const parts = description.split('\n');
  return { name: parts[0] || '', detail: parts.slice(1).join('\n') };
}

/**
 * Name and Description share ONE stored field (`name\ndetail`), so the budget has to be measured
 * on the combined string the API will actually receive - a counter on the textarea alone would
 * disagree with the server by the length of the name (#1604). Returns a friendly message, or
 * null when the description fits.
 */
function validateDescriptionLength(name: string, detail: string): string | null {
  const length = combineDescription(name, detail).length;
  if (length <= LINE_DESCRIPTION_MAX) return null;
  return `Description is too long: ${length.toLocaleString()} of ${LINE_DESCRIPTION_MAX.toLocaleString()} characters. The item name counts toward this limit.`;
}

/**
 * Validates Markup %/Unit cost before submit — shared by BOTH the new-item form and the edit
 * form (same fields, same rules). Mirrors Quantity/Selling price's existing validate-then-
 * setError pattern: returns a friendly error string, or null when the fields are acceptable.
 * A blank field is always valid here (never an error) — an empty Markup %/Unit cost simply
 * means "not set" (new-item form) or "no change" (edit form; see handleSubmit's nextMarkup/
 * nextCost, which treat a blank field as leaving the previous value alone rather than silently
 * nulling it out).
 */
function validatePricingFields(
  newMarkup: string,
  markupNum: number | null,
  costIsDerived: boolean,
  newCost: string,
): string | null {
  // Markup % — matches the backend's addLineSchema/updateLineSchema z.number().min(0).max(100000).
  if (newMarkup.trim() !== '' && (markupNum == null || Number.isNaN(markupNum) || markupNum < 0 || markupNum > 100000)) {
    return 'Markup % must be between 0 and 100,000.';
  }
  // Unit cost — only user-editable (and thus only validated) while NOT derived from markup; a
  // derived cost is always >= 0 by construction (unit_price >= 0, markup already validated above).
  if (!costIsDerived && newCost.trim() !== '') {
    const costNum = parseFloat(newCost);
    if (Number.isNaN(costNum) || costNum < 0) {
      return 'Unit cost must be a non-negative number.';
    }
  }
  return null;
}

/**
 * Live totalbar (v12 SECTION 04) — identical markup shared by both the new-item and edit forms.
 * Line total is always shown (qty × price — no pricing gate, it's the same number Unit price
 * already exposes). Markup %/Margin % and the "stored, not re-derived" note are canSeePricing-
 * gated, matching this file's absent-not-disabled treatment of pricing data everywhere else.
 */
function LineTotalBar({
  lineTotal,
  markupPercent,
  marginPercent,
  canSeePricing,
}: {
  lineTotal: number;
  markupPercent: number | null;
  marginPercent: number | null;
  canSeePricing: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between rounded-lg border border-border bg-background-light/40 px-3 py-2">
        <span className="text-sm text-text-secondary">
          Line total
          {canSeePricing && markupPercent != null && !Number.isNaN(markupPercent) && (
            <>
              {' '}
              · <span className="font-semibold text-text-primary">Markup {Math.round(markupPercent)}%</span>
            </>
          )}
          {canSeePricing && marginPercent != null && (
            <>
              {' '}
              · <span className="font-semibold text-success">Margin {Math.round(marginPercent)}%</span>
            </>
          )}
        </span>
        <span className="text-sm font-bold text-text-primary">{formatCurrency(lineTotal)}</span>
      </div>
      {canSeePricing && (
        <p className="text-[11px] text-text-secondary">
          <span className="font-medium text-text-primary">Markup is stored on the line</span>, not re-derived.
        </p>
      )}
    </div>
  );
}

export function AddLineDialog({
  open,
  onOpenChange,
  onAdd,
  loading = false,
  canSaveToPriceBook = false,
  canSeePricing = false,
  editingLine = null,
  onUpdate,
  onDelete,
  initialQuery,
  extraCreateContent,
  onBackToPicker,
  showOptionalToggle = false,
}: AddLineDialogProps) {
  // Search
  const [searchQ, setSearchQ] = useState('');
  const [results, setResults] = useState<PriceBookItem[]>([]);
  const [searching, setSearching] = useState(false);

  // Selection / creation
  const [selected, setSelected] = useState<PriceBookItem | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  // Shared + new-item fields
  const [quantity, setQuantity] = useState('1');
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newType, setNewType] = useState<'SERVICE' | 'MATERIAL'>('MATERIAL');
  const [newPrice, setNewPrice] = useState('');
  const [newMarkup, setNewMarkup] = useState('');
  // R2 — gates BOTH markup_percent and unit_cost on save. True whenever the user (or a stored,
  // non-null markup_percent shown as-is) set Markup % directly; false only for the one case where
  // the edit form's pre-fill DERIVED a value the user never touched — that derived value must
  // behave exactly like the blank field it replaces (Unit cost stays editable/shows the stored
  // cost, and an untouched save sends neither key). Defaults true so the new-item form's existing
  // markup/cost sync (unrelated to this fix) is unchanged.
  const [markupTouched, setMarkupTouched] = useState(true);
  const [newCost, setNewCost] = useState('');
  const [newTaxable, setNewTaxable] = useState(true);
  // #2053 slice 1 — shared by both forms, same pattern as newTaxable; only read/written when
  // showOptionalToggle is true.
  const [newOptional, setNewOptional] = useState(false);
  const [newSelected, setNewSelected] = useState(true);
  const [saveToPriceBook, setSaveToPriceBook] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { confirm, confirmDialog } = useConfirm();
  // SRVW-221: true while the open creatingNew form was reached via `initialQuery` (the
  // PriceBookPicker "Add new item" hand-off) rather than by typing into this dialog's own search
  // box. Set by the `initialQuery` effect below; drives whether Back/Cancel/Escape/overlay-close
  // route to `onBackToPicker` instead of their previous plain-close behavior.
  const [cameFromPicker, setCameFromPicker] = useState(false);

  const reset = () => {
    setSearchQ('');
    setResults([]);
    setSelected(null);
    setCreatingNew(false);
    setBrowsing(false);
    setQuantity('1');
    setNewName('');
    setNewDescription('');
    setNewType('MATERIAL');
    setNewPrice('');
    setNewMarkup('');
    setMarkupTouched(true);
    setNewCost('');
    setNewTaxable(true);
    setNewOptional(false);
    setNewSelected(true);
    setSaveToPriceBook(false);
    setError(null);
    setCameFromPicker(false);
  };

  /**
   * SRVW-221: the shared exit path for a picker-originated create form - "Back to price book",
   * Cancel, Escape, the close X, and an overlay click all funnel through this so every one of
   * them returns to the picker (rather than only the labeled back button). Resets this dialog's
   * own fields so a later fresh open never carries stale creatingNew state into it.
   */
  const backToPicker = () => {
    onBackToPicker?.();
    reset();
  };

  // Markup %/Unit cost sync — shared by BOTH the new-item form and the edit form (they never
  // render simultaneously, so reusing one set of state/derivations for both is safe): while
  // Markup % holds a usable value (> -100 — see deriveCostFromMarkup's guard), Unit cost is
  // derived live and its input disables; otherwise Unit cost is a normal, freely-editable field.
  const markupNum = newMarkup.trim() === '' ? null : parseFloat(newMarkup);
  // R2 — an untouched, pre-fill-DERIVED markup must not flip Unit cost to derived/disabled.
  const costIsDerived = markupTouched && markupNum != null && !Number.isNaN(markupNum) && markupNum > -100;
  const derivedCost = costIsDerived ? deriveCostFromMarkup(parseFloat(newPrice) || 0, markupNum as number) : null;

  // Name and Description share one stored field, so the live count is taken on the combined
  // string the API will receive. Kept quiet until the description is genuinely long - a counter
  // on a two-line note is noise, and 50,000 characters is only ever reached by a pasted document.
  const descriptionLength = combineDescription(newName.trim(), newDescription).length;
  const showDescriptionCount = descriptionLength > LINE_DESCRIPTION_MAX * 0.8;

  // Live totalbar (v12 SECTION 04) — shared by both forms. Line total only needs qty/price (no
  // pricing gate). Margin needs an "effective" unit cost — the live-derived one while Markup %
  // holds a usable value, otherwise whatever's directly typed into Unit cost — mirroring
  // LineItemRow's own per-row margin sub-line formula, read from the same three numbers.
  const qtyNum = parseFloat(quantity) || 0;
  const priceNum = parseFloat(newPrice) || 0;
  const lineTotal = qtyNum * priceNum;
  const effectiveCost = costIsDerived
    ? derivedCost
    : newCost.trim() !== '' && !Number.isNaN(parseFloat(newCost))
      ? parseFloat(newCost)
      : null;
  const marginPercent = effectiveCost != null && priceNum > 0 ? ((priceNum - effectiveCost) / priceNum) * 100 : null;

  // Pre-fill the shared form fields from the line being edited whenever a different one opens.
  useEffect(() => {
    if (!editingLine) return;
    const { name, detail } = splitDescription(editingLine.description);
    setNewName(name);
    setNewDescription(detail);
    setQuantity(String(toNum(editingLine.quantity)));
    setNewPrice(String(toNum(editingLine.unit_price)));
    // R2/R3 — a stored markup_percent renders as-is (never re-derived); a null one derives from
    // unit_cost/unit_price when that derivation is legal (R3), landing UNTOUCHED so an untouched
    // save persists neither markup_percent nor unit_cost (R2); otherwise the field stays blank.
    if (editingLine.markup_percent != null) {
      setNewMarkup(String(toNum(editingLine.markup_percent)));
      setMarkupTouched(true);
    } else {
      const unitCost = editingLine.unit_cost != null ? toNum(editingLine.unit_cost) : null;
      const derived = unitCost != null ? deriveMarkupFromCost(unitCost, toNum(editingLine.unit_price)) : null;
      if (derived != null) {
        setNewMarkup(formatMarkup(derived));
        setMarkupTouched(false);
      } else {
        setNewMarkup('');
        setMarkupTouched(true);
      }
    }
    setNewCost(editingLine.unit_cost != null ? String(toNum(editingLine.unit_cost)) : '');
    setNewTaxable(editingLine.is_taxable);
    setNewOptional(editingLine.is_optional ?? false);
    // #2090 slice A4 — the recommendation half starts from the REP's own column, the same value
    // and the same `?? is_selected` no-backfill fallback the row checkbox renders
    // (`checkboxChecked`, LineItemRow.tsx). After a send the two columns disagree, and starting
    // from the customer's answer makes the dialog show one thing and the row another.
    setNewSelected(repSelection(editingLine));
    setNewType(editingLine.item_type);
    setSaveToPriceBook(false);
    setError(null);
  }, [editingLine]);

  // `initialQuery` (v12 Wave 3 — Estimate only): when the dialog opens fresh with a query and no
  // `editingLine`, skip the blank search screen and jump straight into the creatingNew form
  // pre-filled with it — mirrors `startCreate()`'s own resets. Guarded on `initialQuery !==
  // undefined` (not just truthy) so an intentionally-blank query (picker's "Add new item" card
  // clicked with nothing typed) still opens the create form directly rather than the search
  // screen. `open`/`editingLine` in the deps (re-)run this each time the dialog opens fresh;
  // `creatingNew` flips true here before the search-debounce effect below ever fires a fetch.
  useEffect(() => {
    if (!open || editingLine || initialQuery === undefined) return;
    setSearchQ(initialQuery);
    setSelected(null);
    setCreatingNew(true);
    setNewName(initialQuery);
    setNewDescription('');
    setNewType('MATERIAL');
    setNewPrice('');
    setNewMarkup('');
    setMarkupTouched(true);
    setNewCost('');
    setNewTaxable(true);
    setNewOptional(false);
    setNewSelected(true);
    setSaveToPriceBook(false);
    setQuantity('1');
    setError(null);
    // SRVW-221: this open came from PriceBookPicker's "Add new item" hand-off - Back/Cancel/
    // Escape/overlay-close should return to that picker, not behave as a plain close.
    setCameFromPicker(true);
  }, [open, editingLine, initialQuery]);

  // Debounced search — only while searching/browsing (not after a pick / when creating / when editing).
  useEffect(() => {
    if (selected || creatingNew || editingLine) return;
    const query = searchQ.trim();
    if (!browsing && !query) {
      setResults([]);
      return;
    }
    let active = true;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = browsing
          ? await listPriceBookItems(query || undefined)
          : await searchPriceBookItems(query);
        if (active) setResults(r);
      } catch {
        if (active) setResults([]);
      } finally {
        if (active) setSearching(false);
      }
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [searchQ, selected, creatingNew, editingLine, browsing]);

  const pickItem = (item: PriceBookItem) => {
    setSelected(item);
    setQuantity('1');
    setError(null);
  };

  const startCreate = () => {
    setCreatingNew(true);
    setNewName(searchQ.trim());
    setNewDescription('');
    setNewType('MATERIAL');
    setNewPrice('');
    setNewMarkup('');
    setMarkupTouched(true);
    setNewCost('');
    setNewTaxable(true);
    setNewOptional(false);
    setNewSelected(true);
    setSaveToPriceBook(false);
    setQuantity('1');
    setError(null);
  };

  const backToSearch = () => {
    setSelected(null);
    setCreatingNew(false);
    setError(null);
  };

  const handleSubmit = async () => {
    const qty = parseFloat(quantity);
    if (isNaN(qty) || qty <= 0) {
      setError('Quantity must be a positive number.');
      return;
    }

    // ── Edit an existing line — a diff patch, never the price-book/search flow below. ──────
    if (editingLine) {
      const name = newName.trim();
      if (!name) {
        setError('Name is required.');
        return;
      }

      const price = parseFloat(newPrice);
      if (isNaN(price) || price < 0) {
        setError('Selling price must be a non-negative number.');
        return;
      }

      const pricingError = validatePricingFields(newMarkup, markupNum, costIsDerived, newCost);
      if (pricingError) {
        setError(pricingError);
        return;
      }
      const descriptionError = validateDescriptionLength(name, newDescription);
      if (descriptionError) {
        setError(descriptionError);
        return;
      }

      const prevMarkup = editingLine.markup_percent != null ? toNum(editingLine.markup_percent) : null;
      const prevCost = editingLine.unit_cost != null ? toNum(editingLine.unit_cost) : null;
      const prevType = editingLine.item_type;
      // An emptied Markup %/Unit cost field is treated as "no change", never a silent,
      // unconfirmed null-out of a previously-set value (a blank number input is a completely
      // normal state a user can land in without intending to clear anything). R2: while the field
      // holds a pre-fill-DERIVED value the user never touched, treat it exactly like "no change"
      // too — it never actually reflects the user's intent, only a readout.
      const nextMarkup = !markupTouched
        ? prevMarkup
        : newMarkup.trim() === ''
          ? prevMarkup
          : (markupNum as number);
      const nextCost = costIsDerived
        ? derivedCost
        : newCost.trim() === ''
          ? prevCost
          : parseFloat(newCost);
      // Name + Description recombine into the single stored `description` string the same way
      // splitDescription() reads them back apart (name\ndetail).
      const nextDescription = combineDescription(name, newDescription);

      const patch: LineUpdatePatch = {};
      if (qty !== toNum(editingLine.quantity)) patch.quantity = qty;
      if (price !== toNum(editingLine.unit_price)) patch.unit_price = price;
      if (newTaxable !== editingLine.is_taxable) patch.is_taxable = newTaxable;
      // #2053 slice 1 — keys omitted entirely (not sent as false/true) when the toggle is off,
      // so a Job/Invoice edit's request body stays byte-identical to today.
      if (showOptionalToggle) {
        if (newOptional !== (editingLine.is_optional ?? false)) patch.is_optional = newOptional;
        // #2090 slice A4 — diffed against the REP's column, for the same reason the pre-fill reads
        // it. Against `is_selected` this drops the write whenever the customer's answer already
        // happens to equal what the rep has just asked for, and the recommendation is lost.
        if (newSelected !== repSelection(editingLine)) patch.is_selected = newSelected;
      }
      if (nextMarkup !== prevMarkup) patch.markup_percent = nextMarkup;
      if (nextCost !== prevCost) patch.unit_cost = nextCost;
      if (nextDescription !== editingLine.description) patch.description = nextDescription;
      if (newType !== prevType) patch.item_type = newType;

      // Optional: also persist a fresh, standalone catalog entry from the line's current values
      // (mirrors the new-item flow below) — never rewrites THIS line's own price_book_item_id.
      // Reads the EDITED type (newType), not the line's original item_type — a changed Type on
      // this same save must be what the new catalog entry carries.
      if (saveToPriceBook && canSaveToPriceBook) {
        try {
          await createPriceBookItem({
            name,
            type: newType,
            unit_price: price,
            taxable: newTaxable,
            // The catalog entry carries the same cost the line does - derived from Markup % when
            // that field is usable, otherwise the directly-typed Unit cost. A null cost (both
            // fields blank and none previously set) is omitted, never sent as 0.
            ...(nextCost != null ? { unit_cost: nextCost } : {}),
          });
        } catch (err: unknown) {
          setError(extractApiError(err, 'Could not save to the price book.'));
          return;
        }
      }

      setSubmitting(true);
      setError(null);
      try {
        await onUpdate?.(editingLine.id, patch);
        reset();
      } catch (err: unknown) {
        setError(extractApiError(err, 'Failed to update line item.'));
      } finally {
        setSubmitting(false);
      }
      return;
    }

    let payload: LineAddPayload;

    if (selected) {
      const selectedCost = priceBookCostForPayload(selected.unit_cost);
      payload = {
        description: selected.description ? `${selected.name}\n${selected.description}` : selected.name,
        item_type: selected.type,
        quantity: qty,
        unit_price: Number(selected.unit_price),
        is_taxable: selected.taxable,
        price_book_item_id: selected.id,
        // The catalog item's own cost rides along (R4) — markup_percent stays absent/null here,
        // never derived-and-stored on add (the 100% markup cap widening is #1991, out of scope).
        ...(selectedCost !== undefined ? { unit_cost: selectedCost } : {}),
      };
    } else if (creatingNew) {
      const name = newName.trim();
      const price = parseFloat(newPrice);
      if (!name) {
        setError('Name is required.');
        return;
      }
      if (isNaN(price) || price < 0) {
        setError('Selling price must be a non-negative number.');
        return;
      }
      const pricingError = validatePricingFields(newMarkup, markupNum, costIsDerived, newCost);
      if (pricingError) {
        setError(pricingError);
        return;
      }
      const descriptionError = validateDescriptionLength(name, newDescription);
      if (descriptionError) {
        setError(descriptionError);
        return;
      }
      payload = {
        description: combineDescription(name, newDescription),
        item_type: newType,
        quantity: qty,
        unit_price: price,
        is_taxable: newTaxable,
        // #2053 slice 1 — keys omitted entirely when the toggle is off (Job/Invoice payloads
        // stay byte-identical to today).
        ...(showOptionalToggle ? { is_optional: newOptional, is_selected: newOptional ? newSelected : true } : {}),
        // Markup % (when usable) always ships with its live-derived Unit cost; otherwise a
        // directly-typed Unit cost ships alone (guard mirrors costIsDerived above).
        ...(costIsDerived
          ? { markup_percent: markupNum as number, unit_cost: derivedCost as number }
          : newCost.trim() !== ''
            ? { unit_cost: parseFloat(newCost) }
            : {}),
      };
      // Optional: persist a reusable catalog item, then reference it on the line.
      if (saveToPriceBook && canSaveToPriceBook) {
        try {
          const created = await createPriceBookItem({
            name,
            type: newType,
            unit_price: price,
            taxable: newTaxable,
            // Same cost the line ships with (see effectiveCost) - omitted when blank, never 0.
            ...(effectiveCost != null ? { unit_cost: effectiveCost } : {}),
          });
          if (created?.id) payload.price_book_item_id = created.id;
        } catch (err: unknown) {
          setError(extractApiError(err, 'Could not save to the price book.'));
          return;
        }
      }
    } else {
      setError('Search for an item, or add a new one.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await onAdd(payload);
      reset();
    } catch (err: unknown) {
      setError(extractApiError(err, 'Failed to add line item.'));
    } finally {
      setSubmitting(false);
    }
  };

  /** Edit-mode footer's Delete button (SRVW-248) - confirms via the same shared prompt
   *  LineItemRow's own trash icon uses before calling `onDelete`. Only reachable when `onDelete`
   *  is provided (button renders conditionally). */
  const handleDelete = async () => {
    if (!editingLine || !onDelete) return;
    const { name } = splitDescription(editingLine.description);
    if (!(await confirm(deleteLineItemPrompt(name)))) return;
    setSubmitting(true);
    setError(null);
    try {
      await onDelete(editingLine.id);
      reset();
    } catch (err: unknown) {
      setError(extractApiError(err, 'Failed to delete line item.'));
    } finally {
      setSubmitting(false);
    }
  };

  const isLoading = loading || submitting;
  const canSubmit = editingLine != null || selected != null || creatingNew;

  return (
    <>
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isLoading) return;
        // SRVW-221: Escape / overlay click / the close X all arrive here as `next === false`.
        // When the open form is a picker hand-off, route them back to the picker instead of the
        // plain close below - the same rule the Cancel button and "Back to price book" apply.
        if (!next && cameFromPicker && onBackToPicker) {
          backToPicker();
          return;
        }
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editingLine ? 'Edit line item' : 'Add line item'}</DialogTitle>
        </DialogHeader>

        {editingLine ? (
          <div className="space-y-3 rounded-xl border border-border bg-background-light/40 p-4">
            <div className="space-y-1">
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Item name" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-description">Description</Label>
              <AutoGrowTextarea
                id="edit-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Optional detail shown under the item name"
                maxLength={LINE_DESCRIPTION_MAX}
              />
              {showDescriptionCount && (
                <p className={cn('text-xs', descriptionLength > LINE_DESCRIPTION_MAX ? 'text-danger' : 'text-text-secondary')}>
                  {descriptionLength.toLocaleString()} / {LINE_DESCRIPTION_MAX.toLocaleString()} characters
                </p>
              )}
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-qty">Quantity</Label>
                <Input id="edit-qty" type="number" min={0.01} step={0.01} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-price">Price ($)</Label>
                <Input id="edit-price" type="number" min={0} step={0.01} value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-markup">Markup %</Label>
                <Input
                  id="edit-markup"
                  type="number"
                  step={0.01}
                  value={canSeePricing ? newMarkup : ''}
                  onChange={(e) => {
                    setNewMarkup(e.target.value);
                    setMarkupTouched(true);
                  }}
                  disabled={!canSeePricing}
                  placeholder={canSeePricing ? '0' : '—'}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-cost">Unit cost ($)</Label>
                <Input
                  id="edit-cost"
                  type="number"
                  min={0}
                  step={0.01}
                  value={
                    !canSeePricing ? '' : costIsDerived ? (derivedCost != null ? derivedCost.toFixed(2) : '') : newCost
                  }
                  onChange={(e) => setNewCost(e.target.value)}
                  disabled={!canSeePricing || costIsDerived}
                  placeholder={canSeePricing ? '0.00' : '—'}
                />
                {canSeePricing && costIsDerived && <p className="mt-1 text-[11px] text-text-secondary">Synced from markup</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-type">Type</Label>
                <Select value={newType} onValueChange={(v) => setNewType(v as 'SERVICE' | 'MATERIAL')}>
                  <SelectTrigger id="edit-type" aria-label="Item type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MATERIAL">Material</SelectItem>
                    <SelectItem value="SERVICE">Service</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-end gap-4 pb-2">
                <div className="flex items-center gap-2">
                  <Switch id="edit-taxable" checked={newTaxable} onCheckedChange={setNewTaxable} />
                  <Label htmlFor="edit-taxable" className="cursor-pointer">Taxable</Label>
                </div>
                {showOptionalToggle && (
                  <div className="flex items-center gap-2">
                    {/* READ THIS IF YOU ARE CHANGING THIS SWITCH. Flipping it also sets
                        `newSelected`, the rep's RECOMMENDATION: it reads and diffs against
                        `rep_selected` (see `repSelection` above and the patch build in
                        `handleSave`), exactly as the row checkbox in LineItemRow.tsx does, and the
                        server routes the `is_selected` key both controls send to `rep_selected`
                        once the estimate has left DRAFT (`routeSelectionWrite`, backend
                        estimate-lines.controller.ts). So a flip after send costs the customer
                        nothing - it is an offer for the NEXT send, which publishes it.
                        `is_optional` is the other half and is not routed: it IS the offer, so
                        changing it after send changes the document, and slice A5 is what revokes
                        the customer's link when the document moves. */}
                    <Switch
                      id="edit-optional"
                      checked={newOptional}
                      onCheckedChange={(v) => {
                        setNewOptional(v);
                        setNewSelected(!v);
                      }}
                      aria-label="Optional for this line"
                    />
                    <Label htmlFor="edit-optional" className="cursor-pointer">Optional</Label>
                  </div>
                )}
              </div>
            </div>
            {canSaveToPriceBook && (
              <div className="flex items-center gap-2">
                <Switch id="edit-save-pricebook" checked={saveToPriceBook} onCheckedChange={setSaveToPriceBook} />
                <Label htmlFor="edit-save-pricebook" className="cursor-pointer">Save to price book</Label>
              </div>
            )}
            <LineTotalBar
              lineTotal={lineTotal}
              markupPercent={markupNum}
              marginPercent={marginPercent}
              canSeePricing={canSeePricing}
            />
          </div>
        ) : (
          <>
        {/* Search box (always visible) */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <Input
            placeholder="Search the price book, or type a new item…"
            value={searchQ}
            onChange={(e) => {
              setSearchQ(e.target.value);
              setSelected(null);
              setCreatingNew(false);
            }}
            className="h-11 pl-9"
            aria-label="Search the price book"
            autoFocus
          />
        </div>

        {/* ── Selected catalog item → confirm quantity ─────────────── */}
        {selected && (
          <div className="space-y-3">
            <div className="flex items-center gap-3 rounded-xl border border-border bg-background-light/40 p-3">
              <ProductThumb
                src={selected.image_url}
                alt={selected.name}
                itemType={selected.type}
                size={48}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{selected.name}</p>
                <p className="text-xs text-text-secondary">
                  {selected.type === 'SERVICE' ? 'Service' : 'Material'} · ${Number(selected.unit_price).toFixed(2)}
                  {selected.taxable ? ' · taxable' : ''}
                </p>
              </div>
              <Button type="button" variant="link" size={null} onClick={backToSearch}>
                Change
              </Button>
            </div>
            <div className="w-32 space-y-1">
              <Label htmlFor="add-qty">Quantity</Label>
              <Input
                id="add-qty"
                type="number"
                min={0.01}
                step={0.01}
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
              />
            </div>
          </div>
        )}

        {/* ── Search results / create-new affordance ───────────────── */}
        {!selected && !creatingNew && (
          <div className="space-y-2">
            <Button
              type="button"
              variant={browsing ? 'solid' : 'outline'}
              tone={browsing ? 'neutral' : undefined}
              size="sm"
              className="w-full justify-center gap-2"
              onClick={() => {
                setBrowsing((b) => !b);
                setSelected(null);
                setCreatingNew(false);
              }}
            >
              <Package className="h-4 w-4" />
              {browsing ? 'Browsing price book' : 'Browse price book'}
            </Button>
            {searching && (
              <div className="flex justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-text-secondary" />
              </div>
            )}
            {!searching && results.length > 0 && (
              <ul className="max-h-56 divide-y divide-border overflow-y-auto rounded-xl border border-border">
                {results.map((item) => (
                  <li key={item.id}>
                    {/* Left raw: a search-result list-row with heterogeneous content
                        (thumbnail + name/description + price), not Button-shaped. */}
                    <button
                      type="button"
                      onClick={() => pickItem(item)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-background-light/60"
                    >
                      <ProductThumb src={item.image_url} alt={item.name} itemType={item.type} size={40} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-text-primary">{item.name}</span>
                        {item.description && (
                          <span className="block truncate text-xs text-text-secondary">{item.description}</span>
                        )}
                      </span>
                      <span className="whitespace-nowrap text-xs text-text-secondary">
                        {item.type === 'SERVICE' ? 'Service' : 'Material'} · ${Number(item.unit_price).toFixed(2)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {searchQ.trim() && !searching && (
              // Left raw: dashed/tinted "add new" CTA card - a distinct family with no
              // matching Button cell (same shape as PriceBookPicker.tsx's AdhocCard).
              <button
                type="button"
                onClick={startCreate}
                className="flex w-full items-center gap-2 rounded-xl border border-sage-200 bg-sage-50 px-3 py-2.5 text-left text-sm font-medium text-sage-700 transition-colors hover:bg-sage-200/60"
              >
                <span className="flex h-7 w-7 items-center justify-center rounded-md border border-dashed border-sage-200">
                  <Plus className="h-4 w-4" />
                </span>
                Add new item: <span className="font-bold">{searchQ.trim()}</span>
              </button>
            )}
            {browsing && !searching && results.length === 0 && (
              <p className="py-2 text-center text-sm text-text-secondary">
                Your price book is empty — type above to add a new item.
              </p>
            )}
            {!browsing && !searchQ.trim() && (
              <p className="py-2 text-center text-sm text-text-secondary">
                Start typing to search the price book, or browse it above.
              </p>
            )}
          </div>
        )}

        {/* ── New item form ────────────────────────────────────────── */}
        {creatingNew && (
          <div className="space-y-3 rounded-xl border border-dashed border-sage-200 bg-surface-light p-4">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-wider text-sage-700">New item</p>
              {/* SRVW-221: a picker-originated create form backs out to the picker (with its
                  browse state intact), never to this dialog's own blank search screen. */}
              <Button
                type="button"
                variant="link"
                size={null}
                onClick={cameFromPicker && onBackToPicker ? backToPicker : backToSearch}
              >
                {cameFromPicker && onBackToPicker ? 'Back to price book' : 'Back to search'}
              </Button>
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-name">Name</Label>
              <Input id="new-name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Item name" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-description">Description</Label>
              <AutoGrowTextarea
                id="new-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Optional detail shown under the item name"
                maxLength={LINE_DESCRIPTION_MAX}
              />
              {showDescriptionCount && (
                <p className={cn('text-xs', descriptionLength > LINE_DESCRIPTION_MAX ? 'text-danger' : 'text-text-secondary')}>
                  {descriptionLength.toLocaleString()} / {LINE_DESCRIPTION_MAX.toLocaleString()} characters
                </p>
              )}
            </div>
            {extraCreateContent}
            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label htmlFor="new-qty">Quantity</Label>
                <Input id="new-qty" type="number" min={0.01} step={0.01} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-price">Price ($)</Label>
                <Input id="new-price" type="number" min={0} step={0.01} value={newPrice} onChange={(e) => setNewPrice(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-markup">Markup %</Label>
                <Input
                  id="new-markup"
                  type="number"
                  step={0.01}
                  value={canSeePricing ? newMarkup : ''}
                  onChange={(e) => setNewMarkup(e.target.value)}
                  disabled={!canSeePricing}
                  placeholder={canSeePricing ? '0' : '—'}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="new-cost">Unit cost ($)</Label>
                <Input
                  id="new-cost"
                  type="number"
                  min={0}
                  step={0.01}
                  value={
                    !canSeePricing ? '' : costIsDerived ? (derivedCost != null ? derivedCost.toFixed(2) : '') : newCost
                  }
                  onChange={(e) => setNewCost(e.target.value)}
                  disabled={!canSeePricing || costIsDerived}
                  placeholder={canSeePricing ? '0.00' : '—'}
                />
                {canSeePricing && costIsDerived && <p className="mt-1 text-[11px] text-text-secondary">Synced from markup</p>}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="new-type">Type</Label>
                <Select value={newType} onValueChange={(v) => setNewType(v as 'SERVICE' | 'MATERIAL')}>
                  <SelectTrigger id="new-type" aria-label="Item type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MATERIAL">Material</SelectItem>
                    <SelectItem value="SERVICE">Service</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap items-end gap-4 pb-2">
                <div className="flex items-center gap-2">
                  <Switch id="new-taxable" checked={newTaxable} onCheckedChange={setNewTaxable} />
                  <Label htmlFor="new-taxable" className="cursor-pointer">Taxable</Label>
                </div>
                {showOptionalToggle && (
                  <div className="flex items-center gap-2">
                    <Switch
                      id="new-optional"
                      checked={newOptional}
                      onCheckedChange={(v) => {
                        setNewOptional(v);
                        setNewSelected(!v);
                      }}
                      aria-label="Optional for new line"
                    />
                    <Label htmlFor="new-optional" className="cursor-pointer">Optional</Label>
                  </div>
                )}
              </div>
            </div>
            {canSaveToPriceBook && (
              <div className="flex items-center gap-2">
                <Switch id="new-save-pricebook" checked={saveToPriceBook} onCheckedChange={setSaveToPriceBook} />
                <Label htmlFor="new-save-pricebook" className="cursor-pointer">Save to price book</Label>
              </div>
            )}
            <LineTotalBar
              lineTotal={lineTotal}
              markupPercent={markupNum}
              marginPercent={marginPercent}
              canSeePricing={canSeePricing}
            />
          </div>
        )}
          </>
        )}

        {error && <p className="text-sm text-danger">{error}</p>}

        <DialogFooter>
          {editingLine && onDelete && (
            <Button
              type="button"
              variant="ghost" tone="danger"
              className="mr-auto justify-start"
              onClick={handleDelete}
              disabled={isLoading}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            // SRVW-221: Cancel on a picker-originated create form returns to the picker too, not
            // just a plain close - same rule as the Dialog's own onOpenChange wrapper above.
            onClick={cameFromPicker && onBackToPicker ? backToPicker : () => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button type="button" variant="solid" tone="business" onClick={handleSubmit} disabled={isLoading || !canSubmit}>
            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {editingLine ? 'Save changes' : 'Add item'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {confirmDialog}
    </>
  );
}
