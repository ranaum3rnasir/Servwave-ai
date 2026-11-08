/**
 * AssetDialog — create/edit a company-tool asset (P4). One dialog for both
 * modes (`editAsset` present = edit). Duplicate serials WARN client-side only
 * and never block submit (QA-38 default — no server enforcement exists).
 * Photo follows the Attachment ordering: entity first, then multipart upload.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ImageIcon, Wrench, X } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { UploadedImage } from "@/components/ui/uploaded-image";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/patterns/FormField";
import {
  useAssets,
  useCreateAsset,
  useInventoryItems,
  useUpdateAsset,
  useUploadAssetPhoto,
  type Asset,
} from "@/lib/api/inventory";
import { extractApiError } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const PHOTO_ACCEPT = "image/jpeg,image/png,image/heic,image/heif";

type Props = {
  open: boolean;
  onClose: () => void;
  editAsset?: Asset | null;
  onSaved: (msg: string) => void;
};

export function AssetDialog({ open, onClose, editAsset, onSaved }: Props) {
  const createAsset = useCreateAsset();
  const updateAsset = useUpdateAsset();
  const uploadPhoto = useUploadAssetPhoto();
  // Full list (no status filter) so the dup-serial check also sees retired
  // tools' serials. Case-insensitive trim match, excluding the asset edited.
  const allAssetsQuery = useAssets({}, 1);
  const { data: catalogItems = [] } = useInventoryItems();

  const [name, setName] = useState("");
  const [serial, setSerial] = useState("");
  const [notes, setNotes] = useState("");
  const [itemId, setItemId] = useState<string | null>(null);
  const [itemQuery, setItemQuery] = useState("");
  const [itemListOpen, setItemListOpen] = useState(false);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(editAsset?.name ?? "");
    setSerial(editAsset?.serial ?? "");
    setNotes(editAsset?.notes ?? "");
    setItemId(editAsset?.price_book_item?.id ?? null);
    setItemQuery("");
    setItemListOpen(false);
    setPhotoFile(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editAsset?.id]);

  const selectedItem = useMemo(() => {
    if (!itemId) return null;
    return (
      catalogItems.find((i) => i.id === itemId) ??
      // Fall back to the edited asset's linked item so the chip renders even
      // before/without the catalog query resolving.
      (editAsset?.price_book_item?.id === itemId ? editAsset.price_book_item : null)
    );
  }, [itemId, catalogItems, editAsset]);

  const filteredItems = useMemo(() => {
    const q = itemQuery.trim().toLowerCase();
    const pool = catalogItems.filter((i) =>
      q === "" ? true : `${i.name} ${i.sku}`.toLowerCase().includes(q),
    );
    return pool.slice(0, 8);
  }, [catalogItems, itemQuery]);

  // Duplicate-serial WARN (client-side, non-blocking — QA-38 default).
  const duplicateOf = useMemo(() => {
    const s = serial.trim().toLowerCase();
    if (!s) return null;
    return (
      (allAssetsQuery.data?.data ?? []).find(
        (a) =>
          a.id !== editAsset?.id && (a.serial ?? "").trim().toLowerCase() === s,
      ) ?? null
    );
  }, [serial, allAssetsQuery.data, editAsset?.id]);

  const previewUrl = useMemo(() => {
    if (!photoFile || typeof URL.createObjectURL !== "function") return null;
    return URL.createObjectURL(photoFile);
  }, [photoFile]);
  useEffect(
    () => () => {
      if (previewUrl && typeof URL.revokeObjectURL === "function")
        URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const isPending =
    createAsset.isPending || updateAsset.isPending || uploadPhoto.isPending;

  async function submit() {
    if (!name.trim()) return setError("Name is required.");
    setError(null);
    const body = {
      name: name.trim(),
      serial: serial.trim() || null,
      price_book_item_id: itemId || null,
      notes: notes.trim() || null,
    };
    try {
      if (editAsset) {
        await updateAsset.mutateAsync({ id: editAsset.id, ...body });
        if (photoFile)
          await uploadPhoto.mutateAsync({ id: editAsset.id, file: photoFile });
        onSaved(`✓ "${body.name}" updated`);
      } else {
        // Entity-first, then upload — the Attachment pattern's ordering.
        const created = await createAsset.mutateAsync(body);
        if (photoFile)
          await uploadPhoto.mutateAsync({ id: created.id, file: photoFile });
        onSaved(`✓ "${body.name}" added to assets`);
      }
    } catch (err) {
      setError(extractApiError(err, "Could not save the asset — try again."));
      return;
    }
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editAsset ? "Edit Asset" : "New Asset"}
      subtitle="Company tool tracked by holder — not sellable stock."
      size="lg"
      footer={
        <>
          <Button variant="outline" size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button size="sm"
            onClick={submit}
            disabled={isPending}
            className="disabled:opacity-60"
          >
            <Wrench className="h-3.5 w-3.5" />
            {isPending ? "Saving…" : editAsset ? "Save changes" : "Create asset"}
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="Name" required gap={1}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="DeWalt hammer drill"
              className={inputCls}
              autoFocus
              aria-label="Asset name"
            />
          </FormField>
          <div>
            <FormField label="Serial" gap={1}>
              <Input
                value={serial}
                onChange={(e) => setSerial(e.target.value)}
                placeholder="SN-000123"
                className={inputCls}
                aria-label="Serial number"
              />
            </FormField>
            {duplicateOf && (
              <p className="mt-1 flex items-start gap-1 text-xs text-warning">
                <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                <span>
                  Another asset (&quot;{duplicateOf.name}&quot;) already has
                  this serial
                </span>
              </p>
            )}
          </div>
        </div>

        <FormField label="Catalog item" gap={1}>
          {(fieldProps) => (
            selectedItem ? (
              <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-border bg-background-light px-2 py-1 text-sm text-text-primary">
                {selectedItem.name}
                {/* Not converted to Button: close-X affordance inside a chip. */}
                <button
                  onClick={() => {
                    setItemId(null);
                    setItemQuery("");
                  }}
                  className="rounded p-0.5 text-text-secondary hover:bg-surface-light hover:text-text-primary"
                  aria-label="Clear catalog item"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : (
              <div className="relative">
                <Input
                  {...fieldProps}
                  value={itemQuery}
                  onChange={(e) => {
                    setItemQuery(e.target.value);
                    setItemListOpen(true);
                  }}
                  onFocus={() => setItemListOpen(true)}
                  placeholder="Search the catalog… (optional)"
                  className={inputCls}
                  aria-label="Catalog item search"
                />
                {itemListOpen && filteredItems.length > 0 && (
                  <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-md border border-border bg-surface-light py-1 shadow-lg">
                    {filteredItems.map((i) => (
                      <li key={i.id}>
                        {/* Not converted to Button: dropdown/search-result
                            list-row target. */}
                        <button
                          onClick={() => {
                            setItemId(i.id);
                            setItemListOpen(false);
                          }}
                          className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm text-text-primary hover:bg-background-light"
                        >
                          <span className="truncate">{i.name}</span>
                          <code className="font-mono text-[10px] text-text-secondary">
                            {i.sku}
                          </code>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          )}
        </FormField>

        <FormField label="Notes" gap={1}>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Purchased 2025 · charger stays at the warehouse"
            className={inputCls}
            aria-label="Asset notes"
          />
        </FormField>

        <FormField label="Photo" gap={1}>
          {(fieldProps) => (
            <div className="flex items-center gap-3">
              {previewUrl || editAsset?.photo_url ? (
                <UploadedImage
                  src={previewUrl ?? editAsset?.photo_url ?? ""}
                  alt="Asset preview"
                  radius="md"
                  edge="ring"
                  className="h-14 w-14"
                />
              ) : (
                <div className="flex h-14 w-14 items-center justify-center rounded-md bg-background-light ring-1 ring-border">
                  <ImageIcon className="h-6 w-6 text-text-secondary" />
                </div>
              )}
              <div className="flex flex-col items-start gap-1">
                <input
                  {...fieldProps}
                  ref={fileInputRef}
                  type="file"
                  accept={PHOTO_ACCEPT}
                  onChange={(e) => setPhotoFile(e.target.files?.[0] ?? null)}
                  className="text-xs text-text-secondary file:mr-2 file:rounded-md file:border file:border-border file:bg-surface-light file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-text-primary hover:file:bg-background-light"
                  aria-label="Asset photo"
                />
                {photoFile && (
                  <Button
                    onClick={() => {
                      setPhotoFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    variant="ghost"
                    tone="subtle"
                    size={null}
                  >
                    Remove selected photo
                  </Button>
                )}
              </div>
            </div>
          )}
        </FormField>
      </div>
    </Modal>
  );
}

// Input/Textarea now own their own border/radius/background/focus-ring
// appearance (design-system layering guard) - this constant is layout-only.
const inputCls = "w-full px-2.5 py-1.5";
