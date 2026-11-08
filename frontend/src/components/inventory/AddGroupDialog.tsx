import { useEffect, useMemo, useRef, useState } from "react";
import {
  ImagePlus,
  Layers,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { UploadedImage } from "@/components/ui/uploaded-image";
import {
  ACCEPTED_IMAGE_MIMES,
  ImageUploadError,
  MAX_SOURCE_BYTES,
  formatBytes,
  prepareImageUpload,
} from "@/lib/image-upload";
import { FormField } from "@/components/patterns/FormField";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCurrency } from "@/lib/utils";
import type { Item, ItemGroup, ItemGroupLine } from "@/lib/api/inventory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// `ItemGroupType` is not re-exported by the seam; derive it from ItemGroup so we
// never import from lib/api/_mock directly (data-seam discipline).
type ItemGroupType = ItemGroup["groupType"];

// Same photo constraints as the brand-logo + category-photo uploads.

type Props = {
  open: boolean;
  onClose: () => void;
  onCreate?: (group: ItemGroup) => void;
  editGroup?: ItemGroup | null;
  onUpdate?: (group: ItemGroup) => void;
  /** Full Item list — used for the line-item picker. */
  items: Item[];
};

/**
 * AddGroupDialog — create or edit a preset Item Group bundle
 * (PRD §6.11 rev 2026-05-28 redesign).
 *
 * An Item Group is a saved bundle of line items dropped onto an estimate or
 * invoice for fast turnaround. Each bundle picks a display mode (flat rate vs
 * itemized), holds a list of lines (each either a Price Book item reference
 * with optional per-line price/cost override, or a free-form custom line), and
 * optionally a custom flat-rate price that overrides the sum-of-lines.
 */
