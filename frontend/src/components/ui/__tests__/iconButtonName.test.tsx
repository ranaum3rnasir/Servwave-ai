import * as React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { X } from "lucide-react";

import { Button as KitButton } from "@/ui-kit/components/ui/button";
import { Button as LegacyButton } from "@/components/ui/button";

/**
 * Mobile slice 25 (rubric A11Y-03): an icon-only button must carry an accessible name, and the
 * TYPE CHECK is what enforces it. `size="icon"` / `size="icon-sm"` buttons have no visible text,
 * so a screen reader announces them as just "button" unless they have `aria-label` or
 * `aria-labelledby`.
 *
 * The `@ts-expect-error` lines below are the test: `npx tsc --noEmit` (CI's frontend type-check)
 * fails with "Unused '@ts-expect-error' directive" if an unnamed icon button ever type-checks
 * again. The runtime assertions only prove the named forms still render a named button.
 */
describe("icon-only buttons need a name (type level)", () => {
  it("the kit Button rejects size icon / icon-sm without aria-label or aria-labelledby", () => {
    const unnamed = () => (
      <>
        {/* @ts-expect-error - an icon-only kit button with no accessible name */}
        <KitButton size="icon"><X /></KitButton>
        {/* @ts-expect-error - an icon-only kit button with no accessible name */}
        <KitButton size="icon-sm" variant="ghost"><X /></KitButton>
      </>
    );
    expect(typeof unnamed).toBe("function");
  });

  it("the legacy Button rejects size icon without aria-label or aria-labelledby", () => {
    const unnamed = () => (
      <>
        {/* @ts-expect-error - an icon-only legacy button with no accessible name */}
        <LegacyButton size="icon" variant="ghost"><X /></LegacyButton>
      </>
    );
    expect(typeof unnamed).toBe("function");
  });

  it("named icon buttons and text buttons type-check and render with a name", () => {
    render(
      <>
        <KitButton size="icon" aria-label="Remove tag"><X /></KitButton>
        <span id="lbl">Close panel</span>
        <KitButton size="icon-sm" aria-labelledby="lbl"><X /></KitButton>
        <LegacyButton size="icon" aria-label="Dismiss"><X /></LegacyButton>
        <KitButton size="sm">Save</KitButton>
        <LegacyButton>Cancel</LegacyButton>
      </>,
    );
    expect(screen.getByRole("button", { name: "Remove tag" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close panel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });
});
