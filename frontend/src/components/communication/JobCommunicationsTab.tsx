/**
 * Job page Communication tab (Communication ↔ Jobs, Slice 1 — "Option X").
 *
 * Variant-A unified timeline: one chronological stream across channels
 * (call/email/sms/whatsapp), each row badged with an inline ocean job pill,
 * plus a compact SMS/email composer that stamps outgoing messages with this
 * job at origin. This tab IS the job's full conversation, so it deliberately
 * does not link out to the customer-scoped center.
 *
 * Visual contract: frontend/src/pages/prototype/comm/VariantA.tsx (JobTab).
 *
 * Manual Communication Log (2026-08-27, slice 5): a "Log communication" entry beside
 * "Call customer", gated on the new `log_past Communication` ability and on nothing else — see
 * `canLogPast` below for why it must not inherit the composer's conditions.
 */
import { useState } from 'react';
import { MessageSquare, Phone, PencilLine } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, extractApiError } from '@/lib/utils';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { SectionCard } from '@/components/jobs/overview/SectionCard';
import { CommRow } from '@/components/communication/shared/CommRow';
import { EntityCallDrawer } from '@/components/communication/shared/EntityCallDrawer';
import { EntitySmsDrawer } from '@/components/communication/shared/EntitySmsDrawer';
import { LogCommunicationDrawer } from '@/components/communication/shared/LogCommunicationDrawer';
import {
  newestFirst,
  useJobCommunications,
  useSendJobEmail,
  useSendJobSms,
} from '@/lib/api/jobCommunications';
import { useScheduleTimezone, formatInstant } from '@/lib/schedule-tz';
import { canModifyLoggedEntry } from '@/lib/api/jobCommunications';
import { useAuthStore } from '@/stores/auth.store';

interface JobCommunicationsTabProps {
  jobId: string;
  jobNumber: string;
  customerId: string;
  customerName: string;
  /** Customer's email — absent disables the Email compose mode. */
  customerEmail?: string;
  /** Customer's phone — absent hides the "Call customer" header action. */
  customerPhone?: string;
}

type ComposeMode = 'sms' | 'email';

// Recent items read as "2h ago"; older ones fall back to a date+time (no seconds).
function formatCommTime(at: string, tz: string): string {
  const d = new Date(at);
  const diffMs = Date.now() - d.getTime();
  // Elapsed time between two instants is the same number everywhere, so the
  // relative branch needs no zone; only the absolute fallback does.
  if (diffMs >= 0 && diffMs < 24 * 60 * 60 * 1000) {
    return formatDistanceToNow(d, { addSuffix: true });
  }
  return formatInstant(at, tz);
}

