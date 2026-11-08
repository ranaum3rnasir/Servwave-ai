/**
 * Lead page Communication tab (slice E4-FE + verification follow-up) — a unified
 * timeline over GET /api/leads/:id/communications: STRICTLY the rows attributed
 * to this lead by lead_id, matching the Job tab's job_id scoping exactly (full
 * job-parity ruling, 2026-07-22 — no customer-history union). A row whose
 * lead_id is null — e.g. a phone-matched call never explicitly tied to THIS
 * lead — will not surface here, same as an unattributed row on a job's timeline.
 *
 * Rendering rides the shared CommRow (E6): navigable job chips + the gated
 * attach/move/detach menu on call/sms/email rows, and the lead chip suppressed for
 * THIS lead's own rows (no self-link).
 *
 * Compose parity with the Job tab: a "Call customer" entry (in-app dialer with
 * lead context) + an SMS composer that stamps outgoing texts with this lead at
 * origin — both gated on comms-module access + create ability (a composer would
 * 403 for non-pilot orgs). Email-from-lead is intentionally omitted (the email
 * endpoint stamps job_id only, no lead_id yet).
 *
 * Manual Communication Log (2026-08-27): a "Log communication" entry in the SAME row, gated on
 * the new `log_past Communication` ability and on nothing else — see `canLogPast` below for why
 * it must not inherit the composer's three conditions. Clicking a logged row reopens that same
 * drawer on the entry, which is where it is corrected or removed (slice 8).
 */
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, Phone, PencilLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { extractApiError } from '@/lib/utils';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { requestCall } from '@/lib/communication/phoneTabHandoff';
import { CommRow } from '@/components/communication/shared/CommRow';
import { EntityCallDrawer } from '@/components/communication/shared/EntityCallDrawer';
import { EntitySmsDrawer } from '@/components/communication/shared/EntitySmsDrawer';
import { LogCommunicationDrawer } from '@/components/communication/shared/LogCommunicationDrawer';
import { EmptyState } from '@/components/ui/empty-state';
import { canModifyLoggedEntry, newestFirst, useLeadCommunications, useSendLeadSms } from '@/lib/api/jobCommunications';
import { useSpiderWatcherStore } from '@/stores/spiderWatcherStore';
import { useAuthStore } from '@/stores/auth.store';
import { useScheduleTimezone, formatInstant } from '@/lib/schedule-tz';
import api from '@/lib/axios';
import { useQueryClient } from '@tanstack/react-query';

function formatAt(at: string, tz: string) {
  return formatInstant(at, tz);
}

