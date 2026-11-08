import { useState } from "react";
import type React from "react";
import { Filter, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type { ItemKind, Trade, Vendor } from "@/lib/api/inventory";

export type StockState = "in_stock" | "low_stock" | "out_of_stock" | "backorder";
export type ItemFlag = "serialized" | "hazmat";

export type Filters = {
  trades: Trade[];
  kinds: ItemKind[];
  stockStates: StockState[];
  vendors: string[];
  flags: ItemFlag[];
  /** Category names selected in the "Showing" → Categories pill */
  categories: string[];
};

export const emptyFilters: Filters = {
  trades: [],
  kinds: [],
  stockStates: [],
  vendors: [],
  flags: [],
  categories: [],
};

export function activeFilterCount(f: Filters): number {
  return (
    f.trades.length +
    f.kinds.length +
    f.stockStates.length +
    f.vendors.length +
    f.flags.length +
    f.categories.length
  );
}

type Props = {
  filters: Filters;
  onChange: (next: Filters) => void;
  vendors: Vendor[];
  resultCount: number;
  totalCount: number;
};

const kindOpts: { value: ItemKind; label: string }[] = [
  { value: "material", label: "Material" },
  { value: "service", label: "Service" },
];
const stockOpts: { value: StockState; label: string; tint: string }[] = [
  {
    value: "in_stock",
    label: "In stock",
    tint: "bg-success/10 text-success ring-success/20",
  },
  {
    value: "low_stock",
    label: "Low stock",
    tint: "bg-warning/10 text-warning ring-warning/20",
  },
  {
    value: "out_of_stock",
    label: "Out of stock",
    tint: "bg-background-light text-text-secondary ring-border",
  },
  {
    value: "backorder",
    label: "On backorder",
    tint: "bg-danger/10 text-danger ring-danger/20",
  },
];
const flagOpts: { value: ItemFlag; label: string; tint: string }[] = [
  {
    value: "serialized",
    label: "Serialized",
    tint: "bg-primary-subtle text-primary ring-primary/20",
  },
  {
    value: "hazmat",
    label: "Hazmat",
    tint: "bg-danger/10 text-danger ring-danger/20",
  },
];

export function FiltersPopover({
  filters,
  onChange,
  vendors,
  resultCount,
  totalCount,
}: Props) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);

  function toggle<K extends keyof Filters>(
    key: K,
    value: Filters[K][number],
  ) {
    const current = filters[key] as Array<typeof value>;
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ ...filters, [key]: next });
  }

  function clearAll() {
    onChange(emptyFilters);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* Raw by design: PopoverTrigger asChild clones + ref-forwards onto
            this element - the never-convert asChild trigger shape. */}
        <button
          className={[
            "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm transition",
            count > 0 || open
              ? "border-primary/40 bg-primary-subtle text-primary"
              : "border-border bg-surface-light text-text-primary hover:bg-background-light",
          ].join(" ")}
        >
          <Filter className="h-3.5 w-3.5" />
          Filters
          {count > 0 && (
            <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-on-fill">
              {count}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        // `border` dropped: PopoverContent's own base string already emits
        // an unconditional `border border-border` - this was a byte-for-byte
        // redundant restatement, not an override.
        className="w-[560px] max-w-[calc(100vw-1.5rem)] overflow-hidden p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div>
            <p className="text-sm font-semibold text-text-primary">Filters</p>
            <p className="text-[11px] text-text-secondary">
              Showing {resultCount} of {totalCount} items
            </p>
          </div>
          {count > 0 && (
            <Button variant="ghost" tone="subtle" size="3xs" onClick={clearAll}>
              Clear all ({count})
            </Button>
          )}
        </div>
        <div className="max-h-[440px] space-y-4 overflow-y-auto p-4">
          <Section title="Item Kind">
            <div className="flex flex-wrap gap-1.5">
              {kindOpts.map((k) => {
                const active = filters.kinds.includes(k.value);
                return (
                  <Chip
                    key={k.value}
                    active={active}
                    onClick={() => toggle("kinds", k.value)}
                  >
                    {k.label}
                  </Chip>
                );
              })}
            </div>
          </Section>

          <Section title="Stock Status">
            <div className="flex flex-wrap gap-1.5">
              {stockOpts.map((s) => {
                const active = filters.stockStates.includes(s.value);
                return (
                  <Chip
                    key={s.value}
                    active={active}
                    tint={s.tint}
                    onClick={() => toggle("stockStates", s.value)}
                  >
                    {s.label}
                  </Chip>
                );
              })}
            </div>
          </Section>

          <Section title="Vendor">
            <div className="flex flex-wrap gap-1.5">
              {vendors.map((v) => {
                const active = filters.vendors.includes(v.name);
                return (
                  <Chip
                    key={v.id}
                    active={active}
                    onClick={() => toggle("vendors", v.name)}
                  >
                    {v.name}
                  </Chip>
                );
              })}
            </div>
          </Section>

          <Section title="Flags">
            <div className="flex flex-wrap gap-1.5">
              {flagOpts.map((f) => {
                const active = filters.flags.includes(f.value);
                return (
                  <Chip
                    key={f.value}
                    active={active}
                    tint={f.tint}
                    onClick={() => toggle("flags", f.value)}
                  >
                    {f.label}
                  </Chip>
                );
              })}
            </div>
          </Section>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-background-light px-4 py-2.5">
          <Button size="sm" onClick={() => setOpen(false)}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {/* Raw by design: bracket size text-[10px] has no matching Heading scale key. */}
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
        {title}
      </h3>
      {children}
    </div>
  );
}

