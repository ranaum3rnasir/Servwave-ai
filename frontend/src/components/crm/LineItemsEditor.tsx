import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/axios';
import { Button } from '@/components/ui/button';
import { UploadedImage } from '@/components/ui/uploaded-image';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { SelectField } from '@/components/form/SelectField';
import { cn, formatCurrency } from '@/lib/utils';
import { useMediaQuery } from '@/hooks/useIsMobile';
import { Package, Search, Plus, Wrench, Trash2, Loader2 } from 'lucide-react';

// ─── Public types ─────────────────────────────────────
//
// A reusable line-items editor extracted from the estimate form
// (standalone-invoices plan §5.3). Price-book/catalog picker + free-form rows +
// per-line taxable toggle / quantity / unit_price / per-line discount + computed
// line total + add/remove. It is GENERIC: a controlled `value` (LineItem[]) +
// `onChange`, with no estimate-only assumptions, so it serves both estimate and
// invoice authoring (InvoiceLineItem is field-identical to EstimateLineItem). It
// owns its own price-book search state; the parent owns the totals/tax (which it
// derives from this array).

/** One editable line item. `unit_price` may be '' transiently while typing. */
export interface LineItem {
  name: string;
  detail: string;
  quantity: number;
  unit_price: number;
  is_taxable: boolean;
  item_type: 'SERVICE' | 'MATERIAL';
  price_book_item_id?: string | null;
  unit_cost?: number | null;
  discount_type?: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  discount_value?: number | null;
  image_url?: string | null;
}

interface PriceBookSearchResult {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  type: 'SERVICE' | 'MATERIAL';
  unit_cost: number | null;
  unit_price: number;
  taxable: boolean;
  category: { id: string; name: string } | null;
}

interface PriceBookCategory {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface LineItemsEditorProps {
  value: LineItem[];
  onChange: (next: LineItem[]) => void;
  /** Per-row "name" validation messages (index-aligned). */
  itemNameErrors?: (string | undefined)[];
  /** Keep at least one row (Trash disabled at length 1). Defaults to true. */
  minOneRow?: boolean;
}

/** A blank free-form row (exported so parents can seed default values). */
export function blankLineItem(): LineItem {
  return {
    name: '',
    detail: '',
    quantity: 1,
    unit_price: '' as unknown as number,
    is_taxable: true,
    item_type: 'SERVICE',
    price_book_item_id: null,
    unit_cost: null,
    discount_type: null,
    discount_value: null,
    image_url: null,
  };
}

// ─── Component ────────────────────────────────────────

export function LineItemsEditor({ value, onChange, itemNameErrors, minOneRow = true }: LineItemsEditorProps) {
  // JS-gated breakpoint (NOT CSS lg:hidden dual-render): only ONE layout variant
  // is ever in the DOM — see useMediaQuery docs for why (portals, a11y, jsdom).
  // Same literal query as StandaloneInvoiceFormPage so the effect dep is stable.
  const isBelowLg = useMediaQuery('(max-width: 1023.98px)');
  const [pbQuery, setPbQuery] = useState('');
  const [pbSuggestions, setPbSuggestions] = useState<PriceBookSearchResult[]>([]);
  const [pbShowDropdown, setPbShowDropdown] = useState(false);
  const [pbLoading, setPbLoading] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedTypeFilter, setSelectedTypeFilter] = useState<'SERVICE' | 'MATERIAL' | null>(null);
  const pbContainerRef = useRef<HTMLDivElement>(null);
  const pbTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pbAbortRef = useRef<AbortController | null>(null);

  const { data: categoriesData } = useQuery({
    queryKey: ['price-book-categories'],
    queryFn: async () => {
      const { data } = await api.get('/api/price-book/categories');
      return data.data as PriceBookCategory[];
    },
  });

