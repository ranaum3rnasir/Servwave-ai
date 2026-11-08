import { useState } from "react";
import { Check, ChevronDown, Pencil, Plus, X } from "lucide-react";
import { SearchablePanel, type SearchablePanelRow } from "@/components/ui/searchable-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * CategoryManagerDropdown — the filter-row category picker on the Vendors
 * page (rev 2026-05-27).
 *
 * Selection model: `value = "all"` represents "no filter". Anything else
 * is the literal category name.
 *
 * `onAddCategory` / `onRenameCategory` are optional. `onAddCategory` pins a
 * "+ Add category" row under the list that closes the dropdown and hands off
 * to the caller - the Vendors page opens its vendor category manager there
 * (the naming, duplicate check and write all live in that manager, not
 * here). `onRenameCategory` puts an inline pencil on each row. A caller that
 * passes neither gets a plain filter.
 *
 * The PANEL is `@/components/ui/searchable-panel` — the shared primitive that
 * owns the search box, so this file declares nothing about search. See that
 * file's header for why this family is searchable at any row count.
 */
export function CategoryManagerDropdown({
  value,
  categories,
  onSelect,
  onAddCategory,
  onRenameCategory,
  className,
  placeholder = "All categories",
}: {
  value: string;
  categories: string[];
  onSelect: (v: string) => void;
  onAddCategory?: () => void;
  onRenameCategory?: (oldName: string, newName: string) => void;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canAdd = !!onAddCategory;
  const canRename = !!onRenameCategory;

  function closeAll() {
    setOpen(false);
    setEditingName(null);
    setEditingDraft("");
    setError(null);
  }

  function startRename(name: string) {
    setEditingName(name);
    setEditingDraft(name);
    setError(null);
  }
  function cancelRename() {
    setEditingName(null);
    setEditingDraft("");
    setError(null);
  }
  function commitRename() {
    const next = editingDraft.trim();
    if (!editingName || !onRenameCategory) return;
    if (!next) {
      setError("Category name can't be empty.");
      return;
    }
    if (next === editingName) {
      cancelRename();
      return;
    }
    if (
      categories.some(
        (c) => c.toLowerCase() === next.toLowerCase() && c !== editingName,
      )
    ) {
      setError(`"${next}" already exists.`);
      return;
    }
    onRenameCategory(editingName, next);
    // If the filter was pointing at the renamed category, keep it pointed at
    // the new name so the user doesn't lose their place.
    if (value === editingName) onSelect(next);
    cancelRename();
  }

  const triggerLabel = value === "all" ? placeholder : value;

  const rows: SearchablePanelRow[] = categories.map((c) => {
    const isSelected = value === c;
    const isEditing = editingName === c;
    return {
      key: c,
      // A bare category name is all there is here - no second line to match.
      label: c,
      render: isEditing ? (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <Input
            autoFocus
            value={editingDraft}
            onChange={(e) => setEditingDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") cancelRename();
            }}
            className="flex-1 px-1.5 py-1"
            placeholder="Rename category…"
          />
          {/* Raw by design: no minted ghost/success cell exists (the
              success tone is not implemented on Button - see
              button.tsx's own header note). */}
          <button
            type="button"
            onClick={commitRename}
            title="Save rename · applies to every vendor using this category"
            className="rounded p-1 text-success hover:bg-success/10"
          >
            <Check className="h-3.5 w-3.5" />
          </button>
          <Button
            variant="ghost"
            tone="subtle"
            size="3xs"
            onClick={cancelRename}
            aria-label="Cancel rename"
            title="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div
          className={[
            "group flex items-center gap-1 border-b border-border last:border-b-0",
            isSelected ? "bg-primary-subtle/60" : "hover:bg-background-light",
          ].join(" ")}
        >
          {/* Raw by design: a listbox-row click target, not
              Button-shaped. */}
          <button
            type="button"
            onClick={() => {
              onSelect(c);
              closeAll();
            }}
            className={[
              "flex-1 px-3 py-2 text-left text-sm transition",
              isSelected
                ? "font-semibold text-primary"
                : "text-text-secondary",
            ].join(" ")}
          >
            {c}
          </button>
          {isSelected && (
            <Check className="h-3.5 w-3.5 flex-shrink-0 text-primary" />
          )}
          {/* Raw by design: a group-hover:opacity reveal with no
              matching ghost/subtle#reveal cell minted (only
              ghost/danger#reveal exists) - converting would either lose
              the row-hover-reveal behaviour or add new SOFT
              opacity/group-hover classes at the layering guard's
              zero-slack ceiling. */}
          {canRename && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startRename(c);
              }}
              title={`Rename "${c}" · updates every vendor using this category`}
              aria-label={`Rename ${c}`}
              className="mr-1 rounded p-1 text-text-secondary opacity-0 transition group-hover:opacity-100 hover:bg-secondary-light hover:text-text-primary"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
        </div>
      ),
    };
  });

  return (
    <SearchablePanel
      open={open}
      onOpenChange={(o) => {
        // Outside-click / dismiss: commit-then-close by resetting all inline
        // edit state (mirrors the original closeAll() bail-mid-edit behavior).
        if (!o) closeAll();
        else setOpen(true);
      }}
      searchPlaceholder="Search categories…"
      searchAriaLabel="Search categories"
      trigger={
        /* Raw by design: PopoverTrigger asChild clones + ref-forwards onto
           this element - the never-convert asChild trigger shape. */
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          className={`inline-flex min-w-[180px] items-center justify-between gap-1.5 rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm text-text-primary hover:border-secondary-dark focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 ${className ?? ""}`}
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-text-secondary" />
        </button>
      }
      align="start"
      sideOffset={4}
      role="listbox"
      // Nested-Escape: cancel an active rename first; otherwise let the
      // popover close (Radix default).
      onEscapeKeyDown={(e) => {
        if (editingName) {
          e.preventDefault();
          cancelRename();
        }
      }}
      // `border` dropped: PopoverContent's own base string already emits
      // an unconditional `border border-border` - this was a byte-for-byte
      // redundant restatement, not an override.
      contentClassName="w-72 overflow-hidden p-0"
      /* "All categories" — selecting clears the filter. Raw by design: a
         role="listbox" row / list-row click target, not Button-shaped.
         Never filtered: whatever the query is, clearing the filter stays one
         click away. */
      resetRow={
        <>
          <button
            type="button"
            onClick={() => {
              onSelect("all");
              closeAll();
            }}
            className={[
              "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
              value === "all"
                ? "bg-primary-subtle font-semibold text-primary"
                : "text-text-secondary hover:bg-background-light",
            ].join(" ")}
          >
            <span className="flex-1">All categories</span>
            {value === "all" && <Check className="h-3.5 w-3.5 text-primary" />}
          </button>

          <div className="border-t border-border" />
        </>
      }
      /* Category list */
      listClassName="max-h-72 overflow-y-auto"
      rows={rows}
      emptyState={
        <p className="px-3 py-2 text-xs italic text-text-secondary">
          No categories yet.
        </p>
      }
      /* Pinned below the filtered list on purpose: a query matching nothing is
         exactly when "Add category" is the thing the user wants. Absent
         entirely when the caller can do neither an add nor a rename. */
      footer={
        canAdd || canRename ? (
        <>
          <div className="border-t border-border" />

          {canAdd && (
            // Raw by design: no minted ghost+brand cell exists (ghost only has
            // neutral/subtle/danger tones); this is also a full-width dropdown
            // footer row, not a standalone Button-shaped control.
            <button
              type="button"
              onClick={() => {
                closeAll();
                onAddCategory?.();
              }}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-semibold text-primary transition hover:bg-primary-subtle"
            >
              <Plus className="h-3.5 w-3.5" />
              Add category
            </button>
          )}

          {error && (
            <div className="border-t border-danger/20 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
              {error}
            </div>
          )}

          {canRename && (
            <div className="border-t border-border bg-background-light px-3 py-1.5 text-[10px] italic text-text-secondary">
              Renaming a category updates every vendor that uses it.
            </div>
          )}
        </>
        ) : undefined
      }
    />
  );
}