// Raw by design: a locally-declared multi-select toggle chip (active/inactive
// + per-option `tint` override) - a segmented toggle control, not Button-shaped.
// (This is the exact local `Chip` the layering-guard test's own fixture names
// as exempt - see layering-guard.test.ts "exonerates a same-file local
// declaration".)
function Chip({
  active,
  tint,
  onClick,
  children,
}: {
  active: boolean;
  tint?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        "rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition",
        active
          ? tint
            ? `${tint} ring-2 ring-offset-1`
            : "bg-primary text-on-fill ring-primary"
          : "bg-surface-light text-text-primary ring-border hover:bg-background-light",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

// Active-filter strip displayed under the search row.
export function ActiveFilterChips({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  const chips: { key: keyof Filters; label: string; value: string }[] = [
    ...filters.kinds.map((v) => ({
      key: "kinds" as keyof Filters,
      label: `Kind: ${v}`,
      value: v,
    })),
    ...filters.stockStates.map((v) => ({
      key: "stockStates" as keyof Filters,
      label: stockLabel(v),
      value: v,
    })),
    ...filters.vendors.map((v) => ({
      key: "vendors" as keyof Filters,
      label: `Vendor: ${v}`,
      value: v,
    })),
    ...filters.flags.map((v) => ({
      key: "flags" as keyof Filters,
      label: v === "serialized" ? "Serialized" : "Hazmat",
      value: v,
    })),
  ];

  if (chips.length === 0) return null;

  function remove(key: keyof Filters, value: string) {
    const current = filters[key] as string[];
    onChange({ ...filters, [key]: current.filter((v) => v !== value) });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <span
          key={`${c.key}:${c.value}`}
          className="inline-flex items-center gap-1 rounded-full bg-primary-subtle px-2 py-0.5 text-[11px] font-medium text-primary ring-1 ring-primary/20"
        >
          {c.label}
          {/* Raw by design: a small close-X affordance inside a chip - the
              explicit never-force-into-Button shape. */}
          <button
            onClick={() => remove(c.key, c.value)}
            className="ml-0.5 rounded-full p-0.5 hover:bg-primary/10"
            aria-label={`Remove ${c.label}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      <Button variant="ghost" tone="subtle" size="3xs" onClick={() => onChange(emptyFilters)}>
        Clear all
      </Button>
    </div>
  );
}

function stockLabel(v: string) {
  if (v === "in_stock") return "In stock";
  if (v === "low_stock") return "Low stock";
  if (v === "out_of_stock") return "Out of stock";
  if (v === "backorder") return "On backorder";
  return v;
}
