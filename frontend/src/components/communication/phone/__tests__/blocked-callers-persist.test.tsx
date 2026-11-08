// SRVW-98: the Blocked callers tab used to mutate React state only, so a block
// vanished on reload, and the copy promised automatic carrier-level blocking
// that no code anywhere delivered. These pin the three things that must stay
// true: rows render from the server's E.164 form, the copy claims nothing
// automatic, and the modal's Block gate matches the server's own rule.
//
// Co-located here deliberately - this directory IS in the tsc program
// (frontend/tsconfig.json excludes only the top-level src/__tests__), so the
// file also guards prop-contract drift.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BlockedCallersView } from "../BlockedCallersView";
import type { BlockedNumber } from "@/lib/api/communication";

// The view renders `blockedAt` on the ORG's clock, so it reads the org query. This
// spec renders it bare (no QueryClientProvider), hence the stub.
vi.mock("@/lib/api/organization", () => ({
  useOrganization: () => ({ data: { timezone: "America/New_York" } }),
}));

const ROW: BlockedNumber = {
  id: "b1000000-0000-0000-0000-000000000001",
  number: "+13475550188",
  reason: "spam",
  blockedAt: "2026-08-01T10:00:00.000Z",
  blockedBy: "Test Admin",
};

function renderView(blocked: BlockedNumber[]) {
  const onBlock = vi.fn();
  const onUnblock = vi.fn();
  render(
    <BlockedCallersView blocked={blocked} onBlock={onBlock} onUnblock={onUnblock} />,
  );
  return { onBlock, onUnblock };
}

describe("BlockedCallersView", () => {
  it("renders an E.164 row in display form", () => {
    renderView([ROW]);
    expect(screen.getByText("(347) 555-0188")).toBeInTheDocument();
  });

  it.each([
    ["a populated list", [ROW]],
    ["an empty list", [] as BlockedNumber[]],
  ])("makes no automatic-blocking claim with %s", (_label, blocked) => {
    const { container } = render(
      <BlockedCallersView blocked={blocked} onBlock={vi.fn()} onUnblock={vi.fn()} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("automatically");
    expect(text).not.toContain("Auto-blocked");
  });

  it("hands the row id back to the shell on Unblock", async () => {
    const user = userEvent.setup();
    const { onUnblock } = renderView([ROW]);

    await user.click(screen.getByRole("button", { name: /unblock/i }));

    expect(onUnblock).toHaveBeenCalledWith(ROW.id);
  });
});

describe("BlockNumberModal", () => {
  it("keeps Block disabled for a number the server would 400", async () => {
    const user = userEvent.setup();
    renderView([]);

    await user.click(screen.getByRole("button", { name: /block a number/i }));
    const input = screen.getByPlaceholderText("(212) 555-0123");
    const submit = screen.getByRole("button", { name: /block number/i });

    // 7 digits: no area code, so it could never match an inbound E.164 caller.
    await user.type(input, "555-0188");
    expect(submit).toBeDisabled();

    await user.clear(input);
    await user.type(input, "(347) 555-0188");
    expect(submit).toBeEnabled();
  });
});
