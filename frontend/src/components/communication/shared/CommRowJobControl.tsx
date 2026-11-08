/**
 * A comm row's job chip, upgraded to the hub's attach / move / detach menu
 * (slice E3) when the viewer may manage attribution:
 *
 *   gate = org comms access (useFeature('phone')) AND
 *          ability.can('update', 'Communication') AND
 *          the channel has a per-row reassign seam (call | sms | email) AND
 *          the row is a PLATFORM record, not a hand-logged one.
 *
 * Gated on  → the pill opens CommJobMenu: unattributed rows attach to one of the
 * customer's open jobs or leads; attributed rows move elsewhere or detach.
 * PATCHes commit server-first (the shared mutation hooks refetch every comm
 * surface — hub + job/customer/lead tabs); success/failure toasts mirror the
 * call-drawer copy.
 *
 * Gated off → today's static pill, now navigable: attributed rows link to
 * /jobs/:id, except the row's OWN job on the job page (plain, no self-link).
 *
 * The gate deliberately no longer requires a customerId. It used to, which meant
 * an unknown-caller row — exactly the row most in need of manual attribution —
 * rendered a dead pill, even though the API accepts the attach. Those rows now
 * get the picker in search mode (useAttachTargets).
 */
import { Link } from 'react-router-dom';
import { toast } from '@/components/ui/use-toast';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { useReassignCallJob, useReassignCallLead } from '@/lib/api/callJob';
import { useReassignEmailJob, useReassignSmsJob } from '@/lib/api/communication';
import type { CommItem } from '@/lib/api/jobCommunications';
import { JobBadge } from './atoms';
import { CommJobMenu, type AttachPick } from './CommJobMenu';
import { useAttachTargets } from './useAttachTargets';

interface CommRowJobControlProps {
  item: CommItem;
  /** Customer scope for the target lists; absent → the picker searches instead. */
  customerId?: string;
  /** The hosting job page's id — its own rows render a plain, link-less pill. */
  currentJobId?: string;
}

export function CommRowJobControl({ item, customerId, currentJobId }: CommRowJobControlProps) {
  const ability = useAppAbility();
  const canAccessComms = useFeature('phone');
  const canManage =
    canAccessComms &&
    ability.can('update', 'Communication') &&
    (item.channel === 'call' || item.channel === 'sms' || item.channel === 'email') &&
    // Manual Communication Log: NOT re-attributable here. Every branch of `pick` below PATCHes a
    // channel-specific endpoint that resolves a CallSession / Message / Email by id, and a
    // logged entry is none of those - it lives in its own table. Its channel is `call` (the API
    // pins it; there is no picker until slice 6), so without this it would sail through the
    // channel test above and offer a menu whose every option 404s.
    //
    // Nor is this only a plumbing detail: moving an entry between a lead and a job is done by
    // EDITING it (slice 8), which is the surface that can also fix the date and the notes that
    // were probably wrong for the same reason.
    !item.manuallyLogged;

  // Scoped to undefined unless the menu can actually render, so static rows
  // never fetch a target list they will not show.
  const targets = useAttachTargets(canManage ? customerId : undefined);
  const reassignCall = useReassignCallJob();
  const reassignCallLead = useReassignCallLead();
  const reassignSms = useReassignSmsJob();
  const reassignEmail = useReassignEmailJob();

  if (!canManage) {
    // Static pill — navigable when attributed (goal: chips align across tabs),
    // except the job page's own rows (no self-link). Label-less legacy rows and
    // unattributed rows keep today's plain/no-job pill.
    if (item.jobId && item.jobLabel && item.jobId !== currentJobId) {
      return (
        <Link
          to={`/jobs/${item.jobId}`}
          title={`Open ${item.jobLabel}`}
          className="rounded-pill transition hover:opacity-80"
        >
          <JobBadge job={item.jobLabel} />
        </Link>
      );
    }
    return <JobBadge job={item.jobLabel} />;
  }

  // "Move to" lists the OTHER targets; the currently attached one is not one.
  const menuJobs = targets.jobs.filter((j) => j.id !== item.jobId);
  // Only calls have a lead endpoint — SMS and email can attach to jobs alone, so
  // they get no Leads group rather than a group that cannot commit.
  const menuLeads = item.channel === 'call' ? targets.leads : [];

  function pick(target: AttachPick | null) {
    const onSuccess = () =>
      toast({ title: target ? `Attached to ${target.label}` : 'Link removed' });
    const onError = () =>
      toast({ title: "Couldn't update the link — try again", variant: 'destructive' });
    if (item.channel === 'call') {
      if (target?.kind === 'lead') {
        reassignCallLead.mutate({ callId: item.id, leadId: target.id }, { onSuccess, onError });
      } else {
        reassignCall.mutate({ callId: item.id, jobId: target?.id ?? null }, { onSuccess, onError });
      }
    } else if (item.channel === 'email') {
      reassignEmail.mutate({ emailId: item.id, jobId: target?.id ?? null }, { onSuccess, onError });
    } else {
      reassignSms.mutate({ messageId: item.id, jobId: target?.id ?? null }, { onSuccess, onError });
    }
  }

  return (
    <CommJobMenu
      jobs={menuJobs}
      leads={menuLeads}
      onPick={pick}
      search={targets.search}
      onSearchChange={targets.setSearch}
      querying={targets.querying}
      needsMoreInput={targets.needsMoreInput}
      loading={targets.loading}
    >
      <button
        type="button"
        title={
          item.jobLabel
            ? `Attached to ${item.jobLabel} — click to move or detach`
            : 'Not attached — click to attach to a job or lead'
        }
        className="rounded-pill transition hover:opacity-80"
      >
        <JobBadge job={item.jobLabel} />
      </button>
    </CommJobMenu>
  );
}
