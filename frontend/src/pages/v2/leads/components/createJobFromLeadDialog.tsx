import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Briefcase, FileText } from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { isConvertibleEstimate } from '@/features/estimate-workspace/lib/convertToJob';
import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogIcon, DialogTitle,
} from '@/ui-kit/components/ui/dialog';

import { StatusChip } from '../../_shared/statusChip';
import { preferV2Path } from '../../uiV2';

export interface CreateJobEstimate {
  id: string;
  estimate_number: string;
  status: string;
  total_amount: string;
  created_at: string;
  /** PROVENANCE - a Job already created FROM this estimate. */
  job?: { id: string; job_number: string; status: string } | null;
  /** ANCHOR FK - set (with `job` staying null) when the multi-convert path folded this estimate
   * into a job alongside others (#2048). */
  job_id?: string | null;
  job_link?: { id: string; job_number: string; status: string } | null;
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
      <DialogContent className="max-w-md">
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
  const convertible = estimates.filter(isConvertibleEstimate);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (preselectEstimateId != null && convertible.some((e) => e.id === preselectEstimateId)) {
      return new Set([preselectEstimateId]);
    }
    if (convertible.length > 1) return new Set(convertible.map((e) => e.id));
    if (convertible.length === 1) return new Set(convertible[0] ? [convertible[0].id] : []);
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
              <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                {estimates.map((est) => {
                  const isConvertible = isConvertibleEstimate(est);
                  const isSelected = selectedIds.has(est.id);
                  // Either job pointer names the job this row already belongs to: `job` is
                  // PROVENANCE, `job_link` is the ANCHOR the multi-convert path attaches through.
                  const attachedJob = est.job ?? est.job_link;
                  return (
                    <div
                      key={est.id}
                      className={[
                        'flex items-center justify-between rounded-lg border px-3 py-2',
                        isConvertible ? 'cursor-pointer' : 'opacity-70',
                        isSelected ? 'border-brand bg-brand-subtle' : '',
                      ].join(' ')}
                      onClick={isConvertible ? () => toggleSelected(est.id) : undefined}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        {isConvertible && (
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
                          <span className="text-sm tabular-nums">{formatCurrency(est.total_amount)}</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {convertible.length === 0 && (
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
                const orderedIds = estimates.filter((e) => selectedIds.has(e.id)).map((e) => e.id);
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
