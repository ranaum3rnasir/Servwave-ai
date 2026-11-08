import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { extractApiError } from "@/lib/utils";

export type ManageEntry = {
  id: string;
  label: string;
  /** Secondary text on the right of the row - a code, a vendor, a count. */
  hint?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Plural noun used in the empty state, e.g. "units". */
  nounPlural: string;
  entries: ManageEntry[];
  /** Resolves on success; reject to surface the reason on the row. */
  onDelete: (id: string) => Promise<unknown>;
};

/**
 * ManageCatalogDialog - delete rows from a catalog dropdown (units, finishes,
 * brands, categories).
 *
 * WHY THIS IS NOT A TRASH ICON INSIDE THE DROPDOWN, which is the obvious place
 * to put it: a Radix SelectItem carries role="option", and an option must not
 * contain focusable interactive content - a nested button is unreachable by
 * keyboard and is announced as part of the option's own label. Pointer-event
 * interception makes it work for a mouse and leaves it broken for everyone
 * else. A destructive action that can be refused ("still used by 12 items")
 * also needs somewhere to say so, which a 28px dropdown row does not have.
 *
 * Delete confirms inline on the row rather than in a second modal: this dialog
 * is already opened from inside AddItemDialog, and a third stacked layer is
 * worse than a two-step row.
 */
export function ManageCatalogDialog({
  open,
  onClose,
  title,
  nounPlural,
  entries,
  onDelete,
}: Props) {
  // id of the row awaiting confirmation, id of the row mid-flight, and the
  // per-row failure message. Keyed by id rather than held as one flag so a
  // failure on one row cannot blank another row's state.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  function close() {
    setConfirming(null);
    setDeleting(null);
    setErrors({});
    onClose();
  }

  async function remove(id: string) {
    setDeleting(id);
    setErrors((e) => {
      const { [id]: _dropped, ...rest } = e;
      return rest;
    });
    try {
      await onDelete(id);
      setConfirming(null);
    } catch (err) {
      // The server refuses a row that is still referenced (400, "Cannot delete
      // finish with items"). That is the useful half of this dialog, so it is
      // shown verbatim on the row instead of collapsing to "try again".
      setErrors((e) => ({
        ...e,
        [id]: extractApiError(err, "Could not delete this one - try again."),
      }));
      setConfirming(null);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      subtitle="Deleting one removes it from the dropdown. Anything still using it keeps it."
      size="sm"
      footer={
        <Button variant="outline" size="sm" onClick={close}>
          Done
        </Button>
      }
    >
      {entries.length === 0 ? (
        <p className="py-6 text-center text-xs text-text-secondary">
          No {nounPlural} yet. Add one from the dropdown.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-col gap-1 py-2">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {entry.label}
                </span>
                {entry.hint && (
                  <span className="flex-none text-[11px] text-text-secondary">{entry.hint}</span>
                )}
                {confirming === entry.id ? (
                  <span className="flex flex-none items-center gap-1">
                    <Button
                      variant="solid"
                      tone="danger"
                      size="sm"
                      disabled={deleting === entry.id}
                      onClick={() => void remove(entry.id)}
                    >
                      {deleting === entry.id ? "Deleting…" : "Delete"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    tone="danger"
                    size="sm"
                    aria-label={`Delete ${entry.label}`}
                    onClick={() => setConfirming(entry.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
              {errors[entry.id] && (
                <p className="text-[11px] text-danger">{errors[entry.id]}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
