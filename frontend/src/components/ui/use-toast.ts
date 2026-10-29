import * as React from "react"
import { toast as kitToast } from "@/ui-kit/components/ui/sonner"

import type {
  ToastActionElement,
  ToastProps,
} from "@/components/ui/toast"

/**
 * The older toast API, kept as a thin adapter (mobile slice 27).
 *
 * About 77 call sites use `toast({ title, description, variant, duration, action })` and
 * `useToast()`, including the global rate-limit, plan and server-error toasts in `lib/axios.ts`.
 * Rather than migrate them, every call is forwarded to the ONE surviving toaster (the kit's, in
 * `ui-kit/components/ui/sonner`), which is mounted once in `App.tsx`. This file has no store, no
 * timers and no mount of its own, so there is nothing to get out of step with the other API.
 *
 * Mapping:
 *   - `title` is the toast's message; `description` its second line. A description-only call
 *     (the common "Text sent to ...") shows as the message.
 *   - `variant: "destructive"` / `tone: "danger"` is an error toast.
 *   - `duration: Infinity` stays until closed; a number is honoured; otherwise the toaster default.
 *   - `action` is the `<ToastAction>` element callers already build; only its label and
 *     `onClick` are read, because the element itself is a Radix part that cannot render outside
 *     a Radix provider.
 *   - `open: false` dismisses (callers that passed an initial `open`); `onOpenChange(false)` fires
 *     when the toast goes away by any route.
 */

type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
}

type Toast = Omit<ToasterToast, "id">

type ActionLike = { props?: { children?: React.ReactNode; onClick?: (e: React.MouseEvent) => void } }

function toAction(action: ToastActionElement | undefined) {
  const props = (action as unknown as ActionLike | undefined)?.props
  if (!props) return undefined
  return {
    label: props.children,
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => props.onClick?.(e),
  }
}

function buildOptions(props: Toast) {
  const { title, description, duration, action, onOpenChange } = props
  // A description-only toast shows its text as the message, not as a second line under nothing.
  const message = title ?? description
  const secondLine = title != null ? description : undefined
  const close = () => onOpenChange?.(false)
  return {
    message: message as React.ReactNode,
    options: {
      description: secondLine,
      duration: typeof duration === "number" ? duration : undefined,
      action: toAction(action),
      onDismiss: close,
      onAutoClose: close,
    },
  }
}

function show(props: Toast, id?: string | number) {
  const { message, options } = buildOptions(props)
  const isError = props.tone === "danger" || props.variant === "destructive"
  const opts = { ...options, ...(id !== undefined ? { id } : {}) }
  return isError ? kitToast.error(message, opts) : kitToast(message, opts)
}

function toast({ ...props }: Toast) {
  const id = show(props)
  const dismiss = () => {
    kitToast.dismiss(id)
  }
  const update = (next: Partial<ToasterToast>) => {
    show({ ...props, ...next } as Toast, id)
  }
  if (props.open === false) dismiss()
  return { id: String(id), dismiss, update }
}

function useToast() {
  return {
    // The list lives in the toaster now; nothing reads it from here.
    toasts: [] as ToasterToast[],
    toast,
    dismiss: (toastId?: string) => {
      kitToast.dismiss(toastId === undefined ? undefined : Number.isNaN(Number(toastId)) ? toastId : Number(toastId))
    },
  }
}

export { useToast, toast }
