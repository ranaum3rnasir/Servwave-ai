// Regression coverage for the inventory Input/Textarea primitive conversion,
// batch A (17 files under components/inventory/, raw <input>/<textarea> ->
// the design-system Input/Textarea primitives). Flagged by an earlier review
// as a real gap: the batch had no test asserting the primitives actually
// render and behave, as opposed to the tag swap merely typechecking.
//
// Two sites get targeted coverage because they were the trickiest part of the
// layering-guard cleanup that followed the conversion:
//  - CreateStageDialog's "new job #" field had its stripped `inputCls` referenced
//    inside a template literal (`${inputCls} mt-1`) rather than as the whole
//    className expression — the exact shape the guard's literal-string scanner
//    cannot resolve on its own, so it had to be checked by hand.
//  - CreateStageDialog's per-line Item/Vendor pickers share `miniSelectCls`,
//    decoupled from the now-stripped `miniInputCls` so the (out-of-scope,
//    ungoverned) SelectField keeps its original box styling untouched while
//    the Qty/PO# Inputs next to it render through the stripped primitive.
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "./helpers";
import { AddBranchDialog } from "@/components/inventory/AddBranchDialog";
import { AddCategoryDialog } from "@/components/inventory/AddCategoryDialog";
import { AddVendorDialog } from "@/components/inventory/AddVendorDialog";
import { CreateStageDialog } from "@/components/inventory/CreateStageDialog";
import type { Item, InventoryJob, Location, PurchaseOrder, Tech, Vendor } from "@/lib/api/inventory";

vi.mock("@/lib/api/inventory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/inventory")>();
  const items: Item[] = [
    {
      id: "itm_1",
      sku: "SKU-001",
      name: "Deadbolt",
      category: "Locksets",
      trade: "locksmith",
      kind: "material",
      uom: "EA",
      unitCost: 10,
      sellPrice: 25,
      serialized: false,
      hazmat: false,
      status: "active",
      vendor: "Acme",
      stock: [],
      updatedAt: "2026-05-01T00:00:00Z",
    },
  ];
  const vendors: Vendor[] = [
    { id: "vnd_1", name: "Acme", category: "Hardware", paymentTerms: "Net 30", leadTimeDays: 3, transmitMethod: "email" },
  ];
  const jobs: InventoryJob[] = [
    { id: "job_1", jobNumber: "J-1850", customer: "Rolex 5th Ave", site: "665 Fifth Ave, NY", trade: "multi", status: "scheduled" },
  ];
  const purchaseOrders: PurchaseOrder[] = [];
  const techs: Tech[] = [];
  return {
    ...actual,
    useInventoryItems: () => ({ data: items, isLoading: false, isError: false }),
    useVendors: () => ({ data: vendors, isLoading: false, isError: false }),
    usePurchaseOrders: () => ({ data: purchaseOrders, isLoading: false, isError: false }),
    useInventoryJobs: () => ({ data: jobs, isLoading: false, isError: false }),
    useTechs: () => ({ data: techs, isLoading: false, isError: false }),
    useCreateStage: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }),
  };
});

const LOCATIONS: Location[] = [
  { id: "loc_1", name: "Main Warehouse", type: "warehouse", branch: "Brooklyn HQ" },
];

describe("inventory Input/Textarea conversion — batch A regression", () => {
  it("AddBranchDialog: Input + Textarea + a SelectField sharing the (now-split) inputCls constant all render and accept input", async () => {
    const onCreate = vi.fn();
    renderWithProviders(<AddBranchDialog open onClose={vi.fn()} onCreate={onCreate} />);

    const name = screen.getByPlaceholderText("e.g. Long Island Branch");
    await userEvent.type(name, "Queens Branch");
    expect(name).toHaveValue("Queens Branch");

    const notes = screen.getByPlaceholderText("Service area · operating hours · special handling");
    await userEvent.type(notes, "24/7 dispatch");
    expect(notes).toHaveValue("24/7 dispatch");

    // Timezone is a SelectField driven by `selectCls`, decoupled from the
    // stripped `inputCls` the Input/Textarea siblings above use — it must
    // still render with its default value untouched.
    expect(screen.getByRole("combobox", { name: "Timezone" })).toHaveTextContent("America/New_York");

    await userEvent.click(screen.getByRole("button", { name: /save branch/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Queens Branch" }));
  });

  it("AddCategoryDialog: Input/Textarea render alongside the Trade SelectField (split selectCls)", async () => {
    const onCreate = vi.fn();
    renderWithProviders(<AddCategoryDialog open onClose={vi.fn()} onCreate={onCreate} />);

    const name = screen.getByPlaceholderText("e.g. Door Hinges, Smart Locks, Coolant Lines…");
    await userEvent.type(name, "Smart Locks");
    expect(name).toHaveValue("Smart Locks");

    const description = screen.getByPlaceholderText("One-line description shown in reports + admin");
    await userEvent.type(description, "Retrofit deadbolts");
    expect(description).toHaveValue("Retrofit deadbolts");

    expect(screen.getByRole("combobox", { name: "Trade" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /save category/i }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Smart Locks" }));
  });

  it("AddVendorDialog: the Account Number Input renders without its dropped font-mono treatment, still holds a value", async () => {
    const onCreate = vi.fn();
    renderWithProviders(<AddVendorDialog open onClose={vi.fn()} onCreate={onCreate} />);

    const vendorName = screen.getByPlaceholderText("ADI, Ferguson, Winsupply…");
    await userEvent.type(vendorName, "Ferguson");
    expect(vendorName).toHaveValue("Ferguson");

    const acct = screen.getByPlaceholderText("Your account # with this vendor");
    await userEvent.type(acct, "AC-4471");
    expect(acct).toHaveValue("AC-4471");

    await userEvent.click(screen.getByRole("button", { name: /save vendor/i }));
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ name: "Ferguson" }));
  });

  it("CreateStageDialog: the template-literal `${inputCls} mt-1` job-number Input renders and accepts input", async () => {
    renderWithProviders(
      <CreateStageDialog open onClose={vi.fn()} locations={LOCATIONS} onCreate={vi.fn()} />,
    );

    const jobNumber = screen.getByPlaceholderText("Type new job # · e.g. J-1870");
    await userEvent.type(jobNumber, "j-9001");
    // Component uppercases on change.
    expect(jobNumber).toHaveValue("J-9001");
  });

  it("CreateStageDialog: the line-item Qty Input (miniInputCls) sits beside the Item SelectField (miniSelectCls) — both render", async () => {
    renderWithProviders(
      <CreateStageDialog open onClose={vi.fn()} locations={LOCATIONS} onCreate={vi.fn()} />,
    );

    // `miniSelectCls` is decoupled from the stripped `miniInputCls` precisely
    // so this ungoverned SelectField keeps its original compact box styling.
    expect(screen.getByRole("combobox", { name: "Item" })).toBeInTheDocument();

    const qty = screen.getByPlaceholderText("0");
    await userEvent.type(qty, "4");
    expect(qty).toHaveValue(4);

    const poNumber = screen.getByPlaceholderText("PO-…");
    await userEvent.type(poNumber, "PO-778");
    expect(poNumber).toHaveValue("PO-778");
  });
});
