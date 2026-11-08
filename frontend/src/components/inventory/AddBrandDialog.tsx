import { useEffect, useRef, useState } from "react";
import { ImagePlus, Pencil, Plus, Trash2 } from "lucide-react";
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
import { SelectField } from "@/components/form/SelectField";
import type { Brand, Vendor } from "@/lib/api/inventory";
import { extractApiError } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// Upload rules (accepted types, source cap, downscale-before-store) live in
// `lib/image-upload` - shared with the category / group / item photo pickers so
// a picture accepted on one of them is accepted on all four.

type Props = {
  open: boolean;
  onClose: () => void;
  /** Fired on save in create mode (no editBrand passed). May return a promise -
   *  awaited so a rejection keeps the dialog open with an error. */
  onCreate?: (brand: Brand) => unknown;
  /** When set, the dialog opens in edit mode pre-filled with this brand. */
  editBrand?: Brand | null;
  /** Fired on save in edit mode - returns the updated brand. May return a
   *  promise - awaited so a rejection keeps the dialog open with an error. */
  onUpdate?: (brand: Brand) => unknown;
  /** Vendor list for the default-vendor dropdown. */
  vendors: Vendor[];
};

/**
 * AddBrandDialog — create or edit a Brand (PRD §6.10, rev 2026-05-27).
 *
 * Brands are first-class manufacturer entities — Mul-T-Lock, Medeco,
 * ASSA Abloy, etc. Each brand can carry a default markup percentage that
 * applies to every item in the brand (overridable per-item or per-group),
 * and a default vendor that auto-fills `item.vendor` when this brand is
 * picked in AddItemDialog.
 */
