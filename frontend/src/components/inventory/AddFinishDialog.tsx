import { useState } from "react";
import { Plus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/patterns/FormField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { extractApiError } from "@/lib/utils";
import type { Finish } from "@/lib/api/inventory";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Fired on save. May return a promise - awaited so a rejection keeps the
   *  dialog open with the typed values and an error, rather than reporting a
   *  success the server never recorded. */
  onCreate: (finish: Finish) => unknown;
  /** Names this org already has, checked before the write - the server carries
   *  @@unique([organization_id, name]), and a 409 after the fact is a worse
   *  experience than refusing here with the typed value still on screen. */
  existingNames?: string[];
};

/**
 * AddFinishDialog - create a Finish from inside the Add/Edit Item dialog.
 *
 * A finish is the surface treatment of a hardware item (Satin Chrome, Oil
 * Rubbed Bronze, Polished Brass). Contractors quote and re-order by it, so it
 * is a first-class per-org entity rather than free text - two spellings of
 * "satin chrome" would split the same physical stock across two filters.
 *
 * The optional code is the BHMA number (626, 10B). Trades outside door
 * hardware have no such code, which is why it is not required.
 *
 * Deliberately smaller than AddBrandDialog: a finish has no logo, website,
 * markup or default vendor. Adding those fields "for symmetry" would put four
 * empty inputs in front of someone who opened this to type one word.
 */
export function AddFinishDialog({ open, onClose, onCreate, existingNames = [] }: Props) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset on the way OUT rather than in an open-effect, so the next open always
  // starts clean without a setState-in-effect cascade (react-hooks/set-state-in-effect).
  // Every close path routes through here: Cancel, the Modal backdrop/Esc, and
  // a successful save.
  function close() {
    setName("");
    setCode("");
    setError(null);
    onClose();
  }

  async function submit() {
    const next = name.trim();
    if (!next) {
      setError("Name is required.");
      return;
    }
    if (existingNames.some((n) => n.trim().toLowerCase() === next.toLowerCase())) {
      setError(`"${next}" already exists - pick it from the list instead.`);
      return;
    }
    setSaving(true);
    try {
      await onCreate({
        id: `fin_new_${Date.now()}`,
        name: next,
        code: code.trim() || undefined,
        isActive: true,
      });
      close();
    } catch (err) {
      setError(extractApiError(err, "Could not save the finish - try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add New Finish"
      subtitle="Finishes are surface treatments (Satin Chrome, Oil Rubbed Bronze). Items get assigned to a finish so you can filter and re-order by it."
      size="sm"
      footer={
        <>
          <Button variant="outline" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={saving}>
            <Plus className="h-3.5 w-3.5" />
            Save Finish
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3">
        <FormField label="Finish Name" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Satin Chrome"
            className="px-2.5 py-1.5"
          />
        </FormField>
        <FormField label="Code" hint="BHMA number, if the manufacturer publishes one.">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="626"
            className="px-2.5 py-1.5"
          />
        </FormField>
      </div>
    </Modal>
  );
}
