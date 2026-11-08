/**
 * SetQuantityDialog — the physical-count ("Set quantity") action on the Stock page
 * (Inventory P1 §6). Records ONE `adjust` movement of counted − system on-hand via
 * POST /api/inventory/stock/set-quantity (QA-205: counted 7 vs system 9 ⇒ adjust −2).
 * Composition mirrors RestockDialog (Modal + SelectField + same footer button classes).
 */
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Boxes } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/form/SelectField";
import { FormField } from "@/components/patterns/FormField";
import { useSetQuantity, type Item, type Location } from "@/lib/api/inventory";
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

// Fixed adjustment reasons (spec §12 rec 3). "Other" requires a free-text note; the sent reason
// is then composed as "Other: <note>". Every other preset is sent verbatim.
const ADJUST_REASONS = [
  "Cycle count",
  "Damaged",
  "Used on job",
  "Returned to vendor",
  "Lost or stolen",
  "Other",
] as const;
const OTHER_REASON = "Other";

export function SetQuantityDialog({ open, onClose, item, locations, onSubmitted }: Props) {
  const setQuantity = useSetQuantity();
  const { data: org } = useOrganization();

  // Default: first location that carries a balance row for this item, else org default.
  const defaultLocationId = useMemo(() => {
    if (!item) return "";
    const withBalance = locations.find((l) => item.stock.some((s) => s.locationId === l.id));
    return withBalance?.id ?? org?.default_inventory_location_id ?? locations[0]?.id ?? "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, locations, org?.default_inventory_location_id]);

  const [locationId, setLocationId] = useState("");
  const [counted, setCounted] = useState("");
  const [reasonPreset, setReasonPreset] = useState("");
  const [reasonNote, setReasonNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLocationId(defaultLocationId);
    setCounted("");
    setReasonPreset("");
    setReasonNote("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);

  // "Other" folds the note in; every other preset is sent verbatim.
  const composedReason =
    reasonPreset === OTHER_REASON ? `${OTHER_REASON}: ${reasonNote.trim()}` : reasonPreset;

  const onHandAt = (locId: string): number =>
    item?.stock.find((s) => s.locationId === locId)?.onHand ?? 0;

  const onHand = onHandAt(locationId);
  const countedNum = parseFloat(counted);
  const hasCount = counted.trim() !== "" && !Number.isNaN(countedNum);
  // Decimal quantities are a P0 fact — keep fractional deltas exact-ish for display.
  const delta = hasCount ? Math.round((countedNum - onHand) * 100) / 100 : 0;

  async function submit() {
    if (!item) return setError("No item selected.");
    if (!locationId) return setError("Pick a location.");
    if (!hasCount || countedNum < 0) return setError("Counted quantity must be 0 or more.");
    if (!reasonPreset) return setError("Reason is required.");
    if (reasonPreset === OTHER_REASON && !reasonNote.trim())
      return setError("Add a note describing the reason.");
    setError(null);
    try {
      await setQuantity.mutateAsync({
        itemId: item.id,
        locationId,
        countedQty: countedNum,
        reason: composedReason,
      });
    } catch (err) {
      setError(extractApiError(err, "Could not record the count — try again."));
      return;
    }
    const locName = locations.find((l) => l.id === locationId)?.name ?? "location";
    onSubmitted(
      `✓ ${item.sku}: set to ${countedNum} at ${locName} (adjust ${delta >= 0 ? "+" : ""}${delta})`,
    );
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Set Quantity (Count)"
      subtitle="Records one immutable stock_movement (type: adjust) of counted − system on-hand."
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          {/* --success and --sage-700 resolve to the same RGB (tokens.css), so
              solid/business is a pixel-exact background match for this CTA. */}
          <Button variant="solid" tone="business" size="sm"
            onClick={submit}
            disabled={setQuantity.isPending}
          >
            <Boxes className="h-3.5 w-3.5" />
            {setQuantity.isPending ? "Saving…" : "Set quantity"}
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
        {/* Not converted to FormField: SelectField's own API has no `id` and
            does not spread the rest of its props onto the trigger, so
            FormField's generated id would reach no element and the label
            would point at nothing (same structural block as LeadFormPage's
            TimeSelect deferral). The local `Field` helper stays defined for
            this and the Reason site below. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Location" required>
            <SelectField
              aria-label="Location"
              value={locationId}
              onValueChange={setLocationId}
              className={selectCls}
              options={locations.map((l) => ({
                value: l.id,
                label: `${l.name} — ${onHandAt(l.id)} on hand`,
              }))}
            />
          </Field>
          <FormField label={`Counted quantity (${item?.uom ?? ""})`} required gap={1}>
            <Input
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              type="number"
              min="0"
              step="0.01"
              placeholder="0"
              className={inputCls}
              autoFocus
              aria-label="Counted quantity"
            />
          </FormField>
        </div>

        {/* Not converted to FormField: SelectField non-forwarding (see the
            Location comment above). */}
        <Field label="Reason" required>
          <SelectField
            aria-label="Reason"
            value={reasonPreset}
            onValueChange={setReasonPreset}
            placeholder="Select a reason…"
            className={selectCls}
            options={ADJUST_REASONS.map((r) => ({ value: r, label: r }))}
          />
        </Field>

        {reasonPreset === OTHER_REASON && (
          <FormField label="Note" required gap={1}>
            <Input
              value={reasonNote}
              onChange={(e) => setReasonNote(e.target.value)}
              placeholder="Describe the adjustment"
              className={inputCls}
              aria-label="Reason note"
            />
          </FormField>
        )}

        {hasCount && (
          <p className="rounded-md border border-border bg-background-light/60 px-3 py-2 text-sm text-text-secondary">
            System shows <span className="font-mono font-semibold text-text-primary">{onHand}</span>{" "}
            — this records an adjustment of{" "}
            <span className="font-mono font-semibold text-text-primary">
              {delta > 0 ? "+" : ""}
              {delta}
            </span>
            .
          </p>
        )}
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
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
    </label>
  );
}
