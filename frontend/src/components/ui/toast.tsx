import * as React from "react"
import * as ToastPrimitives from "@radix-ui/react-toast"
import { cva, type VariantProps } from "class-variance-authority"
import { X } from "lucide-react"

import { cn } from "@/lib/utils"

/* =============================================================================
   Toast - W2/8 `tone`.
   -----------------------------------------------------------------------------
   Program plan section 2a.11 schedules `variant="destructive"` -> `tone=
   "danger"` for this file, marked "primitive-internal" - the ~100 real call
   sites across src/ (grepped: components/, pages/, lib/api/, stores/) never
   render `<Toast variant=...>` JSX directly, they call the exported
   `toast({ ..., variant: 'destructive' })` FUNCTION (use-toast.ts), whose
   return value toaster.tsx spreads onto `<Toast {...props}>` unseen by any
   of them. So the only place this primitive's `variant` prop is ever written
   as a literal is toaster.tsx, inside components/ui/ - in scope here, but
   left untouched below since it already forwards whatever the caller passed
   and needs no change to keep working.

   `toastVariants`'s own `variant` cva block (below) is intentionally NOT
   re-keyed onto `tone`. Its `"destructive"` VALUE is not just a colour name:
   it is a literal CSS class every toast root carries (`"destructive group
   border-danger ..."`), and ToastAction / ToastClose further down this same
   file key their own danger-state styling off it via `group-[.destructive]:`
   compound selectors. Renaming or dropping that class string would silently
   break those two components' hover/focus treatment - out of scope for a
   `variant`/`tone` prop rename, so the internal cva bucket keeps the literal
   name `destructive`. That is purely an internal-class-string constraint,
   though, and does not license leaving the PUBLIC `variant` prop value
   undeprecated - VOCAB_V3's closed-variant rule ("destructive is NOT a
   variant value anywhere in the codebase ... must be converted to the closed
   variant list plus tone=\"danger\"") applies to this file exactly as it
   does to Badge/ConfirmDialog/DropdownMenuItem, all touched the same way
   this same session. `tone="danger"` is the new, preferred prop, resolving
   to the exact same `variant: "destructive"` cell (and therefore the exact
   same class string, `group-[.destructive]` included) rather than inventing
   a second, parallel colour system. `variant="destructive"` is now a
   @deprecated alias on the public prop type below - see its own doc comment
   - kept fully working (byte-identical render, the same "old spelling never
   breaks" contract every sibling primitive in this session honours) so the
   ~100 real `toast({ variant: 'destructive' })` call sites this file cannot
   see are never broken. `tone` wins whenever both are passed.
   ============================================================================= */

const ToastProvider = ToastPrimitives.Provider

const ToastViewport = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Viewport>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Viewport
    ref={ref}
    className={cn(
      "fixed top-0 z-[100] flex max-h-screen w-full flex-col-reverse p-4 sm:bottom-0 sm:right-0 sm:top-auto sm:flex-col md:max-w-[420px]",
      className
    )}
    {...props}
  />
))
ToastViewport.displayName = ToastPrimitives.Viewport.displayName

const toastVariants = cva(
  "group pointer-events-auto relative flex w-full items-center justify-between space-x-4 overflow-hidden rounded-md border p-6 pr-8 shadow-lg transition-all data-[swipe=cancel]:translate-x-0 data-[swipe=end]:translate-x-[var(--radix-toast-swipe-end-x)] data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)] data-[swipe=move]:transition-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full",
  {
    variants: {
      variant: {
        default: "border border-border bg-surface-light text-text-primary",
        destructive:
          "destructive group border-danger bg-danger text-on-fill",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/** Semantic colour. `danger` resolves to the same cell `variant="destructive"` does - see the header note above. */
export type ToastTone = "danger"

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Root> &
    Omit<VariantProps<typeof toastVariants>, "variant"> & {
      /**
       * Structure + colour, closed to `"default"`, plus one retired name.
       *
       * @deprecated `destructive` is retired as a public variant value -
       * the closed-variant rule ("`destructive` is NOT a variant value
       * anywhere in the codebase", program plan section 2a) decomposes it
       * into `tone="danger"` (see `tone`'s own doc comment below). Kept
       * working, byte-identical - same `toastVariants({ variant:
       * "destructive" })` cell, same literal `destructive` class the
       * `group-[.destructive]` selectors on ToastAction/ToastClose depend
       * on (see the file header note) - the same "old spelling never
       * breaks" contract every sibling primitive touched this session
       * honours (Badge, ConfirmDialog, DropdownMenuItem). Write
       * `tone="danger"` instead for new call sites; `tone` wins whenever
       * both are passed.
       */
      variant?: VariantProps<typeof toastVariants>["variant"]
      /**
       * Semantic colour, the vocabulary's preferred entry point for this
       * axis - see the header note above. Resolves to the exact same cell
       * the deprecated `variant="destructive"` does; wins over `variant`
       * whenever both are passed.
       */
      tone?: ToastTone
    }
>(({ className, variant, tone, ...props }, ref) => {
  const resolvedVariant = tone === "danger" ? "destructive" : variant
  return (
    <ToastPrimitives.Root
      ref={ref}
      className={cn(toastVariants({ variant: resolvedVariant }), className)}
      {...props}
    />
  )
})
Toast.displayName = ToastPrimitives.Root.displayName

const ToastAction = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Action>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Action>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Action
    ref={ref}
    className={cn(
      "inline-flex h-8 shrink-0 items-center justify-center rounded-control border bg-transparent px-3 text-sm font-medium ring-offset-surface-light transition-colors hover:bg-background-light focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 group-[.destructive]:border-on-fill/40 group-[.destructive]:hover:border-on-fill/30 group-[.destructive]:hover:bg-danger group-[.destructive]:hover:text-on-fill group-[.destructive]:focus:ring-on-fill",
      className
    )}
    {...props}
  />
))
ToastAction.displayName = ToastPrimitives.Action.displayName

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Close
    ref={ref}
    className={cn(
      "absolute right-2 top-2 rounded-control p-1 text-text-primary/50 opacity-0 transition-opacity hover:text-text-primary focus:opacity-100 focus:outline-none focus:ring-2 group-hover:opacity-100 group-[.destructive]:text-on-fill/70 group-[.destructive]:hover:text-on-fill group-[.destructive]:focus:ring-on-fill/60 group-[.destructive]:focus:ring-offset-danger",
      className
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitives.Close>
))
ToastClose.displayName = ToastPrimitives.Close.displayName

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Title
    ref={ref}
    className={cn("text-sm font-semibold", className)}
    {...props}
  />
))
ToastTitle.displayName = ToastPrimitives.Title.displayName

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitives.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitives.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitives.Description
    ref={ref}
    className={cn("text-sm opacity-90", className)}
    {...props}
  />
))
ToastDescription.displayName = ToastPrimitives.Description.displayName

type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

type ToastActionElement = React.ReactElement<typeof ToastAction>

export {
  type ToastProps,
  type ToastActionElement,
  ToastProvider,
  ToastViewport,
  Toast,
  ToastTitle,
  ToastDescription,
  ToastClose,
  ToastAction,
  toastVariants,
}
