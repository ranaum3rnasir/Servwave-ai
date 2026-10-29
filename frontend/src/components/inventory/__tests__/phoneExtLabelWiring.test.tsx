/**
 * SRVW-54 - the phone + extension row must keep the label wired to the PHONE input.
 *
 * `FormField` wires `id` / `htmlFor` by cloning its direct child. Turning the phone field into a
 * two-input row made that child a wrapper `<div>`, so the id landed on the div: clicking
 * "Phone" focused nothing and the input lost its accessible name. The fix is the render-prop
 * form with `fieldProps` spread onto the phone Input. These pin that on all three inventory
 * sites - and, for the vendor detail dialog's `LabeledInput`, on a field WITHOUT an ext too,
 * since the first version of the fix broke every one of its call sites.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, inventoryWriteAbility } from "@/__tests__/helpers";
import api from "@/lib/axios";
import { AddVendorDialog } from "../AddVendorDialog";
import { AddBranchDialog } from "../AddBranchDialog";
import { VendorDetailDialog } from "../VendorDetailDialog";

const PLUMBING = { id: "a1000000-0000-4000-8000-000000000a01", name: "Plumbing wholesale", vendorCount: 2 };

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ data: { categories: [PLUMBING] } });
});

/** The element a visible label points at, or null when `htmlFor` resolves to nothing. */
function labelTarget(text: string): HTMLElement | null {
  const label = screen.getByText(text, { selector: "label, label *" }).closest("label");
  const id = label?.getAttribute("for");
  return id ? document.getElementById(id) : null;
}

describe("phone + extension row keeps the label on the phone input (SRVW-54)", () => {
  it("AddBranchDialog: the Phone label targets an INPUT, and the Ext box is separate", () => {
    renderWithProviders(<AddBranchDialog open onClose={vi.fn()} onCreate={vi.fn()} />);
    const phone = labelTarget("Phone");
    expect(phone?.tagName).toBe("INPUT");
    expect(phone).toHaveAttribute("placeholder", "(555) 010-1234");
    expect(screen.getByLabelText("Phone extension")).not.toBe(phone);
  });

  it("AddVendorDialog: the Contact Phone label targets an INPUT", () => {
    renderWithProviders(<AddVendorDialog open onClose={vi.fn()} onCreate={vi.fn()} />);
    const phone = labelTarget("Contact Phone");
    expect(phone?.tagName).toBe("INPUT");
    expect(screen.getByLabelText("Contact phone extension")).not.toBe(phone);
  });

  it("VendorDetailDialog edit view: Phone (with ext) AND Email (without) both target an INPUT", async () => {
    const vendor = {
      id: "v1000000-0000-4000-8000-000000000001",
      name: "Acme",
      category: "Plumbing wholesale",
      categoryId: PLUMBING.id,
      contactPhone: "5550101234",
      contactPhoneExt: "204",
      contactEmail: "orders@acme.example",
      status: "active" as const,
    };
    renderWithProviders(
      <VendorDetailDialog
        open
        onClose={vi.fn()}
        vendor={vendor}
        spend={null}
        pos={[]}
        onSave={vi.fn()}
        onDeleteRequest={vi.fn()}
        onArchiveToggle={vi.fn()}
      />,
      { ability: inventoryWriteAbility() },
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    const phone = labelTarget("Phone");
    expect(phone?.tagName).toBe("INPUT");
    expect(phone).toHaveValue("(555) 010-1234");
    expect(screen.getByLabelText("Phone extension")).toHaveValue("204");

    // The single-input branch of LabeledInput must be wired too.
    const email = labelTarget("Email");
    expect(email?.tagName).toBe("INPUT");
    expect(email).toHaveValue("orders@acme.example");
    // Mobile slice 23: an email field by kind, and the browser must not offer the
    // staff member's own address for the vendor's contact.
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("inputmode", "email");
    expect(email).toHaveAttribute("autocomplete", "off");
    expect(email).toHaveAttribute("autocapitalize", "none");
  });
});
