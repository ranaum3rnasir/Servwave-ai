import { useEffect, useRef, useState } from "react";
import type React from "react";
import { Camera, ImagePlus, Sparkles, Upload, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { UploadedImage } from "@/components/ui/uploaded-image";
import { ImageUploadError, dataUrlBytes, prepareImageUpload } from "@/lib/image-upload";
import { FormField } from "@/components/patterns/FormField";
import { SelectField } from "@/components/form/SelectField";
import { CatalogSelect } from "@/components/inventory/CatalogSelect";
import { UNITS_OF_MEASURE, UOM_SELECT_OPTIONS } from "@/components/inventory/unitsOfMeasure";
import {
  adoptServerId,
  defaultVisibilityForKind,
  useBranches,
  useDeleteBrand,
  useDeleteCategory,
  useDeleteFinish,
  useFinishes,
  useLocations,
  useUpsertBranch,
  useUpsertBrand,
  useUpsertFinish,
  useUpsertLocation,
  type Branch,
  type Brand,
  type Category,
  type Finish,
  type Item,
  type ItemKind,
  type ItemVisibility,
  type Location,
  type Vendor,
} from "@/lib/api/inventory";
import { useOrganization } from "@/lib/api/organization";
import { extractApiError } from "@/lib/utils";
import { AddVendorDialog } from "@/components/inventory/AddVendorDialog";
import { AddCategoryDialog } from "@/components/inventory/AddCategoryDialog";
import { AddBrandDialog } from "@/components/inventory/AddBrandDialog";
import { AddFinishDialog } from "@/components/inventory/AddFinishDialog";
import { AddLocationDialog } from "@/components/inventory/AddLocationDialog";
import { ManageCatalogDialog, type ManageEntry } from "@/components/inventory/ManageCatalogDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  open: boolean;
  onClose: () => void;
  /** May return a promise - awaited so a rejected save keeps the dialog open
   *  with the typed values instead of discarding them. */
  onSave: (item: NewItem, editId?: string) => unknown;
  vendors: Vendor[];
  /** May return a promise resolving the persisted vendor (its server id is
   *  adopted via adoptServerId); a void-returning caller still compiles. */
  onAddVendor: (vendor: Vendor) => unknown;
  categories: Category[];
  /** Same contract as onAddVendor, for categories. */
  onAddCategory: (category: Category) => unknown;
  /** Price Book Phase A — brand entities for dropdown. */
  brands?: Brand[];
  editItem?: Item | null;
  prefilledCode?: string;       // SKU / UPC / MPN captured from a scan
  /** Optional Modal z-index — bumped when AddItemDialog is opened from inside
   *  another dialog (e.g. NewPODialog) so the layering stacks cleanly. */
  zIndex?: number;
  /** SRVW-91: hide the starting-stock + reserve-levels panel at a mount whose
   *  onSave never persists the item (NewPODialog), so the panel is not theatre. */
  showStartingStock?: boolean;
  /**
   * #2009 - a requester without the ability to write this item still opens
   * the dialog (Ran's Decision: cost/sell price/GM stay visible), but every
   * control is disabled, the footer drops to a single "Close", and the
   * manage-catalog / add-new entries are unreachable (their trigger selects
   * are disabled, so Radix never mounts the dropdown content). Defaults to
   * `false` - today's behaviour - because this dialog is also mounted from
   * `NewPODialog.tsx` and `InventoryPage.tsx`, neither of which passes it.
   */
  readOnly?: boolean;
};

export type NewItem = {
  sku: string;
  /** Manufacturer part number - the UI calls it "Part Number". `null` where
   *  an EDIT emptied the field: the price-book PATCH copies only the keys it
   *  receives, so an omitted key reads as "leave unchanged" and the cleared
   *  value would come straight back. Undefined on create, where there is
   *  nothing to clear. */
  mpn?: string | null;
  modelNumber?: string | null;
  name: string;
  category: string;
  /** FK id of the picked category (when it matches a known category) — lets
   *  persistence callers send category_id while `category` stays display-only. */
  categoryId?: string;
  trade: string;
  kind: string;
  uom: string;
  unitCost: number;
  sellPrice: number;
  serialized: boolean;
  hazmat: boolean;
  /** Inventory P1: deduct stock when added to jobs/invoices (newly added lines only). */
  trackInventory: boolean;
  /** SRVW-90: apply sales tax on estimates and invoices. Optional because
   *  producers that do not carry it (ImportCSVDialog) omit it, and the server
   *  keeps its own `?? true` default for those. */
  taxable?: boolean;
  vendor: string;
  /** FK id of the picked vendor (display name stays in `vendor`). Same
   *  clear-versus-omit contract as `mpn` above, except the null only travels
   *  for a vendor the operator actually re-picked - see `form.vendorTouched`. */
  vendorId?: string | null;
  photoUrl?: string;
  // Price Book Phase A
  /** Same clear-versus-omit contract as `mpn` above. */
  brandId?: string | null;
  /** Same clear-versus-omit contract as `mpn` above. */
  finishId?: string | null;
  visibility?: ItemVisibility;
  startingStock: {
    locationId: string;
    qty: number;
    min?: number;   // reserve / par level — flag low-stock when on-hand falls below
    max?: number;   // reorder cap
  }[];
};

