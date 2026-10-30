import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, FileText } from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import {
  isConvertibleEstimate, isSelectableEstimate, leadConvertBlockedReason,
} from '@/features/estimate-workspace/lib/convertToJob';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';
import { DialogList } from '@/ui-kit/components/ui/dialogList';

import { StatusChip } from '../../_shared/statusChip';
import { preferV2Path } from '../../uiV2';

export interface CreateJobEstimate {
  id: string;
  estimate_number: string;
  status: string;
  /** Left out of the lead answer for a person who may not see this lead's estimate money; draw no amount then. */
  total_amount?: string;
  created_at: string;
  /** PROVENANCE - a Job already created FROM this estimate. */
  job?: { id: string; job_number: string; status: string } | null;
  /** ANCHOR FK - set (with `job` staying null) when the multi-convert path folded this estimate
   * into a job alongside others (#2048). */
  job_id?: string | null;
  job_link?: { id: string; job_number: string; status: string } | null;
  /** #2188 slice 16 - the estimate's kind=DEPOSIT Invoice, status only (lead.controller.ts's
   * detail select). Absent/empty means this estimate has no deposit, which never blocks. */
  invoices?: Array<{ kind: string; status: string }> | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  estimates: CreateJobEstimate[];
  canCreateEstimate: boolean;
  preselectEstimateId?: string | null;
  isConverting: boolean;
  /** #2048 - always an array, even for a single selection: exactly one id posts the
   * byte-identical `{ estimate_id }` request, more than one posts `{ estimate_ids }`. */
  onConvert: (estimateIds: string[]) => void;
}

/**
 * v2 port of `components/leads/CreateJobFromLeadDialog`, extended by #2048 to fold several WON
 * estimates into one job.
 *
 * Selection rules: (i) a valid preselect wins and selects ONLY that estimate (deep-link
 * semantics, unchanged); (ii) else when more than one estimate is convertible, all of them start
 * checked; (iii) else a lone convertible estimate auto-selects; (iv) else nothing.
 *
 * The legacy version seeded that selection from an effect keyed on `open`. Here the body is a
 * child that only exists while the dialog is open, so the same rule runs as a lazy initialiser on
 * mount - no state written from an effect.
 */
function CreateJobFromLeadDialog({
  open, onOpenChange, leadId, estimates, canCreateEstimate,
  preselectEstimateId, isConverting, onConvert,
}: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent intent="form" className="max-w-md">
        <CreateJobDialogBody
          onOpenChange={onOpenChange}
          leadId={leadId}
          estimates={estimates}
          canCreateEstimate={canCreateEstimate}
          preselectEstimateId={preselectEstimateId}
          isConverting={isConverting}
          onConvert={onConvert}
        />
      </DialogContent>
    </Dialog>
  );
}