  const fetchPbSuggestions = useCallback(async (text: string, categoryId?: string | null, typeFilter?: string | null) => {
    if (text.length < 2) {
      setPbSuggestions([]);
      return;
    }
    if (pbAbortRef.current) pbAbortRef.current.abort();
    pbAbortRef.current = new AbortController();

    setPbLoading(true);
    try {
      const params = new URLSearchParams({ q: text });
      if (categoryId) params.set('category_id', categoryId);
      if (typeFilter) params.set('type', typeFilter);
      const { data } = await api.get(`/api/price-book/items/search?${params.toString()}`, {
        signal: pbAbortRef.current.signal,
      });
      setPbSuggestions(data.data || []);
      setPbShowDropdown(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
    } finally {
      setPbLoading(false);
    }
  }, []);

  const triggerSearch = useCallback((text: string, catId?: string | null, typeF?: string | null) => {
    if (pbTimerRef.current) clearTimeout(pbTimerRef.current);
    pbTimerRef.current = setTimeout(() => fetchPbSuggestions(text, catId, typeF), 300);
  }, [fetchPbSuggestions]);

  const handlePbInputChange = (text: string) => {
    setPbQuery(text);
    triggerSearch(text, selectedCategory, selectedTypeFilter);
  };

  const handleCategoryChange = (catId: string | null) => {
    setSelectedCategory(catId);
    if (pbQuery.length >= 2) triggerSearch(pbQuery, catId, selectedTypeFilter);
  };

  const handleTypeFilterChange = (type: 'SERVICE' | 'MATERIAL' | null) => {
    setSelectedTypeFilter(type);
    if (pbQuery.length >= 2) triggerSearch(pbQuery, selectedCategory, type);
  };

  const handlePbSelect = (item: PriceBookSearchResult) => {
    onChange([
      ...value,
      {
        name: item.name,
        detail: item.description || '',
        quantity: 1,
        unit_price: Number(item.unit_price),
        is_taxable: item.taxable,
        item_type: item.type,
        price_book_item_id: item.id,
        unit_cost: item.unit_cost != null ? Number(item.unit_cost) : null,
        discount_type: null,
        discount_value: null,
        image_url: item.image_url,
      },
    ]);
    setPbQuery('');
    setPbSuggestions([]);
    setPbShowDropdown(false);
  };

  const handleAddFreeform = () => {
    onChange([...value, blankLineItem()]);
  };

  const updateItem = (idx: number, patch: Partial<LineItem>) => {
    onChange(value.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const removeItem = (idx: number) => {
    if (minOneRow && value.length <= 1) return;
    onChange(value.filter((_, i) => i !== idx));
  };

  // Outside-click close.
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pbContainerRef.current && !pbContainerRef.current.contains(e.target as Node)) {
        setPbShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Cleanup.
  useEffect(() => {
    return () => {
      if (pbTimerRef.current) clearTimeout(pbTimerRef.current);
      if (pbAbortRef.current) pbAbortRef.current.abort();
    };
  }, []);

  // Top-level categories only (no subcategories for chips).
  const topCategories = (categoriesData || []).filter((c) => !c.parent_id);

  return (
    <div className="space-y-4">
      {/* Price Book Search */}
      <Card padding="sm" className="space-y-3">
        {/* Category chips */}
        {topCategories.length > 0 && (
          // Segmented category-filter chips (both the "All" chip below and the per-category
          // chips in the map), not Button-shaped - left raw.
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                selectedCategory === null ? 'bg-primary text-on-fill' : 'bg-neutral-surface text-text-secondary hover:bg-neutral-border'
              )}
              onClick={() => handleCategoryChange(null)}
            >
              All
            </button>
            {topCategories.map((cat) => (
              <button
                key={cat.id}
                type="button"
                className={cn(
                  'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                  selectedCategory === cat.id ? 'bg-primary text-on-fill' : 'bg-neutral-surface text-text-secondary hover:bg-neutral-border'
                )}
                onClick={() => handleCategoryChange(cat.id)}
              >
                {cat.name}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          {/* Type filter toggles - segmented control, not Button-shaped, left raw. */}
          <div className="flex rounded-md border overflow-hidden shrink-0">
            <button
              type="button"
              className={cn('px-2 py-1.5 text-xs font-medium', !selectedTypeFilter ? 'bg-primary text-on-fill' : 'bg-surface-light text-text-secondary hover:bg-background-light')}
              onClick={() => handleTypeFilterChange(null)}
            >All</button>
            <button
              type="button"
              aria-label="Filter to services"
              className={cn('px-2 py-1.5 text-xs font-medium border-l flex items-center gap-1', selectedTypeFilter === 'SERVICE' ? 'bg-primary text-on-fill' : 'bg-surface-light text-text-secondary hover:bg-background-light')}
              onClick={() => handleTypeFilterChange(selectedTypeFilter === 'SERVICE' ? null : 'SERVICE')}
            ><Wrench className="h-3 w-3" /></button>
            <button
              type="button"
              aria-label="Filter to materials"
              className={cn('px-2 py-1.5 text-xs font-medium border-l flex items-center gap-1', selectedTypeFilter === 'MATERIAL' ? 'bg-warning-strong text-on-fill' : 'bg-surface-light text-text-secondary hover:bg-background-light')}
              onClick={() => handleTypeFilterChange(selectedTypeFilter === 'MATERIAL' ? null : 'MATERIAL')}
            ><Package className="h-3 w-3" /></button>
          </div>

          {/* Search input */}
          <div ref={pbContainerRef} className="relative flex-1">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-text-secondary pointer-events-none" />
            <Input
              placeholder="Search price book..."
              value={pbQuery}
              onChange={(e) => handlePbInputChange(e.target.value)}
              onFocus={() => { if (pbSuggestions.length > 0) setPbShowDropdown(true); }}
              // Deferred: forces text-sm at every breakpoint (not just md+), but Input's
              // `sm` rung (h-9) is height-only and leaves the base's text-base/md:text-sm
              // alone below md - no rung reproduces "h-9 + always text-sm".
              className="pl-8 text-sm h-9"
              autoComplete="off"
            />
            {pbLoading && <Loader2 className="absolute right-2.5 top-2 h-4 w-4 animate-spin text-text-secondary" />}

            {pbShowDropdown && pbSuggestions.length > 0 && (
              <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-surface-light shadow-lg max-h-72 overflow-y-auto">
                {pbSuggestions.map((item) => (
                  // Dropdown-menu-item result row, not Button-shaped - left raw.
                  <button
                    key={item.id}
                    type="button"
                    className="w-full px-3 py-2.5 text-left text-sm hover:bg-background-light flex items-center gap-3"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handlePbSelect(item)}
                  >
                    {item.image_url ? (
                      <UploadedImage src={item.image_url} radius="sm" className="h-10 w-10 shrink-0" />
                    ) : (
                      <div className="h-10 w-10 rounded bg-background-light flex items-center justify-center shrink-0">
                        {item.type === 'MATERIAL' ? <Package className="h-4 w-4 text-text-soft" /> : <Wrench className="h-4 w-4 text-text-soft" />}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{item.name}</p>
                      {item.description && (
                        <p className="text-xs text-text-secondary truncate">{item.description}</p>
                      )}
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={cn(
                          'text-[10px] font-medium px-1.5 py-0.5 rounded',
                          item.type === 'MATERIAL' ? 'bg-warning-surface text-warning-text' : 'bg-info-surface text-info-text'
                        )}>
                          {item.type === 'MATERIAL' ? 'Material' : 'Service'}
                        </span>
                        {item.category && (
                          <span className="text-[10px] text-text-secondary">{item.category.name}</span>
                        )}
                      </div>
                    </div>
                    <span className="text-sm font-medium tabular-nums shrink-0">{formatCurrency(item.unit_price)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button type="button" variant="outline" size="sm" onClick={handleAddFreeform} className="shrink-0">
            <Plus className="mr-1 h-4 w-4" /> Add item
          </Button>
        </div>
      </Card>

      {/* ─── Line Items (grid table) ─────────── */}
      <Card padding="sm">
        <div className="mb-3">
          <span className="text-sm font-semibold text-text-primary">
            Line Items ({value.length})
          </span>
        </div>

        {/* Horizontal-scroll guard (lg-only): the fixed-px desktop column grid needs ~760px. In the
            ~1024–1300px band where the standalone-invoice sticky sidebar squeezes this column (#266),
            scroll instead of silently clipping the per-line Total + Remove controls (no scrollbar
            without this, so they were unreachable). At ≥~1320px there is room and no scrollbar shows.
            Below lg the JS-gated mobile stacked card renders instead and fits natively, so the
            min-width must NOT apply there (it would force horizontal scrolling on phones). */}
        <div className="lg:overflow-x-auto">
        <div className="lg:min-w-[760px]">

        {/* Header row — desktop only; the mobile card carries its own per-field labels. */}
        {!isBelowLg && (
        <div className="grid grid-cols-[48px_1fr_70px_90px_80px_140px_48px_80px_36px] gap-x-2 items-center mb-1 px-1">
          <span />
          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">Name</span>
          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">Qty</span>
          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">Price</span>
          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">Cost</span>
          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">Discount</span>
          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide text-center">Tax</span>
          <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide text-right">Total</span>
          <span />
        </div>
        )}

        <div className="divide-y divide-border">
          {value.map((item, idx) => {
            const qty = Number(item.quantity) || 0;
            const price = Number(item.unit_price) || 0;
            const gross = Math.round(qty * price * 100) / 100;

            let lineDiscount = 0;
            if (item.discount_type && item.discount_value != null && Number(item.discount_value) > 0) {
              lineDiscount = item.discount_type === 'PERCENTAGE'
                ? Math.round(gross * (Number(item.discount_value) / 100) * 100) / 100
                : Math.min(Number(item.discount_value), gross);
            }
            const effective = Math.round((gross - lineDiscount) * 100) / 100;

            const costNum = Number(item.unit_cost);
            const cost = !isNaN(costNum) ? costNum : null;
            const lineCost = cost != null ? Math.round(qty * cost * 100) / 100 : null;
            const lineMargin = effective > 0 && lineCost != null ? ((effective - lineCost) / effective) * 100 : null;

            return (
              <div key={idx} className="py-2 px-1">
                {/* Desktop dense grid row — the ONLY variant mounted at >=lg (JS-gated) */}
                {!isBelowLg && (
                <div className="grid grid-cols-[48px_1fr_70px_90px_80px_140px_48px_80px_36px] gap-x-2 items-start">
                  {/* Thumbnail + type badge */}
                  <div>
                    {item.image_url ? (
                      <UploadedImage src={item.image_url} radius="sm" className="h-10 w-10" />
                    ) : (
                      <div className="h-10 w-10 rounded bg-background-light flex items-center justify-center">
                        {item.item_type === 'MATERIAL'
                          ? <Package className="h-4 w-4 text-text-soft" />
                          : <Wrench className="h-4 w-4 text-text-soft" />
                        }
                      </div>
                    )}
                    {/* Two-state item-type toggle badge, not Button-shaped - left raw. */}
                    <button
                      type="button"
                      className={cn(
                        'mt-0.5 w-10 text-center text-[9px] font-medium py-0.5 rounded transition-colors',
                        item.item_type === 'MATERIAL'
                          ? 'bg-warning-surface text-warning-text hover:bg-warning-border'
                          : 'bg-info-surface text-info-text hover:bg-info-border'
                      )}
                      onClick={() => updateItem(idx, { item_type: item.item_type === 'SERVICE' ? 'MATERIAL' : 'SERVICE' })}
                      title="Click to toggle type"
                    >
                      {item.item_type === 'MATERIAL' ? 'Material' : 'Service'}
                    </button>
                  </div>

                  {/* Name + Detail (stacked in 1fr column) */}
                  <div className="space-y-1 min-w-0">
                    <Input
                      placeholder="Item name"
                      value={item.name}
                      onChange={(e) => updateItem(idx, { name: e.target.value })}
                      size="xs"
                      // font-medium deferred: Input ships no weight prop.
                      className="font-medium"
                    />
                    {itemNameErrors?.[idx] && (
                      <p className="text-xs text-danger">{itemNameErrors[idx]}</p>
                    )}
                    <Textarea
                      placeholder="Description for customer (optional)"
                      value={item.detail}
                      onChange={(e) => updateItem(idx, { detail: e.target.value })}
                      className="w-full px-2.5 py-1.5 resize-none overflow-hidden"
                      rows={1}
                      onInput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }}
                      onBlur={(e) => { if (!e.target.value) { e.target.style.height = ''; e.target.rows = 1; } }}
                    />
                  </div>

                  {/* Qty — plain whole-number type-in field (no spinner, no decimal stepping) */}
                  <Input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder="1"
                    value={item.quantity as number | string}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/[^0-9]/g, '');
                      updateItem(idx, { quantity: digits === '' ? ('' as unknown as number) : Number(digits) });
                    }}
                    size="xs"
                    className="text-center"
                  />

                  {/* Price */}
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="0.00"
                    value={item.unit_price as number | string}
                    onChange={(e) => updateItem(idx, { unit_price: e.target.value === '' ? ('' as unknown as number) : Number(e.target.value) })}
                    size="xs"
                  />

                  {/* Cost + Margin */}
                  <div>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={item.unit_cost == null ? '' : (item.unit_cost as number | string)}
                      onChange={(e) => updateItem(idx, { unit_cost: e.target.value === '' ? null : Number(e.target.value) })}
                      size="xs"
                    />
                    {lineMargin != null && (
                      <span className={cn('text-[10px] font-medium block mt-0.5', lineMargin < 20 ? 'text-danger' : 'text-success-text')}>
                        {lineMargin.toFixed(0)}% margin
                      </span>
                    )}
                  </div>

                  {/* Discount */}
                  <div className="flex items-center gap-1">
                    <SelectField
                      className="text-xs h-8 w-14"
                      value={item.discount_type || 'NONE'}
                      onValueChange={(v) => {
                        const val = v === 'NONE' ? null : (v as 'PERCENTAGE' | 'FIXED_AMOUNT');
                        updateItem(idx, { discount_type: val, ...(val ? {} : { discount_value: null }) });
                      }}
                      options={[
                        { value: 'NONE', label: '—' },
                        { value: 'PERCENTAGE', label: '%' },
                        { value: 'FIXED_AMOUNT', label: '$' },
                      ]}
                    />
                    {item.discount_type && (
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0"
                        value={item.discount_value == null ? '' : (item.discount_value as number | string)}
                        onChange={(e) => updateItem(idx, { discount_value: e.target.value === '' ? null : Number(e.target.value) })}
                        // Deferred: text-xs at h-8 has no matching rung - Input's `xs` (32px)
                        // always forces text-sm, not text-xs, so it would grow this field's
                        // font rather than reproduce it.
                        className="text-xs h-8 flex-1 min-w-0"
                      />
                    )}
                  </div>

                  {/* Taxable checkbox */}
                  <div className="flex items-center justify-center h-8">
                    <Checkbox
                      checked={item.is_taxable}
                      onCheckedChange={(val) => updateItem(idx, { is_taxable: !!val })}
                    />
                  </div>

                  {/* Total */}
                  <div className="text-right h-8 flex items-center justify-end">
                    {lineDiscount > 0 ? (
                      <div>
                        <span className="text-[10px] text-text-secondary line-through tabular-nums block">{formatCurrency(gross)}</span>
                        <span className="text-sm font-semibold tabular-nums block">{formatCurrency(effective)}</span>
                      </div>
                    ) : (
                      <span className="text-sm font-semibold tabular-nums">{formatCurrency(gross)}</span>
                    )}
                  </div>

                  {/* Delete - small row-action icon in a dense h-8 grid row (Button's
                      smallest icon rung is 40px, would blow out the row height), not
                      Button-shaped - left raw. */}
                  <div className="flex items-center justify-center h-8">
                    <button
                      type="button"
                      onClick={() => removeItem(idx)}
                      disabled={minOneRow && value.length <= 1}
                      className="p-1.5 text-text-secondary hover:text-danger rounded-md hover:bg-danger-surface transition-colors disabled:opacity-30"
                      aria-label={`Remove ${item.name || 'line item'}`}
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                )}

                {/* Mobile stacked card — the ONLY variant mounted below lg (JS-gated, never
                    coexists with the desktop grid; reusing the same placeholders is safe). */}
                {isBelowLg && (
                <div className="space-y-3">
                  {/* Header line: type toggle + line total + remove */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {item.image_url ? (
                        <UploadedImage src={item.image_url} radius="sm" className="h-10 w-10" />
                      ) : (
                        <div className="h-10 w-10 rounded bg-background-light flex items-center justify-center">
                          {item.item_type === 'MATERIAL'
                            ? <Package className="h-4 w-4 text-text-soft" />
                            : <Wrench className="h-4 w-4 text-text-soft" />
                          }
                        </div>
                      )}
                      {/* Two-state item-type toggle badge, not Button-shaped - left raw. */}
                      <button
                        type="button"
                        className={cn(
                          'text-[9px] font-medium px-2 py-0.5 rounded transition-colors',
                          item.item_type === 'MATERIAL'
                            ? 'bg-warning-surface text-warning-text hover:bg-warning-border'
                            : 'bg-info-surface text-info-text hover:bg-info-border'
                        )}
                        onClick={() => updateItem(idx, { item_type: item.item_type === 'SERVICE' ? 'MATERIAL' : 'SERVICE' })}
                        title="Click to toggle type"
                      >
                        {item.item_type === 'MATERIAL' ? 'Material' : 'Service'}
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-right">
                        {lineDiscount > 0 ? (
                          <div>
                            <span className="text-[10px] text-text-secondary line-through tabular-nums block">{formatCurrency(gross)}</span>
                            <span className="text-sm font-semibold tabular-nums block">{formatCurrency(effective)}</span>
                          </div>
                        ) : (
                          <span className="text-sm font-semibold tabular-nums">{formatCurrency(gross)}</span>
                        )}
                      </div>
                      {/* Delete - small row-action icon, not Button-shaped - left raw. */}
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        disabled={minOneRow && value.length <= 1}
                        className="p-1.5 text-text-secondary hover:text-danger rounded-md hover:bg-danger-surface transition-colors disabled:opacity-30"
                        aria-label={`Remove ${item.name || 'line item'}`}
                        title="Remove"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>

                  {/* Name + Description */}
                  <div className="space-y-1">
                    <Input
                      placeholder="Item name"
                      value={item.name}
                      onChange={(e) => updateItem(idx, { name: e.target.value })}
                      size="xs"
                      // font-medium deferred: Input ships no weight prop.
                      className="font-medium"
                    />
                    {itemNameErrors?.[idx] && (
                      <p className="text-xs text-danger">{itemNameErrors[idx]}</p>
                    )}
                    <Textarea
                      placeholder="Description for customer (optional)"
                      value={item.detail}
                      onChange={(e) => updateItem(idx, { detail: e.target.value })}
                      className="w-full px-2.5 py-1.5 resize-none overflow-hidden"
                      rows={1}
                      onInput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }}
                      onBlur={(e) => { if (!e.target.value) { e.target.style.height = ''; e.target.rows = 1; } }}
                    />
                  </div>

                  {/* Labeled numeric fields */}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide block mb-0.5">Qty</span>
                      <Input
                        type="text"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="1"
                        value={item.quantity as number | string}
                        onChange={(e) => {
                          const digits = e.target.value.replace(/[^0-9]/g, '');
                          updateItem(idx, { quantity: digits === '' ? ('' as unknown as number) : Number(digits) });
                        }}
                        size="xs"
                        className="text-center"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide block mb-0.5">Price</span>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        value={item.unit_price as number | string}
                        onChange={(e) => updateItem(idx, { unit_price: e.target.value === '' ? ('' as unknown as number) : Number(e.target.value) })}
                        size="xs"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide block mb-0.5">Cost</span>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        value={item.unit_cost == null ? '' : (item.unit_cost as number | string)}
                        onChange={(e) => updateItem(idx, { unit_cost: e.target.value === '' ? null : Number(e.target.value) })}
                        size="xs"
                      />
                      {lineMargin != null && (
                        <span className={cn('text-[10px] font-medium block mt-0.5', lineMargin < 20 ? 'text-danger' : 'text-success-text')}>
                          {lineMargin.toFixed(0)}% margin
                        </span>
                      )}
                    </div>
                    <div>
                      <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide block mb-0.5">Discount</span>
                      <div className="flex items-center gap-1">
                        <SelectField
                          className="text-xs h-8 w-14"
                          value={item.discount_type || 'NONE'}
                          onValueChange={(v) => {
                            const val = v === 'NONE' ? null : (v as 'PERCENTAGE' | 'FIXED_AMOUNT');
                            updateItem(idx, { discount_type: val, ...(val ? {} : { discount_value: null }) });
                          }}
                          options={[
                            { value: 'NONE', label: '—' },
                            { value: 'PERCENTAGE', label: '%' },
                            { value: 'FIXED_AMOUNT', label: '$' },
                          ]}
                        />
                        {item.discount_type && (
                          <Input
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="0"
                            value={item.discount_value == null ? '' : (item.discount_value as number | string)}
                            onChange={(e) => updateItem(idx, { discount_value: e.target.value === '' ? null : Number(e.target.value) })}
                            // Deferred: text-xs at h-8 has no matching rung - Input's `xs` (32px)
                            // always forces text-sm, not text-xs, so it would grow this field's
                            // font rather than reproduce it.
                            className="text-xs h-8 flex-1 min-w-0"
                          />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Taxable - not converted to FormField: label WRAPS the Checkbox + its own
                      text, not a caption above the control - outside FormField's shape. */}
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={item.is_taxable}
                      onCheckedChange={(val) => updateItem(idx, { is_taxable: !!val })}
                    />
                    <span className="text-[10px] font-medium text-text-secondary uppercase tracking-wide">Taxable</span>
                  </label>
                </div>
                )}
              </div>
            );
          })}
        </div>

        </div>
        </div>
      </Card>
    </div>
  );
}
