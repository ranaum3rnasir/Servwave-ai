"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

/**
 * cmdk list. Powers the Combobox and, later, the ⌘K palette.
 *
 * Worth the dependency for the filtering + keyboard model: it scores matches,
 * keeps the highlight on the best result as you type, and skips group headers
 * when arrowing - all things a naive `.filter()` gets wrong the moment a list
 * has sections.
 */
function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn("bg-kit-popover text-kit-popover-foreground flex w-full flex-col overflow-hidden rounded-lg", className)}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex h-10 items-center gap-2 border-b px-3">
      <Search className="text-subtle-foreground size-4 shrink-0" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "placeholder:text-subtle-foreground flex h-full w-full bg-transparent text-sm outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-64 scroll-py-1 overflow-x-hidden overflow-y-auto overscroll-contain p-1.5", className)}
      {...props}
    />
  );
}

function CommandEmpty({ ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="text-muted-foreground py-6 text-center text-[13px]"
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "text-foreground overflow-hidden",
        "[&_[cmdk-group-heading]]:text-subtle-foreground [&_[cmdk-group-heading]]:px-2.5",
        "[&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1",
        "[&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-bold",
        "[&_[cmdk-group-heading]]:tracking-[0.07em] [&_[cmdk-group-heading]]:uppercase",
        className,
      )}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2",
        "text-[13px] font-medium outline-none select-none",
        "data-[selected=true]:bg-muted data-[selected=true]:text-foreground",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("bg-border -mx-1.5 my-1.5 h-px", className)}
      {...props}
    />
  );
}

export {
  Command, CommandInput, CommandList, CommandEmpty,
  CommandGroup, CommandItem, CommandSeparator,
};
