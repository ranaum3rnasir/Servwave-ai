import { AlertTriangle } from 'lucide-react';

import { Button } from '@/ui-kit/components/ui/button';
import { Dialog } from '@/ui-kit/components/ui/dialog';
import { EM } from '../glyphs';
import { ScheduleAlertContent } from './scheduleAlert';

export interface NeedsCrewConfirmProps {
  /** The record number being scheduled, e.g. "J00041". */
  number: string;
  /** Back to the (still-held) drop modal draft. Escape does the same. */
  onBack: () => void;
  onConfirm: () => void;
}

/**
 * The empty-crew warning (D5 confirm gate - §3.8 state 4 is valid but deliberate), on the kit
 * Dialog since mobile slice 16. The page gates UnifiedDropModal's `open` with `!needsCrewConfirm`,
 * so the two swap on one tick in both directions; see `scheduleAlert.tsx` for why that is safe.
 */
export function NeedsCrewConfirm({ number, onBack, onConfirm }: NeedsCrewConfirmProps) {
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onBack(); }}>
      <ScheduleAlertContent
        tone="danger"
        icon={<AlertTriangle />}
        title="Nobody is assigned"
        description={
          <>
            <strong>{number}</strong> will be scheduled with no crew {EM} it saves
            as <strong>"needs crew"</strong> (red flag, Standard view only). Confirm?
          </>
        }
        actions={
          <>
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
            <Button variant="destructive" onClick={onConfirm}>
              Schedule anyway
            </Button>
          </>
        }
      />
    </Dialog>
  );
}
