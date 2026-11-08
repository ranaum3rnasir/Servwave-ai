import { useState } from 'react';
import { useOrganization } from '@/lib/api/organization';
import { useAppAbility } from '@/contexts/AbilityContext';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

/**
 * Just-in-time (JIT) "accept cards" nudge (spec §6.8) — mounted on send-flow surfaces
 * (SendEstimateDialog, SendInvoiceDialog, Task 2.5) so an admin sees the CTA to set up
 * ServWave Payments right when they're about to send something that could otherwise take
 * a card. A non-admin can't act on the CTA, so they see informational-only copy instead
 * (or nothing, once dismissed/already enabled) — never a button pointing at a settings
 * page they can't open.
 */

const DISMISS_KEY = 'servwave.payments.jit.dismissed';

export function StripePaymentsBanner({ onSetup }: { onSetup: () => void }) {
  const { data: org } = useOrganization();
  const canManage = useAppAbility().can('update', 'Organization');
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  if (!org || org.stripe_charges_enabled || dismissed) return null;

  if (!canManage) {
    // §6.8 non-admin: informational only — no CTA into a settings page they can't open.
    return <p className="text-xs text-text-secondary">Card payments aren’t set up — ask your admin.</p>;
  }

  return (
    // NOTE: the brief's snippet used `rounded-control`, which isn't a registered Tailwind
    // utility in this repo (tailwind.config.js's borderRadius only maps DEFAULT/sm to
    // --radius-control — no `control` key), so it's a no-op class — see the same finding
    // already documented in components/workflows/workflow-visuals.tsx. Using the bare
    // `rounded` utility here instead is what actually resolves to the 6px control radius.
    <div className="flex items-center justify-between gap-2 rounded border border-border bg-primary-subtle p-3">
      <span className="text-sm">Get paid faster — accept card payments.</span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="solid" tone="business" onClick={onSetup}>
          Set up
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Dismiss"
          onClick={() => {
            localStorage.setItem(DISMISS_KEY, '1');
            setDismissed(true);
          }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
