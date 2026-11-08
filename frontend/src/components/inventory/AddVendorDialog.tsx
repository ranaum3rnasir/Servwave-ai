import type React from "react";
import { useState } from "react";
import { Building2, Trash2, UserPlus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { FormField } from "@/components/patterns/FormField";
import type { Vendor, VendorContact } from "@/lib/api/inventory";
import { VendorCategoryPicker } from "@/components/inventory/VendorCategoryPicker";
import { extractApiError, formatPhoneInput } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreate: (vendor: Vendor) => unknown;
};

export function AddVendorDialog({
  open,
  onClose,
  onCreate,
}: Props) {
  const [form, setForm] = useState({
    name: "",
    // The company category row (null = Uncategorized) and its name, always
    // set together by the picker. The picker reads the list itself.
    categoryId: null as string | null,
    category: "",
    contactPersonName: "",
    contactEmail: "",
    contactPhone: "",
    additionalContacts: [] as VendorContact[],
    accountNumber: "",
    website: "",
    pickupAddress: "",
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
      categoryId: null,
      category: "",
      contactPersonName: "",
      contactEmail: "",
      contactPhone: "",
      additionalContacts: [],
      accountNumber: "",
      website: "",
      pickupAddress: "",
      notes: "",
    });
    setError(null);
  }

  function addContact() {
    setForm((f) => ({
      ...f,
      additionalContacts: [
        ...f.additionalContacts,
        {
          id: `vc_new_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
          name: "",
          email: "",
          phone: "",
          role: "",
        },
      ],
    }));
  }

  function updateContact(id: string, patch: Partial<VendorContact>) {
    setForm((f) => ({
      ...f,
      additionalContacts: f.additionalContacts.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    }));
  }

  function removeContact(id: string) {
    setForm((f) => ({
      ...f,
      additionalContacts: f.additionalContacts.filter((c) => c.id !== id),
    }));
  }

  async function submit() {
    if (!form.name.trim()) return setError("Vendor name is required.");
    const vendor: Vendor = {
      id: `vnd_new_${Date.now()}`,
      name: form.name.trim(),
      // Uncategorized is allowed (S4.1): no invented default.
      category: form.category.trim(),
      categoryId: form.categoryId,
      contactPersonName: form.contactPersonName.trim() || undefined,
      contactEmail: form.contactEmail.trim() || undefined,
      contactPhone: form.contactPhone.trim() || undefined,
      additionalContacts: (() => {
        const cleaned = form.additionalContacts
          .map((c) => ({
            id: c.id,
            name: c.name?.trim() || undefined,
            email: c.email?.trim() || undefined,
            phone: c.phone?.trim() || undefined,
            role: c.role?.trim() || undefined,
          }))
          .filter((c) => c.name || c.email || c.phone || c.role);
        return cleaned.length > 0 ? cleaned : undefined;
      })(),
      accountNumber: form.accountNumber.trim() || undefined,
      website: form.website.trim() || undefined,
      pickupAddress: form.pickupAddress.trim() || undefined,
      notes: form.notes.trim() || undefined,
      status: "active",
    };
    setSaving(true);
    try {
      await onCreate(vendor);
      reset();
      onClose();
    } catch (err) {
      setError(extractApiError(err, "Could not save the vendor - try again."));
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
      title="Add New Vendor"
      subtitle="Creates a new vendor in your master vendor list."
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
            Save Vendor
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-md border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="col-span-2">
          <FormField label="Vendor Name" required>
            <Input
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="ADI, Ferguson, Winsupply…"
              className={inputCls}
              autoFocus
            />
          </FormField>
        </div>

        {/* VendorCategoryPicker accepts no id prop, so there is no way to
            wire a label id onto its Select trigger. Left on the local Field. */}
        <Field label="Category">
          <VendorCategoryPicker
            value={form.categoryId}
            valueName={form.category}
            onChange={(sel) =>
              setForm((f) => ({ ...f, categoryId: sel.categoryId, category: sel.category }))
            }
          />
        </Field>

        <FormField label="Account Number">
          <Input
            value={form.accountNumber}
            onChange={(e) => set("accountNumber", e.target.value)}
            placeholder="Your account # with this vendor"
            className={inputCls}
          />
        </FormField>

        <FormField label="Contact Person">
          <Input
            value={form.contactPersonName}
            onChange={(e) => set("contactPersonName", e.target.value)}
            placeholder="Rep name (the human you call)"
            className={inputCls}
          />
        </FormField>

        <FormField label="Website">
          <Input
            value={form.website}
            onChange={(e) => set("website", e.target.value)}
            placeholder="https://www.vendor.com"
            className={inputCls}
          />
        </FormField>

        <FormField label="Contact Email">
          <Input
            value={form.contactEmail}
            onChange={(e) => set("contactEmail", e.target.value)}
            type="email"
            placeholder="orders@vendor.com"
            className={inputCls}
          />
        </FormField>

        <FormField label="Contact Phone">
          <Input
            value={form.contactPhone}
            onChange={(e) => set("contactPhone", formatPhoneInput(e.target.value))}
            placeholder="(555) 010-1234"
            className={inputCls}
          />
        </FormField>

        {/* Additional contacts — one card per extra person (orders rep + AP +
            branch manager + after-hours dispatch…). Each card has its own
            name / email / phone / role + an X to remove. The primary contact
            above is the default that surfaces on PO docs and email pickers. */}
        <div className="col-span-2 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
              Additional contacts ({form.additionalContacts.length})
              <span className="ml-1 text-[10px] font-normal normal-case tracking-normal text-text-secondary">
                — optional. Add AP, branch manager, after-hours, etc.
              </span>
            </span>
            {/* Raw by design: no minted outline+brand cell exists (outline
                only has neutral + danger tones). */}
            <button
              type="button"
              onClick={addContact}
              className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-surface-light px-2 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10"
              title="Add another contact person for this vendor"
            >
              <UserPlus className="h-3 w-3" />
              Add contact
            </button>
          </div>

          {form.additionalContacts.length === 0 ? (
            <p className="text-[11px] italic text-text-secondary">
              No additional contacts yet. Click <strong>+ Add contact</strong>{" "}
              to add another person (e.g. AP rep, branch manager).
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {form.additionalContacts.map((c, idx) => (
                <div
                  key={c.id}
                  className="relative rounded-md border border-border bg-background-light p-2.5"
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                      Contact #{idx + 2}
                    </span>
                    <Button
                      variant="ghost"
                      tone="danger"
                      size="3xs"
                      onClick={() => removeContact(c.id)}
                      aria-label="Remove this contact"
                      title="Remove this contact"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <Input
                      value={c.name ?? ""}
                      onChange={(e) =>
                        updateContact(c.id, { name: e.target.value })
                      }
                      placeholder="Name"
                      className={inputCls}
                    />
                    <Input
                      value={c.role ?? ""}
                      onChange={(e) =>
                        updateContact(c.id, { role: e.target.value })
                      }
                      placeholder="Role (AP, Branch manager, After-hours…)"
                      className={inputCls}
                    />
                    <Input
                      value={c.email ?? ""}
                      onChange={(e) =>
                        updateContact(c.id, { email: e.target.value })
                      }
                      type="email"
                      placeholder="email@vendor.com"
                      className={inputCls}
                    />
                    <Input
                      value={c.phone ?? ""}
                      onChange={(e) =>
                        updateContact(c.id, { phone: formatPhoneInput(e.target.value) })
                      }
                      placeholder="(555) 010-1234"
                      className={inputCls}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="col-span-2">
          <FormField label="Pickup / Ship-from Address">
            <Input
              value={form.pickupAddress}
              onChange={(e) => set("pickupAddress", e.target.value)}
              placeholder="Will-call counter address — surfaced on pickup tickets"
              className={inputCls}
            />
          </FormField>
        </div>

        <div className="col-span-2">
          <FormField label="Notes">
            <Textarea
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={2}
              placeholder="Optional · special handling, ship-from notes, rep contacts"
              className={`${inputCls} resize-none`}
            />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

const inputCls = "w-full px-2.5 py-1.5";

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-[11px] font-medium uppercase tracking-wide text-text-secondary">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
    </label>
  );
}
