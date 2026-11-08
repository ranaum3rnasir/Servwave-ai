import type { Dispatch, SetStateAction } from 'react';
import { X } from 'lucide-react';

import { TrackedItemSearch } from '@/components/inventory/lo/TrackedItemSearch';
import { Button } from '@/ui-kit/components/ui/button';
import { Input } from '@/ui-kit/components/ui/input';

import type { MaterialDraftLine } from './planShared';

/**
 * The LO-5 default-materials editor.
 *
 * The legacy module renders this markup twice - once in the builder, once in
 * the detail sheet's edit mode - with the same grid, the same dedupe-on-pick
 * rule and the same two `aria-label` templates. It is one component here
 * because those aria-labels ARE the test selector surface for both call sites,
 * and two copies is two places for them to drift.
 *
 * `onChange` is the raw setState, not a plain value callback, so the pick
 * handler can stay a functional update exactly as it is today - a value
 * callback closing over the current array would drop the earlier of two picks
 * in one tick.
 *
 * `TrackedItemSearch` is reused, not rebuilt: it belongs to the Inventory
 * module's logistic-order picker and is shared with it.
 */
function MaterialLines({
  lines, onChange,
}: {
  lines: MaterialDraftLine[];
  onChange: Dispatch<SetStateAction<MaterialDraftLine[]>>;
}) {
  return (
    <>
      {lines.length > 0 && (
        <div className="mb-2 flex flex-col gap-2">
          {lines.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_80px_40px] items-center gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{m.item_name}</p>
                {m.item_sku && <code className="text-muted-foreground font-mono text-xs">{m.item_sku}</code>}
              </div>
              <Input
                type="number" min={0.01} step={0.01}
                aria-label={`Quantity for ${m.item_name}`}
                value={m.qty}
                onChange={(e) => {
                  const n = parseFloat(e.target.value);
                  onChange((prev) => prev.map((x, j) => (j === i ? { ...x, qty: Number.isFinite(n) ? n : 0 } : x)));
                }}
                className="text-right"
              />
              <Button
                size="icon-sm" variant="ghost"
                aria-label={`Remove ${m.item_name}`}
                onClick={() => onChange((prev) => prev.filter((_, j) => j !== i))}
              >
                <X />
              </Button>
            </div>
          ))}
        </div>
      )}
      <TrackedItemSearch
        onPick={(item) =>
          onChange((prev) =>
            prev.some((m) => m.item_id === item.id)
              ? prev
              : [...prev, { item_id: item.id, item_sku: item.sku ?? null, item_name: item.name, qty: 1 }],
          )
        }
      />
    </>
  );
}

export { MaterialLines };
