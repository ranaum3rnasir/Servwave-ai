/**
 * The pickup mark of a logistic order (Roles & Permissions S07.11), the same mark a stage carries (S07.6, S07.7): the two
 * buttons that save it and the line that shows it. Both sit on the order sheet that the job page's Logistics tab and the
 * Inventory page's Logistic Orders tab share.
 *
 * Which buttons show is the server's list for this person and this order (`detail.actions`, `pick_up` and
 * `record_pickup`, offered only on a Processed order that is not yet taken); this file never tests a switch or a status.
 */
import { useState } from 'react';
import { PackageCheck, Users } from 'lucide-react';

import { PickupPeopleDialog } from '@/components/inventory/PickupPeopleDialog';
import { pickupLabel } from '@/components/inventory/pickupLabel';
import {
  extractLoError,
  useLoPickupPeople,
  useTakeLo,
  useTakeLoForOther,
  type LogisticOrderAction,
  type LogisticOrderDetail,
} from '@/lib/api/logisticOrders';
import { extractApiError } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/** "Taken by Tom" and the time, plus ", recorded by Lee" when someone else recorded it. Nothing until the order is taken. */
export function LoTakenLine({ detail }: { detail: Pick<LogisticOrderDetail, 'takenAt' | 'takenBy' | 'recordedBy'> }) {
  if (!detail.takenAt) return null;
  return (
    <p className="mt-2 inline-flex items-center gap-1 text-xs text-text-secondary">
      <PackageCheck className="h-3 w-3" />
      {pickupLabel({
        takenAt: detail.takenAt,
        takenById: detail.takenBy?.id,
        takenByName: detail.takenBy?.name,
        recordedById: detail.recordedBy?.id,
        recordedByName: detail.recordedBy?.name,
      })}
    </p>
  );
}

/** "Taken by..." on an order: the people the server lists, the order's requester first. */
function TakenByOtherDialog({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const people = useLoPickupPeople(orderId, true);
  const record = useTakeLoForOther();

  return (
    <PickupPeopleDialog
      people={people.data?.map((p) => ({ id: p.id, name: p.name, tag: p.requester ? 'Requested' : undefined }))}
      loading={people.isLoading}
      loadError={people.isError ? people.error : null}
      saving={record.isPending}
      saveError={record.isError ? (extractLoError(record.error)?.message ?? record.error) : null}
      onRecord={(takenById) => record.mutate({ id: orderId, takenById }, { onSuccess: onClose })}
      onClose={onClose}
    />
  );
}

/** "Taken by me" and "Taken by..." for a Processed order, each only when the server's list for this person carries it. */
export function LoPickupButtons({ orderId, actions }: { orderId: string; actions: readonly LogisticOrderAction[] }) {
  const take = useTakeLo();
  const [pickerOpen, setPickerOpen] = useState(false);
  const canTakeMyself = actions.includes('pick_up');
  const canRecordForOther = actions.includes('record_pickup');
  if (!canTakeMyself && !canRecordForOther) return null;

  return (
    <>
      {canTakeMyself && (
        <Button variant="outline" size="sm" disabled={take.isPending} onClick={() => take.mutate(orderId)}>
          <PackageCheck className="h-4 w-4" />
          Taken by me
        </Button>
      )}
      {canRecordForOther && (
        <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
          <Users className="h-4 w-4" />
          Taken by...
        </Button>
      )}
      {take.isError && (
        <span role="alert" className="text-xs text-danger">
          {extractLoError(take.error)?.message ?? extractApiError(take.error, 'Could not save the pickup - try again.')}
        </span>
      )}
      {pickerOpen && <TakenByOtherDialog orderId={orderId} onClose={() => setPickerOpen(false)} />}
    </>
  );
}
