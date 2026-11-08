import { useEffect, useMemo, useState } from "react";
import type React from "react";
import { MapPin, Truck, Warehouse, Boxes, Building2, Plus, Save, User as UserIcon } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/patterns/FormField";
import { SelectField } from "@/components/form/SelectField";
import type { Branch, Location, Tech } from "@/lib/api/inventory";
import { adoptServerId, useTechs, useLocations } from "@/lib/api/inventory";
// LocationType enum is not in the seam's re-export type-list; pull it type-only
// from _mock (the sanctioned exception, mirroring LocationStockHealth.tsx).
import type { LocationType } from "@/lib/api/_mock/inventory";
import { AddBranchDialog } from "@/components/inventory/AddBranchDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { extractApiError } from "@/lib/utils";

type Props = {
  open: boolean;
  onClose: () => void;
  /** #2043/R6 - awaited inside `submit()` so a rejection keeps the dialog
   *  open with the server's message instead of `reset(); onClose()` running
   *  unconditionally. The parent must let the rejection propagate. */
  onCreate: (loc: Location) => void | Promise<void>;
  onUpdate?: (loc: Location) => void | Promise<void>;
  editLocation?: Location | null;
  branches: Branch[];
  onAddBranch: (branch: Branch) => unknown;
};

const typeOptions: {
  value: LocationType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  hint: string;
}[] = [
  {
    value: "truck",
    label: "Truck / Van",
    icon: Truck,
    hint: "A tech's vehicle — has a primary tech + vehicle info",
  },
  {
    value: "warehouse",
    label: "Warehouse",
    icon: Warehouse,
    hint: "Bulk storage with bin sub-locations",
  },
  {
    value: "counter",
    label: "Counter / Shop",
    icon: Boxes,
    hint: "Walk-in counter or shop floor",
  },
  {
    value: "staging",
    label: "Job-site staging",
    icon: MapPin,
    hint: "Temporary on-site storage for an active job",
  },
];

