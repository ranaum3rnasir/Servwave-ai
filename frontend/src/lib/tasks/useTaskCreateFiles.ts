/**
 * Files picked in a New Task dialog (visits-and-task-categories slice 13).
 *
 * One hook behind BOTH create dialogs - the Tasks page's and the legacy one the job, lead,
 * customer and estimate task tabs mount - so the queue lives in one place.
 *
 * Why not `useUploadQueue`: that queue uploads the moment a file is picked and clears its rows
 * when the batch settles, with failures reported only as a toast. Here neither holds. A file
 * cannot go anywhere until the task it belongs to exists, and a failed file must stay on screen,
 * named, with a Retry - the task is already created, so "try the whole thing again" is not an
 * option the user has.
 *
 * The lifecycle:
 *   1. `add` - refuse what the server would refuse (type, size) with a sentence, queue the rest.
 *      Nothing is sent. `remove` drops a queued file; `reset` (the dialog's Cancel) drops them all.
 *   2. `uploadTo(taskId)` - after the task is created. Serial, like every other upload surface:
 *      parallel phone uploads share one thin uplink and all finish later. Each file's outcome is
 *      its own; a failure never stops the files behind it and never undoes the task.
 *   3. `retry(key)` / `cancel(key)` - per file, against the same task.
 *
 * A cancel is not proof the file is absent. Aborting the multipart request stops the browser,
 * not bytes the server already has, so a late cancel can still leave a stored attachment - and
 * a Retry on top of it stores the same file twice. So once a cancel settles, and again before a
 * cancelled row is retried, the task's attachments are read back: a file the server has is shown
 * as uploaded and counted, and Retry is offered only for one it does not.
 *
 * Transport is `uploadAttachment`'s decision, as everywhere else: video takes the resumable
 * direct path, keyed by the new task's id, everything else the multipart route.
 *
 * Every success reports the running count to the tasks store, so the new task's board card shows
 * its files as they land rather than after a reload.
 */
import { useCallback, useRef, useState } from 'react';

import api from '@/lib/axios';
import type { UploadSelectionView } from '@/lib/attachments/uploadSelection';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';
import { probeVideoDuration } from '@/lib/attachments/uploadGuidance';
import { oversizeRefusalMessage, unsupportedTypeRefusalMessage } from '@/lib/uploadTypes';
import { TASK_ATTACHMENT_ENTITY } from '@/lib/tasks/types';
import { extractApiError } from '@/lib/utils';
import { useTasksStore } from '@/stores/tasksStore';

let sequence = 0;

function refusalFor(file: File): string | null {
  return unsupportedTypeRefusalMessage(file) ?? oversizeRefusalMessage(file);
}

export interface TaskCreateFiles {
  items: UploadSelectionView[];
  /** Picks refused before anything was sent, as sentences. Replaced on each pick. */
  refusals: string[];
  /** The task the files are going to, once it exists. Null while the form is still a draft. */
  taskId: string | null;
  /** A file is being sent right now. The dialog must not close under it. */
  uploading: boolean;
  /** Files that did not make it (errors only - a cancel is the user's own choice). */
  failed: UploadSelectionView[];
  add: (files: FileList | File[]) => void;
  remove: (key: string) => void;
  /** Forget everything: the dialog closed. Never called mid-upload. */
  reset: () => void;
  /**
   * Upload every queued file to the new task. Resolves true when every file landed and the user
   * stopped none of them - the dialog closes on true, and a cancel owes the user its outcome.
   */
  uploadTo: (taskId: string) => Promise<boolean>;
  retry: (key: string) => Promise<void>;
  cancel: (key: string) => void;
}

