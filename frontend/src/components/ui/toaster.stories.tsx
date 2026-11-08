/* =============================================================================
   Toaster - Storybook stories, full-coverage pass (Storybook phase, W2 plan).

   Storybook 8 is scaffolded now (.storybook/main.ts, .storybook/preview.ts,
   the @storybook/react-vite devDependency in package.json) - this file
   imports the real `Meta` / `StoryObj` types from `@storybook/react` and
   wires `argTypes` so every axis is a live control in the Storybook UI,
   matching badge.stories.tsx / dialog.stories.tsx / checkbox.stories.tsx.

   COVERAGE REQUIREMENT AND WHY THIS FILE LOOKS THE WAY IT DOES.

   toaster.tsx itself ships NO cva() block and NO props at all - `Toaster` is
   a zero-argument function component that reads `useToast()`'s shared state
   and maps it onto `<Toast>`. So, read narrowly, the completeness pass has
   zero keys and zero values to check against this specific file - the same
   "no cva -> vacuously satisfied" situation checkbox.stories.tsx documents
   for checkbox.tsx.

   But `Toaster` is not a decorative wrapper the way an empty-cva primitive
   normally is: it is the ONLY application call site that renders `Toast` -
   grep confirms it, every real feature/page importer of `./toast` (outside
   this session's own `.stories.tsx` files) reaches it only through
   `toaster.tsx` - and it is mounted exactly ONCE, at `App.tsx:286`. Every
   toast the product ever shows a user renders through this component. So
   the meaningful coverage question for "Toaster" is not "does Toaster have
   variants" (it doesn't) but "does every value of the variant it renders -
   `toastVariants` in toast.tsx, `variant: default | destructive` - actually
   get exercised through it." toast.stories.tsx (this file's sibling) already
   covers that cva block directly against the raw `Toast`/`ToastProvider`/
   `ToastViewport` primitives, which satisfies the completeness pass on its
   own; this file covers the same two values again, deliberately, but through
   the real composed path (`Toaster` + the `toast()` singleton call) rather
   than the raw primitives, since that composed path is what this specific
   file was assigned to story and is what a designer debugging a real toast
   actually sees, matching real production call shapes:

     variant="default"      no-op call sites just pass `description` (see
       ScopeOfWorkCard.tsx undo-toast, and the `Default` story below, which
       reproduces the exact shape src/__tests__/toast-autodismiss.test.tsx
       asserts on: `toast({ description: 'Text sent to Acme' })`).
     variant="destructive"  every error-path call site (SendInvoiceDialog.tsx:112,
       SendEstimateDialog.tsx:159, PurchaseOrdersPage.tsx)
       pairs it with `duration: Infinity` so the error stays up until the user
       dismisses it - reproduced in the `Destructive` story below.

   `toast()` (use-toast.ts) is an imperative, module-level singleton call -
   not a prop `<Toaster>` itself accepts. So "wire argTypes to the real prop
   type" here means: the Controls panel drives the arguments of that real
   `toast()` call (title/description/variant), not a prop on the `Toaster`
   JSX element (which takes none). `Default`/`WithTitleAndDescription`/
   `Destructive`/`DestructiveTitleOnly` share one `LiveToastDemo` render that
   re-fires `toast()` on every control change (dismissing the previous demo
   toast first), so flipping `variant` in the Controls panel replaces the
   visible toast live, the same way Dialog's `size`/`pad`/`gap` controls
   redraw its open dialog live.

   KNOWN LIMITATION, WORTH RECORDING RATHER THAN DISCOVERING BY SURPRISE.
   `memoryState` (use-toast.ts) is one JS-module-level singleton, not a React
   context scoped per component tree - by design, since the real app mounts
   exactly one `<Toaster/>` for the whole page. Every `<Toaster/>` instance in
   this file's stories subscribes to and renders that same shared array. On
   Storybook's single-story Canvas tab (how a designer normally browses -
   one story mounted at a time, unmounted when you pick another) this is
   invisible, and each story's own unmount cleanup below dismisses its own
   toast so it does not "follow" the next story you open. On the combined
   Docs/autodocs page, where several stories' canvases can be mounted at
   once, a toast fired in one block can appear in another block's `<Toaster/>`
   too - that is this primitive's real, tested architecture (see
   src/__tests__/toast-autodismiss.test.tsx's own comment on why it needs
   `vi.resetModules()` per test to get an isolated instance), not a story
   authoring bug.

   `duration: Infinity` is used through most of these stories so a toast
   stays up while a designer inspects the canvas or flips a control, rather
   than racing the real 4-second auto-dismiss timer (TOAST_AUTO_DISMISS in
   use-toast.ts). `AutoDismiss` is the one story that deliberately leaves
   `duration` unset, to show that real default timing on its own.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';
import * as React from 'react';

import { Toaster } from './toaster';
import { toast } from './use-toast';
import { ToastAction } from './toast';
import { Button } from './button';
import { Inline } from './inline';

type ToastVariant = 'default' | 'destructive';
const VARIANTS: ToastVariant[] = ['default', 'destructive'];

/** The args every `LiveToastDemo`-backed story drives through the real `toast()` call. */
type StoryArgs = {
  variant: ToastVariant;
  title: string;
  description: string;
};

