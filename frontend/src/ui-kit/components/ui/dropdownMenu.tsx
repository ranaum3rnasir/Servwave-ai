"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Circle } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * Radix owns the roving-focus model here, and that is the whole reason not to
 * hand-roll this: arrow keys, Home/End, type-ahead, submenu timing, and
 * closing on outside click without swallowing the click that closed it. Each
 * is easy to approximate and easy to get subtly wrong.
 */
const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const contentClasses = [
  // `overflow-x-hidden`, not `overflow-hidden`: paired with the `overflow-y-auto`
  // on the next line the two would be a same-property conflict decided by
  // stylesheet order rather than by this file, and the menu's ability to scroll
  // is not something to leave to a coin toss.
  "bg-kit-popover text-kit-popover-foreground z-floating min-w-[13rem] overflow-x-hidden rounded-lg border p-1.5 shadow-popover",
  "max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto",
  "origin-[var(--radix-dropdown-menu-content-transform-origin)]",
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
];

const itemClasses = [
  "relative flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2",
  "text-[13px] font-medium outline-none select-none transition-colors",
  "focus:bg-muted data-[highlighted]:bg-muted",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
  "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
  // Destructive items tint on highlight, so the danger reads before the click.
  "data-[variant=destructive]:text-destructive data-[variant=destructive]:[&_svg]:text-destructive",
  "data-[variant=destructive]:data-[highlighted]:bg-status-red-subtle",
];

function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = "end",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        collisionPadding={10}
        className={cn(contentClasses, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: "default" | "destructive";
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      className={cn(itemClasses, className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      checked={checked}
      className={cn(itemClasses, "pl-8", className)}
      {...props}
    >
      <span className="absolute left-2.5 grid size-4 place-items-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-3.5 stroke-[3] !text-brand" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(itemClasses, "pl-8", className)}
      {...props}
    >
      <span className="absolute left-2.5 grid size-4 place-items-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Circle className="size-2 fill-brand !text-brand" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn(
        "text-subtle-foreground px-2.5 pt-1.5 pb-1 text-[10.5px] font-bold tracking-[0.07em] uppercase",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("bg-border -mx-0.5 my-1.5 h-px", className)}
      {...props}
    />
  );
}

/** Right-aligned shortcut hint. Never the only signal for an action. */
function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("text-subtle-foreground ml-auto text-[11px] font-semibold tracking-wide", className)}
      {...props}
    />
  );
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(itemClasses, "data-[state=open]:bg-muted", className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-4" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(contentClasses, "origin-[var(--radix-dropdown-menu-content-transform-origin)]", className)}
      {...props}
    />
  );
}

export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut,
  DropdownMenuGroup, DropdownMenuPortal, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger,
};
