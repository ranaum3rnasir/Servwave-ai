import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Loader2, Copy, FilePlus } from 'lucide-react';
import api from '@/lib/axios';
import { cn } from '@/lib/utils';
import { useAppAbility } from '@/contexts/AbilityContext';
import { createEstimate, duplicateEstimate } from '@/lib/api/estimates';
import { invalidateEstimateLists, type EstimateAnchor } from '../lib/newEstimate';
import { toast } from '@/components/ui/use-toast';
import { extractApiError } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu';

/** One estimate on the lead, as the tab strip needs it. */
interface SiblingEstimate {
  id: string;
  estimate_number: string;
  name?: string | null;
  status: string;
  created_at: string;
}

/** Which container the strip is listing: the estimate's own anchor. */
export type TabStripAnchor =
  | { kind: 'lead'; id: string }
  | { kind: 'customer'; id: string }
  | { kind: 'job'; id: string };

interface EstimateTabsProps {
  anchor: TabStripAnchor;
  activeEstimateId: string;
}

/** The list-endpoint params for one anchor: its own id column, plus the anchor-kind narrowing. */
const ANCHOR_ID_PARAM = { lead: 'lead_id', customer: 'customer_id', job: 'job_id' } as const;

/** The create payload for a new estimate in the same container. */
function anchorCreatePayload(anchor: TabStripAnchor): EstimateAnchor {
  return { [ANCHOR_ID_PARAM[anchor.kind]]: anchor.id } as EstimateAnchor;
}

/**
 * The label for a tab whose estimate has no name. Derived from the estimate's OWN number, never
 * from its position in the list: the two agree only while the container's numbering is dense, so
 * one deletion used to make the strip and the workspace title disagree about the same estimate.
 * `estimate_number` is zero-padded per container ("E00002"), and the workspace shows the number
 * without its padding.
 */
function fallbackLabel(estimateNumber: string): string {
  const digits = estimateNumber.replace(/\D/g, '');
  return digits ? `Estimate ${Number(digits)}` : estimateNumber;
}

/**
 * Per-anchor estimate tab strip for the unified workspace.
 *
 * Lists every estimate sharing this estimate's container — the same lead (re-quotes /
 * Good-Better-Best options), the same customer, or the same job (change orders and options on one
 * job) — lets you switch between them, and adds a new one on the SAME anchor, blank or copied.
 * Tabs show the estimate's custom name when set, else its own number. Renaming is done from the
 * title; deleting from the top-bar Actions (⋯) menu.
 */
export function EstimateTabs({ anchor, activeEstimateId }: EstimateTabsProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const ability = useAppAbility();
  const canCreate = ability.can('create', 'Estimate');
  const canDuplicate = ability.can('duplicate', 'Estimate');

  // `anchor` narrows the list to estimates anchored THIS way — customer_id alone is denormalised
  // onto every row, so without it a customer's strip would also list their lead- and job-anchored
  // estimates.
  const listParams = { [ANCHOR_ID_PARAM[anchor.kind]]: anchor.id, anchor: anchor.kind, limit: 50 };

  const { data: siblings } = useQuery<SiblingEstimate[]>({
    queryKey: ['estimates', { anchor: anchor.kind, id: anchor.id }],
    queryFn: async () => {
      const { data } = await api.get('/api/estimates', { params: listParams });
      return data.estimates as SiblingEstimate[];
    },
    enabled: Boolean(anchor.id),
  });

  // Creation order, so the strip reads oldest-first however the numbers fall.
  const tabs = [...(siblings ?? [])].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const labelFor = (est: SiblingEstimate) => est.name?.trim() || fallbackLabel(est.estimate_number);

  // After a blank/copy create, refresh the strip + the list page, then land on it.
  function goToNewEstimate(newId: string) {
    invalidateEstimateLists(queryClient);
    navigate(`/estimates/${newId}`);
  }

  const addBlank = useMutation({
    // A "blank" estimate is genuinely empty — no line items — so it starts from
    // scratch on the SAME anchor. (The backend allows an empty DRAFT.)
    mutationFn: () => createEstimate(anchorCreatePayload(anchor)),
    onSuccess: (data) => data?.estimate?.id && goToNewEstimate(data.estimate.id),
    onError: (err) =>
      toast({
        title: 'Could not add estimate',
        description: extractApiError(err, 'Failed to create a new estimate'),
        variant: 'destructive',
      }),
  });

  const addCopy = useMutation({
    mutationFn: (sourceId: string) => duplicateEstimate(sourceId),
    onSuccess: (data) => data?.estimate?.id && goToNewEstimate(data.estimate.id),
    onError: (err) =>
      toast({
        title: 'Could not copy estimate',
        description: extractApiError(err, 'Failed to copy the estimate'),
        variant: 'destructive',
      }),
  });

  const busy = addBlank.isPending || addCopy.isPending;

  return (
    <div className="flex items-center gap-1 border-b border-border">
      <div className="flex items-center gap-1 overflow-x-auto">
        {tabs.map((est) => {
          const isActive = est.id === activeEstimateId;
          return (
            // Tab-strip item (segmented toggle) - not Button-shaped. Deferred.
            <button
              key={est.id}
              type="button"
              onClick={() => !isActive && navigate(`/estimates/${est.id}`)}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap border-b-2 px-3 pb-2 pt-1 text-sm font-semibold transition-colors',
                isActive
                  ? 'border-primary text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary',
              )}
            >
              {labelFor(est)}
            </button>
          );
        })}
      </div>

      {canCreate && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Tab-strip-integrated "add" trigger (shares the tabs' px-3 pb-2 pt-1
                baseline) - no ghost/brand cell is minted to reproduce its always-on
                text-primary + hover:text-ocean-800. Deferred. */}
            <button
              type="button"
              disabled={busy}
              className="ml-1 flex items-center gap-1 whitespace-nowrap px-3 pb-2 pt-1 text-sm font-semibold text-primary hover:text-ocean-800 disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add estimate
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => addBlank.mutate()}>
              <FilePlus className="mr-2 h-4 w-4" />
              Start blank
            </DropdownMenuItem>
            {canDuplicate && tabs.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Copy className="mr-2 h-4 w-4" />
                    Copy from…
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {tabs.map((est) => (
                      <DropdownMenuItem key={est.id} onSelect={() => addCopy.mutate(est.id)}>
                        {labelFor(est)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
