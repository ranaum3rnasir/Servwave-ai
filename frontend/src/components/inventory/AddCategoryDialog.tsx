import { useEffect, useRef, useState } from "react";
import { FolderPlus, ImagePlus, Pencil, Trash2 } from "lucide-react";
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
import type { Category } from "@/lib/api/inventory";
import { extractApiError } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// Same constraints as the brand-logo + group-photo upload. Prototype inlines
// images as data URIs; production swaps to signed object-storage URLs. The size
// rules and the downscale live in `lib/image-upload` so all four inline upload
// surfaces accept the same (large) source files.

const TRADE_OPTIONS: { value: "" | NonNullable<Category["trade"]>; label: string }[] = [
  { value: "", label: "— none —" },
  { value: "locksmith", label: "Locksmith" },
  { value: "door", label: "Door" },
  { value: "security", label: "Security" },
  { value: "hvac", label: "HVAC" },
  { value: "plumbing", label: "Plumbing" },
];

type Props = {
  open: boolean;
  onClose: () => void;
  /** Fired on save in create mode (no editCategory passed). May return a
   *  promise - awaited so a rejection keeps the dialog open with an error. */
  onCreate?: (cat: Category) => unknown;
  /** When set, the dialog opens in edit mode pre-filled with this category. */
  editCategory?: Category | null;
  /** Fired on save in edit mode - returns the updated category. May return a
   *  promise - awaited so a rejection keeps the dialog open with an error. */
  onUpdate?: (cat: Category) => unknown;
};

export function AddCategoryDialog({
  open,
  onClose,
  onCreate,
  editCategory,
  onUpdate,
}: Props) {
  const isEdit = !!editCategory;
  const [form, setForm] = useState<{
    name: string;
    description: string;
    trade: "" | NonNullable<Category["trade"]>;
    photoUrl: string;
  }>({ name: "", description: "", trade: "", photoUrl: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Pre-fill the form when the dialog opens in edit mode (and reset on close).
  useEffect(() => {
    if (open && editCategory) {
      setForm({
        name: editCategory.name,
        description: editCategory.description ?? "",
        trade: editCategory.trade ?? "",
        photoUrl: editCategory.photoUrl ?? "",
      });
      setError(null);
    } else if (open && !editCategory) {
      setForm({ name: "", description: "", trade: "", photoUrl: "" });
      setError(null);
    }
  }, [open, editCategory?.id]);

  function reset() {
    setForm({ name: "", description: "", trade: "", photoUrl: "" });
    setError(null);
  }

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

  async function submit() {
    if (!form.name.trim()) return setError("Category name is required.");
    setSaving(true);
    try {
      if (isEdit && editCategory && onUpdate) {
        await onUpdate({
          ...editCategory,
          name: form.name.trim(),
          description: form.description.trim() || undefined,
          trade: form.trade || undefined,
          photoUrl: form.photoUrl || undefined,
        });
      } else if (onCreate) {
        const cat: Category = {
          id: `cat_new_${Date.now()}`,
          name: form.name.trim(),
          trade: form.trade || undefined,
          description: form.description.trim() || undefined,
          photoUrl: form.photoUrl || undefined,
        };
        await onCreate(cat);
      }
      reset();
      onClose();
    } catch (err) {
      setError(extractApiError(err, "Could not save the category - try again."));
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
      title={isEdit ? `Edit category · ${editCategory!.name}` : "Add category"}
      subtitle={
        isEdit
          ? "Rename, swap the photo, or update the description. The new name propagates to every item in this category."
          : "Categories group items in the price book (e.g. Cylinders, Capacitors, Locksets)."
      }
      size="md"
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
            {isEdit ? (
              <>
                <Pencil className="h-3.5 w-3.5" />
                Save Changes
              </>
            ) : (
              <>
                <FolderPlus className="h-3.5 w-3.5" />
                Save Category
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
        {/* Category hero photo — banner-style upload, full width, 2:1 aspect.
            Matches the Group hero photo treatment so the Categories tab and
            Groups tab feel like siblings. */}
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
            Category Photo (optional)
          </span>
          {/* Raw by design: a banner-style photo-tile upload trigger with a
              conditional idle ring/bg state - no minted Button cell
              reproduces this shape. */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className={[
              "mt-1 flex aspect-[2/1] w-full items-center justify-center overflow-hidden rounded-lg ring-1 transition",
              form.photoUrl
                ? "ring-border hover:ring-primary/40"
                : "bg-background-light ring-border hover:bg-background-light hover:ring-primary/40",
            ].join(" ")}
            title={form.photoUrl ? "Replace category photo" : "Upload category photo"}
            aria-label={form.photoUrl ? "Replace category photo" : "Upload category photo"}
          >
            {form.photoUrl ? (
              <UploadedImage src={form.photoUrl} backdrop className="h-full w-full" />
            ) : (
              <div className="flex flex-col items-center gap-1 text-text-secondary">
                <ImagePlus className="h-6 w-6" />
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
              PNG / JPG / SVG / WebP / HEIC · 2:1 works best · up to{" "}
              {formatBytes(MAX_SOURCE_BYTES)}
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

        <FormField label="Category Name" required>
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Door Hinges, Smart Locks, Coolant Lines…"
            className={inputCls}
            autoFocus
          />
        </FormField>

        {/* SelectField's Radix Select ROOT forwards no id to its trigger - a
            known gap (FormField.tsx's header comment). Kept as SelectField
            rather than a raw Select/SelectTrigger: the layering guard
            resolves same-file local `const` string classNames, and
            selectCls's hard/soft classes would redden the ratchet if handed
            straight to SelectTrigger (a components/ui export) instead of
            through SelectField, which the guard does not govern. */}
        <FormField
          label="Trade"
          optional
          hint="Tags this category with a trade for filtering + reporting"
        >
          <SelectField
            aria-label="Trade"
            value={form.trade || "NONE"}
            onValueChange={(v) =>
              setForm((f) => ({
                ...f,
                trade: (v === "NONE" ? "" : v) as typeof f.trade,
              }))
            }
            className={selectCls}
            options={TRADE_OPTIONS.map((opt) => ({
              value: opt.value || "NONE",
              label: opt.label,
            }))}
          />
        </FormField>

        <FormField label="Description" optional>
          <Textarea
            value={form.description}
            onChange={(e) =>
              setForm((f) => ({ ...f, description: e.target.value }))
            }
            rows={2}
            placeholder="One-line description shown in reports + admin"
            className={`${inputCls} resize-none`}
          />
        </FormField>
      </div>
    </Modal>
  );
}

const inputCls = "w-full px-2.5 py-1.5";

// SelectField isn't a design-system primitive under the layering guard, so it
// keeps its prior appearance verbatim, independent of the now-stripped inputCls.
const selectCls =
  "w-full rounded-md border border-border px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";
