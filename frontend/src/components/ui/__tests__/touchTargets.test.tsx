import * as React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { X } from "lucide-react";

import { Button as KitButton } from "@/ui-kit/components/ui/button";
import { Checkbox as KitCheckbox } from "@/ui-kit/components/ui/checkbox";
import { Switch as KitSwitch } from "@/ui-kit/components/ui/switch";
import { Dialog as KitDialog, DialogContent as KitDialogContent, DialogTitle as KitDialogTitle } from "@/ui-kit/components/ui/dialog";
import { Sheet as KitSheet, SheetContent as KitSheetContent, SheetTitle as KitSheetTitle } from "@/ui-kit/components/ui/sheet";
import { Button as LegacyButton } from "@/components/ui/button";
import { Checkbox as LegacyCheckbox } from "@/components/ui/checkbox";
import { Switch as LegacySwitch } from "@/components/ui/switch";
import { Dialog as LegacyDialog, DialogContent as LegacyDialogContent, DialogTitle as LegacyDialogTitle } from "@/components/ui/dialog";
import { Sheet as LegacySheet, SheetContent as LegacySheetContent, SheetTitle as LegacySheetTitle } from "@/components/ui/sheet";

/**
 * Mobile slice 25 (rubric TOUCH-01, TOUCH-02): on a coarse pointer (the `touch:` variant,
 * `@media (pointer: coarse)`) the small shared controls reach 44 px; where the visual must stay
 * small (a 16 px checkbox, a 22 px switch) the HIT AREA grows instead, with negative margins so
 * the layout keeps its footprint. With a fine pointer every control keeps its visual size, and the
 * sub-24 px ones (checkbox, switch) get an invisible 24 px hit area (WCAG 2.5.8).
 *
 * jsdom cannot evaluate media queries, so these pin the classes; the mobile gate
 * (frontend/e2e/mobile, `targets` check) measures the real boxes on the six devices.
 */
