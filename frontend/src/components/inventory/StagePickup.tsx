import { useState } from 'react';
import { PackageCheck, Users } from 'lucide-react';

import { PickupPeopleDialog } from '@/components/inventory/PickupPeopleDialog';
import { pickupLabel } from '@/components/inventory/pickupLabel';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useStagePickupPeople, useTakeStage, useTakeStageForOther } from '@/lib/api/inventory';
import type { JobStage } from '@/lib/api/inventory';
import { extractApiError } from '@/lib/utils';
import { Button } from '@/ui-kit/components/ui/button';

type PickupFields = Pick<JobStage, 'id' | 'takenAt' | 'takenById' | 'takenByName' | 'recordedById' | 'recordedByName'>;

/** "Taken by..." on a stage: the people the server lists, the stage's assigned person first. */
function TakenByOtherDialog({ stageId, onClose, onTaken }: { stageId: string; onClose: () => void; onTaken?: (taken: JobStage) => void }) {
  const people = useStagePickupPeople(stageId, true);
  const record = useTakeStageForOther();

  return (
    <PickupPeopleDialog
      people={people.data?.map((p) => ({ id: p.id, name: p.name, tag: p.assigned ? 'Assigned' : undefined }))}
      loading={people.isLoading}
      loadError={people.isError ? people.error : null}
      saving={record.isPending}
      saveError={record.isError ? record.error : null}
      onRecord={(takenById) => record.mutate({ stageId, takenById }, { onSuccess: (taken) => { onTaken?.(taken); onClose(); } })}
      onClose={onClose}
    />
  );
}

/**
 * The pickup of a stage (Roles & Permissions S07.6, S07.7). A taken stage reads "Taken by <name>" (and ", recorded by <name>"
 * when someone else recorded it) and the time, to anyone who can see it. A stage not yet taken offers "Taken by me" to a
 * person who holds Pick up staged items, and "Taken by..." (a people picker) to one who holds Record pickup for someone
 * else; neither needs Edit stock, and the server saves the result. Used on the Staging tab and on the job page's staging
 * section.
 */
export function StagePickup({ stage, onTaken }: { stage: PickupFields; onTaken?: (taken: JobStage) => void }) {
  const ability = useAppAbility();
  const take = useTakeStage();
  const [pickerOpen, setPickerOpen] = useState(false);

  if (stage.takenAt) {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
        <PackageCheck className="size-3" />
        {pickupLabel(stage)}
      </span>
    );
  }
  const canTakeMyself = ability.can('pick_up_staged', 'Inventory');
  const canRecordForOther = ability.can('record_pickup_for_other', 'Inventory');
  if (!canTakeMyself && !canRecordForOther) return null;

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="inline-flex flex-wrap items-center justify-end gap-2">
        {canTakeMyself && (
          <Button
            size="sm"
            disabled={take.isPending}
            onClick={(e) => {
              e.stopPropagation();
              take.mutate(stage.id, { onSuccess: (taken) => onTaken?.(taken) });
            }}
          >
            <PackageCheck />
            Taken by me
          </Button>
        )}
        {canRecordForOther && (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              setPickerOpen(true);
            }}
          >
            <Users />
            Taken by...
          </Button>
        )}
      </span>
      {take.isError && (
        <span role="alert" className="text-destructive text-xs">
          {extractApiError(take.error, 'Could not save the pickup - try again.')}
        </span>
      )}
      {pickerOpen && <TakenByOtherDialog stageId={stage.id} onClose={() => setPickerOpen(false)} onTaken={onTaken} />}
    </span>
  );
}
