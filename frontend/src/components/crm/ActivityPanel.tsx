import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow, format } from 'date-fns';
import api from '@/lib/axios';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useSettingsGuard } from '@/stores/settingsGuard.store';
import { getInitials } from '@/lib/utils';
import { toWallClock, useScheduleTimezone } from '@/lib/schedule-tz';
import { EmptyState } from '@/components/ui/empty-state';

type TimelineEntityType = 'LEAD' | 'JOB' | 'INVOICE';

interface ActivityPanelProps {
  entityType: TimelineEntityType;
  entityId: string;
}

interface NoteItem {
  id: string;
  content: string;
  created_at: string;
  creator: { id: string; first_name: string; last_name: string };
}

interface TimelineItem {
  id: string;
  event_type: string;
  description: string;
  created_at: string;
  creator?: { id: string; first_name: string; last_name: string } | null;
  metadata?: Record<string, unknown> | null;
}

type ActivityItem =
  | { type: 'note'; data: NoteItem }
  | { type: 'timeline'; data: TimelineItem };

// Parse schedule metadata ({ from, to } ISO timestamps) off SCHEDULED/RESCHEDULED
// events. metadata is Prisma Json — guard every hop; anything malformed → null.
function scheduleMeta(ev: TimelineItem): { from: string | null; to: string } | null {
  if (ev.event_type !== 'SCHEDULED' && ev.event_type !== 'RESCHEDULED') return null;
  const meta = ev.metadata;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const { from, to } = meta as { from?: unknown; to?: unknown };
  if (typeof to !== 'string') return null;
  // An ABSENT `from` and an explicit null are the same fact - "no previous time" - and
  // treating absent as malformed suppressed the schedule line entirely on every
  // RESCHEDULED row, which is the majority of them: only rows carrying an explicit
  // `from: null` rendered a line at all (8 of J00234's 11 rendered none). The writers
  // now always send `from`, but the rows already stored do not.
  if (from !== undefined && typeof from !== 'string' && from !== null) return null;
  return { from: typeof from === 'string' ? from : null, to };
}

/**
 * The shipped stamp shape, unchanged - only the ZONE moves. Kept on date-fns rather than
 * switched to formatInstant because Intl puts a comma between the date and the time
 * ("May 10, 2026, 10:00 AM") where this format does not, and this is a timezone fix, not
 * a copy change.
 */
const fmtSchedule = (iso: string, tz: string) =>
  format(toWallClock(new Date(iso), tz), 'MMM d, yyyy h:mm a');

/**
 * (b) Timeline descriptions embed a raw UTC instant - "Visit 2 scheduled for
 * 2026-08-25T17:00:00.000Z" - and are rendered verbatim, so every viewer in every zone
 * reads a bare Z string on the job page. The writers no longer emit these, but the rows
 * already on staging and in prod do, and nothing re-writes history; so any ISO-8601 UTC
 * instant left in a description is rendered on the ORG clock here instead.
 *
 * Anchored on the 'T' and the trailing 'Z' rather than on loose digits, so a job number,
 * a quantity or a plain date in the prose cannot match.
 */
const ISO_UTC = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g;

export function humanizeInstants(text: string, tz: string): string {
  return text.replace(ISO_UTC, (iso) => {
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : fmtSchedule(iso, tz);
  });
}

function entityRoute(entityType: string): string {
  return entityType.toLowerCase() + 's';
}

// Timeline endpoint is available for every TimelineEntityType (LEAD/JOB/INVOICE) — no
// ESTIMATE here: no GET /api/estimates/:id/timeline exists (estimates have their own richer
// HistoryPanel on audit_logs instead, see EstimateWorkspacePage). Narrowing entityType's type
// above makes a stray ESTIMATE mount a compile error rather than a silent 404.
const TIMELINE_ENTITY_TYPES: TimelineEntityType[] = ['JOB', 'LEAD', 'INVOICE'];

