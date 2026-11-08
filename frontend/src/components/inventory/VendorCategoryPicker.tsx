import { useMemo, useState } from "react";
import { SelectField } from "@/components/form/SelectField";
import { Button } from "@/components/ui/button";
import { useVendorCategories, type VendorCategory } from "@/lib/api/inventory";
import { UNCATEGORIZED_LABEL } from "@/lib/inventory/vendor-category";
import { VendorCategoryManager } from "./VendorCategoryManager";

/** What the picker hands back: the row's id (null = Uncategorized) and its name. */
export type VendorCategorySelection = { categoryId: string | null; category: string };

type Props = {
  /** The selected category row's id; null = Uncategorized. */
  value: string | null;
  /**
   * The vendor's stored category NAME. Only read when `value` names a row the
   * company list does not hold (a stale cache, a row deleted under an open
   * dialog) so the field still shows what the vendor carries.
   */
  valueName?: string;
  onChange: (next: VendorCategorySelection) => void;
  placeholder?: string;
  /** Optional CSS classes applied to the wrapping element */
  className?: string;
  /** Highlights the field as part of an in-edit form (amber border) */
  inEdit?: boolean;
};

// Radix Select cannot select the empty string, so "no category" needs a
// sentinel value. Namespaced so it can never collide with a row id.
const UNCATEGORIZED_VALUE = "__uncategorized__";
const NO_CATEGORIES: VendorCategory[] = [];

/**
 * Dropdown of the company's vendor categories (Purchasing Audit Verdict PR 4,
 * S4.1) plus "Uncategorized". Picking an option commits immediately.
 *
 * The list is the real per-company `vendor_categories` table, read here so
 * every caller (Add Vendor, the vendor detail editor, the item dialog's
 * nested Add Vendor) shows the same names without threading a prop. A pinned
 * "Manage categories…" row opens the shared <VendorCategoryManager> inline to
 * add, rename and delete rows (the Vendors screen opens the same manager from
 * its "Add category" entries).
 */
export function VendorCategoryPicker({
  value,
  valueName,
  onChange,
  placeholder,
  className,
  inEdit,
}: Props) {
  const { data: categories = NO_CATEGORIES } = useVendorCategories();
  const [managing, setManaging] = useState(false);

  const options = useMemo(() => {
    const rows = categories.map((c) => ({ value: c.id, label: c.name }));
    // A vendor pointing at a row the list does not hold must still display
    // and stay selectable rather than snapping to Uncategorized.
    if (value && !categories.some((c) => c.id === value)) {
      rows.push({ value, label: valueName?.trim() || "Unknown category" });
    }
    return [{ value: UNCATEGORIZED_VALUE, label: UNCATEGORIZED_LABEL }, ...rows];
  }, [categories, value, valueName]);

  function handlePick(next: string) {
    if (next === UNCATEGORIZED_VALUE) {
      onChange({ categoryId: null, category: "" });
      return;
    }
    const row = categories.find((c) => c.id === next);
    onChange({ categoryId: next, category: row?.name ?? valueName ?? "" });
  }

  // Named to not start with "border"/"ring"/etc - SelectTrigger below still
  // consumes this for its own (pre-existing, out of scope for this pass)
  // conditional border/ring tint.
  const edgeCls = inEdit ? "border-warning/20" : "border-border";
  const ringCls = inEdit
    ? "focus:ring-warning/20"
    : "focus:ring-primary/20 focus:border-primary";

  return (
    <div className={`flex flex-col ${className ?? ""}`}>
      <div className="relative flex items-center gap-1">
        <SelectField
          value={value ?? UNCATEGORIZED_VALUE}
          onValueChange={handlePick}
          className={`h-auto flex-1 ${edgeCls} px-2.5 py-1.5 ${ringCls}`}
          placeholder={placeholder ?? "Select a category…"}
          options={options}
          action={{
            label: "Manage categories…",
            separator: true,
            onSelect: () => setManaging(true),
          }}
        />
      </div>

      {managing && (
        <div
          role="group"
          aria-label="Manage categories"
          className="mt-2 rounded-md border border-border bg-background-light p-2 text-xs"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Manage categories
            </span>
            <Button variant="ghost" tone="subtle" size="3xs" onClick={() => setManaging(false)}>
              Done
            </Button>
          </div>

          <VendorCategoryManager
            // Adding from inside a vendor form almost always means "and file
            // this vendor under it" - pick it, the operator can change their mind.
            onAdded={(row) => onChange({ categoryId: row.id, category: row.name })}
            // Keep the open draft's display name in step with the row it points at.
            onRenamed={(row) => {
              if (value === row.id) onChange({ categoryId: row.id, category: row.name });
            }}
            // The server only deletes an EMPTY category, but an unsaved draft may
            // have just picked it - fall back to Uncategorized rather than save a
            // dangling id.
            onDeleted={(id) => {
              if (value === id) onChange({ categoryId: null, category: "" });
            }}
          />
        </div>
      )}
    </div>
  );
}
