/**
 * S1.2 (Purchasing Audit Verdict, PR 1): ServWave never sends a PO, so the
 * Add Vendor form no longer asks for payment terms, a default lead time or a
 * PO transmit method, and the vendor it hands back carries none of them. A
 * vendor is saveable from a name and a category alone.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/__tests__/helpers";
import api from "@/lib/axios";
import { AddVendorDialog } from "../AddVendorDialog";

const RETIRED_KEYS = ["paymentTerms", "leadTimeDays", "transmitMethod", "transmitMethods"] as const;

// S4.1: the category picker reads the company's real list itself.
const PLUMBING = { id: "a1000000-0000-4000-8000-000000000a01", name: "Plumbing wholesale", vendorCount: 2 };

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ data: { categories: [PLUMBING] } });
});

describe("AddVendorDialog - retired sending fields (S1.2)", () => {
  it("renders no Payment Terms, Lead Time or PO Transmit Method controls", () => {
    renderWithProviders(<AddVendorDialog open onClose={vi.fn()} onCreate={vi.fn()} />);

    expect(screen.queryByText(/payment terms/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/lead time/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/transmit/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /payment terms/i })).not.toBeInTheDocument();
    // The transmit chips were <button>s named after the channels.
    for (const chip of [/^email$/i, /vendor portal/i, /^edi$/i, /will-call/i]) {
      expect(screen.queryByRole("button", { name: chip })).not.toBeInTheDocument();
    }

    // What the form still asks for.
    expect(screen.getByPlaceholderText("ADI, Ferguson, Winsupply…")).toBeInTheDocument();
    expect(screen.getByText("Category")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Your account # with this vendor")).toBeInTheDocument();
  });

  it("saves a vendor from name + category alone, with none of the retired keys on the object", async () => {
    const onCreate = vi.fn();
    renderWithProviders(<AddVendorDialog open onClose={vi.fn()} onCreate={onCreate} />);

    await userEvent.type(screen.getByPlaceholderText("ADI, Ferguson, Winsupply…"), "S12 Vendor");
    // The category picker is the dialog's only combobox now.
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(await screen.findByRole("option", { name: "Plumbing wholesale" }));
    await userEvent.click(screen.getByRole("button", { name: /save vendor/i }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    const vendor = onCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(vendor).toMatchObject({
      name: "S12 Vendor",
      category: "Plumbing wholesale",
      // S4.1: the real row's id travels with the name.
      categoryId: PLUMBING.id,
      status: "active",
    });
    for (const key of RETIRED_KEYS) expect(vendor).not.toHaveProperty(key);
  });

  it("offers the company list plus Uncategorized - no free-text '+ Add new category…' row", async () => {
    renderWithProviders(<AddVendorDialog open onClose={vi.fn()} onCreate={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox"));

    expect(await screen.findByRole("option", { name: "Plumbing wholesale" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Uncategorized" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /add new category/i })).not.toBeInTheDocument();
  });

  it("saves an Uncategorized vendor as categoryId null and an empty name (S4.1)", async () => {
    const onCreate = vi.fn();
    renderWithProviders(<AddVendorDialog open onClose={vi.fn()} onCreate={onCreate} />);

    await userEvent.type(screen.getByPlaceholderText("ADI, Ferguson, Winsupply…"), "S41 Loose Vendor");
    await userEvent.click(screen.getByRole("button", { name: /save vendor/i }));

    const vendor = onCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(vendor).toMatchObject({ name: "S41 Loose Vendor", categoryId: null, category: "" });
  });
});
