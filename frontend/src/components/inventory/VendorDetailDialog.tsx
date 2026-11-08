import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { safeHref } from "@/lib/safe-href";
import {
  Archive,
  ArchiveRestore,
  Calendar,
  CreditCard,
  DollarSign,
  ExternalLink,
  Mail,
  MapPin,
  Phone,
  Plus,
  Save,
  ShoppingCart,
  Trash2,
  User,
  UserPlus,
} from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/patterns/FormField";
import { KpiTile } from "@/components/data/KpiStrip";
import { EmptyState } from "@/components/ui/empty-state";
import type {
  Vendor,
  VendorContact,
  VendorUpsertPayload,
  PurchaseOrder,
} from "@/lib/api/inventory";
import { POPreviewDialog } from "@/components/inventory/POPreviewDialog";
import { VendorCategoryPicker } from "@/components/inventory/VendorCategoryPicker";
import { vendorCategoryLabel } from "@/lib/inventory/vendor-category";
import {
  fmtMoney,
  fmtMoneyFull,
  fmtRelativeDate,
  recentPOs,
  type VendorSpend,
} from "@/lib/inventory/vendor-spend";
import { poTotal } from "@/lib/inventory/po-money";
import { useAppAbility } from "@/contexts/AbilityContext";
import { extractApiError, formatPhone, formatPhoneInput } from "@/lib/utils";
import { Button } from "@/components/ui/button";

type Props = {
  open: boolean;
  onClose: () => void;
  vendor: Vendor | null;
  spend: VendorSpend | null;
  pos: PurchaseOrder[];
  /**
   * Persist the patch. May return a promise: the dialog stays in edit mode,
   * with the draft, until it settles, and a rejection is shown inline (S4.2).
   */
  onSave: (vendorId: string, patch: VendorUpsertPayload) => unknown;
  onDeleteRequest: (vendor: Vendor) => void;
  onArchiveToggle: (vendor: Vendor) => void;
};

type DraftFields = {
  name: string;
  /** Company category row (null = Uncategorized) and its name, set together by the picker. */
  categoryId: string | null;
  category: string;
  contactPersonName: string;
  contactEmail: string;
  contactPhone: string;
  additionalContacts: VendorContact[];
  accountNumber: string;
  website: string;
  pickupAddress: string;
  notes: string;
};

function toDraft(v: Vendor): DraftFields {
  return {
    name: v.name,
    categoryId: v.categoryId ?? null,
    category: v.category,
    contactPersonName: v.contactPersonName ?? "",
    contactEmail: v.contactEmail ?? "",
    contactPhone: formatPhone(v.contactPhone ?? ""),
    additionalContacts: (v.additionalContacts ?? []).map((c) => ({ ...c, phone: formatPhone(c.phone ?? "") })),
    accountNumber: v.accountNumber ?? "",
    website: v.website ?? "",
    pickupAddress: v.pickupAddress ?? "",
    notes: v.notes ?? "",
  };
}

// Returns `[]`, never `undefined`, for an emptied list. The server treats a
// present `additionalContacts` array as "replace the whole set" and an absent
// key as "leave contacts alone" — so `undefined` here is what made removing the
// last contact a no-op that still reported success.
function normaliseContacts(list: VendorContact[]): VendorContact[] {
  const cleaned = list
    .map((c) => ({
      id: c.id,
      name: c.name?.trim() || undefined,
      email: c.email?.trim() || undefined,
      phone: c.phone?.trim() || undefined,
      role: c.role?.trim() || undefined,
    }))
    .filter((c) => c.name || c.email || c.phone || c.role);
  return cleaned;
}

function contactsEqual(
  a: VendorContact[] | undefined,
  b: VendorContact[] | undefined,
): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    const x = aa[i];
    const y = bb[i];
    if (!x || !y) return false;
    if (
      x.id !== y.id ||
      (x.name ?? "") !== (y.name ?? "") ||
      (x.email ?? "") !== (y.email ?? "") ||
      (x.phone ?? "") !== (y.phone ?? "") ||
      (x.role ?? "") !== (y.role ?? "")
    )
      return false;
  }
  return true;
}

