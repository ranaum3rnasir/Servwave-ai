import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { usePurchaseOrder } from '@/lib/api/inventory';
import type { PurchaseOrder } from '@/lib/api/inventory';
import { useAppAbility } from '@/contexts/AbilityContext';
import { PODetailDialog } from '@/components/inventory/PODetailDialog';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';

import { useRecordVisit } from '../pageBreadcrumbs';
import { usePurchaseOrderReceive } from './components/poReceive';

/**
 * /inventory/purchase-orders/:poId - ONE purchase order, opened from a link on a job.
 *
 * A record route, like a job's or an estimate's: it carries no list guard, because the order opens whatever the
 * list switches say. The page asks the server; View purchase orders is the only
 * thing that opens an order. Without it the page never asks, and a refusal or a missing order draws the same plain
 * not-found state, so the screen says nothing about whether the order exists.
 */
export default function PurchaseOrderRecordPage() {
  const { poId } = useParams<{ poId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const canRead = useAppAbility().can('read', 'PurchaseOrder');
  const query = usePurchaseOrder(poId, canRead);
  useRecordVisit('inventory', query.data?.poNumber);

  // The server's order after a receive, a status move or a note made in the dialog; null until the first one.
  const [latest, setLatest] = useState<PurchaseOrder | null>(null);
  const po = latest && latest.id === poId ? latest : (query.data ?? null);
  const handleReceive = usePurchaseOrderReceive(setLatest);

  // Back to wherever the person came from (the job); a page opened from a bookmark goes home.
  const leave = () => {
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  };

  if (query.isLoading && canRead) return null;

  if (!canRead || !po) {
    return (
      <div>
        <PageHeader
          back={<Button variant="ghost" size="sm" onClick={leave}><ArrowLeft />Back</Button>}
          title="Purchase order"
        />
        <EmptyState title="Purchase order not found" description="It may have been removed, or it is not one you can open." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        back={<Button variant="ghost" size="sm" onClick={leave}><ArrowLeft />Back</Button>}
        title="Purchase order"
      />
      <PODetailDialog
        open
        onClose={leave}
        po={po}
        onReceive={handleReceive}
        onUpdated={setLatest}
        onDeleted={leave}
      />
    </div>
  );
}