// Item Kind is two values, and unlike Brand/Finish/Unit/Location it stays a
// fixed list on purpose: `kind === "material"` is what picks the
// MATERIAL/SERVICE projection that estimates, jobs and invoices key on, so a
// third kind would gain no behaviour anywhere downstream.
//
// `labor`, `bundle` and `fee` used to be here. All three already billed as
// SERVICE, and the Stock > Items grid filtered bundle and fee out entirely, so
// choosing either saved an item that then appeared nowhere. The server folds
// the retired tokens into `service` on write (normalizeKind).
const kindOpts: { value: ItemKind; label: string }[] = [
  { value: "material", label: "Material" },
  { value: "service", label: "Service" },
];

export function AddItemDialog({
  open,
  onClose,
  onSave,
  vendors,
  onAddVendor,
  categories,
  onAddCategory,
  brands = [],
  editItem,
  prefilledCode,
  zIndex,
  showStartingStock = true,
  readOnly = false,
}: Props) {
  // zIndex is accepted for prop-API parity with the prototype; the shadcn
  // Dialog adapter manages stacking itself, so it is intentionally not wired.
  void zIndex;
  const { data: locations = [] } = useLocations();
  const { data: branches = [] } = useBranches();
  const { data: finishes = [] } = useFinishes();
  const upsertFinish = useUpsertFinish();
  const upsertBrand = useUpsertBrand();
  const upsertLocation = useUpsertLocation();
  const upsertBranch = useUpsertBranch();
  // Deleting a catalog row. Only the four entities that HAVE a delete endpoint
  // get a "Manage …" entry - vendors and locations have none, so offering it
  // there would open a dialog that could only refuse.
  const deleteFinish = useDeleteFinish();
  const deleteBrand = useDeleteBrand();
  const deleteCategory = useDeleteCategory();
  const { data: org } = useOrganization();
  // NO local mirror of rows created from inside this dialog. An earlier version
  // kept one so a new row would appear before the refetch landed - and that is
  // the same duplicate-writer defect the Items grid had. Every upsert hook
  // invalidates ['inventory'], so the refetched list ALREADY contains the row;
  // the extra copy rendered a second identical option, and Radix then painted
  // BOTH matching labels into the trigger. That is where the live "BOXBOX" and
  // "Satin ChromeSatin Chrome" came from. The query is the single source.
  // SRVW-91: the starting location used to default to the fabricated "loc_wh_main",
  // which matches no real location and would 400 the thresholds endpoint's uuid check.
  const defaultLocId = org?.default_inventory_location_id ?? locations[0]?.id ?? "";
  const isEdit = !!editItem;
  const [form, setForm] = useState({
    sku: "",
    mpn: "",
    modelNumber: "",
    name: "",
    category: "",
    trade: "general",
    kind: "material",
    uom: "EA",
    unitCost: "",
    sellPrice: "",
    serialized: false,
    hazmat: false,
    trackInventory: false,
    taxable: true,
    vendorId: "",
    // Whether the operator has used the Vendor select in THIS opening. Vendor
    // is the one identifier the dialog cannot seed from an id: the items API
    // serializes only `vendor` (a NAME) on an item, never `vendor_id`, so edit
    // recovers the id by matching that name against the vendor list. If the
    // list has not landed yet - and the pre-fill effect does not re-run when it
    // does - the match misses and the field seeds empty though the item does
    // have a vendor. Nulling THAT would wipe a vendor nobody touched, so the
    // clear only travels once the operator has actually used the select. Kept
    // in `form` rather than beside it so the existing seed/reset writes carry
    // it, instead of adding another setState to the pre-fill effect.
    vendorTouched: false,
    // Price Book Phase A
    brandId: "",
    finishId: "",
    visibility: "catalog" as ItemVisibility,
    startingLocId: "",
    startingQty: "",
    startingMin: "",   // reserve / par level
    startingMax: "",   // reorder cap
  });
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);
  const [showAddBrand, setShowAddBrand] = useState(false);
  const [showAddFinish, setShowAddFinish] = useState(false);
  const [showAddLocation, setShowAddLocation] = useState(false);
  // Which catalog the "Manage …" dialog is currently showing, or null.
  const [managing, setManaging] = useState<null | "finish" | "brand" | "category">(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoMeta, setPhotoMeta] = useState<{ name: string; sizeKb: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  // Pre-fill the form when opening in edit mode, or with a scanned code.
  useEffect(() => {
    if (!open) return;
    if (editItem) {
      const matchedVendor = vendors.find((v) => v.name === editItem.vendor);
      setForm({
        sku: editItem.sku,
        mpn: editItem.mpn ?? "",
        modelNumber: editItem.modelNumber ?? "",
        name: editItem.name,
        category: editItem.category,
        trade: editItem.trade,
        kind: editItem.kind,
        uom: editItem.uom,
        unitCost: editItem.unitCost != null ? String(editItem.unitCost) : "",
        sellPrice: String(editItem.sellPrice),
        serialized: editItem.serialized,
        hazmat: editItem.hazmat,
        trackInventory: editItem.trackInventory ?? false,
        taxable: editItem.taxable ?? true,
        vendorId: matchedVendor?.id ?? "",
        vendorTouched: false,
        brandId: editItem.brandId ?? "",
        finishId: editItem.finishId ?? "",
        visibility: editItem.visibility ?? defaultVisibilityForKind(editItem.kind),
        startingLocId: "",
        startingQty: "",
        startingMin: "",
        startingMax: "",
      });
      setPhotoUrl(editItem.photoUrl ?? null);
      setPhotoMeta(null);
    } else if (prefilledCode) {
      // Coming from a scan that didn't find a match — pre-fill SKU
      setForm((f) => ({ ...f, sku: prefilledCode.toUpperCase() }));
    }
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editItem?.id, prefilledCode]);

  // Locations arrive async, so the starting location falls back to the org default until the
  // user picks one - never overwriting a choice they have made. DERIVED at read time rather
  // than seeded by an effect: an effect repaints once with the select still empty before
  // filling it, and react-hooks/set-state-in-effect rejects the pattern outright.
  const startingLocId = form.startingLocId || defaultLocId;

  async function handleFiles(fileList: FileList | null) {
    const file = fileList?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Photo must be an image (jpg, png, webp, heic).");
      return;
    }
    try {
      // Downscales before storing - the photo rides inline as a data URI, so a
      // raw 10 MB camera shot would be ~13 MB of base64 in the record.
      const dataUrl = await prepareImageUpload(file);
      setPhotoUrl(dataUrl);
      setPhotoMeta({ name: file.name, sizeKb: Math.round(dataUrlBytes(dataUrl) / 1024) });
      setError(null);
    } catch (err) {
      setError(
        err instanceof ImageUploadError
          ? err.message
          : "Couldn't read the file. Try a different image.",
      );
    }
  }

  function clearPhoto() {
    setPhotoUrl(null);
    setPhotoMeta(null);
    if (uploadRef.current) uploadRef.current.value = "";
    if (cameraRef.current) cameraRef.current.value = "";
  }

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function buildSuggestedSku(): string {
    const slug = form.name
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, "")
      .split(" ")
      .slice(0, 3)
      .map((w) => w.slice(0, 4))
      .join("-");
    const rand = Math.floor(Math.random() * 900 + 100);
    return `ITM-${slug || "NEW"}-${rand}`;
  }

  function suggestSku() {
    set("sku", buildSuggestedSku());
  }

  function reset() {
    setForm({
      sku: "",
      mpn: "",
      modelNumber: "",
      name: "",
      category: "",
      trade: "general",
      kind: "material",
      uom: "EA",
      unitCost: "",
      sellPrice: "",
      serialized: false,
      hazmat: false,
      trackInventory: false,
      taxable: true,
      vendorId: "",
      vendorTouched: false,
      brandId: "",
      finishId: "",
      visibility: "catalog",
      startingLocId: "",
      startingQty: "",
      startingMin: "",
      startingMax: "",
    });
    clearPhoto();
    setError(null);
  }

  // When item kind changes (e.g. material → labor), re-default visibility.
  // Won't override a manual choice the user already made in edit mode if the
  // visibility was set by them, but for new-item flow this gives a smart default.
  function handleKindChange(nextKind: string) {
    setForm((f) => ({
      ...f,
      kind: nextKind,
      visibility: defaultVisibilityForKind(nextKind as ItemKind),
    }));
  }

  // Auto-fill vendor when a brand with a default vendor is picked
  function handleBrandChange(nextBrandId: string) {
    setForm((f) => {
      const brand = brands.find((b) => b.id === nextBrandId);
      const nextVendorId =
        brand?.defaultVendorId && !f.vendorId ? brand.defaultVendorId : f.vendorId;
      return {
        ...f,
        brandId: nextBrandId,
        vendorId: nextVendorId,
      };
    });
  }

  function handleVendorChange(value: string) {
    setForm((f) => ({ ...f, vendorId: value, vendorTouched: true }));
  }

  async function handleVendorCreated(v: Vendor) {
    const saved = adoptServerId(v, await onAddVendor(v));
    setForm((f) => ({ ...f, vendorId: saved.id, vendorTouched: true }));
    return saved;
  }

  function handleCategoryChange(value: string) {
    set("category", value);
  }

  async function handleCategoryCreated(c: Category) {
    const saved = adoptServerId(c, await onAddCategory(c));
    set("category", saved.name);
    return saved;
  }

  // ─── "+ Add new …" on the remaining entity-backed dropdowns ────────────────
  // Each follows the vendor/category shape above: the sentinel opens a creator,
  // and the created row's SERVER id is adopted before it is selected. Adopting
  // matters - a locally synthesized `fin_new_*` id would reach the API and 400
  // on its uuid check, and toPriceBookBody throws on one deliberately rather
  // than silently dropping it (assertServerFk).

  async function handleBrandCreated(b: Brand) {
    const saved = adoptServerId(b, await upsertBrand.mutateAsync(b));
    handleBrandChange(saved.id);
    return saved;
  }

  async function handleFinishCreated(f: Finish) {
    const saved = adoptServerId(f, await upsertFinish.mutateAsync(f));
    set("finishId", saved.id);
    return saved;
  }


  async function handleLocationCreated(l: Location) {
    const saved = adoptServerId(l, await upsertLocation.mutateAsync(l));
    set("startingLocId", saved.id);
    return saved;
  }

  async function submit() {
    if (!form.name.trim()) return setError("Item name is required.");
    // SKU is required now rather than silently auto-filled. The old behaviour
    // minted one from the name on save, which meant an item could acquire a SKU
    // nobody chose and nobody saw until it turned up on a PO. Generate is still
    // one click away; it just has to be a click.
    if (!form.sku.trim()) return setError("SKU is required - type one or press Generate.");
    // SRVW-91: reserve levels are stored per (item, location), so a min or max with no
    // location cannot be written at all - say so instead of dropping it silently.
    if ((form.startingMin || form.startingMax) && !startingLocId)
      return setError("Pick a location for the reserve levels.");
    const vendorName =
      vendors.find((v) => v.id === form.vendorId)?.name || "—";
    // An emptied identifier must reach the server as an explicit null on EDIT.
    // Omitting the key is what the PATCH handler reads as "leave unchanged", so
    // an operator deleting a wrong part number saw it reappear on the next
    // refetch. On CREATE there is nothing to clear, so a blank field still
    // sends nothing rather than starting to write nulls.
    //
    // Keyed on isEdit rather than on "did the operator change this field", so
    // an edit also sends null for an identifier that was ALREADY empty. That is
    // deliberate: every one of these fields is seeded straight from the item
    // (`editItem.mpn ?? ""`, `editItem.brandId ?? ""`, …), so an empty field on
    // edit means the column really is empty and the null is a no-op write over
    // a null. updateItem does no field diff and writes no audit entry, so there
    // is nothing to be gained by tracking per-field dirtiness here, and a dirty
    // map is one more thing to keep in sync with the form. Vendor is the single
    // exception, and only because it is NOT seeded from an id - see below.
    const cleared = (v: string) => v || (isEdit ? null : undefined);
    const finalSku = form.sku.trim();
    const categoryName = form.category.trim() || "Uncategorized";
    setSaving(true);
    try {
      await onSave(
        {
          sku: finalSku,
          mpn: cleared(form.mpn.trim()),
          modelNumber: cleared(form.modelNumber.trim()),
          name: form.name.trim(),
          category: categoryName,
          categoryId: categories.find((c) => c.name === categoryName)?.id,
          trade: form.trade,
          kind: form.kind,
          uom: form.uom,
          unitCost: parseFloat(form.unitCost || "0"),
          sellPrice: parseFloat(form.sellPrice || "0"),
          serialized: form.serialized,
          hazmat: form.hazmat,
          trackInventory: form.trackInventory,
          taxable: form.taxable,
          vendor: vendorName,
          // Unsetting the vendor clears `vendor_id` the same way, but only for
          // an operator who actually used the select: an empty vendorId can
          // also mean the name-match seed missed (see `form.vendorTouched`).
          vendorId: form.vendorTouched ? cleared(form.vendorId) : form.vendorId || undefined,
          photoUrl: photoUrl ?? undefined,
          brandId: cleared(form.brandId),
          finishId: cleared(form.finishId),
          visibility: form.visibility,
          startingStock:
            form.startingQty || form.startingMin || form.startingMax
              ? [
                  {
                    locationId: startingLocId,
                    qty: parseInt(form.startingQty || "0", 10),
                    min: form.startingMin ? parseInt(form.startingMin, 10) : undefined,
                    max: form.startingMax ? parseInt(form.startingMax, 10) : undefined,
                  },
                ]
              : [],
        },
        editItem?.id,
      );
      reset();
      onClose();
    } catch (err) {
      setError(extractApiError(err, "Could not save the item - check the fields and try again."));
    } finally {
      setSaving(false);
    }
  }

  const margin =
    form.unitCost && form.sellPrice
      ? Math.round(
          ((parseFloat(form.sellPrice) - parseFloat(form.unitCost)) /
            parseFloat(form.sellPrice)) *
            100,
        )
      : null;

  // One ManageCatalogDialog serves all four deletable catalogs; this picks what
  // it is currently showing. `managing === null` still resolves to a shape so
  // the dialog's props stay non-optional - it is closed, so the values are
  // never read.
  const manageConfig: {
    title: string;
    nounPlural: string;
    entries: ManageEntry[];
    onDelete: (id: string) => Promise<unknown>;
  } = (() => {
    switch (managing) {
      case "finish":
        return {
          title: "Manage Finishes",
          nounPlural: "finishes",
          entries: finishes.map((f) => ({ id: f.id, label: f.name, hint: f.code })),
          onDelete: (id: string) => deleteFinish.mutateAsync({ id }),
        };
      case "brand":
        return {
          title: "Manage Brands",
          nounPlural: "brands",
          entries: brands.map((b) => ({ id: b.id, label: b.name })),
          onDelete: (id: string) => deleteBrand.mutateAsync({ id }),
        };
      case "category":
        return {
          title: "Manage Categories",
          nounPlural: "categories",
          entries: categories.map((c) => ({ id: c.id, label: c.name })),
          onDelete: (id: string) => deleteCategory.mutateAsync({ id }),
        };
      default:
        return {
          title: "",
          nounPlural: "",
          entries: [],
          onDelete: () => Promise.resolve(),
        };
    }
  })();

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      // Esc must close the nested dialog, not this one underneath it.
      lockEscape={
        showAddVendor ||
        showAddCategory ||
        showAddBrand ||
        showAddFinish ||
        showAddLocation ||
        managing !== null
      }
      title={
        isEdit
          ? `${readOnly ? "Item" : "Edit Item"} · ${editItem!.sku}`
          : "Add Item to Stock"
      }
      size="xl"
      footer={
        readOnly ? (
          <Button variant="outline" size="sm"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Close
          </Button>
        ) : (
          <>
            <Button variant="outline" size="sm"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={saving}>
              {isEdit ? "Save Changes" : "Save Item"}
            </Button>
          </>
        )
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {/* ONE wrapper, not a fragment of bands. DialogContent is a grid with
          `gap-4` between its direct children, so sibling bands would each be
          pushed 16px apart and none of them could sit flush. `-mx-6` cancels
          DialogContent's `p-6` so the bands reach the dialog edges; each band
          puts the padding back with its own `px-6`. */}
      <div className="-mx-6">
        {/* ── Name band ────────────────────────────────────────────────────
            Item Name gets the full dialog width and is the first thing on
            screen. At the old rail width a 40-character part description
            wrapped to two lines, which is harder to scan than one long line. */}
        <div className="border-b border-border px-6 pb-4">
          <div className="grid grid-cols-12 gap-3">
            <div className="col-span-12 sm:col-span-8">
              <FormField label="Item Name" required>
                <Input
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  placeholder="e.g. Dual Run Capacitor 45/5 MFD 440V"
                  className="h-10 px-3 text-[14.5px]"
                  disabled={readOnly}
                />
              </FormField>
            </div>
            <div className="col-span-12 sm:col-span-4">
              <FormField label="SKU" required>
                {/* Render-prop: Input + the Generate button, a compound pair
                    cloneElement can't target - fieldProps lands on the Input. */}
                {(fieldProps) => (
                  <div className="flex gap-1.5">
                    <Input
                      {...fieldProps}
                      value={form.sku}
                      onChange={(e) => set("sku", e.target.value.toUpperCase())}
                      className="h-10 flex-1 px-3"
                      disabled={readOnly}
                    />
                    {/* Hidden (not merely disabled) in read-only mode, matching
                        the photo rail's Remove-photo pattern - there is nothing
                        to generate a SKU for when the field itself is inert. */}
                    {!readOnly && (
                      <Button variant="outline" tone="neutral" onClick={suggestSku}>
                        Generate
                      </Button>
                    )}
                  </div>
                )}
              </FormField>
            </div>
          </div>
        </div>

        {/* ── Photo rail + working fields ──────────────────────────────────
            The rail holds what you copy off the physical part: the photo, the
            model number and the part number. Stacks above the fields below the
            sm breakpoint rather than squeezing to an unusable column. */}
        <div className="grid grid-cols-1 sm:grid-cols-[248px_1fr]">
          <aside className="flex flex-col gap-3 border-b border-border bg-background-light p-4 sm:border-b-0 sm:border-r">
            {/* The label below is a drag/drop drop-zone - the whole zone IS the
                control, with no visible input box. FormField's own header
                comment names a file-drop zone as outside its pattern. */}
            <label
              onDragOver={
                readOnly
                  ? undefined
                  : (e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }
              }
              onDragLeave={readOnly ? undefined : () => setDragOver(false)}
              onDrop={
                readOnly
                  ? undefined
                  : (e) => {
                      e.preventDefault();
                      setDragOver(false);
                      void handleFiles(e.dataTransfer.files);
                    }
              }
              className={[
                "relative flex h-[190px] w-full items-center justify-center overflow-hidden rounded-lg border border-dashed text-center transition",
                readOnly
                  ? "cursor-default border-border bg-surface-light"
                  : [
                      "cursor-pointer",
                      dragOver
                        ? "border-primary bg-primary-subtle"
                        : photoUrl
                          ? "border-success/20 bg-surface-light"
                          : "border-border bg-surface-light hover:border-primary hover:bg-primary-subtle/50",
                    ].join(" "),
              ].join(" ")}
            >
              {photoUrl ? (
                <>
                  <UploadedImage
                    src={photoUrl}
                    alt="Item preview"
                    backdrop
                    className="h-full w-full"
                  />
                  {/* Raw by design: a close-X affordance overlaid on a photo
                      thumbnail, not Button-shaped. Hidden (not merely
                      disabled) in read-only mode - there is nothing to
                      remove a photo from. */}
                  {!readOnly && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        clearPhoto();
                      }}
                      className="absolute right-1 top-1 rounded-full bg-text-primary/70 p-1 text-on-fill hover:bg-text-primary"
                      aria-label="Remove photo"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </>
              ) : (
                <div className="flex flex-col items-center gap-1.5 px-2 text-text-secondary">
                  <ImagePlus className="h-5 w-5 text-text-secondary" />
                  <p className="text-[11px] leading-tight">
                    {readOnly ? "No photo" : "Drop image or click"}
                  </p>
                </div>
              )}
              <Input
                ref={uploadRef}
                type="file"
                accept="image/*"
                className="sr-only w-px"
                onChange={(e) => void handleFiles(e.target.files)}
                disabled={readOnly}
              />
            </label>
            <div className="flex gap-1.5">
              {/* Raw by design (both buttons below): outline/neutral sets no
                  idle text colour and nothing in this row's ambient wrapper
                  supplies one, so converting would silently render this muted
                  text-secondary label near-black. */}
              <button
                type="button"
                onClick={() => uploadRef.current?.click()}
                disabled={readOnly}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-surface-light px-1.5 py-1 text-[11px] font-medium text-text-secondary hover:bg-background-light disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface-light"
                title="Upload photo"
              >
                <Upload className="h-3 w-3 text-text-secondary" />
                Upload
              </button>
              <button
                type="button"
                onClick={() => cameraRef.current?.click()}
                disabled={readOnly}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-md border border-border bg-surface-light px-1.5 py-1 text-[11px] font-medium text-text-secondary hover:bg-background-light disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface-light"
                title="Take photo (camera on mobile)"
              >
                <Camera className="h-3 w-3 text-primary" />
                Camera
              </button>
              <Input
                ref={cameraRef}
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only w-px"
                onChange={(e) => void handleFiles(e.target.files)}
                disabled={readOnly}
              />
            </div>
            {photoMeta && (
              <p className="truncate text-[10px] text-text-secondary">
                ✓ {photoMeta.name}
                <span className="ml-1 text-text-secondary">· {photoMeta.sizeKb} KB</span>
              </p>
            )}

            <span className="h-px bg-border" />

            {/* Manufacturer identifiers sit with the photo because that is
                where you read them from - off the box in your hand. `mpn` is
                the existing column (CSV import, Items search and the barcode
                scanner already match on it). Model number is its own column: a
                part number and a model number differ routinely and both get
                quoted back to vendors on a PO. */}
            <FormField label="Model Number">
              <Input
                value={form.modelNumber}
                onChange={(e) => set("modelNumber", e.target.value)}
                placeholder="e.g. MT5+"
                className="px-2.5 py-1.5"
                disabled={readOnly}
              />
            </FormField>
            <FormField label="Part Number">
              <Input
                value={form.mpn}
                onChange={(e) => set("mpn", e.target.value)}
                placeholder="e.g. 114"
                title="Manufacturer part number (MPN)"
                className="px-2.5 py-1.5"
                disabled={readOnly}
              />
            </FormField>
          </aside>

          <div className="px-6 py-4">
            {/* ── Classification ───────────────────────────────────────────
                Brand and Finish are ordinary fields here, not a tinted "Price
                Book" card with its own heading. The card implied brand and
                visibility were a separate subsystem; they are two attributes
                of the item like any other, and Finish was stranded above it
                belonging to neither. */}
            <SectionRule label="Classification" first />
            <div className="grid grid-cols-12 gap-3">
              <div className="col-span-12 sm:col-span-4">
                <FormField label="Category">
                  <CatalogSelect
                    label="Category"
                    noun="category"
                    addVerb="Add"
                    noneLabel="Select category…"
                    value={form.category}
                    onChange={handleCategoryChange}
                    onAddNew={() => setShowAddCategory(true)}
                    onManage={() => setManaging("category")}
                    managePlural="categories"
                    options={categories.map((c) => ({ value: c.name, label: c.name }))}
                    disabled={readOnly}
                  />
                </FormField>
              </div>
              <div className="col-span-6 sm:col-span-4">
                {/* SRVW-90: `type` (SERVICE|MATERIAL) is a server-side
                    projection of this control, so there is no second control
                    the two columns can contradict each other through. */}
                <FormField label="Item Kind">
                  <SelectField
                    aria-label="Item kind"
                    value={form.kind}
                    onValueChange={handleKindChange}
                    className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
                    options={kindOpts}
                    disabled={readOnly}
                  />
                </FormField>
              </div>
              <div className="col-span-6 sm:col-span-4">
                {/* Unit of Measure is a FIXED list - the only catalog dropdown
                    here that is not extendable. A unit is not per-business
                    vocabulary the way a brand or a finish is, and letting each
                    org invent its own is how the demo org ended up with both BX
                    and BOX. Plain SelectField, not CatalogSelect: there is no
                    add-new and no manage entry to offer. */}
                <FormField label="Unit of Measure">
                  <SelectField
                    aria-label="Unit of measure"
                    value={form.uom}
                    onValueChange={(v) => set("uom", v)}
                    className="w-full rounded-md border border-border bg-surface-light px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/10"
                    // A code stored before this list was frozen must still show
                    // rather than blanking the trigger - the item stores the
                    // CODE STRING, not a foreign key.
                    options={
                      form.uom && !UNITS_OF_MEASURE.some((u) => u.code === form.uom)
                        ? [...UOM_SELECT_OPTIONS, { value: form.uom, label: form.uom }]
                        : UOM_SELECT_OPTIONS
                    }
                    disabled={readOnly}
                  />
                </FormField>
              </div>

              <div className="col-span-6 sm:col-span-4">
                <FormField label="Brand">
                  <CatalogSelect
                    label="Brand"
                    noun="brand"
                    noneLabel="— none —"
                    value={form.brandId}
                    onChange={handleBrandChange}
                    onAddNew={() => setShowAddBrand(true)}
                    onManage={() => setManaging("brand")}
                    options={brands
                      .filter((b) => b.isActive !== false)
                      .map((b) => ({ value: b.id, label: b.name }))}
                    disabled={readOnly}
                  />
                </FormField>
              </div>
              <div className="col-span-6 sm:col-span-4">
                <FormField label="Finish">
                  <CatalogSelect
                    label="Finish"
                    noun="finish"
                    managePlural="finishes"
                    noneLabel="— none —"
                    value={form.finishId}
                    onChange={(v) => set("finishId", v)}
                    onAddNew={() => setShowAddFinish(true)}
                    onManage={() => setManaging("finish")}
                    options={finishes
                      .filter((f) => f.isActive !== false)
                      .map((f) => ({ value: f.id, label: f.name }))}
                    disabled={readOnly}
                  />
                </FormField>
              </div>
              <div className="col-span-12 sm:col-span-4">
                <FormField label="Vendor / Source">
                  {/* No onManage - vendors have no delete endpoint, so the
                      entry would open a dialog that could only refuse. */}
                  <CatalogSelect
                    label="Vendor / Source"
                    noun="vendor"
                    noneLabel="Select vendor…"
                    value={form.vendorId}
                    onChange={handleVendorChange}
                    onAddNew={() => setShowAddVendor(true)}
                    options={vendors.map((v) => ({
                      value: v.id,
                      label: `${v.name}${v.category ? ` · ${v.category}` : ""}`,
                    }))}
                    disabled={readOnly}
                  />
                </FormField>
              </div>
            </div>

            {/* ── Pricing ──────────────────────────────────────────────────
                Money fields are sized to money (w-32, tabular figures) rather
                than stretched across half the dialog. */}
            <SectionRule label="Pricing" />
            <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
              <FormField label="Unit Cost">
                <MoneyInput
                  value={form.unitCost}
                  onChange={(v) => set("unitCost", v)}
                  ariaLabel="Unit cost"
                  disabled={readOnly}
                />
              </FormField>
              <FormField label="Sell Price">
                {/* Render-prop: MoneyInput + a conditional margin badge, a
                    compound pair cloneElement can't target. */}
                {() => (
                  <div className="flex items-center gap-2">
                    <MoneyInput
                      value={form.sellPrice}
                      onChange={(v) => set("sellPrice", v)}
                      ariaLabel="Sell price"
                      disabled={readOnly}
                    />
                    {margin !== null && (
                      <span
                        className={[
                          "rounded-md px-2 py-1 font-mono text-xs font-semibold tabular-nums",
                          margin > 30
                            ? "bg-success/10 text-success"
                            : margin > 0
                              ? "bg-warning/10 text-warning"
                              : "bg-danger/10 text-danger",
                        ].join(" ")}
                        title="Gross margin"
                      >
                        {margin}% GM
                      </span>
                    )}
                  </div>
                )}
              </FormField>
            </div>

            {/* ── Starting stock ───────────────────────────────────────────
                Hidden in edit mode (stock changes go through
                movements/transfers), and at any mount whose onSave never
                persists the item (showStartingStock={false}, SRVW-91). */}
            {isEdit || !showStartingStock ? null : (
              <>
                <SectionRule label="Starting Stock" />
                <div className="grid grid-cols-12 gap-3">
                  <div className="col-span-12 sm:col-span-6">
                    <FormField label="Location">
                      <CatalogSelect
                        label="Starting stock location"
                        noun="location"
                        value={startingLocId}
                        onChange={(v) => set("startingLocId", v)}
                        onAddNew={() => setShowAddLocation(true)}
                        options={locations.map((l) => ({ value: l.id, label: l.name }))}
                      />
                    </FormField>
                  </div>
                  <div className="col-span-4 sm:col-span-2">
                    <FormField label="On Hand">
                      <Input
                        value={form.startingQty}
                        onChange={(e) => set("startingQty", e.target.value)}
                        type="number"
                        step="1"
                        min="0"
                        placeholder="0"
                        className="px-2.5 py-1.5"
                      />
                    </FormField>
                  </div>
                  <div className="col-span-4 sm:col-span-2">
                    <FormField label="Min">
                      <Input
                        value={form.startingMin}
                        onChange={(e) => set("startingMin", e.target.value)}
                        type="number"
                        step="1"
                        min="0"
                        placeholder="0"
                        title="Reserve level - flags low stock when on-hand falls below this"
                        className="px-2.5 py-1.5"
                      />
                    </FormField>
                  </div>
                  <div className="col-span-4 sm:col-span-2">
                    <FormField label="Max">
                      <Input
                        value={form.startingMax}
                        onChange={(e) => set("startingMax", e.target.value)}
                        type="number"
                        step="1"
                        min="0"
                        placeholder="—"
                        title="Reorder cap - stops auto-replenish suggestions at this number"
                        className="px-2.5 py-1.5"
                      />
                    </FormField>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* ── Flags ──────────────────────────────────────────────────────────
            All five in one band above the footer. Visibility is a checkbox
            here rather than a two-button segmented control in a box of its
            own: it is one boolean and it was costing a third of a row. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border bg-background-light px-6 py-3">
          <CheckRow
            id="item-visibility"
            checked={form.visibility === "catalog"}
            onChange={(v) => set("visibility", v ? "catalog" : "internal_only")}
            label="Show in customer catalog"
            title="Uncheck to hide this item from customer-facing surfaces"
            disabled={readOnly}
          />
          <CheckRow
            id="item-serialized"
            checked={form.serialized}
            onChange={(v) => set("serialized", v)}
            label="Serialized"
            title="Force serial capture at install"
            disabled={readOnly}
          />
          <CheckRow
            id="item-hazmat"
            checked={form.hazmat}
            onChange={(v) => set("hazmat", v)}
            label="Hazmat"
            title="Link SDS, restrict transport"
            disabled={readOnly}
          />
          <CheckRow
            id="item-track-inventory"
            checked={form.trackInventory}
            onChange={(v) => set("trackInventory", v)}
            label="Track inventory"
            title="Deducts stock when this item is added to a job or invoice"
            disabled={readOnly}
          />
          <CheckRow
            id="item-taxable"
            checked={form.taxable}
            onChange={(v) => set("taxable", v)}
            label="Taxable"
            title="Apply sales tax on estimates and invoices"
            disabled={readOnly}
          />
        </div>
      </div>

      {/* Nested creator dialogs */}
      <AddVendorDialog
        open={showAddVendor}
        onClose={() => setShowAddVendor(false)}
        onCreate={handleVendorCreated}
      />
      <AddCategoryDialog
        open={showAddCategory}
        onClose={() => setShowAddCategory(false)}
        onCreate={handleCategoryCreated}
      />
      <AddBrandDialog
        open={showAddBrand}
        onClose={() => setShowAddBrand(false)}
        onCreate={handleBrandCreated}
        vendors={vendors}
      />
      <AddFinishDialog
        open={showAddFinish}
        onClose={() => setShowAddFinish(false)}
        onCreate={handleFinishCreated}
        existingNames={finishes.map((f) => f.name)}
      />
      <AddLocationDialog
        open={showAddLocation}
        onClose={() => setShowAddLocation(false)}
        // #2043/R6 - AddLocationDialog's onCreate now returns void|Promise<void>
        // (it is awaited so a rejection keeps the dialog open); this inline
        // creator's own Location-carrying return stays internal to it.
        onCreate={async (l) => { await handleLocationCreated(l); }}
        branches={branches}
        onAddBranch={async (b: Branch) => adoptServerId(b, await upsertBranch.mutateAsync(b))}
      />

      {/* One manage dialog, told which catalog it is showing. Four separate
          mounts would be four copies of the same list-with-delete. */}
      <ManageCatalogDialog
        open={managing !== null}
        onClose={() => setManaging(null)}
        title={manageConfig.title}
        nounPlural={manageConfig.nounPlural}
        entries={manageConfig.entries}
        onDelete={manageConfig.onDelete}
      />
    </Modal>
  );
}

