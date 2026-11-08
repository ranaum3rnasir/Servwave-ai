import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { useCopilotStore } from '@/stores/copilotStore';
import { useCopilot } from './CopilotContext';

/**
 * The write-approval card. Shows the resolved, hash-pinned payload and requires
 * explicit confirmation. Confirm is sage (a business action, not an AI flourish);
 * nothing is saved until pressed. Focus moves to Confirm on appear (a11y).
 */
export default function ApprovalCard() {
  const pending = useCopilotStore((s) => s.pendingApproval);
  const { confirmApproval, cancelApproval } = useCopilot();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (pending) confirmRef.current?.focus();
  }, [pending]);

  if (!pending) return null;
  const { action } = pending;

  return (
    <div
      role="group"
      aria-label="Confirm action"
      className="mx-3 my-2 rounded-card border border-ai-500/40 bg-on-fill/[0.07] p-4 shadow-[0_8px_30px_rgb(var(--ai-600)/0.18)] backdrop-blur-md motion-safe:animate-servy-in"
    >
      <p className="text-sm font-semibold text-on-fill">Confirm: {action.summary}</p>

      {action.isFinancial && action.amountLabel && (
        <p className="mt-1 text-base font-bold text-on-fill">{action.amountLabel}</p>
      )}

      {action.detail.length > 0 && (
        <dl className="mt-2 space-y-1">
          {action.detail.map((d, i) => (
            <div key={i} className="flex gap-2 text-xs">
              <dt className="shrink-0 font-medium text-on-fill/50">{d.label}:</dt>
              <dd className="break-words text-on-fill/90">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-3 text-xs text-on-fill/45">Nothing is saved until you confirm.</p>

      <div className="mt-3 flex gap-2">
        <Button ref={confirmRef} variant="solid" tone="business" size="sm" onClick={() => void confirmApproval()}>
          Confirm
        </Button>
        <Button
          variant="onDark"
          size="sm"
          onClick={() => cancelApproval()}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
