/**
 * S4.1 (Purchasing Audit Verdict, PR 4): vendor categories are a real
 * per-company list. The picker reads it, offers "Uncategorized", and its
 * pinned "Manage categories…" row opens an inline add / rename / delete list
 * whose writes are optimistic with a rollback - a 409 (duplicate name,
 * category still in use) is shown under the list and the row goes back to
 * how it was.
 *
 * The HTTP client is the seam: a tiny in-memory "server" backs api.get so a
 * refetch after a successful write returns the written state (the hooks
 * invalidate on settle), while a rejected write returns the unchanged list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, inventoryWriteAbility } from "@/__tests__/helpers";
import api from "@/lib/axios";
import type { VendorCategory } from "@/lib/api/inventory";
import { VendorCategoryPicker } from "../VendorCategoryPicker";

const PLUMBING: VendorCategory = { id: "a1000000-0000-4000-8000-000000000a01", name: "Plumbing wholesale", vendorCount: 3 };
const SECURITY: VendorCategory = { id: "a1000000-0000-4000-8000-000000000a02", name: "Security + low voltage", vendorCount: 0 };
const GLAZING_ID = "a1000000-0000-4000-8000-000000000a03";

const mockApi = vi.mocked(api);
let server: VendorCategory[];

function conflict(error: string, message: string, extra: Record<string, unknown> = {}) {
  return { response: { status: 409, data: { error, message, ...extra } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  server = [PLUMBING, SECURITY];
  mockApi.get.mockImplementation(async () => ({ data: { categories: [...server] } }));
  mockApi.post.mockImplementation(async (_url: string, body?: unknown) => {
    const { name } = body as { name: string };
    const row = { id: GLAZING_ID, name, vendorCount: 0 };
    server = [...server, row];
    return { data: { category: row } };
  });
  mockApi.patch.mockImplementation(async (url: string, body?: unknown) => {
    const { name } = body as { name: string };
    const id = url.split("/").pop();
    server = server.map((c) => (c.id === id ? { ...c, name } : c));
    const row = server.find((c) => c.id === id)!;
    return { data: { category: row } };
  });
  mockApi.delete.mockImplementation(async (url: string) => {
    const id = url.split("/").pop();
    server = server.filter((c) => c.id !== id);
    return { data: { message: "Category deleted" } };
  });
});

function renderPicker(props: Partial<React.ComponentProps<typeof VendorCategoryPicker>> = {}) {
  const onChange = vi.fn();
  renderWithProviders(
    <VendorCategoryPicker value={PLUMBING.id} valueName={PLUMBING.name} onChange={onChange} {...props} />,
    { ability: inventoryWriteAbility() },
  );
  return { onChange };
}

async function openList() {
  await userEvent.click(screen.getByRole("combobox"));
  // The options come from the query; wait for the first real one.
  await screen.findByRole("option", { name: PLUMBING.name });
}

async function openManage() {
  await openList();
  await userEvent.click(screen.getByRole("option", { name: /manage categories/i }));
  return screen.findByRole("group", { name: /manage categories/i });
}

describe("VendorCategoryPicker - the list", () => {
  it("lists the company categories plus Uncategorized, and the current row reads as selected", async () => {
    renderPicker();
    await openList();

    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual([
      "Uncategorized",
      PLUMBING.name,
      SECURITY.name,
      "Manage categories…",
    ]);
    expect(screen.getByRole("option", { name: PLUMBING.name })).toHaveAttribute("aria-selected", "true");
  });

  it("picking a category emits its id and name", async () => {
    const { onChange } = renderPicker();
    await openList();

    await userEvent.click(screen.getByRole("option", { name: SECURITY.name }));

    expect(onChange).toHaveBeenCalledWith({ categoryId: SECURITY.id, category: SECURITY.name });
  });

  it("picking Uncategorized emits null and an empty name", async () => {
    const { onChange } = renderPicker();
    await openList();

    await userEvent.click(screen.getByRole("option", { name: "Uncategorized" }));

    expect(onChange).toHaveBeenCalledWith({ categoryId: null, category: "" });
  });

  it("a vendor whose row is not in the list still shows its stored name", async () => {
    renderPicker({ value: "a1000000-0000-4000-8000-0000000000ff", valueName: "Retired name" });
    await openList();

    expect(screen.getByRole("option", { name: "Retired name" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("VendorCategoryPicker - Manage categories (inline add / rename / delete)", () => {
  it("adds a category, POSTs it, lists it with its count, and picks it", async () => {
    const { onChange } = renderPicker();
    const panel = await openManage();

    await userEvent.type(within(panel).getByLabelText("New category name"), "Glazing");
    await userEvent.click(within(panel).getByRole("button", { name: /^add$/i }));

    await waitFor(() =>
      expect(mockApi.post).toHaveBeenCalledWith("/api/inventory/vendor-categories", { name: "Glazing" }),
    );
    expect(await within(panel).findByText("Glazing")).toBeInTheDocument();
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ categoryId: GLAZING_ID, category: "Glazing" }),
    );
    // The input is cleared for the next one.
    expect(within(panel).getByLabelText("New category name")).toHaveValue("");
  });

  it("a duplicate name shows the server's 409 message and the optimistic row is rolled back", async () => {
    mockApi.post.mockRejectedValue(
      conflict("CATEGORY_EXISTS", 'A category named "Plumbing wholesale" already exists.'),
    );
    const { onChange } = renderPicker();
    const panel = await openManage();

    await userEvent.type(within(panel).getByLabelText("New category name"), "plumbing wholesale{Enter}");

    expect(await within(panel).findByRole("alert")).toHaveTextContent(/already exists/i);
    // Exactly the two real rows - the placeholder is gone.
    await waitFor(() =>
      expect(within(panel).getAllByRole("button", { name: /^rename /i })).toHaveLength(2),
    );
    expect(within(panel).queryByText("plumbing wholesale")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renames a category through PATCH and the list shows the new name", async () => {
    renderPicker();
    const panel = await openManage();

    await userEvent.click(within(panel).getByRole("button", { name: `Rename ${SECURITY.name}` }));
    const input = within(panel).getByLabelText(`New name for ${SECURITY.name}`);
    await userEvent.clear(input);
    await userEvent.type(input, "Low voltage{Enter}");

    await waitFor(() =>
      expect(mockApi.patch).toHaveBeenCalledWith(`/api/inventory/vendor-categories/${SECURITY.id}`, {
        name: "Low voltage",
      }),
    );
    expect(await within(panel).findByText("Low voltage")).toBeInTheDocument();
    expect(within(panel).queryByText(SECURITY.name)).not.toBeInTheDocument();
  });

  it("renaming the selected category keeps the vendor's display name in step", async () => {
    const { onChange } = renderPicker();
    const panel = await openManage();

    await userEvent.click(within(panel).getByRole("button", { name: `Rename ${PLUMBING.name}` }));
    const input = within(panel).getByLabelText(`New name for ${PLUMBING.name}`);
    await userEvent.clear(input);
    await userEvent.type(input, "Plumbing supply{Enter}");

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ categoryId: PLUMBING.id, category: "Plumbing supply" }),
    );
  });

  it("a rename to an existing name shows the 409 and rolls the name back", async () => {
    mockApi.patch.mockRejectedValue(
      conflict("CATEGORY_EXISTS", 'A category named "Plumbing wholesale" already exists.'),
    );
    renderPicker();
    const panel = await openManage();

    await userEvent.click(within(panel).getByRole("button", { name: `Rename ${SECURITY.name}` }));
    const input = within(panel).getByLabelText(`New name for ${SECURITY.name}`);
    await userEvent.clear(input);
    await userEvent.type(input, "Plumbing wholesale{Enter}");

    expect(await within(panel).findByRole("alert")).toHaveTextContent(/already exists/i);
    await waitFor(() => expect(within(panel).getByText(SECURITY.name)).toBeInTheDocument());
  });

  it("deleting a category that vendors still use shows the blocked message and keeps the row", async () => {
    mockApi.delete.mockRejectedValue(
      conflict(
        "CATEGORY_IN_USE",
        "3 vendors still use this category. Move them to another category first.",
        { vendor_count: 3 },
      ),
    );
    renderPicker();
    const panel = await openManage();

    await userEvent.click(within(panel).getByRole("button", { name: `Delete ${PLUMBING.name}` }));

    expect(await within(panel).findByRole("alert")).toHaveTextContent(/3 vendors still use this category/i);
    // Rolled back: the row is still there after the rejection settles.
    await waitFor(() => expect(within(panel).getByText(PLUMBING.name)).toBeInTheDocument());
    expect(mockApi.delete).toHaveBeenCalledWith(`/api/inventory/vendor-categories/${PLUMBING.id}`);
  });

  it("deleting an empty category removes it from the list", async () => {
    renderPicker();
    const panel = await openManage();

    await userEvent.click(within(panel).getByRole("button", { name: `Delete ${SECURITY.name}` }));

    await waitFor(() =>
      expect(mockApi.delete).toHaveBeenCalledWith(`/api/inventory/vendor-categories/${SECURITY.id}`),
    );
    await waitFor(() => expect(within(panel).queryByText(SECURITY.name)).not.toBeInTheDocument());
    expect(within(panel).getByText(PLUMBING.name)).toBeInTheDocument();
  });

  it("deleting the category the draft had just picked falls back to Uncategorized", async () => {
    const { onChange } = renderPicker({ value: SECURITY.id, valueName: SECURITY.name });
    const panel = await openManage();

    await userEvent.click(within(panel).getByRole("button", { name: `Delete ${SECURITY.name}` }));

    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ categoryId: null, category: "" }));
  });

  it("Done closes the panel", async () => {
    renderPicker();
    const panel = await openManage();

    await userEvent.click(within(panel).getByRole("button", { name: /^done$/i }));

    expect(screen.queryByRole("group", { name: /manage categories/i })).not.toBeInTheDocument();
  });
});
