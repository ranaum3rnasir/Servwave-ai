import { useState } from 'react';
import { Loader2, PackageCheck } from 'lucide-react';

import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { extractApiError } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';

/** One choice in the picker; `tag` marks the person the screen puts first and says why ("Assigned"). */
export interface PickupPersonOption {
  id: string;
  name: string;
  tag?: string;
}

interface PickupPeopleDialogProps {
  /** The company's active people, in the order the server sent them. */
  people: PickupPersonOption[] | undefined;
  loading: boolean;
  loadError: unknown;
  saving: boolean;
  saveError: unknown;
  onRecord: (takenById: string) => void;
  onClose: () => void;
}

/**
 * "Taken by..." (Roles & Permissions S07.7, S07.11): pick the colleague who took the parts, then the caller records it.
 * One picker for a stage and a logistic order. The people sit in a searchable combobox with a scroller of its own, so a
 * company of hundreds of people stays usable; the server decides who is listed and in what order.
 */
export function PickupPeopleDialog({ people, loading, loadError, saving, saveError, onRecord, onClose }: PickupPeopleDialogProps) {
  const [takenById, setTakenById] = useState('');
  const tagged = people?.find((p) => p.tag);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent intent="form" className="max-w-sm" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Who took the parts?</DialogTitle>
          <DialogDescription>Record a pickup for a colleague. It is saved as taken by them and recorded by you.</DialogDescription>
        </DialogHeader>

        <Combobox
          aria-label="Person who took the parts"
          value={takenById}
          onValueChange={setTakenById}
          placeholder={loading ? 'Loading people...' : 'Choose a person'}
          options={(people ?? []).map((p) => ({ value: p.id, label: p.name }))}
          renderOptionSuffix={(option) =>
            tagged && option.value === tagged.id ? <span className="text-muted-foreground ml-auto text-xs">{tagged.tag}</span> : null
          }
        />
        {!!loadError && (
          <span role="alert" className="text-destructive text-xs">
            {extractApiError(loadError, 'Could not load your team - try again.')}
          </span>
        )}
        {!!saveError && (
          <span role="alert" className="text-destructive text-xs">
            {extractApiError(saveError, 'Could not save the pickup - try again.')}
          </span>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={!takenById || saving} onClick={() => onRecord(takenById)}>
            {saving ? <Loader2 className="animate-spin" /> : <PackageCheck />}
            Record pickup
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
