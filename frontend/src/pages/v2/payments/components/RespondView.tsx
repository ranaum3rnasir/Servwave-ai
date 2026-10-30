import { useEffect, useState } from 'react';

import { useDisputeEvidence } from '@/lib/api/paymentsPage';
import { SheetFooter } from '@/ui-kit/components/ui/sheet';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';

import { LoadError } from '../../_shared/loadError';
import { DrawerBody, DrawerCloseButton, DrawerHeaderBar, useDrawerHost } from '../drawerHost';
import { withoutRespond } from '../drawerStack';
import { DisputeEvidenceForm } from './DisputeEvidenceForm';

/**
 * Answering a dispute: the evidence form on its own pushed view, "Back to Dispute" in the header (the form has no Back of
 * its own). Only someone the API lets answer (`can_edit`) gets the form; anyone else, or an address that points here
 * after the deadline or after the evidence was sent, is taken to the Dispute view with nothing said.
 */
export function RespondView({ disputeId }: { disputeId: string }) {
  const host = useDrawerHost();
  const query = useDisputeEvidence(disputeId);
  const data = query.data ?? null;
  // Reload: read the dispute again, then start the form over from what came back.
  const [formKey, setFormKey] = useState(0);
  const reload = () => { void query.refetch().then(() => setFormKey((k) => k + 1)); };

  const refused = Boolean(data && !data.can_edit);
  const { stack, replace } = host;
  useEffect(() => {
    if (refused) replace(withoutRespond(stack, disputeId));
  }, [refused, stack, replace, disputeId]);

  if (query.isError) {
    return (
      <>
        <DrawerHeaderBar title="Respond to dispute" />
        <div className="flex-1">
          <LoadError title="This dispute can’t be opened." onRetry={() => void query.refetch()} retrying={query.isFetching} />
        </div>
        <SheetFooter>
          <DrawerCloseButton />
        </SheetFooter>
      </>
    );
  }
  if (!data || refused) {
    return (
      <>
        <DrawerHeaderBar title="Respond to dispute" />
        <DrawerBody><Skeleton className="h-6 w-40" /><Skeleton className="h-10 w-32" /></DrawerBody>
      </>
    );
  }
  return (
    <>
      <DrawerHeaderBar title="Respond to dispute" />
      <DisputeEvidenceForm
        key={formKey}
        data={data}
        onDirtyChange={host.setDirty}
        onReload={reload}
        onSubmitted={() => host.replace(withoutRespond(host.stack, disputeId))}
      />
    </>
  );
}
