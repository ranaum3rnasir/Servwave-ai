import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Button as KitButton } from "@/ui-kit/components/ui/button";
import { Button as LegacyButton } from "@/components/ui/button";

/**
 * Mobile slice 40 (rubric TOUCH-05): a disabled button can carry a reason, and on touch the reason
 * is reachable by TAPPING the button, not only by hovering a title. A disabled button swallows
 * pointer events (`pointer-events-none`), so the tap lands on the shell around it. These tests
 * tap that shell the way a finger would: a click on the disabled button's parent.
 */
const REASON = "Select 25 or fewer invoices to send";

const kinds = [
  ["kit Button", KitButton],
  ["legacy Button", LegacyButton],
] as const;

describe.each(kinds)("%s disabledReason", (_name, Button) => {
  it("tapping a disabled button with a reason shows the reason as visible helper text", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled disabledReason={REASON} onClick={onClick}>
        Send
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    expect(screen.queryByRole("status")).toBeNull();

    // The disabled button gets no events; the tap reaches its shell.
    fireEvent.click(button.parentElement as HTMLElement);

    expect((await screen.findByRole("status")).textContent).toBe(REASON);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps the reason on hover (title on the shell) and as the button's description", () => {
    render(
      <Button disabled disabledReason={REASON}>
        Send
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    expect((button.parentElement as HTMLElement).getAttribute("title")).toBe(REASON);
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
    expect(button).toHaveProperty("disabled", true);
    const describedBy = document.getElementById(button.getAttribute("aria-describedby") as string);
    expect(describedBy?.textContent).toBe(REASON);
  });

  it("the shell opens from the keyboard too", async () => {
    render(
      <Button disabled disabledReason={REASON}>
        Send
      </Button>,
    );
    const shell = screen.getByRole("button", { name: "Send" }).parentElement as HTMLElement;
    fireEvent.keyDown(shell, { key: "Enter" });
    expect((await screen.findByRole("status")).textContent).toBe(REASON);
  });

  it("a second tap closes the explanation again", async () => {
    render(
      <Button disabled disabledReason={REASON}>
        Send
      </Button>,
    );
    const shell = screen.getByRole("button", { name: "Send" }).parentElement as HTMLElement;
    fireEvent.click(shell);
    await screen.findByRole("status");
    fireEvent.click(shell);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("an enabled button ignores the reason: no shell, no title, it just clicks", () => {
    const onClick = vi.fn();
    render(
      <Button disabledReason={REASON} onClick={onClick}>
        Send
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    expect(button.parentElement?.hasAttribute("title")).toBe(false);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a disabled button without a reason renders exactly as before", () => {
    render(<Button disabled>Send</Button>);
    const button = screen.getByRole("button", { name: "Send" });
    expect(button.parentElement?.hasAttribute("data-disabled-reason-shell")).toBe(false);
  });
});