/**
 * Fires `toast({ variant, title, description })` whenever those three args
 * change, replacing the previous demo toast (the effect's cleanup dismisses
 * it before the next call, and again on unmount) - see the header note on
 * why this is how a designer gets "live" controls over an imperative,
 * singleton-backed primitive instead of a declarative prop on `<Toaster>`.
 */
function LiveToastDemo({ variant, title, description }: StoryArgs) {
  const handleRef = React.useRef<ReturnType<typeof toast> | null>(null);

  React.useEffect(() => {
    handleRef.current = toast({
      title: title || undefined,
      description: description || undefined,
      variant,
      duration: Infinity,
    });
    return () => {
      handleRef.current?.dismiss();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, title, description]);

  return <Toaster />;
}

const meta = {
  title: 'UI/Toaster',
  component: Toaster,
  tags: ['autodocs'],
  parameters: {
    // ToastViewport is fixed-positioned at a screen corner (toast.tsx) - the
    // default padded/centered canvas letterboxes that, same reasoning as
    // dialog.stories.tsx's Dialog meta.
    layout: 'fullscreen',
  },
  args: {
    variant: 'default',
    title: '',
    description: 'Text sent to Acme',
  },
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: VARIANTS,
      description:
        'toast.tsx\'s own `toastVariants` cva key - the only colour axis this primitive ships (no `tone`/`size`/`gap`/`pad`; not part of this session\'s measured demand, program plan section 1h). Not a prop on `Toaster` itself (it takes none) - drives the `variant` argument of the real `toast()` call this story fires.',
    },
    title: {
      control: { type: 'text' },
      description:
        'Optional. Real call sites often omit it entirely (toaster.tsx only renders `ToastTitle` when truthy) - see the `Default` story below for the title-less shape.',
    },
    description: {
      control: { type: 'text' },
      description:
        'Optional. Some real error-path call sites (PurchaseOrdersPage.tsx) pass only `title` and skip this - see `DestructiveTitleOnly`.',
    },
  },
  render: (args: StoryArgs) => <LiveToastDemo {...args} />,
} satisfies Meta<StoryArgs>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * `variant="default"`, description only, no title - the exact shape
 * src/__tests__/toast-autodismiss.test.tsx asserts on
 * (`toast({ description: 'Text sent to Acme' })`) and the shape
 * ScopeOfWorkCard.tsx's own undo-toast title/description pairing simplifies
 * from. Flip the controls above the canvas to see any variant/title/
 * description combination live.
 */
export const Default: Story = {
  args: {
    variant: 'default',
    title: '',
    description: 'Text sent to Acme',
  },
};

/**
 * `variant="default"` with both `title` and `description` set - matches
 * SendInvoiceDialog.tsx:108's real success copy
 * (`toast({ title: 'Invoice sent', description: '...has been emailed...' })`).
 */
export const WithTitleAndDescription: Story = {
  args: {
    variant: 'default',
    title: 'Invoice sent',
    description: 'I00042 has been emailed to the customer.',
  },
};

/**
 * `variant="destructive"` - the solid danger fill (toastVariants' second and
 * last cva value). Matches SendEstimateDialog.tsx:159's real error copy,
 * which also pairs this variant with `duration: Infinity` in production so
 * the failure stays up until the user closes it - reproduced here too.
 */
export const Destructive: Story = {
  args: {
    variant: 'destructive',
    title: 'Estimate not sent',
    description: 'Failed to send the estimate. Check the recipient email and try again.',
  },
};

