/**
 * Customer page communications roll-up (Communication ↔ Jobs, Surface 3).
 * One unified Variant-A timeline across ALL channels (calls / SMS / email /
 * WhatsApp), newest first, every row badged by job — "badge it, don't hide it":
 * the muted "no job" pill keeps per-job legibility even for unattributed rows.
 *
 * Manual Communication Log — the CUSTOMER anchor (#2021). This tab was read-ONLY: it could show
 * an entry anchored to one of this customer's leads or jobs and could not record one, so a
 * conversation about the customer and about no one lead or job had nowhere to go, and a customer
 * holding neither could not be logged against at all. It now carries the same "Log communication"
 * entry point the lead and job tabs do, opening the same drawer with a CUSTOMER anchor, and a
 * logged row reopens it for correction.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, PencilLine } from 'lucide-react';
import api from '@/lib/axios';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAppAbility } from '@/contexts/AbilityContext';
import { useFeature } from '@/lib/entitlements';
import { CommRow } from '@/components/communication/shared/CommRow';
import { EntityCallDrawer } from '@/components/communication/shared/EntityCallDrawer';
import { EntitySmsDrawer } from '@/components/communication/shared/EntitySmsDrawer';
import { LogCommunicationDrawer } from '@/components/communication/shared/LogCommunicationDrawer';
import { EmptyState } from '@/components/ui/empty-state';
// Shared CommItem contract — single frontend declaration, field names FROZEN
// (mirrors the backend mapper).
import { canModifyLoggedEntry, newestFirst, type CommItem } from '@/lib/api/jobCommunications';
import { useAuthStore } from '@/stores/auth.store';
import { useScheduleTimezone, formatInstant } from '@/lib/schedule-tz';

function formatAt(at: string, tz: string) {
  return formatInstant(at, tz);
}

export function CustomerCommunicationsTab({ customerId }: { customerId: string }) {
  const tz = useScheduleTimezone();
  const ability = useAppAbility();
  const canAccessComms = useFeature('phone');
  // Manual Communication Log: gated on the `log_past Communication` ability and on NOTHING ELSE
  // — the ruling already made for the lead and job tabs. In particular NOT on `canAccessComms`,
  // which every other control on this tab is behind: the phone entitlement would hide the button
  // from exactly the organisations this feature exists for, the ones that do their calling
  // somewhere else and have nothing but hand-typed history to keep.
  const canLogPast = ability.can('log_past', 'Communication');
  // WHO IS LOOKING — the other half of the edit affordance below. The row rule is "the logger, or
  // an organisation admin", which the ability alone cannot answer.
  const viewer = useAuthStore((s) => s.user);
  // Row → detail drawer (calls only in this slice), gated on comms access — the
  // call/recording/transcript endpoints 404 for non-pilot orgs.
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  // #2046 (R1) — keyed by the row's own `threadId`; the drawer re-sources off the anchor-filtered
  // by-id thread read, so this never needs the section gate.
  const [selectedSmsThreadId, setSelectedSmsThreadId] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  /** The entry the drawer is reopened on. Null while it is being used to record a new one. */
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const { data: items, isLoading, isError } = useQuery({
    queryKey: ['customer-communications', customerId],
    queryFn: async () => {
      const { data } = await api.get(`/api/customers/${customerId}/communications`);
      return data.items as CommItem[];
    },
    enabled: Boolean(customerId),
    // Live refresh — a call/text lands as a webhook row seconds after hangup;
    // poll + refetch on focus so it appears without a manual reload (house
    // pattern, notifications.ts).
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  // Backend returns ascending (oldest first); the roll-up reads newest-first,
  // matching the page's "most recent" convention on the sibling tabs. One shared
  // sort — see `newestFirst`.
  const timeline = newestFirst(items);

  // ONE return, not four early ones. The action row and the drawer have to stand in every state
  // the timeline can be in — a customer with NOTHING logged yet is the case this whole change
  // exists for, and an early return on the empty branch is exactly how the button would go
  // missing there.
  return (
    <div>
      {canLogPast && (
        <div className="mb-3 flex items-center justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setLogOpen(true)}>
            <PencilLine className="mr-1.5 h-3.5 w-3.5" />
            Log communication
          </Button>
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
          title="No communication with this customer yet."
          description={
            canLogPast
              ? 'Log a past call, text or email to record contact that happened outside ServWave.'
              : undefined
          }
        />
      ) : (
      <ol className="space-y-0.5">
        {timeline.map((it) => (
          // Shared row (slice E6): same standard line as the Job/Lead tabs —
          // direction · who (· answered by) with navigable lead/job chips and
          // the gated attach/move/detach menu on call/sms/email rows.
          <CommRow
            key={it.id}
            item={it}
            formatTimestamp={(at) => formatAt(at, tz)}
            tz={tz}
            customerId={customerId}
            onSelect={
              // TWO DIFFERENT DESTINATIONS, decided by PROVENANCE and never by channel.
              //
              // A logged entry opens the EDIT DRAWER (#2021). It must never reach the two arms
              // below: they route the row's id into a PLATFORM record - EntityCallDrawer resolves
              // a CallSession by id, the sms arm opens the customer's real SMS thread - and a
              // logged entry lives in its own table, so the call arm dead-ends on "Couldn't load
              // this call" and the text arm opens a conversation that never contained it.
              //
              // …and only for somebody who may actually change it: `canLogPast` is the capability
              // half, `canModifyLoggedEntry` the row half (the logger, or an org admin). The API
              // enforces both again on the write - this decides what to OFFER. Same predicate and
              // same reasoning as the lead and job tabs.
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
      {selectedCallId && (
        <EntityCallDrawer callId={selectedCallId} onClose={() => setSelectedCallId(null)} />
      )}
      {selectedSmsThreadId && (
        <EntitySmsDrawer
          threadId={selectedSmsThreadId}
          onClose={() => setSelectedSmsThreadId(null)}
        />
      )}
      {/* ONE drawer for both jobs. `entryId` set = correcting an existing entry; absent =
          recording a new one. The anchor is this CUSTOMER either way — and naming a lead or a job
          inside the drawer is how an entry is moved onto one. */}
      {(logOpen || editingEntryId) && (
        <LogCommunicationDrawer
          anchor={{ kind: 'customer', id: customerId }}
          entryId={editingEntryId ?? undefined}
          customerId={customerId}
          onClose={() => {
            setLogOpen(false);
            setEditingEntryId(null);
          }}
        />
      )}
    </div>
  );
}
