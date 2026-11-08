import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, ClipboardList, Save, Tag, AlignLeft } from 'lucide-react';
import { listScopePresets } from '@/lib/api/estimates';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatCurrency } from '@/lib/utils';

export interface ScopePreset {
  id: string;
  name: string;
  emoji?: string | null;
  scope_text: string;
  priced: boolean;
  price: number | null;
  category?: string | null;
}

// Canonical formatter - reads the org's configured currency rather than
// hardcoding USD.
const money = formatCurrency;

interface ScopePresetPickerProps {
  open: boolean;
  /** The estimate's current scope text — enables "Save current scope as preset". */
  currentScope: string;
  /** Open a preset in the editor (priced/description + price) before adding. */
  onSelect: (preset: ScopePreset) => void;
  /** R5a — the optional category typed into the save-current inline field, trimmed. */
  onSaveCurrent: (category?: string) => void;
  onClose: () => void;
}

/**
 * Price-book-style visual picker of owner-built scope-of-work presets. Each preset
 * is a square card; clicking it opens an editor where you adjust price / wording and
 * choose priced-line vs description-only before it's added to the estimate.
 */
export function ScopePresetPicker({
  open,
  currentScope,
  onSelect,
  onSaveCurrent,
  onClose,
}: ScopePresetPickerProps) {
  const [q, setQ] = useState('');
  // R5a (2026-07-21) — category is a free-text tag, not a relational model (ScopePreset has no
  // dedicated categories endpoint like PriceBookCategory) — chips are derived client-side from
  // whatever's already on the search-matched presets, and filtering is client-side too.
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [saveCategory, setSaveCategory] = useState('');

  const { data: allPresets = [], isLoading } = useQuery<ScopePreset[]>({
    queryKey: ['scope-presets', q],
    queryFn: async () => (await listScopePresets(q)).presets ?? [],
    enabled: open,
  });

  const categories = Array.from(
    new Set(allPresets.map((p) => p.category?.trim()).filter((c): c is string => !!c)),
  ).sort();
  // A stale activeCategory (e.g. the search text changed and that category no longer appears)
  // falls back to "All" rather than silently filtering to an empty, unexplained grid.
  const effectiveCategory = activeCategory && categories.includes(activeCategory) ? activeCategory : null;
  const presets = effectiveCategory ? allPresets.filter((p) => p.category === effectiveCategory) : allPresets;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] w-[min(56rem,95vw)] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader divider className="px-6 pb-4 pt-6">
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5 text-primary" />
            Scope of Work Presets
          </DialogTitle>
          <div className="relative mt-3">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search scope presets…"
              className="pl-9"
            />
          </div>
        </DialogHeader>

        {categories.length > 0 && (
          <div className="flex flex-wrap gap-1.5 border-b border-border px-6 py-3">
            {/* Category filter pill (segmented toggle) - not Button-shaped. Deferred. */}
            <button
              type="button"
              onClick={() => setActiveCategory(null)}
              className={`rounded-pill px-2.5 py-1 text-xs font-semibold transition-colors ${
                effectiveCategory === null
                  ? 'bg-primary text-on-fill'
                  : 'bg-background-light text-text-secondary hover:bg-primary-subtle'
              }`}
            >
              All
            </button>
            {categories.map((cat) => (
              // Category filter pill (segmented toggle) - not Button-shaped. Deferred.
              <button
                key={cat}
                type="button"
                onClick={() => setActiveCategory(cat)}
                className={`rounded-pill px-2.5 py-1 text-xs font-semibold transition-colors ${
                  effectiveCategory === cat
                    ? 'bg-primary text-on-fill'
                    : 'bg-background-light text-text-secondary hover:bg-primary-subtle'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <p className="py-10 text-center text-sm text-text-secondary">Searching…</p>
          ) : presets.length === 0 ? (
            <p className="py-10 text-center text-sm text-text-secondary">
              {allPresets.length === 0 ? 'No scope presets yet.' : `No presets in "${effectiveCategory}".`}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {presets.map((p) => (
                // Preset card: rich structured content (name, category badge, price) -
                // a grid-tile click target, not Button-shaped. Deferred.
                <button
                  key={p.id}
                  type="button"
                  onClick={() => onSelect(p)}
                  className="group flex h-full flex-col gap-1.5 rounded-card border border-border bg-surface-light p-4 text-left transition-all hover:border-primary/40 hover:shadow-card"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-text-primary">{p.name}</p>
                    {p.category && (
                      <span className="shrink-0 rounded-pill bg-background-light px-2 py-0.5 text-[10px] font-semibold text-text-secondary">
                        {p.category}
                      </span>
                    )}
                  </div>
                  <p className="line-clamp-3 text-xs text-text-secondary">{p.scope_text}</p>
                  <div className="mt-auto pt-1.5">
                    {p.priced ? (
                      <span className="inline-flex items-center gap-1 text-sm font-bold text-sage-700">
                        <Tag className="h-3.5 w-3.5" />
                        {money(p.price ?? 0)}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary">
                        <AlignLeft className="h-3.5 w-3.5" />
                        Description
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
          {currentScope.trim() && (
            // Deferred: text-xs has no matching Input rung - `size="xs"`
            // forces text-sm (Input's own smallest measured font override),
            // not text-xs, so applying it would enlarge this field's font.
            // No demand for a text-xs rung was ever measured on Input (see
            // input.tsx's own header note), so the override stays raw.
            <Input
              value={saveCategory}
              onChange={(e) => setSaveCategory(e.target.value)}
              placeholder="Category (optional)"
              className="h-9 w-40 text-xs"
            />
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!currentScope.trim()}
            title={currentScope.trim() ? 'Save this estimate’s scope text as a reusable preset' : 'Write a scope first'}
            onClick={() => {
              onSaveCurrent(saveCategory.trim() || undefined);
              setSaveCategory('');
            }}
          >
            <Save className="mr-1 h-4 w-4" />
            Save current scope as preset
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