export function LeadCommunicationsTab({
  leadId,
  leadLabel,
  customerId,
  customerName,
  customerPhone,
}: {
  leadId: string;
  /** The lead's L-number — stamped into the composer caption + call context. */
  leadLabel?: string;
  /** The lead's customer — powers the open-jobs attach menu, SMS routing + call. */
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
}) {
  const tz = useScheduleTimezone();
  const queryClient = useQueryClient();
  const markLeadNotificationsRead = useSpiderWatcherStore((s) => s.markLeadNotificationsRead);
  const { data: items, isLoading, isError } = useLeadCommunications(leadId);
  const sendSms = useSendLeadSms(leadId);
  const ability = useAppAbility();
  const canAccessComms = useFeature('phone');
  // Composer + call entry: the org must have comms-module access AND the user
  // the create ability, and we need a customer to route SMS / bind the call —
  // otherwise this tab stays a clean read-only timeline.
  const canCompose =
    canAccessComms && ability.can('create', 'Communication') && !!customerId;
  // Manual Communication Log: gated on the NEW ability and on NOTHING ELSE.
  //
  // It deliberately inherits none of `canCompose`'s three conditions. The phone entitlement would
  // hide it from the organisations that never had ServWave Phone - the ones the feature exists
  // for. `create Communication` is the wrong gate (it is the shared baseline every role holds,
  // and it gates click-to-call and texts, not this). And a resolved customer is not needed to
  // record that someone was spoken to. This is why the button gets its own row below rather than
  // joining the composer's.
  const canLogPast = ability.can('log_past', 'Communication');
  // WHO IS LOOKING — the other half of the edit affordance below. The row-level rule is "the
  // logger, or an organisation admin", and neither half can be answered from the ability alone.
  const viewer = useAuthStore((s) => s.user);

  const [searchParams, setSearchParams] = useSearchParams();
  const [body, setBody] = useState(() => (searchParams.get('draft') || '').slice(0, 500));
  const [logOpen, setLogOpen] = useState(false);
  /** The entry the drawer is reopened on. Null while it is being used to record a new one. */
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);

  // Pre-fill composer if a draft message was provided via URL (e.g. from Spider Notification), capped at 500 chars
  useEffect(() => {
    const draft = searchParams.get('draft');
    if (draft && draft.slice(0, 500) !== body) {
      setBody(draft.slice(0, 500));
    }
  }, [searchParams]);

  // Row → detail drawer (calls only in this slice), gated on comms access.
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  // #2046 (R1) — keyed by the row's own `threadId`, not the tab's `customerId`; the drawer
  // re-sources off the anchor-filtered by-id thread read, so this never needs the section gate.
  const [selectedSmsThreadId, setSelectedSmsThreadId] = useState<string | null>(null);

  const handleSend = () => {
    const trimmed = body.trim();
    if (!trimmed || sendSms.isPending || !customerId) return;
    sendSms.mutate(
      { customerId, body: trimmed },
      {
        onSuccess: async () => {
          setBody('');
          const notifId = searchParams.get('notifId');
          if (notifId) {
            try {
              await api.patch(`/api/notifications/${notifId}/read`);
              queryClient.invalidateQueries({ queryKey: ['notifications'] });
            } catch (err) {
              console.warn('Failed to mark notification as read:', err);
            }
          }
          if (leadId) {
            markLeadNotificationsRead(leadId, 'new-contacted');
          }
          if (searchParams.has('draft') || searchParams.has('notifId')) {
            const next = new URLSearchParams(searchParams);
            next.delete('draft');
            next.delete('notifId');
            setSearchParams(next, { replace: true });
          }
        },
      },
    );
  };

  // Backend returns ascending (oldest first); the roll-up reads newest-first,
  // matching the Customer page convention. One shared sort — see `newestFirst`.
  const timeline = newestFirst(items);

  return (
    <div>
      {/* The action row. Two INDEPENDENT conditions, never one: "Call customer" needs the phone
          entitlement, the create ability and a customer with a phone number; "Log communication"
          needs only the logging ability. They sit side by side where both apply, and each stands
          alone where the other does not - which is the whole placement decision. */}
      {(canLogPast || (canCompose && customerPhone)) && (
        <div className="mb-3 flex items-center justify-end gap-2">
          {canLogPast && (
            <Button size="sm" variant="outline" onClick={() => setLogOpen(true)}>
              <PencilLine className="mr-1.5 h-3.5 w-3.5" />
              Log communication
            </Button>
          )}
          {canCompose && customerPhone && (
            /* Interactive chrome → ocean (default), never sage. */
            <Button
              size="sm"
              onClick={() =>
                requestCall(customerPhone, {
                  leadId,
                  leadLabel,
                  customerId,
                  customerName,
                })
              }
            >
              <Phone className="mr-1.5 h-3.5 w-3.5" />
              Call customer
            </Button>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex gap-3 px-2 py-2.5">
              <Skeleton className="h-4 w-4 shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-72" />
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <p className="text-sm text-danger">Failed to load communications.</p>
        </div>
      ) : timeline.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No communication on this lead yet."
          description={
            canLogPast
              ? 'Log a past call, text or email to record contact that happened outside ServWave.'
              : undefined
          }
        />
      ) : (
        <ol className="space-y-0.5">
          {timeline.map((it) => (
            <CommRow
              key={it.id}
              item={it}
              formatTimestamp={(at) => formatAt(at, tz)}
              tz={tz}
              currentLeadId={leadId}
              customerId={customerId}
              onSelect={
                // TWO DIFFERENT DESTINATIONS, decided by PROVENANCE and never by channel.
                //
                // A logged entry opens the EDIT DRAWER (slice 8) — the destination slice 6's gate
                // was holding the click open for. It must never reach the two arms below: they
                // route the row's id into a PLATFORM record (EntityCallDrawer resolves a
                // CallSession by id; the sms arm opens the customer's real SMS thread), and a
                // logged entry lives in its own table, so the call arm yielded a dead-end drawer
                // reading "Couldn't load this call" and the text arm a conversation that never
                // contained it.
                //
                // Provenance and not channel, because channel stopped being a constant in slice
                // 6: a channel-shaped condition would leak again the moment a text or an email
                // could be logged. Same predicate, same reason, as CommRowJobControl's refusal.
                //
                // …and only for somebody who may actually change it. A row offering an edit that
                // 403s is worse than a row offering nothing. `canLogPast` is the capability half;
                // `canModifyLoggedEntry` is the row half (the logger, or an org admin). The API
                // enforces both again on the write — this decides what to OFFER, not what is
                // allowed.
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
              className="rounded-lg px-2 py-2.5 hover:bg-background-light"
            />
          ))}
        </ol>
      )}

      {/* Composer — texts sent here are stamped with this lead at origin.
          Rendered only for comms-enabled orgs + users with create Communication;
          everyone else gets the clean read-only timeline. */}
      {canCompose && (
        <div className="mt-4 border-t border-border pt-3">
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
              placeholder={`Text ${customerName ?? 'customer'}…`}
              className="min-h-0 flex-1 resize-none"
            />
            <Button
              variant="solid" tone="business"
              onClick={handleSend}
              disabled={sendSms.isPending || !body.trim()}
            >
              Send
            </Button>
          </div>
          {sendSms.isError && (
            <p className="mt-1.5 text-sm text-danger">
              {extractApiError(sendSms.error, 'Failed to send text')}
            </p>
          )}
          <p className="mt-1.5 flex items-center gap-2 text-[11px] text-text-soft">
            <span className="text-text-secondary/70">⌘↵ to send</span>·
            <span>
              Texts sent from this lead are tagged {leadLabel ?? 'to this lead'} automatically.
            </span>
          </p>
        </div>
      )}

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
          a new one. The anchor is this lead either way — and switching it inside the drawer is
          how an entry is moved onto a job. */}
      {(logOpen || editingEntryId) && (
        <LogCommunicationDrawer
          anchor={{ kind: 'lead', id: leadId }}
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
