/**
 * A comm row's job chip, upgraded to the hub's attach / move / detach menu
 * (slice E3) when the viewer may manage attribution:
 *
 *   gate = org comms access (useFeature('phone')) AND
 *          ability.can('attach', 'Communication') (the Attach conversations to jobs and leads switch) AND
 *          the channel has a per-row reassign seam (call | sms | email) AND
 *          the row is a PLATFORM record, not a hand-logged one.
 *
 * Gated on  → a text's or a call's pill opens "Attach to a lead or job" (AttachMenu, #3024): the leads and jobs of every
 * customer carrying its number. An email's pill opens CommJobMenu: the customer's open jobs or leads, or a search.
 * Attributed rows move elsewhere or detach.
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
import {
  useReassignEmailJob,
  useReassignEmailLead,
  type ConversationLinkResult,
} from '@/lib/api/communication';
import type { CommItem } from '@/lib/api/jobCommunications';
import { JobBadge } from './atoms';
import { AttachMenu } from './AttachMenu';
import { CommJobMenu, type AttachPick } from './CommJobMenu';
import { useAttachTargets } from './useAttachTargets';
import { useRetieText } from './useRetieText';

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
    ability.can('attach', 'Communication') &&
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

  // A text or a call opens "Attach to a lead or job" (#3024), which reads its own targets when it opens. An email keeps the
  // customer-seeded menu: it has no number, so there are no customers carrying one. Scoped to undefined unless that menu can
  // actually render, so static rows and text and call rows never fetch a target list they will not show.
  const targets = useAttachTargets(canManage && item.channel === 'email' ? customerId : undefined);
  const reassignCall = useReassignCallJob();
  const reassignCallLead = useReassignCallLead();
  const retieText = useRetieText();
  const reassignEmail = useReassignEmailJob();
  const reassignEmailLead = useReassignEmailLead();

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
  // Jobs and leads are targets for an email too (Attach conversations to jobs and leads).
  const menuLeads = targets.leads;

  // A change that took the row out of the person's reach (a detach of a conversation they could read only through
  // the record it was taken off) is a success: the row leaves their screen on the refetch, and the note says so
  // instead of reporting an error.
  const done = (target: AttachPick | null, result?: ConversationLinkResult) =>
    toast({
      title: result?.left
        ? 'Link removed. This conversation is no longer in your list.'
        : target
          ? `Attached to ${target.label}`
          : 'Link removed',
    });
  const failed = () => toast({ title: "Couldn't update the link - try again", variant: 'destructive' });

  /**
   * An email keeps its job and its lead separately, so "No job or lead" clears each end the row has,
   * the lead first (a row on a job is always reachable through it, so the lead step never strands it). The chain stops
   * as soon as a step reports that the row left the person's reach: there is nothing more they may change.
   */
  async function detachSeparateEnds() {
    const ends = {
      clearLead: () => reassignEmailLead.mutateAsync({ emailId: item.id, leadId: null }),
      clearJob: () => reassignEmail.mutateAsync({ emailId: item.id, jobId: null }),
    };
    try {
      let result: ConversationLinkResult | undefined;
      if (item.leadId) {
        result = await ends.clearLead();
        if (result?.left) return done(null, result);
      }
      if (item.jobId || !item.leadId) result = await ends.clearJob();
      done(null, result);
    } catch {
      failed();
    }
  }

  function pick(target: AttachPick | null) {
    const options = { onSuccess: (result: ConversationLinkResult) => done(target, result), onError: failed };
    if (item.channel === 'call') {
      if (target?.kind === 'lead') {
        reassignCallLead.mutate({ callId: item.id, leadId: target.id }, options);
      } else {
        reassignCall.mutate({ callId: item.id, jobId: target?.id ?? null }, options);
      }
    } else if (item.channel === 'email') {
      if (!target) void detachSeparateEnds();
      else if (target.kind === 'lead') reassignEmailLead.mutate({ emailId: item.id, leadId: target.id }, options);
      else reassignEmail.mutate({ emailId: item.id, jobId: target.id }, options);
    } else {
      retieText(item, target).then((result) => done(target, result), failed);
    }
  }

  const pill = (
    <button
      type="button"
      title={
        item.jobLabel
          ? `Attached to ${item.jobLabel} - click to move or detach`
          : 'Not attached - click to attach to a job or lead'
      }
      className="rounded-pill transition hover:opacity-80"
    >
      <JobBadge job={item.jobLabel} />
    </button>
  );

  if (item.channel === 'sms' || item.channel === 'call') {
    return (
      <AttachMenu
        target={{ kind: item.channel, id: item.id }}
        current={{ jobId: item.jobId, leadId: item.leadId }}
        onPick={pick}
      >
        {pill}
      </AttachMenu>
    );
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
      {pill}
    </CommJobMenu>
  );
}
