import { useNavigate, useLocation, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { useLogisticOrder } from '@/lib/api/logisticOrders';
import { useAppAbility } from '@/contexts/AbilityContext';
import { LODetailSheet } from '@/components/inventory/lo/LODetailSheet';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { PageHeader } from '@/ui-kit/components/layout/pageHeader';
import { Button } from '@/ui-kit/components/ui/button';

import { useRecordVisit } from '../pageBreadcrumbs';

/**
 * /inventory/logistic-orders/:orderId - ONE logistic order, opened from its alert (or a link on a job).
 *
 * A record route, like a job's or a purchase order's: it carries no list or Show guard, because Show Logistic Orders page
 * hides the list page and its menu entry, not the order. The page asks the server; View logistic orders is the only thing
 * that opens an order. Without it the page never asks, and a refusal or a missing order draws the same plain not-found
 * state, so the screen says nothing about whether the order exists. The order is the list's own sheet: what a person may
 * do to it is the server's `actions` list for them and this order.
 */
export default function LogisticOrderRecordPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const canRead = useAppAbility().can('read', 'LogisticOrder');
  const query = useLogisticOrder(canRead && orderId ? orderId : null);
  useRecordVisit('inventory', query.data?.number);

  // Back to wherever the person came from (the bell); a page opened from a bookmark goes home.
  const leave = () => {
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  };

  if (query.isLoading && canRead) return null;

  if (!canRead || !query.data) {
    return (
      <div>
        <PageHeader
          back={<Button variant="ghost" size="sm" onClick={leave}><ArrowLeft />Back</Button>}
          title="Logistic order"
        />
        <EmptyState title="Logistic order not found" description="It may have been removed, or it is not one you can open." />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        back={<Button variant="ghost" size="sm" onClick={leave}><ArrowLeft />Back</Button>}
        title="Logistic order"
      />
      <LODetailSheet open onOpenChange={(open) => { if (!open) leave(); }} loId={query.data.id} />
    </div>
  );
}