export function AddBrandDialog({
  open,
  onClose,
  onCreate,
  editBrand,
  onUpdate,
  vendors,
}: Props) {
  const isEdit = !!editBrand;
  const [form, setForm] = useState<{
    name: string;
    logoUrl: string;            // data: URI (uploaded) or seed value; empty string = no logo
    website: string;
    description: string;
    defaultMarkupPct: string; // string for input control, converted on save
    defaultVendorId: string;
    isActive: boolean;
  }>({
    name: "",
    logoUrl: "",
    website: "",
    description: "",
    defaultMarkupPct: "",
    defaultVendorId: "",
    isActive: true,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && editBrand) {
      setForm({
        name: editBrand.name,
        logoUrl: editBrand.logoUrl ?? "",
        website: editBrand.website ?? "",
        description: editBrand.description ?? "",
        defaultMarkupPct:
          editBrand.defaultMarkupPct != null
            ? String(editBrand.defaultMarkupPct)
            : "",
        defaultVendorId: editBrand.defaultVendorId ?? "",
        isActive: editBrand.isActive ?? true,
      });
      setError(null);
    } else if (open && !editBrand) {
      setForm({
        name: "",
        logoUrl: "",
        website: "",
        description: "",
        defaultMarkupPct: "",
        defaultVendorId: "",
        isActive: true,
      });
      setError(null);
    }
  }, [open, editBrand?.id]);

  async function handleFilePick(file: File) {
    try {
      const dataUrl = await prepareImageUpload(file);
      setForm((f) => ({ ...f, logoUrl: dataUrl }));
      setError(null);
    } catch (err) {
      setError(
        err instanceof ImageUploadError
          ? err.message
          : "Couldn't read the file. Try a different image.",
      );
    }
  }

  async function submit() {
    if (!form.name.trim()) return setError("Brand name is required.");
    let parsedMarkup: number | undefined = undefined;
    if (form.defaultMarkupPct.trim()) {
      const v = Number(form.defaultMarkupPct);
      if (!isFinite(v) || v < 0) {
        return setError(
          "Default markup must be a number (e.g. 1.4 = 40% markup over cost).",
        );
      }
      parsedMarkup = v;
    }
    setSaving(true);
    try {
      if (isEdit && editBrand && onUpdate) {
        await onUpdate({
          ...editBrand,
          name: form.name.trim(),
          logoUrl: form.logoUrl || undefined,
          website: form.website.trim() || undefined,
          description: form.description.trim() || undefined,
          defaultMarkupPct: parsedMarkup,
          defaultVendorId: form.defaultVendorId || undefined,
          isActive: form.isActive,
        });
      } else if (onCreate) {
        const brand: Brand = {
          id: `brd_new_${Date.now()}`,
          name: form.name.trim(),
          logoUrl: form.logoUrl || undefined,
          website: form.website.trim() || undefined,
          description: form.description.trim() || undefined,
          defaultMarkupPct: parsedMarkup,
          defaultVendorId: form.defaultVendorId || undefined,
          isActive: form.isActive,
        };
        await onCreate(brand);
      }
      onClose();
    } catch (err) {
      setError(extractApiError(err, "Could not save the brand - try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit Brand · ${editBrand!.name}` : "Add New Brand"}
      subtitle={
        isEdit
          ? "Update the brand details. Items already in this brand keep their assignment."
          : "Brands represent manufacturers (Mul-T-Lock, Medeco, Schlage). Items get assigned to a brand for filtering and customer-catalog grouping."
      }
      size="md"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button size="sm"
            onClick={submit}
            disabled={saving}
          >
            {isEdit ? (
              <>
                <Pencil className="h-3.5 w-3.5" />
                Save Changes
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5" />
                Save Brand
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
        {/* Logo + Name row — logo on the left as a 64×64 tile, name field on the
            right. Customers recognize the brand by its logo on the Price Book
            cards, so this is surfaced first. (PRD §6.10 rev 2026-05-28.) */}
        <div className="flex items-start gap-3">
          <div className="flex flex-col items-center gap-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              Logo
            </span>
            {/* Raw by design: a 64px square photo-tile upload trigger with a
                conditional idle ring/bg state - no minted Button cell
                reproduces this shape. */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={[
                "flex h-16 w-16 items-center justify-center rounded-lg ring-1 transition",
                form.logoUrl
                  ? "ring-border hover:ring-primary/40"
                  : "bg-background-light ring-border hover:bg-background-light hover:ring-primary/40",
              ].join(" ")}
              title={form.logoUrl ? "Replace logo" : "Upload brand logo"}
              aria-label={form.logoUrl ? "Replace brand logo" : "Upload brand logo"}
            >
              {form.logoUrl ? (
                <UploadedImage
                  src={form.logoUrl}
                  radius="lg"
                  className="h-full w-full"
                />
              ) : (
                <ImagePlus className="h-5 w-5 text-text-secondary" />
              )}
            </button>
            <Input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_IMAGE_MIMES.join(",")}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFilePick(file);
                // reset so re-picking the same file fires onChange again
                e.target.value = "";
              }}
              className="hidden"
            />
            {/* Raw by design: a danger-toned text link with no matching
                link/danger cell (link only has a brand tone). */}
            {form.logoUrl && (
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, logoUrl: "" }))}
                className="inline-flex items-center gap-0.5 text-[10px] text-danger hover:underline"
              >
                <Trash2 className="h-2.5 w-2.5" />
                Remove
              </button>
            )}
          </div>

          <div className="flex-1">
            <FormField label="Brand Name" required>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Mul-T-Lock, Schlage, Honeywell…"
                className={inputCls}
                autoFocus
              />
            </FormField>
            <p className="mt-1 text-[10px] text-text-secondary">
              PNG / JPG / SVG / WebP / HEIC · square works best · up to{" "}
              {formatBytes(MAX_SOURCE_BYTES)}
            </p>
          </div>
        </div>

        <FormField label="Website" optional>
          <Input
            type="url"
            value={form.website}
            onChange={(e) =>
              setForm((f) => ({ ...f, website: e.target.value }))
            }
            placeholder="https://www.brandname.com"
            className={inputCls}
          />
        </FormField>

        <FormField label="Description" optional>
          <Textarea
            value={form.description}
            onChange={(e) =>
              setForm((f) => ({ ...f, description: e.target.value }))
            }
            rows={2}
            placeholder="One-liner — what this brand makes, any rep / payment quirks"
            className={`${inputCls} resize-none`}
          />
        </FormField>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <FormField
            label="Default Markup"
            optional
            hint="Applied when item / group markup is blank"
          >
            <Input
              type="number"
              step="0.05"
              min="0"
              value={form.defaultMarkupPct}
              onChange={(e) =>
                setForm((f) => ({ ...f, defaultMarkupPct: e.target.value }))
              }
              placeholder="1.4 = 40% markup"
              className={inputCls}
            />
          </FormField>

          {/* SelectField's Radix Select ROOT forwards no id to its trigger -
              a known gap (FormField.tsx's header comment). Kept as
              SelectField rather than a raw Select/SelectTrigger: the
              layering guard resolves same-file local `const` string
              classNames, and selectCls's hard/soft classes would redden the
              ratchet if handed straight to SelectTrigger (a components/ui
              export) instead of through SelectField, which the guard does
              not govern. */}
          <FormField
            label="Default Vendor"
            optional
            hint="Auto-fills on new items in this brand"
          >
            <SelectField
              aria-label="Default vendor"
              value={form.defaultVendorId || "NONE"}
              onValueChange={(v) =>
                setForm((f) => ({ ...f, defaultVendorId: v === "NONE" ? "" : v }))
              }
              className={selectCls}
              options={[
                { value: "NONE", label: "— none —" },
                ...vendors.map((v) => ({ value: v.id, label: v.name })),
              ]}
            />
          </FormField>
        </div>

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
          Active — show in new-item dropdowns
        </label>
      </div>
    </Modal>
  );
}

const inputCls = "w-full px-2.5 py-1.5";

// SelectField isn't a design-system primitive under the layering guard, so it
// keeps its prior appearance verbatim, independent of the now-stripped inputCls.
const selectCls =
  "w-full rounded-md border border-border px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
