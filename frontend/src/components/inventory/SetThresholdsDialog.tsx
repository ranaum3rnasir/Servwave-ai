/**
 * SetThresholdsDialog - "Reserve levels" (SRVW-91): the per-(item, location) min/max editor.
 * PUT /api/inventory/stock/thresholds is the only writer of StockBalance.min/max, so this is
 * where the low-stock chip, the Low stock tab, the bulk-restock dialog and the low-stock PO
 * proposals come alive. It never touches on-hand - quantity keeps its own single write path.
 * Composition mirrors SetQuantityDialog (Modal + SelectField + the same footer buttons).
 */
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Gauge } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/form/SelectField";
import { FormField } from "@/components/patterns/FormField";
import { useSetThresholds, type Item, type Location } from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
import { extractApiError } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  item: Item | null;
  locations: Location[];
  onSubmitted: (msg: string) => void;
};

export function SetThresholdsDialog({ open, onClose, item, locations, onSubmitted }: Props) {
  const setThresholds = useSetThresholds();
  const { data: org } = useOrganization();

  // Every location is offered, not only the ones that already carry a balance row -
  // reaching a fresh pair is exactly how a first threshold gets set.
  const defaultLocationId = useMemo(
    () => org?.default_inventory_location_id ?? locations[0]?.id ?? "",
    [org?.default_inventory_location_id, locations],
  );

  const [locationId, setLocationId] = useState("");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [error, setError] = useState<string | null>(null);

  const thresholdsAt = (locId: string) => item?.stock.find((s) => s.locationId === locId);
  const asField = (n: number | undefined) => (n == null ? "" : String(n));

  useEffect(() => {
    if (!open) return;
    pickLocation(defaultLocationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id, defaultLocationId]);

  // Switching location re-prefills from that location's stored levels.
  function pickLocation(locId: string) {
    const current = thresholdsAt(locId);
    setLocationId(locId);
    setMin(asField(current?.min));
    setMax(asField(current?.max));
    setError(null);
  }

  const onHandAt = (locId: string): number => thresholdsAt(locId)?.onHand ?? 0;

  // A blank input clears the column back to NULL.
  function parseLevel(raw: string): number | null | undefined {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return undefined;
    return n;
  }

  async function submit() {
    if (!item) return setError("No item selected.");
    if (!locationId) return setError("Pick a location.");
    const minValue = parseLevel(min);
    const maxValue = parseLevel(max);
    if (minValue === undefined || maxValue === undefined)
      return setError("Reserve levels must be whole numbers of 0 or more.");
    if (minValue != null && maxValue != null && maxValue < minValue)
      return setError("Max must be greater than or equal to Min.");
    setError(null);
    try {
      await setThresholds.mutateAsync({ itemId: item.id, locationId, min: minValue, max: maxValue });
    } catch (err) {
      setError(extractApiError(err, "Could not save the reserve levels - try again."));
      return;
    }
    const locName = locations.find((l) => l.id === locationId)?.name ?? "location";
    onSubmitted(
      `✓ ${item.sku}: reserve levels at ${locName} set to min ${minValue ?? "none"} / max ${maxValue ?? "none"}`,
    );
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Reserve Levels"
      subtitle="Min drives the low-stock alert; max caps replenishment suggestions. On-hand is not changed."
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button variant="solid" tone="business" size="sm"
            onClick={submit}
            disabled={setThresholds.isPending}
          >
            <Gauge className="h-3.5 w-3.5" />
            {setThresholds.isPending ? "Saving…" : "Save levels"}
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
        {/* Not converted to FormField: SelectField's own API has no `id` and does not
            spread the rest of its props onto the trigger, so FormField's generated id
            would reach no element (same structural block as SetQuantityDialog). */}
        <Field label="Location" required>
          <SelectField
            aria-label="Location"
            value={locationId}
            onValueChange={pickLocation}
            className={selectCls}
            options={locations.map((l) => ({
              value: l.id,
              label: `${l.name} - ${onHandAt(l.id)} on hand`,
            }))}
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField label="Min (reserve)" gap={1}>
            <Input
              value={min}
              onChange={(e) => setMin(e.target.value)}
              type="number"
              min="0"
              step="1"
              placeholder="none"
              className={inputCls}
              autoFocus
              aria-label="Min reserve"
            />
          </FormField>
          <FormField label="Max (reorder cap)" gap={1}>
            <Input
              value={max}
              onChange={(e) => setMax(e.target.value)}
              type="number"
              min="0"
              step="1"
              placeholder="none"
              className={inputCls}
              aria-label="Max reorder cap"
            />
          </FormField>
        </div>

        <p className="rounded-md border border-border bg-background-light/60 px-3 py-2 text-sm text-text-secondary">
          Leave a field blank to clear it. Alerts fire on the next movement that takes on-hand
          below the min - setting a min under today's count does not send one on its own.
        </p>
      </div>
    </Modal>
  );
}

// Input now owns its own border/radius/background/focus-ring appearance
// (design-system layering guard) - this constant is layout-only.
const inputCls = "w-full px-2.5 py-1.5";
const selectCls =
  "w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  // A div, not a <label>: the only control this wraps is SelectField, which
  // renders a Radix trigger carrying its own `aria-label` - that wins over a
  // wrapping label for the accessible name, so the label element contributed
  // nothing and only pushed the raw-<label> ratchet above its floor. FormField
  // is not the answer here either, for the reason recorded at the call site.
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
    </div>
  );
}