function CreateJobDialogBody({
  onOpenChange, leadId, estimates, canCreateEstimate, preselectEstimateId, isConverting, onConvert,
}: Omit<Props, 'open'>) {
  const navigate = useNavigate();
  // TWO lists, because they answer two different questions. `selectable` is what may be ticked
  // and submitted (won, unattached, deposit settled). `approved` is the older, looser question
  // the footer guidance asks - "is there an approved estimate here at all" - and it must stay
  // loose: a deposit-blocked estimate IS approved, so telling its operator to "approve an
  // estimate first" would send them after the wrong thing. That row states its own reason.
  const selectable = estimates.filter(isSelectableEstimate);
  const approved = estimates.filter(isConvertibleEstimate);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (preselectEstimateId != null && selectable.some((e) => e.id === preselectEstimateId)) {
      return new Set([preselectEstimateId]);
    }
    if (selectable.length > 1) return new Set(selectable.map((e) => e.id));
    if (selectable.length === 1) return new Set(selectable[0] ? [selectable[0].id] : []);
    return new Set();
  });
  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <>
        <DialogHeader>
          <DialogIcon><Briefcase /></DialogIcon>
          <div>
            <DialogTitle>Create job from estimate</DialogTitle>
            <DialogDescription>
              Pick an approved estimate to convert into a job. Only approved estimates can be converted.
            </DialogDescription>
          </div>
        </DialogHeader>

        <DialogBody>
          {estimates.length === 0 ? (
            <EmptyState icon={<FileText />} title="No estimates yet." />
          ) : (
            <>
              <DialogList cap="max-h-72 overflow-y-auto overscroll-contain" className="flex flex-col gap-1.5">
                {estimates.map((est) => {
                  const isSelectable = isSelectableEstimate(est);
                  const isSelected = selectedIds.has(est.id);
                  // Won and unattached, yet still refused: only the deposit gate can say that
                  // here. Shared with LeadDetailPage's one-click button, so the two surfaces
                  // cannot say different things about the same estimate.
                  const blockedReason = leadConvertBlockedReason(est);
                  // Either job pointer names the job this row already belongs to: `job` is
                  // PROVENANCE, `job_link` is the ANCHOR the multi-convert path attaches through.
                  const attachedJob = est.job ?? est.job_link;
                  return (
                    <div
                      key={est.id}
                      className={[
                        'flex flex-col rounded-lg border px-3 py-2',
                        isSelectable ? 'cursor-pointer' : 'opacity-70',
                        isSelected ? 'border-brand bg-brand-subtle' : '',
                      ].join(' ')}
                      onClick={isSelectable ? () => toggleSelected(est.id) : undefined}
                    >
                      <div className="flex w-full items-center justify-between">
                        <div className="flex min-w-0 items-center gap-2">
                          {isSelectable && (
                            <Checkbox
                              checked={isSelected}
                              aria-label={est.estimate_number}
                              onClick={(e) => e.stopPropagation()}
                              onCheckedChange={() => toggleSelected(est.id)}
                            />
                          )}
                          <span className="text-brand font-medium">{est.estimate_number}</span>
                          <StatusChip domain="estimate" status={est.status} />
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {attachedJob ? (
                            <Button
                              variant="link"
                              size="sm"
                              className="h-auto px-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenChange(false);
                                navigate(preferV2Path(`/jobs/${attachedJob.id}`));
                              }}
                            >
                              {attachedJob.job_number} →
                            </Button>
                          ) : (
                            est.total_amount != null && <span className="text-sm tabular-nums">{formatCurrency(est.total_amount)}</span>
                          )}
                        </div>
                      </div>
                      {blockedReason && (
                        <p className="text-muted-foreground mt-1 text-xs">{blockedReason}</p>
                      )}
                    </div>
                  );
                })}
              </DialogList>
              {approved.length === 0 && (
                <p className="text-muted-foreground mt-2 text-xs">
                  No approved estimate to convert yet. Approve an estimate first
                  {canCreateEstimate ? ', or create a new one below.' : '.'}
                </p>
              )}
            </>
          )}
        </DialogBody>

        <DialogFooter className="justify-between">
          {canCreateEstimate ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { onOpenChange(false); navigate(preferV2Path(`/estimates/new?lead_id=${leadId}`)); }}
            >
              <FileText />
              New estimate
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={selectedIds.size === 0 || isConverting}
              onClick={() => {
                // Render order (the payload's own `created_at desc`), never the order rows were
                // toggled in - filtering `estimates` rather than reading `selectedIds` directly.
                // ...and only ids the API would accept: showing a deposit-blocked row disabled
                // is not enough on its own if a stale selection can still carry it into the POST.
                const orderedIds = estimates
                  .filter((e) => selectedIds.has(e.id) && isSelectableEstimate(e))
                  .map((e) => e.id);
                if (orderedIds.length > 0) onConvert(orderedIds);
              }}
            >
              <Briefcase />
              {isConverting ? 'Creating…' : 'Create job'}
            </Button>
          </div>
        </DialogFooter>
    </>
  );
}

export { CreateJobFromLeadDialog };
