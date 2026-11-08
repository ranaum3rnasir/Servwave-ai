import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { StatusBadge } from '@/components/data/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { extractApiError } from '@/lib/utils';
import { duplicateEstimate } from '@/lib/api/estimates';
import { useFeature } from '@/lib/entitlements';
import { Loader2 } from 'lucide-react';

interface DuplicateEstimateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  estimateId: string;
  /** The estimate's current lead (the default duplicate target). */
  currentLeadId: string | null;
  /** Customer whose leads can be the alternate target. */
  customerId: string | null;
}

interface LeadOption {
  id: string;
  status: string;
  service_request: string;
  created_at: string;
}

export function DuplicateEstimateDialog({
  open,
  onOpenChange,
  estimateId,
  currentLeadId,
  customerId,
}: DuplicateEstimateDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [targetLeadId, setTargetLeadId] = useState<string>(currentLeadId ?? '');

  useEffect(() => {
    if (open) setTargetLeadId(currentLeadId ?? '');
  }, [open, currentLeadId]);

  // Leads belonging to the same customer — the pool of alternate targets.
  // Skipped without the Pro `leads` entitlement (/api/leads 402s there); the copy
  // then keeps the original's anchor, which is the existing empty-pool behaviour.
  // Duplicating an estimate stays available on Starter.
  const hasLeads = useFeature('leads');
  const { data: leads, isLoading: leadsLoading } = useQuery({
    queryKey: ['leads', { customer_id: customerId }],
    queryFn: async () => {
      const { data } = await api.get('/api/leads', {
        params: { customer_id: customerId, limit: 25 },
      });
      return data.leads as LeadOption[];
    },
    enabled: open && Boolean(customerId) && hasLeads,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      return duplicateEstimate(estimateId, {
        target_lead_id: targetLeadId || undefined,
      });
    },
    onSuccess: (data) => {
      const est = data.estimate;
      queryClient.invalidateQueries({ queryKey: ['estimates'] });
      onOpenChange(false);
      if (est?.id) navigate(`/estimates/${est.id}`);
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Duplicate Estimate</DialogTitle>
          <DialogDescription>
            Clone this estimate onto a lead. Defaults to the same lead; pick another to re-quote elsewhere.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Target lead</Label>
            {leadsLoading ? (
              <p className="text-sm text-text-secondary py-2">Loading leads...</p>
            ) : (leads ?? []).length === 0 ? (
              <EmptyState density="flush"
                title="No leads found for this customer — the duplicate will stay on the current lead."
               
              />
            ) : (
              <div className="mt-1 max-h-64 space-y-1.5 overflow-y-auto">
                {(leads ?? []).map((lead) => {
                  const selected = targetLeadId === lead.id;
                  const isCurrent = currentLeadId === lead.id;
                  return (
                    // selectable card-row (radio-style border/bg swap + StatusBadge) -
                    // not Button-shaped, left raw.
                    <button
                      key={lead.id}
                      type="button"
                      onClick={() => setTargetLeadId(lead.id)}
                      className={
                        'flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ' +
                        (selected
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-background-light')
                      }
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-text-primary">
                          {lead.service_request || 'Lead'}
                          {isCurrent && <span className="ml-1.5 text-xs text-text-secondary">(same lead)</span>}
                        </p>
                        <p className="text-xs text-text-secondary">
                          {new Date(lead.created_at).toLocaleDateString('en-US')}
                        </p>
                      </div>
                      <StatusBadge domain="lead" status={lead.status} neutral />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {mutation.error && (
            <p className="text-sm text-danger">
              {extractApiError(mutation.error, 'Failed to duplicate estimate')}
            </p>
          )}

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
              {mutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Duplicating...
                </>
              ) : (
                'Duplicate'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
