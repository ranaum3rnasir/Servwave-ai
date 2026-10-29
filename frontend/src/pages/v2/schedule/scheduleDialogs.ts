import { lazyWhenOpened } from '@/lib/platform/lazyWhenOpened';
import { runAfterSettle } from '@/lib/platform/runAfterSettle';

/**
 * The scheduler's dialogs that are mounted once and driven by an `open` prop.
 *
 * They are fetched the first time one opens, not with the board (mobile slice 61, PERF-03): most
 * visits never open one, and together with the form controls only they use (customer picker,
 * address search, date and time fields, the crew picker) they were a fifth of the scheduler's first
 * download, which on a phone line is the page's largest paint. `__tests__/dialogsAreLazy.test.ts`
 * fails if one of them is imported statically again.
 *
 * Dialogs that are rendered only while a state is set (the conflict, needs-crew, unschedule and
 * reschedule confirms) are small and stay as they are.
 */
export const AssignJobDialog = lazyWhenOpened(
  () => import('@/components/jobs/AssignJobDialog'),
  (m) => m.AssignJobDialog,
);
export const CancelJobDialog = lazyWhenOpened(
  () => import('@/components/jobs/CancelJobDialog'),
  (m) => m.CancelJobDialog,
);
export const ScheduleCreatePopover = lazyWhenOpened(
  () => import('./creation/scheduleCreatePopover'),
  (m) => m.ScheduleCreatePopover,
);
export const EventEditor = lazyWhenOpened(
  () => import('./components/eventEditor'),
  (m) => m.EventEditor,
);
export const EventEntryDialog = lazyWhenOpened(
  () => import('./components/eventEntryDialog'),
  (m) => m.EventEntryDialog,
);
export const UnifiedDropModal = lazyWhenOpened(
  () => import('./components/unifiedDropModal'),
  (m) => m.UnifiedDropModal,
);

const ALL = [AssignJobDialog, CancelJobDialog, ScheduleCreatePopover, EventEditor, EventEntryDialog, UnifiedDropModal];

/**
 * Download the dialogs once the board has settled (load, then a quiet period, then an idle moment),
 * so the first tap on a card or an empty slot opens its dialog straight away, without putting any
 * of them on the wire while the board's own data is still being fetched. Returns the cancel
 * function, for an effect cleanup.
 */
export function warmScheduleDialogs(): () => void {
  return runAfterSettle(() => {
    for (const dialog of ALL) dialog.preload();
  });
}