/**
 * `variant="destructive"` with no `description` - matches
 * PurchaseOrdersPage.tsx's real shape
 * (`toast({ title: extractApiError(...), variant: 'destructive' })`), which
 * passes only a `title`. Distinct from `Default`'s description-only shape -
 * between the two, both of `ToastTitle`/`ToastDescription`'s optionality is
 * covered.
 */
export const DestructiveTitleOnly: Story = {
  args: {
    variant: 'destructive',
    title: 'Failed to convert the reservation',
    description: '',
  },
};

/**
 * `action` - a `ToastAction` button rendered inside the toast, dismissed by
 * the same click that undoes the action it names. Matches
 * ScopeOfWorkCard.tsx:487-495's real "Undo remove" toast exactly (line
 * removed from a job's scope of work, restorable for a few seconds).
 * Deliberately its own `render`, not routed through `LiveToastDemo` - the
 * click target this story exists to show is the trigger button, not a
 * Controls-panel-driven auto-fire on mount.
 */
export const WithAction: Story = {
  render: () => (
    <>
      <Toaster />
      <Button
        variant="outline"
        onClick={() =>
          toast({
            title: 'Scope of work removed',
            description: 'Emergency repair - main line',
            duration: Infinity,
            action: (
              <ToastAction altText="Undo remove" onClick={() => {}}>
                Undo
              </ToastAction>
            ),
          })
        }
      >
        Remove scope line
      </Button>
    </>
  ),
};

/**
 * `action` again, with a navigation intent rather than an undo - matches
 * CreatePOFromJobDialog.tsx:147-159's real "View" toast shown right after a
 * purchase order is created. Two real, distinct shapes for the same prop
 * are worth both being visible to a designer, not just one representative.
 */
export const WithNavigationAction: Story = {
  render: () => (
    <>
      <Toaster />
      <Button
        variant="outline"
        onClick={() =>
          toast({
            title: 'PO-00042 created',
            description: 'Draft purchase order linked to this job.',
            duration: Infinity,
            action: (
              <ToastAction altText="View purchase order" onClick={() => {}}>
                View
              </ToastAction>
            ),
          })
        }
      >
        Create purchase order
      </Button>
    </>
  ),
};

/**
 * TOAST_LIMIT (use-toast.ts) keeps only the newest 3 toasts - firing a
 * fourth drops the oldest rather than growing the stack unbounded. Real
 * reducer behaviour (`toasts: [action.toast, ...state.toasts].slice(0, 3)`),
 * not a story-only rule.
 */
export const StackedToastsRespectTheLimit: Story = {
  render: () => (
    <>
      <Toaster />
      <Button
        variant="outline"
        onClick={() => {
          ['First', 'Second', 'Third', 'Fourth'].forEach((label, i) => {
            toast({
              title: `${label} toast`,
              description: `Fired ${i + 1} of 4 in this click - only the newest 3 stay.`,
              duration: Infinity,
            });
          });
        }}
      >
        Fire 4 toasts at once
      </Button>
    </>
  ),
};

/**
 * No `duration` override - the real default (TOAST_AUTO_DISMISS, 4000ms)
 * applies and the toast closes itself. Matches
 * src/__tests__/toast-autodismiss.test.tsx's "auto-closes a default toast
 * (no duration) after ~4s" case. Deliberately not routed through
 * `LiveToastDemo`, which pins `duration: Infinity` so control-flipping does
 * not race this same timer.
 */
export const AutoDismiss: Story = {
  render: () => (
    <>
      <Toaster />
      <Button variant="outline" onClick={() => toast({ description: 'Text sent to Acme' })}>
        Fire a toast with the default (auto-closes in ~4s)
      </Button>
    </>
  ),
};

/**
 * `duration: Infinity` and the real default side by side - matches
 * src/__tests__/toast-autodismiss.test.tsx's sticky-toast regression guard
 * (`toast({ description: 'Send failed', duration: Infinity })` never
 * auto-closes). The two buttons make the timing difference directly
 * comparable in one canvas.
 */
export const AutoDismissVsSticky: Story = {
  render: () => (
    <>
      <Toaster />
      <Inline gap={2} wrap align="center">
        <Button variant="outline" size="sm" onClick={() => toast({ description: 'Closes on its own in ~4s' })}>
          Default duration
        </Button>
        <Button
          variant="outline"
          tone="danger"
          size="sm"
          onClick={() =>
            toast({ description: 'Send failed', variant: 'destructive', duration: Infinity })
          }
        >
          duration: Infinity (sticky)
        </Button>
      </Inline>
    </>
  ),
};