export function useTaskCreateFiles(): TaskCreateFiles {
  const setAttachmentCount = useTasksStore((s) => s.setAttachmentCount);

  const [items, setItems] = useState<UploadSelectionView[]>([]);
  const [refusals, setRefusals] = useState<string[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // The upload loop is async and must read the rows as they are NOW, not as the render that
  // started it saw them, so the rows live in a ref and every write goes through `commit`.
  const itemsRef = useRef<UploadSelectionView[]>([]);
  const commit = useCallback((next: UploadSelectionView[]) => {
    itemsRef.current = next;
    setItems(next);
  }, []);
  const patch = useCallback(
    (key: string, change: Partial<UploadSelectionView>) =>
      commit(itemsRef.current.map((i) => (i.key === key ? { ...i, ...change } : i))),
    [commit],
  );

  const busy = useRef(false);
  const uploaded = useRef(0);
  /** The user stopped a transfer in this run: show them the outcome rather than closing on it. */
  const stopped = useRef(false);
  const controllers = useRef(new Map<string, AbortController>());

  const add = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setRefusals(list.map(refusalFor).filter((m): m is string => m !== null));

      const added: UploadSelectionView[] = list
        .filter((file) => refusalFor(file) === null)
        .map((file) => ({
          key: `task-file-${++sequence}`,
          file,
          durationSeconds: null,
          status: 'selected',
          loaded: 0,
        }));
      if (added.length === 0) return;
      commit([...itemsRef.current, ...added]);

      // A nicety for the long-clip nudge; nothing waits on it.
      for (const item of added) {
        void probeVideoDuration(item.file)
          .then((duration) => {
            if (duration !== null) patch(item.key, { durationSeconds: duration });
          })
          .catch(() => {
            /* no duration to show */
          });
      }
    },
    [commit, patch],
  );

  const remove = useCallback(
    (key: string) => commit(itemsRef.current.filter((i) => i.key !== key)),
    [commit],
  );

  const reset = useCallback(() => {
    commit([]);
    setRefusals([]);
    setTaskId(null);
    uploaded.current = 0;
  }, [commit]);

  /**
   * Whether the server holds `item` on the task, read back rather than assumed. Matched by name
   * and size against the task's attachments, less the rows already shown as uploaded for the same
   * name and size - the task is brand new, so everything on it came from this dialog. Also syncs
   * the count to the server's. A failed read answers false: Retry stays on offer.
   */
  const landed = useCallback(
    async (target: string, item: UploadSelectionView) => {
      try {
        const { data } = await api.get(`/api/attachments/${TASK_ATTACHMENT_ENTITY}/${target}`);
        const rows = (data?.attachments ?? []) as { file_name: string; file_size: number }[];
        const same = (r: { file_name: string; file_size: number }) =>
          r.file_name === item.file.name && r.file_size === item.file.size;
        const claimed = itemsRef.current.filter(
          (i) => i.key !== item.key && i.status === 'done' && i.file.name === item.file.name && i.file.size === item.file.size,
        ).length;
        const onServer = rows.filter(same).length > claimed;
        uploaded.current = rows.length;
        setAttachmentCount(target, rows.length);
        return onServer;
      } catch {
        return false;
      }
    },
    [setAttachmentCount],
  );

  const uploadOne = useCallback(
    async (target: string, item: UploadSelectionView) => {
      if (item.status === 'cancelled' && (await landed(target, item))) {
        patch(item.key, { status: 'done' });
        return;
      }
      patch(item.key, { status: 'uploading', loaded: 0, total: undefined, error: undefined });
      const controller = new AbortController();
      controllers.current.set(item.key, controller);
      try {
        await uploadAttachment({
          entityType: TASK_ATTACHMENT_ENTITY,
          entityId: target,
          file: item.file,
          onProgress: (loaded, total) => patch(item.key, { loaded, total }),
          signal: controller.signal,
        });
        patch(item.key, { status: 'done' });
        uploaded.current += 1;
        setAttachmentCount(target, uploaded.current);
      } catch (err) {
        if (!controller.signal.aborted) {
          patch(item.key, { status: 'error', error: extractApiError(err, 'Upload failed.') });
        } else {
          patch(item.key, { status: (await landed(target, item)) ? 'done' : 'cancelled' });
        }
      } finally {
        controllers.current.delete(item.key);
      }
    },
    [landed, patch, setAttachmentCount],
  );

  /** Holds the one upload turn for `run`; false when another run already holds it. */
  const withTurn = useCallback(async (run: () => Promise<void>) => {
    if (busy.current) return false;
    busy.current = true;
    setUploading(true);
    try {
      await run();
    } finally {
      busy.current = false;
      setUploading(false);
    }
    return true;
  }, []);

  const uploadTo = useCallback(
    async (target: string) => {
      const queued = itemsRef.current.filter((i) => i.status === 'selected');
      if (queued.length === 0) return true;
      // A refusal was about the draft's picker, which is gone once the task exists.
      setRefusals([]);
      setTaskId(target);
      uploaded.current = 0;
      stopped.current = false;
      await withTurn(async () => {
        for (const item of queued) await uploadOne(target, item);
      });
      return !stopped.current && itemsRef.current.every((i) => i.status === 'done');
    },
    [uploadOne, withTurn],
  );

  const retry = useCallback(
    async (key: string) => {
      const item = itemsRef.current.find((i) => i.key === key);
      if (!item || !taskId) return;
      await withTurn(() => uploadOne(taskId, item));
    },
    [taskId, uploadOne, withTurn],
  );

  const cancel = useCallback((key: string) => {
    stopped.current = true;
    controllers.current.get(key)?.abort();
  }, []);

  return {
    items,
    refusals,
    taskId,
    uploading,
    failed: items.filter((i) => i.status === 'error'),
    add,
    remove,
    reset,
    uploadTo,
    retry,
    cancel,
  };
}
