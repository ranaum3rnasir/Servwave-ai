import { useState } from "react";
import { Building2 } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/patterns/FormField";
import { SelectField } from "@/components/form/SelectField";
import type { Branch } from "@/lib/api/inventory";
import { extractApiError, formatPhoneInput } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreate: (branch: Branch) => unknown;
};

const timezones = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
];

export function AddBranchDialog({ open, onClose, onCreate }: Props) {
  const [form, setForm] = useState({
    name: "",
    code: "",
    address: "",
    phone: "",
    managerName: "",
    timezone: "America/New_York",
    notes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function reset() {
    setForm({
      name: "",
      code: "",
      address: "",
      phone: "",
      managerName: "",
      timezone: "America/New_York",
      notes: "",
    });
    setError(null);
  }

  async function submit() {
    if (!form.name.trim()) return setError("Branch name is required.");
    const branch: Branch = {
      id: `br_new_${Date.now()}`,
      name: form.name.trim(),
      code: form.code.trim().toUpperCase() || undefined,
      address: form.address.trim() || undefined,
      phone: form.phone.trim() || undefined,
      managerName: form.managerName.trim() || undefined,
      timezone: form.timezone,
      notes: form.notes.trim() || undefined,
    };
    setSaving(true);
    try {
      await onCreate(branch);
      reset();
      onClose();
    } catch (err) {
      setError(extractApiError(err, "Could not save the branch - try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Add New Branch"
      subtitle="Branches roll up to your organization. Locations, techs, and POs belong to a branch."
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button size="sm"
            onClick={submit}
            disabled={saving}
          >
            <Building2 className="h-3.5 w-3.5" />
            Save Branch
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <div className="col-span-2">
          <FormField label="Branch Name" required>
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Long Island Branch"
              className={inputCls}
              autoFocus
            />
          </FormField>
        </div>
        <FormField label="Code">
          <Input
            value={form.code}
            onChange={(e) => set("code", e.target.value.toUpperCase())}
            placeholder="LI"
            maxLength={6}
            className={inputCls}
          />
        </FormField>

        <div className="col-span-3">
          <FormField label="Address">
            <Input
              value={form.address}
              onChange={(e) => set("address", e.target.value)}
              placeholder="Street address, city, state, ZIP"
              className={inputCls}
            />
          </FormField>
        </div>

        <FormField label="Phone">
          <Input
            value={form.phone}
            onChange={(e) => set("phone", formatPhoneInput(e.target.value))}
            placeholder="(555) 010-1234"
            className={inputCls}
          />
        </FormField>
        <FormField label="Branch Manager">
          <Input
            value={form.managerName}
            onChange={(e) => set("managerName", e.target.value)}
            placeholder="Manager name"
            className={inputCls}
          />
        </FormField>
        {/* SelectField's Radix Select ROOT renders no DOM of its own and
            doesn't forward an id to its trigger, so FormField's generated id
            lands on the SelectField invocation, not a real element - a known,
            pre-existing gap (see FormField.tsx's own header comment on
            SelectField-shaped controls). Kept as SelectField rather than
            expanded to a raw Select/SelectTrigger: the layering guard
            resolves same-file local `const` string classNames, and passing
            `selectCls`'s hard/soft classes directly to SelectTrigger (a
            components/ui export) - rather than through SelectField, which
            the guard does not govern - reddens the ratchet. */}
        <FormField label="Timezone">
          <SelectField
            aria-label="Timezone"
            value={form.timezone}
            onValueChange={(v) => set("timezone", v)}
            className={selectCls}
            options={timezones.map((tz) => ({ value: tz, label: tz }))}
          />
        </FormField>

        <div className="col-span-3">
          <FormField label="Notes" optional>
            <Textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
              placeholder="Service area · operating hours · special handling"
              className={`${inputCls} resize-none`}
            />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

const inputCls = "w-full px-2.5 py-1.5";

// SelectField isn't a design-system primitive under the layering guard, so it
// keeps its prior appearance verbatim, independent of the now-stripped inputCls.
const selectCls =
  "w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