/**
 * A band heading: small caps label, then a hairline running to the edge.
 *
 * This replaced four different grouping devices that had accumulated in this
 * one dialog - a tinted bordered card for Price Book, a grey rounded strip for
 * the flags, another for starting stock, and nothing at all for the fields in
 * between. A rule costs one line and never nests.
 */
function SectionRule({ label, first = false }: { label: string; first?: boolean }) {
  return (
    <div className={`flex items-center gap-3 ${first ? "mb-3" : "mb-3 mt-5"}`}>
      <span className="flex-none text-[10.5px] font-bold uppercase tracking-[0.1em] text-text-secondary">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * Checkbox with its label beside it, which is the one shape FormField cannot
 * produce (it always renders the label above the control).
 *
 * Built on the Checkbox + Label primitives rather than a raw label/input pair:
 * the component-api guard's raw-tag ratchet for `label` and `input` is at
 * floor, and this dialog previously carried three raw pairs plus one primitive
 * pair. Routing all of them through here removes the raw pairs entirely and
 * ends the font-medium / font-semibold split between the two styles.
 */
function CheckRow({
  id,
  checked,
  onChange,
  label,
  title,
  disabled = false,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  /** The explanation that used to sit in the label's parenthetical. */
  title: string;
  disabled?: boolean;
}) {
  return (
    <span className="flex items-center gap-2" title={title}>
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        disabled={disabled}
      />
      <Label htmlFor={id} size="xs" tone="subtle" weight="semibold">
        {label}
      </Label>
    </span>
  );
}

/**
 * A money field sized to money: 8rem wide with the currency symbol inside and
 * tabular figures, instead of a full-width text box that reads as if it wants a
 * sentence. The symbol is decorative - `aria-hidden`, with the unit carried in
 * the accessible name - so a screen reader does not announce "dollar" as part
 * of the value.
 */
function MoneyInput({
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="relative w-32">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-text-secondary"
      >
        $
      </span>
      <Input
        aria-label={`${ariaLabel} in dollars`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        type="number"
        step="0.01"
        min="0"
        placeholder="0.00"
        className="py-1.5 pl-6 pr-2.5 tabular-nums"
        disabled={disabled}
      />
    </div>
  );
}