// Every cleared optional field emits `null`, never `undefined`: JSON.stringify
// drops an `undefined` value's key outright, so the server's `!== undefined`
// guard never saw it and the old column value survived a "save" that the UI
// reported as successful. `upsertVendorSchema` types all seven as
// `.nullable().optional()` and `toVendorData` writes the null straight through,
// so no API change is needed — only an honest payload.
function diffDraft(orig: Vendor, d: DraftFields): VendorUpsertPayload {
  const o = toDraft(orig);
  const patch: VendorUpsertPayload = {};
  if (d.name !== o.name) patch.name = d.name;
  // The id is what the server writes; the name rides along so the page's
  // optimistic row shows the new category before the refetch (S4.1).
  if (d.categoryId !== o.categoryId || d.category !== o.category) {
    patch.categoryId = d.categoryId;
    patch.category = d.category;
  }
  if (d.contactPersonName !== o.contactPersonName)
    patch.contactPersonName = d.contactPersonName || null;
  if (d.contactEmail !== o.contactEmail)
    patch.contactEmail = d.contactEmail || null;
  if (d.contactPhone !== o.contactPhone)
    patch.contactPhone = d.contactPhone || null;
  const nextContacts = normaliseContacts(d.additionalContacts);
  if (!contactsEqual(nextContacts, normaliseContacts(o.additionalContacts)))
    patch.additionalContacts = nextContacts;
  if (d.accountNumber !== o.accountNumber)
    patch.accountNumber = d.accountNumber || null;
  if (d.website !== o.website) patch.website = d.website || null;
  if (d.pickupAddress !== o.pickupAddress)
    patch.pickupAddress = d.pickupAddress || null;
  if (d.notes !== o.notes) patch.notes = d.notes || null;
  return patch;
}