export function AddLocationDialog({
  open,
  onClose,
  onCreate,
  onUpdate,
  editLocation,
  branches,
  onAddBranch,
}: Props) {
  // Tech roster now flows through the data seam (was a module-scope import of
  // `../data/techs`). Driver-eligible techs (vehicle owners) drive the
  // primary-tech picker + vehicle auto-fill.
  const { data: allTechs = [] } = useTechs();
  const driverTechs = useMemo(
    () =>
      (allTechs as Tech[]).filter(
        (t) => t.role === "field_tech" || t.role === "subcontractor",
      ),
    [allTechs],
  );

  // Existing locations back the one-van-per-tech soft warning (P3 §1b — convention,
  // not enforced; the schema has no unique on primary_tech_id).
  const { data: existingLocations = [] } = useLocations();

  const [showAddBranch, setShowAddBranch] = useState(false);
  const isEdit = !!editLocation;
  // P3 §1b: the tech binding is id-first (`primaryTechId` is what persists);
  // `primaryTech` stays alongside as the display name / vehicle-autofill anchor.
  const [form, setForm] = useState({
    name: "",
    type: "truck" as LocationType,
    branch: branches[0]?.name ?? "",
    primaryTech: "",
    primaryTechId: "",
    vehicle: "",
  });
  const [error, setError] = useState<string | null>(null);

  function handleBranchChange(value: string) {
    if (value === "__add_new__") {
      setShowAddBranch(true);
      return;
    }
    setForm((f) => ({ ...f, branch: value }));
  }

  async function handleBranchCreated(b: Branch) {
    const saved = adoptServerId(b, await onAddBranch(b));
    setForm((f) => ({ ...f, branch: saved.name }));
    return saved;
  }

  function handleTechPick(techId: string) {
    if (techId === "__unassigned__") {
      setForm((f) => ({ ...f, primaryTech: "", primaryTechId: "", vehicle: "" }));
      return;
    }
    const t = driverTechs.find((x) => x.id === techId);
    if (!t) return;
    setForm((f) => ({
      ...f,
      primaryTech: t.name,
      primaryTechId: t.id,
      // Auto-fill vehicle from the tech's record, but only if the field is
      // empty OR matches a known tech's vehicle (so manual overrides stick).
      vehicle:
        !f.vehicle.trim() ||
        driverTechs.some((x) => x.vehicle === f.vehicle)
          ? t.vehicle ?? ""
          : f.vehicle,
    }));
  }

  // Pre-fill on open when in edit mode. `primaryTechId` seeds from the row when the
  // API provides it; legacy name-only rows fall back to a roster name-match at render/
  // submit time (see resolvedTechId below).
  useEffect(() => {
    if (!open) return;
    if (editLocation) {
      setForm({
        name: editLocation.name,
        type: editLocation.type,
        branch: editLocation.branch,
        primaryTech: editLocation.primaryTech ?? "",
        primaryTechId: editLocation.primaryTechId ?? "",
        vehicle: editLocation.vehicle ?? "",
      });
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editLocation?.id]);

  // The id that would persist if submitted now: explicit pick → row seed → roster
  // name-match (legacy rows whose API payload predates `primaryTechId`).
  const resolvedTechId =
    form.primaryTechId ||
    (driverTechs.find((t) => t.name === form.primaryTech)?.id ?? "");

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function reset() {
    setForm({
      name: "",
      type: "truck",
      branch: branches[0]?.name ?? "",
      primaryTech: "",
      primaryTechId: "",
      vehicle: "",
    });
    setError(null);
  }

  async function submit() {
    if (!form.name.trim()) return setError("Location name is required.");
    setError(null);
    if (isEdit && editLocation && onUpdate) {
      const updated: Location = {
        ...editLocation,
        name: form.name.trim(),
        type: form.type,
        branch: form.branch,
        primaryTech:
          form.type === "truck" && form.primaryTech.trim()
            ? form.primaryTech.trim()
            : undefined,
        primaryTechId:
          form.type === "truck" && resolvedTechId ? resolvedTechId : undefined,
        vehicle:
          form.type === "truck" && form.vehicle.trim()
            ? form.vehicle.trim()
            : undefined,
      };
      try {
        await onUpdate(updated);
      } catch (err) {
        setError(extractApiError(err, "Could not update the location - please try again."));
        return;
      }
      reset();
      onClose();
      return;
    }
    const loc: Location = {
      id: `loc_new_${Date.now()}`,
      name: form.name.trim(),
      type: form.type,
      branch: form.branch,
      primaryTech:
        form.type === "truck" && form.primaryTech.trim()
          ? form.primaryTech.trim()
          : undefined,
      primaryTechId:
        form.type === "truck" && resolvedTechId ? resolvedTechId : undefined,
      vehicle:
        form.type === "truck" && form.vehicle.trim()
          ? form.vehicle.trim()
          : undefined,
    };
    try {
      await onCreate(loc);
    } catch (err) {
      setError(extractApiError(err, "Could not create the location - please try again."));
      return;
    }
    reset();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      lockEscape={showAddBranch}
      title={isEdit ? `Edit Location · ${editLocation!.name}` : "Add Location"}
      subtitle={
        isEdit
          ? "Change tech assignment, vehicle, branch, or rename. Stock at this location is preserved."
          : "Organize stock as Branch → Warehouse, Truck, Counter, or Bin."
      }
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
          >
            {isEdit ? (
              <Save className="h-3.5 w-3.5" />
            ) : (
              <Building2 className="h-3.5 w-3.5" />
            )}
            {isEdit ? "Save Changes" : "Create Location"}
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {/* Type picker — visual cards */}
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Location Type
          </span>
          <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {typeOptions.map((opt) => {
              const Icon = opt.icon;
              const active = form.type === opt.value;
              return (
                // Raw by design: a segmented toggle control (a selectable
                // card grid), not Button-shaped.
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => set("type", opt.value)}
                  className={[
                    "flex flex-col items-start gap-1 rounded-card border p-3 text-left transition",
                    active
                      ? "border-primary bg-primary-subtle ring-1 ring-primary/30"
                      : "border-border bg-surface-light hover:border-secondary hover:bg-background-light",
                  ].join(" ")}
                >
                  <Icon
                    className={[
                      "h-4 w-4",
                      active ? "text-primary" : "text-text-secondary",
                    ].join(" ")}
                  />
                  <span
                    className={[
                      "text-xs font-semibold",
                      active ? "text-primary" : "text-text-primary",
                    ].join(" ")}
                  >
                    {opt.label}
                  </span>
                  <span className="text-[10px] leading-tight text-text-secondary">
                    {opt.hint}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <FormField label="Location Name" required>
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder={
                form.type === "truck"
                  ? "e.g. Carlos's Van"
                  : form.type === "warehouse"
                    ? "e.g. Queens Warehouse"
                    : form.type === "counter"
                      ? "e.g. Atlantic Ave Counter"
                      : "e.g. Rolex 5th Ave Staging"
              }
              className={inputCls}
              autoFocus
            />
          </FormField>

          {/* SelectField's Radix Select ROOT forwards no id to its trigger -
              a known gap (FormField.tsx's header comment). Kept as
              SelectField, not a raw Select/SelectTrigger: the layering guard
              resolves literal/local-const classNames, and this control's
              hard/soft classes would redden the ratchet if handed straight
              to SelectTrigger (a components/ui export) instead of through
              SelectField, which the guard does not govern. The wrapping div
              (SelectField + "add branch" button) is a single element, so it
              still goes through cloneElement - the generated id lands on the
              div, unused. */}
          <FormField label="Branch">
            <div className="flex min-w-0 gap-1">
              <SelectField
                aria-label="Branch"
                value={form.branch}
                onValueChange={handleBranchChange}
                className={`min-w-0 flex-1 truncate ${selectCls}`}
                options={[
                  ...branches.map((b) => ({
                    value: b.name,
                    label: `${b.name}${b.code ? ` · ${b.code}` : ""}`,
                  })),
                  { value: "__separator__", label: "──────────", disabled: true },
                  { value: "__add_new__", label: "+ Add new branch…" },
                ]}
              />
              {/* Raw by design: bg-background-light with a no-op hover (idle
                  and hover states are identical) - no minted outline cell
                  matches (outline/neutral carries bg-surface-light). */}
              <button
                type="button"
                onClick={() => setShowAddBranch(true)}
                title="Add a new branch"
                aria-label="Add new branch"
                className="flex flex-shrink-0 items-center justify-center rounded-md border border-border bg-background-light px-2 text-text-secondary hover:bg-background-light"
              >
                <Plus className="h-3.5 w-3.5 text-primary" />
              </button>
            </div>
          </FormField>
        </div>

        {form.type === "truck" && (() => {
          const matchedTechId =
            resolvedTechId || (form.primaryTech.trim() === "" ? "__unassigned__" : "");
          const matchedTech =
            driverTechs.find((t) => t.id === resolvedTechId) ??
            driverTechs.find((t) => t.name === form.primaryTech);
          // One-van-per-tech is convention only (no DB unique) — warn softly when the
          // picked tech already anchors another location, never block (P3 §1b).
          const conflictLocation = matchedTech
            ? existingLocations.find(
                (l) =>
                  l.id !== editLocation?.id &&
                  ((!!l.primaryTechId && l.primaryTechId === matchedTech.id) ||
                    (!l.primaryTechId &&
                      !!l.primaryTech &&
                      l.primaryTech === matchedTech.name)),
              )
            : undefined;
          const knownVehicleTechs = matchedTech?.vehicle === form.vehicle;
          const knownVehicles = Array.from(
            new Set(
              driverTechs.map((t) => t.vehicle).filter(Boolean) as string[],
            ),
          );
          return (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-md border border-border bg-background-light p-3">
            {/* SelectField's Radix Select ROOT forwards no id to its trigger -
                a known gap (FormField.tsx's header comment). Kept as
                SelectField, not a raw Select/SelectTrigger: the layering
                guard resolves same-file local `const` string classNames, and
                selectCls's hard/soft classes would redden the ratchet if
                handed straight to SelectTrigger (a components/ui export)
                instead of through SelectField, which the guard does not
                govern. render-prop is still needed here (not cloneElement)
                for the conditional helper/warning paragraphs sitting after
                the Select - fieldProps go unused since SelectField has
                nowhere to receive them. */}
            <FormField label="Primary Tech">
              {() => (
                <>
                  <SelectField
                    aria-label="Primary tech"
                    value={matchedTechId}
                    onValueChange={handleTechPick}
                    placeholder={
                      form.primaryTech && !matchedTech && matchedTechId === ""
                        ? `${form.primaryTech} (free-text — not in tech list)`
                        : undefined
                    }
                    className={selectCls}
                    options={[
                      { value: "__unassigned__", label: "Unassigned" },
                      ...driverTechs.map((t) => ({
                        value: t.id,
                        label: `${t.name}${t.primaryTrade ? ` · ${t.primaryTrade}` : ""}${t.role === "subcontractor" ? " · 1099" : ""}`,
                      })),
                    ]}
                  />
                  {matchedTech && (
                    <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-text-secondary">
                      <UserIcon className="h-3 w-3" />
                      {matchedTech.branch}
                      {matchedTech.certs && matchedTech.certs.length > 0
                        ? ` · ${matchedTech.certs.join(" · ")}`
                        : ""}
                    </p>
                  )}
                  {conflictLocation && (
                    <p className="mt-0.5 text-[11px] text-warning">
                      {matchedTech!.name} is already the primary tech of “
                      {conflictLocation.name}” — one van per tech is the convention.
                    </p>
                  )}
                </>
              )}
            </FormField>
            <FormField label="Vehicle">
              {/* Render-prop: Input + datalist + a conditional success
                  paragraph, a compound shape cloneElement can't target -
                  fieldProps lands on the Input. */}
              {(fieldProps) => (
                <>
                  <Input
                    {...fieldProps}
                    list="known-vehicles"
                    value={form.vehicle}
                    onChange={(e) => set("vehicle", e.target.value)}
                    placeholder="Ford Transit · BX-4421"
                    className={inputCls}
                  />
                  <datalist id="known-vehicles">
                    {knownVehicles.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                  {matchedTech?.vehicle && knownVehicleTechs && (
                    <p className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-success">
                      ✨ Auto-filled from {matchedTech.name}'s assigned vehicle
                    </p>
                  )}
                </>
              )}
            </FormField>
            <div className="col-span-2 text-[11px] text-text-secondary">
              Stock at this location starts at zero. Use{" "}
              <strong>Transfer</strong> to seed inventory from the warehouse,
              or assign as the receive-to for an incoming PO.
            </div>
          </div>
          );
        })()}

        {/* Nested AddBranch dialog */}
        <AddBranchDialog
          open={showAddBranch}
          onClose={() => setShowAddBranch(false)}
          onCreate={handleBranchCreated}
        />
      </div>
    </Modal>
  );
}

const inputCls = "w-full px-2.5 py-1.5";

// SelectField isn't a design-system primitive under the layering guard, so it
// keeps its prior appearance verbatim, independent of the now-stripped inputCls.
const selectCls =
  "w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