const tokens = (el: Element) => new Set((el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
const expectTokens = (el: Element, want: string[]) => {
  const have = tokens(el);
  expect(want.filter((t) => !have.has(t))).toEqual([]);
};

describe("buttons reach 44 px on touch, desktop sizes unchanged", () => {
  it("kit Button: icon, icon-sm and sm grow on touch only", () => {
    render(
      <>
        <KitButton size="icon" aria-label="a"><X /></KitButton>
        <KitButton size="icon-sm" aria-label="b"><X /></KitButton>
        <KitButton size="sm">c</KitButton>
        <KitButton>d</KitButton>
      </>,
    );
    expectTokens(screen.getByRole("button", { name: "a" }), ["size-10", "touch:size-11"]);
    expectTokens(screen.getByRole("button", { name: "b" }), ["size-8.5", "touch:size-11"]);
    expectTokens(screen.getByRole("button", { name: "c" }), ["h-8.5", "touch:h-11", "touch:min-w-11"]);
    // The default size is not one of the small sizes: nothing touch-only on it.
    expect([...tokens(screen.getByRole("button", { name: "d" }))].filter((t) => t.startsWith("touch:"))).toEqual([]);
  });

  it("a call site's own small size still loses to the touch size (touch: is emitted later)", () => {
    render(<KitButton size="icon-sm" aria-label="x" className="size-6"><X /></KitButton>);
    expectTokens(screen.getByRole("button", { name: "x" }), ["size-6", "touch:size-11"]);
  });

  it("legacy Button: icon and sm grow on touch only", () => {
    render(
      <>
        <LegacyButton size="icon" aria-label="a"><X /></LegacyButton>
        <LegacyButton size="sm">b</LegacyButton>
      </>,
    );
    expectTokens(screen.getByRole("button", { name: "a" }), ["h-10", "w-10", "touch:size-11"]);
    expectTokens(screen.getByRole("button", { name: "b" }), ["h-9", "touch:h-11", "touch:min-w-11"]);
  });
});

describe("checkbox and switch: the hit area grows, the visual does not", () => {
  for (const [name, Checkbox] of [["kit", KitCheckbox], ["legacy", LegacyCheckbox]] as const) {
    it(`${name} Checkbox: 24 px hit area with a fine pointer, 44 px on touch, a 16 px box inside`, () => {
      render(<Checkbox aria-label="Taxable" />);
      const root = screen.getByRole("checkbox", { name: "Taxable" });
      // The footprint stays 16 px: the margins take back exactly what the hit area adds.
      expectTokens(root, ["size-6", "-m-1", "touch:size-11", "touch:-m-3.5"]);
      const box = root.querySelector('[data-slot="checkbox-box"]');
      expect(box).not.toBeNull();
      expectTokens(box!, ["size-4"]);
    });
  }

  it("kit Switch: the 38x22 track sits in a 24 px hit area, 44 px tall on touch", () => {
    render(<KitSwitch aria-label="Visible" />);
    const root = screen.getByRole("switch", { name: "Visible" });
    expectTokens(root, ["h-6", "-my-px", "touch:h-11", "touch:-my-[11px]", "touch:w-11", "touch:-mx-[3px]"]);
    const track = root.querySelector('[data-slot="switch-track"]');
    expect(track).not.toBeNull();
    expectTokens(track!, ["h-5.5", "w-9.5"]);
  });

  it("legacy Switch path is the kit Switch (payments W2: one switch everywhere)", () => {
    render(<LegacySwitch aria-label="Visible" />);
    const root = screen.getByRole("switch", { name: "Visible" });
    expectTokens(root, ["h-6", "-my-px", "touch:h-11", "touch:-my-[11px]", "touch:w-11", "touch:-mx-[3px]"]);
    const track = root.querySelector('[data-slot="switch-track"]');
    expect(track).not.toBeNull();
    expectTokens(track!, ["h-5.5", "w-9.5"]);
  });
});

describe("dialog and sheet close buttons: named, 44 px on touch", () => {
  it("kit Dialog close", () => {
    render(
      <KitDialog open>
        <KitDialogContent aria-describedby={undefined}><KitDialogTitle>T</KitDialogTitle></KitDialogContent>
      </KitDialog>,
    );
    expectTokens(screen.getByRole("button", { name: "Close" }), ["size-8", "touch:size-11"]);
    expect(screen.getByRole("button", { name: "Close" }).getAttribute("aria-label")).toBe("Close");
  });

  it("legacy Dialog close", () => {
    render(
      <LegacyDialog open>
        <LegacyDialogContent aria-describedby={undefined}><LegacyDialogTitle>T</LegacyDialogTitle></LegacyDialogContent>
      </LegacyDialog>,
    );
    expectTokens(screen.getByRole("button", { name: "Close" }), ["size-8", "touch:size-11"]);
    expect(screen.getByRole("button", { name: "Close" }).getAttribute("aria-label")).toBe("Close");
  });

  it("kit Sheet close", () => {
    render(
      <KitSheet open>
        <KitSheetContent aria-describedby={undefined}><KitSheetTitle>T</KitSheetTitle></KitSheetContent>
      </KitSheet>,
    );
    expectTokens(screen.getByRole("button", { name: "Close" }), ["size-8", "touch:size-11"]);
    expect(screen.getByRole("button", { name: "Close" }).getAttribute("aria-label")).toBe("Close");
  });

  it("legacy Sheet close", () => {
    render(
      <LegacySheet open>
        <LegacySheetContent aria-describedby={undefined}><LegacySheetTitle>T</LegacySheetTitle></LegacySheetContent>
      </LegacySheet>,
    );
    expectTokens(screen.getByRole("button", { name: "Close" }), ["touch:size-11"]);
    expect(screen.getByRole("button", { name: "Close" }).getAttribute("aria-label")).toBe("Close");
  });
});