export function VendorDetailDialog({
  open,
  onClose,
  vendor,
  spend,
  pos,
  onSave,
  onDeleteRequest,
  onArchiveToggle,
}: Props) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<DraftFields | null>(null);
  const [previewPONumber, setPreviewPONumber] = useState<string | null>(null);
  // The dialog had no error surface at all, so a 400 from a blanked required
  // field was indistinguishable from a successful save. Mirrors AddVendorDialog.
  const [error, setError] = useState<string | null>(null);
  // True while `onSave` is in flight: the footer is locked so a slow server
  // cannot be double-submitted, and edit mode is only left once it resolves.
  const [saving, setSaving] = useState(false);
  const ability = useAppAbility();
  // POST /api/inventory/vendors is an upsert used for both create and edit
  // (lib/api/inventory.ts) and is gated `create Vendor` - Edit and Archive
  // both ride it. Delete is its own DELETE route, gated `delete Vendor`.
  const canEditVendor = ability.can("create", "Vendor");
  const canDeleteVendor = ability.can("delete", "Vendor");

  useEffect(() => {
    if (!open) {
      setIsEditing(false);
      setDraft(null);
      setPreviewPONumber(null);
      setError(null);
    }
  }, [open, vendor?.id]);

  const patch = useMemo(() => {
    if (!vendor || !draft) return {} as Partial<Vendor>;
    return diffDraft(vendor, draft);
  }, [vendor, draft]);
  const hasChanges = Object.keys(patch).length > 0;
  // Only the name is required: a vendor may be Uncategorized (S4.1).
  const nameValid = !draft || !!draft.name.trim();

  if (!vendor) return null;

  function startEditing() {
    setDraft(toDraft(vendor!));
    setError(null);
    setIsEditing(true);
  }
  function cancelEditing() {
    setDraft(null);
    setError(null);
    setIsEditing(false);
  }
  // Edit mode used to end the moment Save was clicked, before the server had
  // answered: a rejected write then rolled the record back underneath a dialog
  // that had already thrown the draft away, and the only trace was a toast
  // fired next to a premature "updated". The save is awaited now (S4.2): on
  // success the dialog leaves edit mode; on failure it keeps the draft, shows
  // the server's reason inline and stays put so the operator can fix and retry.
  async function saveEdits() {
    if (!hasChanges || saving) return;
    if (!nameValid) return setError("Vendor name is required.");
    setError(null);
    setSaving(true);
    try {
      await onSave(vendor!.id, patch);
      cancelEditing();
    } catch (err) {
      setError(extractApiError(err, "Could not save the vendor - try again."));
    } finally {
      setSaving(false);
    }
  }

  const isInactive = vendor.status === "inactive";
  const last5POs = recentPOs(vendor, pos, 5);

  return (
    <>
    <Modal
      open={open}
      onClose={() => {
        cancelEditing();
        onClose();
      }}
      title={`Vendor · ${vendor.name}`}
      subtitle={
        vendorCategoryLabel(vendor) +
        (vendor.accountNumber ? ` · acct ${vendor.accountNumber}` : "")
      }
      size="xl"
      lockEscape={isEditing}
      editAction={
        canEditVendor && !isEditing
          ? {
              label: "Edit",
              onClick: startEditing,
            }
          : undefined
      }
      footer={
        isEditing ? (
          <>
            <Button variant="outline" size="sm"
              onClick={cancelEditing}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button size="sm"
              onClick={() => void saveEdits()}
              disabled={!hasChanges || saving}
              title={
                saving
                  ? "Saving…"
                  : !hasChanges
                    ? "No changes to save"
                    : !nameValid
                      ? "Vendor name is required"
                      : "Save vendor changes"
              }
            >
              <Save className="h-3.5 w-3.5" />
              Save Changes
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="sm"
              onClick={onClose}
            >
              Close
            </Button>
            {vendor.contactEmail && (
              <a
                href={`mailto:${vendor.contactEmail}`}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary-subtle bg-surface-light px-3 py-1.5 text-sm font-semibold text-primary hover:bg-primary-subtle"
              >
                <Mail className="h-3.5 w-3.5" />
                Email Vendor
              </a>
            )}
            {canEditVendor && (
              // Not converted to Button: warning-toned action, no `warning`
              // tone is minted.
              <button
                onClick={() => onArchiveToggle(vendor)}
                className="inline-flex items-center gap-1.5 rounded-md border border-warning/20 bg-surface-light px-3 py-1.5 text-sm font-semibold text-warning hover:bg-warning/10"
                title={
                  isInactive
                    ? "Re-activate this vendor"
                    : "Soft-archive — keep history, hide from active lists"
                }
              >
                {isInactive ? (
                  <>
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    Reactivate
                  </>
                ) : (
                  <>
                    <Archive className="h-3.5 w-3.5" />
                    Archive
                  </>
                )}
              </button>
            )}
            {canDeleteVendor && (
              <Button
                onClick={() => onDeleteRequest(vendor)}
                variant="outline"
                tone="danger"
                size="sm"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </Button>
            )}
          </>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {error && (
          <div
            role="alert"
            className="rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {error}
          </div>
        )}
        {/* Hero strip: name + category + status */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-background-light/40 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-primary-subtle px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary ring-1 ring-primary/20">
              {vendorCategoryLabel(vendor)}
            </span>
            <span
              className={[
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ring-1",
                isInactive
                  ? "bg-background-light text-text-secondary ring-border"
                  : "bg-success/10 text-success ring-success/20",
              ].join(" ")}
            >
              {isInactive ? "inactive" : "active"}
            </span>
            <code className="font-mono text-[11px] text-text-secondary">
              {vendor.id}
            </code>
          </div>
          <div className="flex items-center gap-1 text-xs text-text-secondary">
            <Calendar className="h-3 w-3" />
            {spend?.lastOrderedAt
              ? `Last ordered ${fmtRelativeDate(spend.lastOrderedAt)}`
              : "No POs yet"}
          </div>
        </div>

        {/* Three-column overview */}
        <div className="grid grid-cols-12 gap-3">
          {/* Contact card */}
          <div className="col-span-4 rounded-md border border-border bg-surface-light p-3">
            <p className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              <span>
                Contact
                {(vendor.additionalContacts?.length ?? 0) > 0 && (
                  <span className="ml-1 rounded-full bg-primary-subtle px-1.5 py-0 text-[9px] font-bold text-primary ring-1 ring-primary/20">
                    +{vendor.additionalContacts!.length} more
                  </span>
                )}
              </span>
            </p>
            {isEditing && draft ? (
              <div className="space-y-2 text-[12px]">
                <p className="text-[9px] uppercase tracking-wide text-text-secondary">
                  Primary
                </p>
                <LabeledInput
                  label="Person"
                  icon={<User className="h-3 w-3" />}
                  value={draft.contactPersonName}
                  onChange={(v) => setDraft({ ...draft, contactPersonName: v })}
                  placeholder="Rep name"
                />
                <LabeledInput
                  label="Email"
                  icon={<Mail className="h-3 w-3" />}
                  value={draft.contactEmail}
                  onChange={(v) => setDraft({ ...draft, contactEmail: v })}
                  placeholder="orders@vendor.com"
                  type="email"
                />
                <LabeledInput
                  label="Phone"
                  icon={<Phone className="h-3 w-3" />}
                  value={draft.contactPhone}
                  onChange={(v) => setDraft({ ...draft, contactPhone: formatPhoneInput(v) })}
                  placeholder="(555) 010-1234"
                />
                <LabeledInput
                  label="Website"
                  icon={<ExternalLink className="h-3 w-3" />}
                  value={draft.website}
                  onChange={(v) => setDraft({ ...draft, website: v })}
                  placeholder="https://www.vendor.com"
                />

                {/* Additional contacts (edit) */}
                <div className="mt-2 border-t border-border pt-2">
                  <div className="mb-1.5 flex items-center justify-between">
                    <p className="text-[9px] uppercase tracking-wide text-text-secondary">
                      Additional contacts ({draft.additionalContacts.length})
                    </p>
                    {/* Not converted to Button: an outline action colored
                        border-primary and text-primary, no outline/brand
                        cell is minted. */}
                    <button
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          additionalContacts: [
                            ...draft.additionalContacts,
                            {
                              id: `vc_new_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                              name: "",
                              email: "",
                              phone: "",
                              role: "",
                            },
                          ],
                        })
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-surface-light px-1.5 py-0.5 text-[10px] font-semibold text-primary hover:bg-primary-subtle"
                      title="Add another contact"
                    >
                      <UserPlus className="h-2.5 w-2.5" />
                      Add
                    </button>
                  </div>
                  {draft.additionalContacts.length === 0 ? (
                    <p className="text-[11px] italic text-text-secondary">
                      No additional contacts. Use <strong>+ Add</strong> for
                      AP, branch manager, after-hours, etc.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {draft.additionalContacts.map((c, idx) => (
                        <div
                          key={c.id}
                          className="relative rounded-md border border-border bg-background-light/40 p-1.5"
                        >
                          <div className="mb-1 flex items-center justify-between">
                            <span className="text-[9px] font-semibold uppercase tracking-wide text-text-secondary">
                              Contact #{idx + 2}
                            </span>
                            <Button
                              type="button"
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  additionalContacts:
                                    draft.additionalContacts.filter(
                                      (x) => x.id !== c.id,
                                    ),
                                })
                              }
                              aria-label="Remove contact"
                              title="Remove contact"
                              variant="ghost"
                              tone="danger"
                              size="icon"
                            >
                              <Trash2 className="h-2.5 w-2.5" />
                            </Button>
                          </div>
                          <div className="grid grid-cols-1 gap-1">
                            <Input
                              value={c.name ?? ""}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  additionalContacts:
                                    draft.additionalContacts.map((x) =>
                                      x.id === c.id
                                        ? { ...x, name: e.target.value }
                                        : x,
                                    ),
                                })
                              }
                              placeholder="Name"
                              className="px-1.5 py-0.5 text-[11px]"
                            />
                            <Input
                              value={c.role ?? ""}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  additionalContacts:
                                    draft.additionalContacts.map((x) =>
                                      x.id === c.id
                                        ? { ...x, role: e.target.value }
                                        : x,
                                    ),
                                })
                              }
                              placeholder="Role (AP, Branch, After-hours…)"
                              className="px-1.5 py-0.5 text-[11px]"
                            />
                            <Input
                              value={c.email ?? ""}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  additionalContacts:
                                    draft.additionalContacts.map((x) =>
                                      x.id === c.id
                                        ? { ...x, email: e.target.value }
                                        : x,
                                    ),
                                })
                              }
                              type="email"
                              placeholder="email@vendor.com"
                              className="px-1.5 py-0.5 text-[11px]"
                            />
                            <Input
                              value={c.phone ?? ""}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  additionalContacts:
                                    draft.additionalContacts.map((x) =>
                                      x.id === c.id
                                        ? { ...x, phone: formatPhoneInput(e.target.value) }
                                        : x,
                                    ),
                                })
                              }
                              placeholder="(555) 010-1234"
                              className="px-1.5 py-0.5 text-[11px]"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-1 text-[12px] text-text-primary">
                {vendor.contactPersonName && (
                  <Row icon={<User className="h-3 w-3 text-text-secondary" />} text={vendor.contactPersonName} />
                )}
                {vendor.contactEmail && (
                  <Row
                    icon={<Mail className="h-3 w-3 text-text-secondary" />}
                    text={
                      <a
                        href={`mailto:${vendor.contactEmail}`}
                        className="hover:text-primary"
                      >
                        {vendor.contactEmail}
                      </a>
                    }
                  />
                )}
                {vendor.contactPhone && (
                  <Row
                    icon={<Phone className="h-3 w-3 text-text-secondary" />}
                    text={
                      <a
                        href={`tel:${vendor.contactPhone}`}
                        className="hover:text-primary"
                      >
                        {formatPhone(vendor.contactPhone)}
                      </a>
                    }
                  />
                )}
                {vendor.website && (
                  <Row
                    icon={<ExternalLink className="h-3 w-3 text-primary" />}
                    text={
                      <a
                        href={safeHref(vendor.website)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:text-primary/80"
                      >
                        {vendor.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
                      </a>
                    }
                  />
                )}
                {!vendor.contactPersonName &&
                  !vendor.contactEmail &&
                  !vendor.contactPhone &&
                  !vendor.website && (
                    <p className="text-xs italic text-text-secondary">
                      No contact info on file
                    </p>
                  )}

                {/* Additional contacts (read) */}
                {(vendor.additionalContacts?.length ?? 0) > 0 && (
                  <div className="mt-2 space-y-1.5 border-t border-border pt-2">
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-text-secondary">
                      Additional contacts
                    </p>
                    {vendor.additionalContacts!.map((c) => (
                      <div
                        key={c.id}
                        className="rounded-md border border-border bg-background-light/50 px-2 py-1"
                      >
                        {(c.name || c.role) && (
                          <p className="text-[11px] font-semibold text-text-primary">
                            {c.name ?? "—"}
                            {c.role && (
                              <span className="ml-1 text-[10px] font-normal text-text-secondary">
                                · {c.role}
                              </span>
                            )}
                          </p>
                        )}
                        {c.email && (
                          <a
                            href={`mailto:${c.email}`}
                            className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-primary"
                          >
                            <Mail className="h-2.5 w-2.5 text-text-secondary" />
                            {c.email}
                          </a>
                        )}
                        {c.phone && (
                          <a
                            href={`tel:${c.phone}`}
                            className="flex items-center gap-1 text-[11px] text-text-secondary hover:text-primary"
                          >
                            <Phone className="h-2.5 w-2.5 text-text-secondary" />
                            {formatPhone(c.phone)}
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Account card */}
          <div className="col-span-4 rounded-md border border-border bg-surface-light p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Account
            </p>
            {isEditing && draft ? (
              <div className="space-y-2 text-[12px]">
                <LabeledInput
                  label="Account #"
                  icon={<CreditCard className="h-3 w-3" />}
                  value={draft.accountNumber}
                  onChange={(v) => setDraft({ ...draft, accountNumber: v })}
                  placeholder="ADI-12345"
                />
              </div>
            ) : (
              <div className="text-[12px]">
                <span className="block text-[9px] uppercase text-text-secondary">
                  Account #
                </span>
                <code className="font-mono font-semibold text-text-primary">
                  {vendor.accountNumber ?? "—"}
                </code>
              </div>
            )}
          </div>

          {/* Pickup card */}
          <div className="col-span-4 rounded-md border border-border bg-surface-light p-3">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Pickup / Ship-from
            </p>
            {isEditing && draft ? (
              <Textarea
                value={draft.pickupAddress}
                onChange={(e) =>
                  setDraft({ ...draft, pickupAddress: e.target.value })
                }
                rows={3}
                placeholder="Will-call counter address"
                className="w-full resize-none px-2 py-1 text-[11px]"
              />
            ) : vendor.pickupAddress ? (
              <p className="flex items-start gap-1.5 text-[12px] text-text-secondary">
                <MapPin className="mt-0.5 h-3 w-3 flex-shrink-0 text-text-secondary" />
                {vendor.pickupAddress}
              </p>
            ) : (
              <p className="text-xs italic text-text-secondary">
                No pickup address on file
              </p>
            )}
            {isEditing && draft ? (
              <div className="mt-3">
                <span className="block text-[9px] uppercase text-text-secondary">
                  Notes
                </span>
                <Textarea
                  value={draft.notes}
                  onChange={(e) =>
                    setDraft({ ...draft, notes: e.target.value })
                  }
                  rows={2}
                  placeholder="Special handling, rep notes…"
                  className="mt-1 w-full resize-none px-2 py-1 text-[11px]"
                />
              </div>
            ) : (
              vendor.notes && (
                <p className="mt-2 border-t border-border pt-2 text-[11px] italic text-text-secondary">
                  "{vendor.notes}"
                </p>
              )
            )}
          </div>
        </div>

        {/* In-edit banner for name/category (header-level fields) */}
        {isEditing && draft && (
          <div className="rounded-md border border-warning/20 bg-warning/10 p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-warning">
              Vendor identity
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <FormField label="Vendor Name" required gap={1}>
                <Input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  invalid={!nameValid}
                  className="px-2 py-1"
                />
              </FormField>
              {/* Not converted to FormField: VendorCategoryPicker has no `id`
                  prop and does not forward one to its Select trigger, so
                  FormField's generated id would reach no element - same
                  structural block as SelectField. */}
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase text-text-secondary">
                  Category
                </span>
                <VendorCategoryPicker
                  value={draft.categoryId}
                  valueName={draft.category}
                  onChange={(sel) =>
                    // Functional: the picker may call back after an await
                    // (inline add), when this render's `draft` is stale.
                    setDraft((d) =>
                      d ? { ...d, categoryId: sel.categoryId, category: sel.category } : d,
                    )
                  }
                  inEdit
                />
              </label>
            </div>
          </div>
        )}

        {/* Spend cards */}
        {spend && !isEditing && (
          <div className="grid grid-cols-12 gap-3">
            <KpiTile
              className="col-span-3"
              icon={DollarSign}
              label="YTD Spend"
              value={fmtMoneyFull(spend.ytd)}
              sub={`${spend.ytdPoCount} POs this year`}
              tone="success"
            />
            <KpiTile
              className="col-span-3"
              icon={Calendar}
              label="This Month"
              value={fmtMoneyFull(spend.thisMonth)}
              sub={
                spend.lastMonth > 0
                  ? `${spend.momDelta >= 0 ? "▲" : "▼"} ${Math.abs(spend.momDeltaPct * 100).toFixed(0)}% vs last month`
                  : "no comparison"
              }
              tone="primary"
            />
            <KpiTile
              className="col-span-3"
              icon={CreditCard}
              label="All-Time"
              value={fmtMoneyFull(spend.allTime)}
              sub={`${spend.poCount} total POs`}
              tone="neutral"
            />
            <KpiTile
              className="col-span-3"
              icon={ShoppingCart}
              label="Avg PO"
              value={fmtMoney(spend.avgPoSize)}
              sub={
                spend.topItemName
                  ? `Top: ${spend.topItemName.slice(0, 26)}${spend.topItemName.length > 26 ? "…" : ""}`
                  : "no item data"
              }
              tone="info"
            />
          </div>
        )}

        {/* Recent POs table */}
        {!isEditing && last5POs.length > 0 && (
          <div className="rounded-md border border-border bg-surface-light">
            <p className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
              Recent purchase orders
            </p>
            <table className="w-full text-xs">
              <thead className="bg-background-light text-[10px] uppercase tracking-wide text-text-secondary">
                <tr>
                  <th className="px-3 py-1.5 text-left">PO</th>
                  <th className="px-3 py-1.5 text-left">Job / Customer</th>
                  <th className="px-3 py-1.5 text-left">Ordered</th>
                  <th className="px-3 py-1.5 text-left">Status</th>
                  <th className="px-3 py-1.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {last5POs.map((po) => (
                  <tr
                    key={po.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setPreviewPONumber(po.poNumber)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setPreviewPONumber(po.poNumber);
                      }
                    }}
                    title={`Preview ${po.poNumber}`}
                    className="cursor-pointer transition-colors hover:bg-primary-subtle/60 focus:bg-primary-subtle/60 focus:outline-none"
                  >
                    <td className="px-3 py-1.5">
                      <code className="font-mono font-semibold text-primary">
                        {po.poNumber}
                      </code>
                    </td>
                    <td className="px-3 py-1.5 text-text-secondary">
                      {po.jobNumber ? `${po.jobNumber} · ${po.customer ?? ""}` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-text-secondary">
                      {po.orderedAt ? new Date(po.orderedAt).toLocaleDateString('en-US') : "—"}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="rounded-full bg-background-light px-1.5 py-0.5 text-[9px] font-semibold uppercase text-text-secondary ring-1 ring-border">
                        {po.status}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-text-primary">
                      {fmtMoney(poTotal(po))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!isEditing && last5POs.length === 0 && (
          <EmptyState
            variant="card"
            icon={ShoppingCart}
            title="No purchase orders on file for this vendor yet."
          />
        )}
      </div>
    </Modal>

    <POPreviewDialog
      open={!!previewPONumber}
      onClose={() => setPreviewPONumber(null)}
      poNumber={previewPONumber}
      zIndex={80}
      lockEscape
    />
    </>
  );
}

function Row({ icon, text }: { icon: React.ReactNode; text: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      {icon}
      <span className="min-w-0 flex-1 truncate">{text}</span>
    </div>
  );
}

function LabeledInput({
  label,
  icon,
  value,
  onChange,
  placeholder,
  type,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <FormField label={<span className="flex items-center gap-1">{icon}{label}</span>} gap={0.5}>
      <Input
        value={value}
        type={type ?? "text"}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-1.5 py-1 text-[11px]"
      />
    </FormField>
  );
}