export function JobCommunicationsTab({
  jobId,
  jobNumber,
  customerId,
  customerName,
  customerEmail,
  customerPhone,
}: JobCommunicationsTabProps) {
  const tz = useScheduleTimezone();
  const { data: items, isLoading, isError, error } = useJobCommunications(jobId);
  const sendSms = useSendJobSms(jobId);
  const sendEmail = useSendJobEmail(jobId);
  const ability = useAppAbility();
  const canAccessComms = useFeature('phone');
  // Composer + call entry (E5): the org must have comms-module access AND the
  // user the create ability — otherwise this tab is a read-only timeline (a
  // composer here would 403 once the backend gates are on).
  const canCompose = canAccessComms && ability.can('create', 'Communication');
  // Manual Communication Log: gated on the NEW ability and on NOTHING ELSE — the same rule the
  // lead tab follows.
  //
  // It deliberately inherits neither of `canCompose`'s conditions. The phone entitlement would
  // hide it from the organisations that never had ServWave Phone, which are the ones this
  // feature exists for; and `create Communication` is the wrong gate (it is the shared baseline
  // every role holds, and it gates click-to-call and texts, not this).
  const canLogPast = ability.can('log_past', 'Communication');
  // WHO IS LOOKING — the other half of the edit affordance below (the logger, or an org admin).
  const viewer = useAuthStore((s) => s.user);
  const [logOpen, setLogOpen] = useState(false);
  /** The entry the drawer is reopened on. Null while it is being used to record a new one. */
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [mode, setMode] = useState<ComposeMode>('sms');
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  // Row → detail drawer (calls only in this slice). Gated on comms access: the
  // call/recording/transcript endpoints 404 for non-pilot orgs.
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  // Text row → SMS conversation drawer. #2046 (R1) — keyed by the row's own `threadId`; the
  // drawer re-sources off the anchor-filtered by-id thread read, so this never needs the section
  // gate.
  const [selectedSmsThreadId, setSelectedSmsThreadId] = useState<string | null>(null);

  // Backend returns ascending (oldest first); this timeline reads newest-first, the same way
  // the Lead and Customer tabs do — one shared sort, see `newestFirst`.
  const timeline = newestFirst(items);

  const sendPending = mode === 'sms' ? sendSms.isPending : sendEmail.isPending;

  const handleSend = () => {
    const trimmed = body.trim();
    if (!trimmed || sendPending) return;
    if (mode === 'sms') {
      sendSms.mutate({ customerId, body: trimmed }, { onSuccess: () => setBody('') });
    } else {
      if (!customerEmail) return;
      sendEmail.mutate(
        { to: customerEmail, subject: subject.trim(), body: trimmed },
        {
          onSuccess: () => {
            setBody('');
            setSubject('');
          },
        }
      );
    }
  };

  return (
    <div className="p-5">
      <SectionCard
        title="Communication"
        icon={<MessageSquare className="h-4 w-4 text-text-secondary" />}
        /* Two INDEPENDENT conditions, never one: "Call customer" needs the phone entitlement,
           the create ability and a customer with a phone number; "Log communication" needs only
           the logging ability. They sit side by side in the header where both apply, and each
           stands alone where the other does not - which is the whole placement decision. */
        meta={
          canLogPast || (canCompose && customerPhone) ? (
            <>
              {canLogPast && (
                <Button size="sm" variant="outline" onClick={() => setLogOpen(true)}>
                  <PencilLine className="mr-1.5 h-3.5 w-3.5" />
                  Log communication
                </Button>
              )}
              {canCompose && customerPhone && (
                // Interactive chrome → ocean (default), never sage.
                <Button
                  size="sm"
                  onClick={() =>
                    requestCall(customerPhone, {
                      jobId,
                      jobLabel: jobNumber,
                      customerId,
                      customerName,
                    })
                  }
                >
                  <Phone className="mr-1.5 h-3.5 w-3.5" />
                  Call customer
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}

        {isError && (
          <p className="text-sm text-danger">
            {extractApiError(error, 'Failed to load communication')}
          </p>
        )}

        {!isLoading && !isError && (!items || items.length === 0) && (
          <div className="flex flex-col items-center py-12 text-center">
            <MessageSquare className="mb-2 h-8 w-8 text-text-secondary/30" />
            <p className="max-w-sm text-sm text-text-secondary">
              No communication on this job yet. Texts, emails and calls that originate from this job
              will appear here.
            </p>
            {/* Discovery where it is needed: an org with no ServWave Phone sees an empty panel
                for ever otherwise, and the capability that fills it is invisible. */}
            {canLogPast && (
              <p className="mt-1 max-w-sm text-sm text-text-soft">
                Log a past call, text or email to record contact that happened outside
                ServWave.
              </p>
            )}
          </div>
        )}

        {!isLoading && !isError && timeline.length > 0 && (
          <ol className="divide-y divide-border">
            {timeline.map((it) => (
              // Shared row (slice E6): navigable lead/job chips + the gated
              // attach/move/detach menu; this job's own rows keep a plain pill.
              <CommRow
                key={it.id}
                item={it}
                formatTimestamp={(at) => formatCommTime(at, tz)}
                tz={tz}
                currentJobId={jobId}
                customerId={customerId}
                onSelect={
                  // TWO DIFFERENT DESTINATIONS, decided by PROVENANCE and never by channel. A
                  // logged entry opens the EDIT DRAWER (slice 8) and must never reach the two
                  // arms below, which route the row's id into a PLATFORM record. Offered only to
                  // somebody who may actually change it - the logger, or an org admin, holding
                  // the ability. See LeadCommunicationsTab for the full reasoning.
                  it.manuallyLogged
                    ? canLogPast && canModifyLoggedEntry(it, { id: viewer?.id, role: viewer?.role })
                      ? () => setEditingEntryId(it.id)
                      : undefined
                    : canAccessComms
                      ? it.channel === 'call'
                        ? () => setSelectedCallId(it.id)
                        : it.channel === 'sms' && it.threadId
                          ? () => setSelectedSmsThreadId(it.threadId ?? null)
                          : undefined
                      : undefined
                }
                className="py-3 first:pt-0 last:pb-0"
              />
            ))}
          </ol>
        )}

        {/* Composer — texts/emails sent here are stamped with this job at origin.
            Rendered only for comms-enabled orgs + users with create Communication
            (E5); everyone else gets the clean read-only timeline. */}
        {canCompose && (
        <div className="mt-4 border-t border-border pt-3">
          {/* Channel toggle — ocean active state (interactive chrome, never sage). */}
          <div className="mb-2 flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-border bg-background-light p-0.5">
              {(['sms', 'email'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  disabled={m === 'email' && !customerEmail}
                  onClick={() => setMode(m)}
                  className={cn(
                    'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                    mode === m
                      ? 'bg-primary text-on-fill shadow-sm'
                      : 'text-text-secondary hover:text-text-primary',
                    m === 'email' && !customerEmail && 'cursor-not-allowed opacity-50'
                  )}
                >
                  {m === 'sms' ? 'Text' : 'Email'}
                </button>
              ))}
            </div>
            {!customerEmail && (
              <span className="text-[11px] text-text-soft">No email on file for this customer.</span>
            )}
          </div>

          {mode === 'email' && (
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject"
              className="mb-2 h-9"
            />
          )}
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={mode === 'sms' ? `Text ${customerName}…` : `Email ${customerName}…`}
              className="min-h-0 flex-1 resize-none"
            />
            <Button variant="solid" tone="business" onClick={handleSend} disabled={sendPending || !body.trim()}>
              Send
            </Button>
          </div>
          {mode === 'sms' && sendSms.isError && (
            <p className="mt-1.5 text-sm text-danger">
              {extractApiError(sendSms.error, 'Failed to send text')}
            </p>
          )}
          {mode === 'email' && sendEmail.isError && (
            <p className="mt-1.5 text-sm text-danger">
              {extractApiError(sendEmail.error, 'Failed to send email')}
            </p>
          )}
          <p className="mt-1.5 flex items-center gap-2 text-[11px] text-text-soft">
            <span className="text-text-secondary/70">⌘↵ to send</span>·
            <span>
              {mode === 'sms' ? 'Texts' : 'Emails'} sent from this job are tagged {jobNumber}{' '}
              automatically.
            </span>
          </p>
        </div>
        )}
      </SectionCard>

      {selectedCallId && (
        <EntityCallDrawer callId={selectedCallId} onClose={() => setSelectedCallId(null)} />
      )}
      {selectedSmsThreadId && (
        <EntitySmsDrawer
          threadId={selectedSmsThreadId}
          customerName={customerName}
          onClose={() => setSelectedSmsThreadId(null)}
        />
      )}
      {/* ONE drawer for both jobs. `entryId` set = correcting an existing entry; absent = recording
          a new one. */}
      {(logOpen || editingEntryId) && (
        <LogCommunicationDrawer
          anchor={{ kind: 'job', id: jobId }}
          entryId={editingEntryId ?? undefined}
          customerId={customerId}
          customerName={customerName}
          onClose={() => {
            setLogOpen(false);
            setEditingEntryId(null);
          }}
        />
      )}
    </div>
  );
}
