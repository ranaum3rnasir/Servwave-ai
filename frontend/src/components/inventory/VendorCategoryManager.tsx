import { useState } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppAbility } from "@/contexts/AbilityContext";
import {
  useCreateVendorCategory,
  useDeleteVendorCategory,
  useRenameVendorCategory,
  useVendorCategories,
  type VendorCategory,
} from "@/lib/api/inventory";
import { VENDOR_CATEGORY_NAME_MAX } from "@/lib/inventory/vendor-category";
import { extractApiError } from "@/lib/utils";

const NO_CATEGORIES: VendorCategory[] = [];

// 409 bodies carry a human `message` ("A category named X already exists.",
// "3 vendors still use this category...") beside the machine `error` code;
// prefer it, then fall back to the shared extractor for 400s and the rest.
function apiMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { message?: string } } })?.response?.data;
  return data?.message || extractApiError(err, fallback);
}

type Props = {
  /** A row the server accepted. The vendor form's picker files the draft under it. */
  onAdded?: (row: VendorCategory) => void;
  /** A rename the server accepted. */
  onRenamed?: (row: VendorCategory) => void;
  /** A delete the server accepted. */
  onDeleted?: (id: string) => void;
  /** Focus the new-name box on mount (the Vendors screen opens straight into "add"). */
  autoFocusAdd?: boolean;
};

/**
 * The vendor category manager: add, rename and delete rows of the company's
 * `vendor_categories` list. One component, two hosts - the vendor form's
 * picker opens it inline from "Manage categories…", and the Vendors screen
 * opens it in a dialog from its "Add category" entries.
 *
 * Every write is optimistic with a rollback in the hooks and invalidates the
 * shared vendor-category query, so every picker and filter reading it updates
 * at once. A 409 (duplicate name, category still in use) is shown under the
 * list. Add, rename and delete are gated on `create` / `update` / `delete
 * Vendor`, the same verbs the three routes check.
 */
export function VendorCategoryManager({ onAdded, onRenamed, onDeleted, autoFocusAdd }: Props) {
  const { data: categories = NO_CATEGORIES } = useVendorCategories();
  const createCategory = useCreateVendorCategory();
  const renameCategory = useRenameVendorCategory();
  const deleteCategory = useDeleteVendorCategory();
  const ability = useAppAbility();
  const canAddCategory = ability.can("create", "Vendor");
  const canRenameCategory = ability.can("update", "Vendor");
  const canDeleteCategory = ability.can("delete", "Vendor");

  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState<VendorCategory | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const name = newName.trim();
    if (!name) return;
    setError(null);
    try {
      const row = await createCategory.mutateAsync({ name });
      setNewName("");
      onAdded?.(row);
    } catch (err) {
      setError(apiMessage(err, `Could not add "${name}".`));
    }
  }

  function startRename(c: VendorCategory) {
    setEditing(c);
    setRenameDraft(c.name);
    setError(null);
  }
  function cancelRename() {
    setEditing(null);
    setRenameDraft("");
  }
  async function commitRename() {
    if (!editing) return;
    const target = editing;
    const name = renameDraft.trim();
    if (!name) {
      setError("Category name can't be empty.");
      return;
    }
    cancelRename();
    if (name === target.name) return;
    setError(null);
    try {
      const row = await renameCategory.mutateAsync({ id: target.id, name });
      onRenamed?.(row);
    } catch (err) {
      setError(apiMessage(err, `Could not rename "${target.name}".`));
    }
  }

  async function remove(c: VendorCategory) {
    setError(null);
    try {
      await deleteCategory.mutateAsync({ id: c.id });
      onDeleted?.(c.id);
    } catch (err) {
      setError(apiMessage(err, `Could not delete "${c.name}".`));
    }
  }

  return (
    <>
      {canAddCategory && (
        <div className="flex items-center gap-1">
          <Input
            size="sm"
            autoFocus={autoFocusAdd}
            value={newName}
            maxLength={VENDOR_CATEGORY_NAME_MAX}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
              if (e.key === "Escape") setNewName("");
            }}
            placeholder="New category name…"
            aria-label="New category name"
            className="flex-1"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void add()}
            disabled={!newName.trim() || createCategory.isPending}
          >
            <Plus className="h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      )}

      <ul className="mt-2">
        {categories.length === 0 && (
          <li className="py-1 italic text-text-secondary">No categories yet.</li>
        )}
        {categories.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-1 border-b border-border py-1 last:border-b-0"
          >
            {editing?.id === c.id ? (
              <>
                <Input
                  size="sm"
                  autoFocus
                  value={renameDraft}
                  maxLength={VENDOR_CATEGORY_NAME_MAX}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitRename();
                    }
                    if (e.key === "Escape") cancelRename();
                  }}
                  aria-label={`New name for ${c.name}`}
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  tone="subtle"
                  size="3xs"
                  onClick={() => void commitRename()}
                  aria-label="Save rename"
                  title="Save rename · every vendor in the category follows"
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
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
              </>
            ) : (
              <>
                <span className="flex-1 truncate text-text-primary">{c.name}</span>
                <span className="text-[10px] text-text-secondary">
                  {c.vendorCount} {c.vendorCount === 1 ? "vendor" : "vendors"}
                </span>
                {canRenameCategory && (
                  <Button
                    variant="ghost"
                    tone="subtle"
                    size="3xs"
                    onClick={() => startRename(c)}
                    aria-label={`Rename ${c.name}`}
                    title="Rename"
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                )}
                {canDeleteCategory && (
                  <Button
                    variant="ghost"
                    tone="danger"
                    size="3xs"
                    onClick={() => void remove(c)}
                    aria-label={`Delete ${c.name}`}
                    title={
                      c.vendorCount > 0
                        ? `${c.vendorCount} vendor${c.vendorCount === 1 ? "" : "s"} use this category`
                        : "Delete"
                    }
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-md border border-danger/20 bg-danger/10 px-2 py-1 text-[11px] text-danger"
        >
          {error}
        </p>
      )}
    </>
  );
}