export function ActivityPanel({ entityType, entityId }: ActivityPanelProps) {
  const tz = useScheduleTimezone();
  const queryClient = useQueryClient();
  const [noteContent, setNoteContent] = useState('');
  const setDirty = useSettingsGuard((s) => s.setDirty);
  const noteDirty = noteContent.trim().length > 0;
  const route = entityRoute(entityType);

  // Publish the note draft's dirty state to the shared unsaved-changes guard so
  // navigation/panel-exit affordances warn before discarding it (#488). Cleanup
  // resets the flag, so both addNoteMutation.onSuccess (clears noteContent) and
  // component unmount clear it automatically — no stale dirty flag persists.
  useEffect(() => {
    setDirty(noteDirty);
    return () => setDirty(false);
  }, [noteDirty, setDirty]);

  // Cover full-page reload / tab close / external navigation with the native
  // browser prompt (mirrors SettingsLayout's beforeunload pattern).
  useEffect(() => {
    if (!noteDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [noteDirty]);

  // Fetch notes
  const { data: notesData, isLoading: notesLoading } = useQuery({
    queryKey: ['notes', entityType, entityId],
    queryFn: async () => {
      const { data } = await api.get(`/api/${route}/${entityId}/notes`);
      return data.notes as NoteItem[];
    },
  });

  // Fetch timeline (only for supported entity types)
  const hasTimeline = TIMELINE_ENTITY_TYPES.includes(entityType);
  const { data: timelineData, isLoading: timelineLoading } = useQuery({
    queryKey: ['timeline', entityType, entityId],
    queryFn: async () => {
      const { data } = await api.get(`/api/${route}/${entityId}/timeline`);
      return data.events as TimelineItem[];
    },
    enabled: hasTimeline,
  });

  // Add note mutation
  const addNoteMutation = useMutation({
    mutationFn: async (content: string) => {
      const { data } = await api.post(`/api/${route}/${entityId}/notes`, { content });
      return data.note;
    },
    onSuccess: () => {
      setNoteContent('');
      queryClient.invalidateQueries({ queryKey: ['notes', entityType, entityId] });
      queryClient.invalidateQueries({ queryKey: ['timeline', entityType, entityId] });
    },
  });

  const isLoading = notesLoading || (hasTimeline && timelineLoading);

  // Merge and sort reverse-chronologically
  const items: ActivityItem[] = [];
  if (notesData) {
    for (const note of notesData) {
      items.push({ type: 'note', data: note });
    }
  }
  if (timelineData) {
    for (const event of timelineData) {
      items.push({ type: 'timeline', data: event });
    }
  }
  items.sort((a, b) => {
    const dateA = new Date(a.data.created_at).getTime();
    const dateB = new Date(b.data.created_at).getTime();
    return dateB - dateA;
  });

  const rescheduleCount = (timelineData ?? []).filter(
    (e) => e.event_type === 'RESCHEDULED'
  ).length;

  return (
    <div className="flex flex-col h-full">
      {/* Note input */}
      <div className="p-3 border-b border-border space-y-2">
        <Textarea
          value={noteContent}
          onChange={(e) => setNoteContent(e.target.value)}
          placeholder="Add a note..."
          rows={3}
          // Deferred: this site forces text-sm with no min-height change, but Textarea's
          // only smaller rung (`sm`) bundles that font with min-h-16 (64px) - there is no
          // rung for "text-sm at the default 80px min-height", so size can't reproduce it.
          className="text-sm resize-none"
        />
        <Button
          size="sm"
          className="w-full"
          disabled={!noteContent.trim() || addNoteMutation.isPending}
          onClick={() => addNoteMutation.mutate(noteContent.trim())}
        >
          {addNoteMutation.isPending ? 'Adding...' : 'Add'}
        </Button>
        {addNoteMutation.error && (
          <p className="text-xs text-danger">Failed to add note</p>
        )}
      </div>

      {/* Activity list */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-3 space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-2">
                <Skeleton shape="circle" className="h-7 w-7 shrink-0" />
                <div className="flex-1 space-y-1">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-4 w-full" />
                </div>
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="No activity yet" className="px-4" />
        ) : (
          <div className="p-3 space-y-1">
            {rescheduleCount > 0 && (
              <div className="text-xs text-warning font-medium px-2.5 pb-1">
                Rescheduled {rescheduleCount} {rescheduleCount === 1 ? 'time' : 'times'}
              </div>
            )}
            {items.map((item) => {
              const isNote = item.type === 'note';
              const noteData = isNote ? (item.data as NoteItem) : null;
              const timelineData = !isNote ? (item.data as TimelineItem) : null;
              const creator = isNote ? noteData!.creator : timelineData!.creator;
              const initials = creator
                ? getInitials(`${creator.first_name} ${creator.last_name}`)
                : '??';
              const name = creator
                ? `${creator.first_name} ${creator.last_name}`
                : 'System';
              const content = isNote ? noteData!.content : timelineData!.description;
              const timeAgo = formatDistanceToNow(new Date(item.data.created_at), {
                addSuffix: true,
              });
              const sched = !isNote ? scheduleMeta(timelineData!) : null;

              return (
                <div
                  key={`${item.type}-${item.data.id}`}
                  className={`rounded-lg p-2.5 ${isNote ? 'bg-surface-light' : 'bg-background-light'}`}
                >
                  <div className="flex gap-2">
                    <div className="flex items-center justify-center h-7 w-7 rounded-full bg-primary/10 text-primary text-[10px] font-semibold shrink-0">
                      {initials}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-text-primary truncate">
                          {name}
                        </span>
                        <span className="text-[10px] text-text-secondary whitespace-nowrap">
                          {timeAgo}
                        </span>
                      </div>
                      <p className="text-xs text-text-secondary mt-0.5 whitespace-pre-wrap break-words">
                        {isNote ? content : humanizeInstants(content, tz)}
                      </p>
                      {sched && (
                        <p className="text-[11px] text-text-secondary mt-0.5">
                          {sched.from
                            ? `${fmtSchedule(sched.from, tz)} \u2192 ${fmtSchedule(sched.to, tz)}`
                            : `Scheduled for ${fmtSchedule(sched.to, tz)}`}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
