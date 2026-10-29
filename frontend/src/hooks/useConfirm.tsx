/**
 * useConfirm - promise-based access to the app's own `ConfirmDialog`, shaped as a drop-in for
 * `window.confirm`.
 *
 * WHY A PROMISE RATHER THAN THE USUAL open/onConfirm STATE PAIR. `window.confirm` is a blocking
 * call that returns a boolean *in the middle of a handler*, and several call sites lean on exactly
 * that: bulk actions on EstimatesPage/JobsPage compute a count, confirm, then continue an async
 * loop. Rewriting each of those into "stash the pending payload in state, render a dialog, resume
 * the work in onConfirm" means splitting one readable handler into three pieces per site, 16 times
 * over, and every split is a chance to drop a branch. Awaiting a promise keeps each handler in one
 * piece, so the diff stays a swap of the confirm CALL rather than a rewrite of the logic around it.
 *
 * The dialog is uncancellable-by-default in the same sense `window.confirm` is: dismissing it
 * (Escape, backdrop, Cancel) resolves `false`, never rejects, so `if (!(await confirm(...))) return;`
 * is the whole contract and there is nothing to try/catch.
 *
 * Usage:
 *   const { confirm, confirmDialog } = useConfirm();
 *   ...
 *   if (!(await confirm({ title: 'Delete this attachment?', tone: 'danger' }))) return;
 *   ...
 *   return (<>{...}{confirmDialog}</>);
 */
import { useCallback, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ConfirmDialog, type ConfirmDialogTone } from '@/components/ui/confirm-dialog';

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmDialogTone;
  icon?: LucideIcon;
}

export function useConfirm() {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  // Held in a ref, not state: settling the promise must not depend on a re-render having landed.
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    resolverRef.current?.(ok);
    resolverRef.current = null;
    setOptions(null);
  }, []);

  const confirm = useCallback((opts: ConfirmOptions) => {
    // A second confirm while one is open resolves the first as declined rather than orphaning its
    // promise - an awaited caller that never settles would hang its handler forever.
    resolverRef.current?.(false);
    setOptions(opts);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const confirmDialog = (
    <ConfirmDialog
      open={options !== null}
      onOpenChange={(next) => {
        if (!next) settle(false);
      }}
      title={options?.title ?? ''}
      description={options?.description}
      icon={options?.icon}
      tone={options?.tone}
      confirmLabel={options?.confirmLabel ?? 'Confirm'}
      cancelLabel={options?.cancelLabel ?? 'Cancel'}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );

  return { confirm, confirmDialog };
}