export function AddGroupDialog({
  open,
  onClose,
  onCreate,
  editGroup,
  onUpdate,
  items,
}: Props) {
  const isEdit = !!editGroup;
  const [form, setForm] = useState<{
    name: string;
    description: string;
    photoUrl: string;
    groupType: ItemGroupType;
    flatRatePriceOverride: string;
    isActive: boolean;
    lines: ItemGroupLine[];
  }>({
    name: "",
    description: "",
    photoUrl: "",
    groupType: "individual",
    flatRatePriceOverride: "",
    isActive: true,
    lines: [],
  });
  const [error, setError] = useState<string | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && editGroup) {
      setForm({
        name: editGroup.name,
        description: editGroup.description ?? "",
        photoUrl: editGroup.photoUrl ?? "",
        groupType: editGroup.groupType,
        flatRatePriceOverride:
          editGroup.flatRatePriceOverride != null
            ? String(editGroup.flatRatePriceOverride)
            : "",
        isActive: editGroup.isActive,
        lines: editGroup.lines.map((l) => ({ ...l })),
      });
      setError(null);
    } else if (open && !editGroup) {
      setForm({
        name: "",
        description: "",
        photoUrl: "",
        groupType: "individual",
        flatRatePriceOverride: "",
        isActive: true,
        lines: [],
      });
      setError(null);
    }
    if (open) {
      setPickerQuery("");
      setPickerOpen(false);
    }
  }, [open, editGroup?.id]);

  async function handleFilePick(file: File) {
    try {
      const dataUrl = await prepareImageUpload(file);
      setForm((f) => ({ ...f, photoUrl: dataUrl }));
      setError(null);
    } catch (err) {
      setError(
        err instanceof ImageUploadError
          ? err.message
          : "Couldn't read the file. Try a different image.",
      );
    }
  }

  // Item picker search — name, sku, customerName
  const pickerResults = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    if (!q) return items.slice(0, 8);
    return items
      .filter((it) => {
        const hay = `${it.name} ${it.customerName ?? ""} ${it.sku}`.toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 8);
  }, [items, pickerQuery]);

  function addRealItemLine(it: Item) {
    const newLine: ItemGroupLine = {
      id: `ln_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      itemId: it.id,
      name: it.name,
      quantity: 1,
    };
    setForm((f) => ({ ...f, lines: [...f.lines, newLine] }));
    setPickerQuery("");
    setPickerOpen(false);
  }

  function addFreeFormLine() {
    const newLine: ItemGroupLine = {
      id: `ln_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: "",
      quantity: 1,
      priceOverride: 0,
      costOverride: 0,
    };
    setForm((f) => ({ ...f, lines: [...f.lines, newLine] }));
    setPickerOpen(false);
  }

  function updateLine(id: string, patch: Partial<ItemGroupLine>) {
    setForm((f) => ({
      ...f,
      lines: f.lines.map((l) => (l.id === id ? { ...l, ...patch } : l)),
    }));
  }

  function removeLine(id: string) {
    setForm((f) => ({ ...f, lines: f.lines.filter((l) => l.id !== id) }));
  }

  // Effective price/cost per line — override falls back to the referenced
  // item's listPrice/sellPrice/unitCost when set, otherwise 0.
  function linePrice(line: ItemGroupLine): number {
    if (line.priceOverride != null) return line.priceOverride;
    if (line.itemId) {
      const it = items.find((x) => x.id === line.itemId);
      if (it) return it.listPrice ?? it.sellPrice ?? 0;
    }
    return 0;
  }
  function lineCost(line: ItemGroupLine): number {
    if (line.costOverride != null) return line.costOverride;
    if (line.itemId) {
      const it = items.find((x) => x.id === line.itemId);
      if (it) return it.unitCost ?? 0;
    }
    return 0;
  }
  function lineAmount(line: ItemGroupLine): number {
    return linePrice(line) * line.quantity;
  }
  function lineMarginPct(line: ItemGroupLine): number | null {
    const p = linePrice(line);
    const c = lineCost(line);
    if (p <= 0) return null;
    if (c <= 0) return 100; // 100% margin (or treat as max)
    return ((p - c) / p) * 100;
  }

  const subtotal = form.lines.reduce((sum, l) => sum + lineAmount(l), 0);

  const customerSeesPrice = (() => {
    if (form.groupType === "individual") return subtotal;
    // flat_rate: override if set, else subtotal
    if (form.flatRatePriceOverride.trim()) {
      const v = Number(form.flatRatePriceOverride);
      if (isFinite(v) && v >= 0) return v;
    }
    return subtotal;
  })();

  function submit() {
    if (!form.name.trim()) return setError("Bundle name is required.");
    if (form.lines.length === 0)
      return setError("Add at least one line to the bundle.");
    // Validate free-form lines have a name + non-negative price
    for (const l of form.lines) {
      if (!l.itemId && !l.name.trim()) {
        return setError("Free-form lines need a name.");
      }
      if (l.quantity <= 0) {
        return setError(`Quantity must be greater than 0 (line "${l.name || "—"}").`);
      }
    }
    let parsedFlatRate: number | undefined = undefined;
    if (form.groupType === "flat_rate" && form.flatRatePriceOverride.trim()) {
      const v = Number(form.flatRatePriceOverride);
      if (!isFinite(v) || v < 0) {
        return setError("Flat-rate price must be a positive number.");
      }
      parsedFlatRate = v;
    }
    const payload: ItemGroup = {
      id: editGroup?.id ?? `grp_new_${Date.now()}`,
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      photoUrl: form.photoUrl || undefined,
      groupType: form.groupType,
      flatRatePriceOverride: parsedFlatRate,
      isActive: form.isActive,
      lines: form.lines.map((l) => ({
        ...l,
        name: l.name.trim(),
      })),
    };
    if (isEdit && onUpdate) onUpdate(payload);
    else if (onCreate) onCreate(payload);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit Bundle · ${editGroup!.name}` : "Create Bundle"}
      subtitle="Preset list of items + quantities. Drop the bundle onto an estimate or invoice and every line populates automatically."
      size="xl"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button size="sm"
            onClick={submit}
          >
            {isEdit ? (
              <>
                <Pencil className="h-3.5 w-3.5" />
                Save Changes
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                Save Bundle
              </>
            )}
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
        {/* Hero photo banner */}
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Bundle Photo (optional)
          </span>
          {/* Raw by design: a banner-style photo-tile upload trigger with a
              conditional idle ring/bg state - no minted Button cell
              reproduces this shape. */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={[
              "mt-1 flex aspect-[4/1] w-full items-center justify-center overflow-hidden rounded-lg ring-1 transition",
              form.photoUrl
                ? "ring-border hover:ring-primary/40"
                : "bg-background-light ring-border hover:bg-background-light hover:ring-primary/40",
            ].join(" ")}
            title={form.photoUrl ? "Replace bundle photo" : "Upload bundle photo"}
          >
            {form.photoUrl ? (
              <UploadedImage src={form.photoUrl} backdrop className="h-full w-full" />
            ) : (
              <div className="flex flex-col items-center gap-1 text-text-secondary">
                <ImagePlus className="h-5 w-5" />
                <span className="text-[11px]">Click to upload a hero photo</span>
              </div>
            )}
          </button>
          <Input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_MIMES.join(",")}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFilePick(file);
              e.target.value = "";
            }}
            className="hidden"
          />
          <div className="mt-1 flex items-center justify-between">
            <p className="text-[10px] text-text-secondary">
              PNG / JPG / SVG / WebP / HEIC · up to {formatBytes(MAX_SOURCE_BYTES)}
            </p>
            {/* Raw by design: a danger-toned text link with no matching
                link/danger cell (link only has a brand tone). */}
            {form.photoUrl && (
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, photoUrl: "" }))}
                className="inline-flex items-center gap-0.5 text-[10px] text-danger hover:underline"
              >
                <Trash2 className="h-2.5 w-2.5" />
                Remove
              </button>
            )}
          </div>
        </div>

        {/* Name + Active toggle */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="col-span-2">
            <FormField label="Bundle Name" required>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Standard Rekey, Camera Install Kit, Lockout Service…"
                className={inputCls}
                autoFocus
              />
            </FormField>
          </div>
          <div className="flex items-end">
            {/* Checkbox-leads-its-own-label row: FormField always renders its
                label ABOVE the control, which would flip this to a stacked
                layout - a real visual change, not a wrapping move. Left raw. */}
            <label className="flex items-center gap-2 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(e) =>
                  setForm((f) => ({ ...f, isActive: e.target.checked }))
                }
                className="h-4 w-4 rounded border-border text-primary focus:ring-primary"
              />
              Active — show in estimate / invoice picker
            </label>
          </div>
        </div>

        <FormField label="Description" optional>
          <Textarea
            value={form.description}
            onChange={(e) =>
              setForm((f) => ({ ...f, description: e.target.value }))
            }
            rows={2}
            placeholder="One-liner — what's in this bundle and when do you use it"
            className={`${inputCls} resize-none`}
          />
        </FormField>

        {/* Group type */}
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Customer-facing format
          </span>
          <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <GroupTypeOption
              active={form.groupType === "individual"}
              title="Individual items"
              subtitle="Every line shows on the estimate (parts + labor itemized)"
              onClick={() =>
                setForm((f) => ({ ...f, groupType: "individual" }))
              }
            />
            <GroupTypeOption
              active={form.groupType === "flat_rate"}
              title="Flat rate"
              subtitle="One lump-sum line on the estimate. Items stay internal."
              onClick={() => setForm((f) => ({ ...f, groupType: "flat_rate" }))}
            />
          </div>
        </div>

        {form.groupType === "flat_rate" && (
          <FormField
            label="Flat-rate price (optional override)"
            hint={
              <>
                Leave blank to use the sum of items. Set a number to charge a fixed
                price (e.g. "Standard Rekey: $189 flat" even if parts only sum to $120).
              </>
            }
          >
            {/* Render-prop: the control is a "$" prefix span plus the Input,
                a compound pair cloneElement can't target - fieldProps lands
                on the Input itself. */}
            {(fieldProps) => (
              <div className="flex items-center gap-2">
                <span className="text-sm text-text-secondary">$</span>
                <Input
                  {...fieldProps}
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.flatRatePriceOverride}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      flatRatePriceOverride: e.target.value,
                    }))
                  }
                  placeholder={`Default = ${formatCurrency(subtotal)} (sum of items)`}
                  className={inputCls}
                />
              </div>
            )}
          </FormField>
        )}

        {/* Bundle lines */}
        <div className="rounded-card border border-border bg-background-light/40 p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              Items in this bundle
            </span>
            <span className="text-[11px] text-text-secondary">
              {form.lines.length} line{form.lines.length === 1 ? "" : "s"}
            </span>
          </div>

          {/* Picker */}
          <div className="relative mt-2">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-secondary" />
                <Input
                  value={pickerQuery}
                  onFocus={() => setPickerOpen(true)}
                  onChange={(e) => {
                    setPickerQuery(e.target.value);
                    setPickerOpen(true);
                  }}
                  placeholder="Search items…"
                  className="py-1.5 pl-8 pr-2.5"
                />
              </div>
              {/* Raw by design: outline/neutral sets no idle text colour and
                  nothing in this row's ambient wrapper supplies one, so
                  converting would silently render this muted text-secondary
                  label near-black. */}
              <button
                type="button"
                onClick={addFreeFormLine}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm text-text-secondary hover:bg-background-light"
                title="Add a one-off line that isn't a Price Book item"
              >
                <Plus className="h-3.5 w-3.5" />
                Free-form line
              </button>
            </div>
            {pickerOpen && (
              <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-surface-light shadow-lg">
                {pickerResults.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-text-secondary">
                    No items match — try a different search or click "Free-form line"
                  </div>
                ) : (
                  // Raw by design: a listbox-row click target, not
                  // Button-shaped.
                  pickerResults.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => addRealItemLine(it)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-primary-subtle"
                    >
                      {it.photoUrl ? (
                        <UploadedImage
                          src={it.photoUrl}
                          radius="sm"
                          edge="ring"
                          className="h-6 w-6"
                        />
                      ) : (
                        <div className="h-6 w-6 rounded bg-background-light ring-1 ring-border" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-text-primary">
                          {it.customerName ?? it.name}
                        </div>
                        <div className="text-[10px] text-text-secondary">
                          {it.sku} · ${(it.listPrice ?? it.sellPrice ?? 0).toFixed(2)}
                        </div>
                      </div>
                    </button>
                  ))
                )}
                <Button
                  variant="ghost"
                  tone="subtle"
                  size="3xs"
                  onClick={() => setPickerOpen(false)}
                  className="w-full"
                >
                  Close
                </Button>
              </div>
            )}
          </div>

          {/* Lines table */}
          <div className="mt-3 overflow-hidden rounded-md border border-border bg-surface-light">
            <table className="min-w-full text-sm">
              <thead className="border-b border-border bg-background-light text-left text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-2 py-1.5">Item</th>
                  <th className="px-2 py-1.5 w-20 text-right">Qty</th>
                  <th className="px-2 py-1.5 w-24 text-right">Price</th>
                  <th className="px-2 py-1.5 w-24 text-right">Cost</th>
                  <th className="px-2 py-1.5 w-16 text-right">Margin</th>
                  <th className="px-2 py-1.5 w-20 text-right">Amount</th>
                  <th className="px-2 py-1.5 w-8"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {form.lines.length === 0 && (
                  <tr>
                    <td
                      colSpan={7}
                      className="px-3 py-8 text-center text-xs text-text-secondary"
                    >
                      <EmptyState title='No lines yet — search above to add Price Book items, or click "Free-form line" for one-off charges.' />
                    </td>
                  </tr>
                )}
                {form.lines.map((line) => {
                  const isFreeForm = !line.itemId;
                  const referencedItem = line.itemId
                    ? items.find((x) => x.id === line.itemId)
                    : undefined;
                  const margin = lineMarginPct(line);
                  return (
                    <tr key={line.id} className="align-top">
                      <td className="px-2 py-1.5">
                        {isFreeForm ? (
                          <Input
                            value={line.name}
                            onChange={(e) =>
                              updateLine(line.id, { name: e.target.value })
                            }
                            placeholder="Free-form line name…"
                            className="px-1.5 py-1"
                          />
                        ) : (
                          <div className="flex items-center gap-2">
                            {referencedItem?.photoUrl ? (
                              <UploadedImage
                                src={referencedItem.photoUrl}
                                radius="sm"
                                edge="ring"
                                className="h-7 w-7"
                              />
                            ) : (
                              <div className="h-7 w-7 rounded bg-background-light ring-1 ring-border" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-sm font-medium text-text-primary">
                                {line.name}
                              </div>
                              <div className="text-[10px] text-text-secondary">
                                {referencedItem?.sku ?? ""}
                              </div>
                            </div>
                          </div>
                        )}
                        {isFreeForm && (
                          <span className="mt-0.5 inline-block rounded bg-warning/10 px-1 py-0 text-[9px] font-medium text-warning">
                            FREE-FORM
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          type="number"
                          step="0.25"
                          min="0"
                          value={line.quantity}
                          onChange={(e) =>
                            updateLine(line.id, {
                              quantity: Number(e.target.value) || 0,
                            })
                          }
                          className="px-1.5 py-1 text-right"
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={
                            line.priceOverride != null
                              ? line.priceOverride
                              : linePrice(line) || ""
                          }
                          onChange={(e) => {
                            const v = e.target.value;
                            updateLine(line.id, {
                              priceOverride: v === "" ? undefined : Number(v),
                            });
                          }}
                          placeholder={
                            !isFreeForm && referencedItem
                              ? `${(referencedItem.listPrice ?? referencedItem.sellPrice ?? 0).toFixed(2)}`
                              : "0.00"
                          }
                          className="px-1.5 py-1 text-right"
                          title={
                            !isFreeForm
                              ? "Override the item's list price for this bundle. Leave blank to use the item's current price."
                              : ""
                          }
                        />
                      </td>
                      <td className="px-2 py-1.5">
                        <Input
                          type="number"
                          step="0.01"
                          min="0"
                          value={
                            line.costOverride != null
                              ? line.costOverride
                              : lineCost(line) || ""
                          }
                          onChange={(e) => {
                            const v = e.target.value;
                            updateLine(line.id, {
                              costOverride: v === "" ? undefined : Number(v),
                            });
                          }}
                          placeholder={
                            !isFreeForm && referencedItem
                              ? `${(referencedItem.unitCost ?? 0).toFixed(2)}`
                              : "0.00"
                          }
                          className="px-1.5 py-1 text-right"
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right text-xs tabular-nums text-text-secondary">
                        {margin == null ? "—" : `${margin.toFixed(0)}%`}
                      </td>
                      <td className="px-2 py-1.5 text-right text-sm tabular-nums font-medium text-text-primary">
                        ${lineAmount(line).toFixed(2)}
                      </td>
                      <td className="px-2 py-1.5">
                        <Button
                          variant="ghost"
                          tone="danger"
                          revealOnHover
                          size="3xs"
                          onClick={() => removeLine(line.id)}
                          title="Remove line"
                          aria-label="Remove line"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {form.lines.length > 0 && (
                <tfoot className="border-t border-border bg-background-light/60 text-sm">
                  <tr>
                    <td colSpan={5} className="px-2 py-1.5 text-right text-text-secondary">
                      Subtotal (sum of lines)
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-text-primary">
                      ${subtotal.toFixed(2)}
                    </td>
                    <td></td>
                  </tr>
                  <tr>
                    <td
                      colSpan={5}
                      className="px-2 py-1.5 text-right text-[11px] uppercase tracking-wide text-primary"
                    >
                      Customer sees ({form.groupType === "flat_rate" ? "flat rate" : "itemized"})
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-base font-bold text-primary">
                      ${customerSeesPrice.toFixed(2)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>
    </Modal>
  );
}

const inputCls = "w-full px-2.5 py-1.5";

function GroupTypeOption({
  active,
  title,
  subtitle,
  onClick,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    // Raw by design: a segmented toggle control (a 2-option card selector),
    // not Button-shaped.
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex flex-col items-start gap-0.5 rounded-md border-2 p-2.5 text-left transition",
        active
          ? "border-primary bg-primary-subtle"
          : "border-border bg-surface-light hover:border-secondary",
      ].join(" ")}
    >
      <div className="flex items-center gap-1.5">
        <Layers
          className={`h-3.5 w-3.5 ${active ? "text-primary" : "text-text-secondary"}`}
        />
        <span
          className={`text-sm font-semibold ${active ? "text-primary" : "text-text-secondary"}`}
        >
          {title}
        </span>
      </div>
      <span className={`text-[11px] ${active ? "text-primary" : "text-text-secondary"}`}>
        {subtitle}
      </span>
    </button>
  );
}
