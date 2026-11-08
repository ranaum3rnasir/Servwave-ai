/**
 * The upload queue behind the fire-and-forget attachment surfaces
 * (direct-to-storage PRD, slice 5).
 *
 * Two things it exists to guarantee:
 *
 *  1. A selected file is RENDERED before it is sent. `enqueue` only adds rows
 *     to state; the transport is kicked off from an effect, which React runs
 *     after the commit. That is what makes "the size is visible before the
 *     upload starts" a fact about the code rather than a claim about timing.
 *
 *  2. There is exactly ONE seam for byte progress. `upload` receives an
 *     `onProgress(loaded, total)` callback and everything downstream — the
 *     bar, the percentage, the "we don't have a number" fallback — is derived
 *     from it. S2 replaced the body of `upload` with resumable transport and
 *     kept calling the same callback; neither this hook's progress plumbing
 *     nor `UploadSelectionList`'s rendering of it changed.
 *
 *  3. Since S2, a row in flight can be STOPPED. `cancel(key)` aborts that
 *     row's transfer through an `AbortSignal` handed to `upload`, and a
 *     cancelled row is not a failure: it raises no toast and reports nothing
 *     to `onSettled`.
 *
 * The queue is deliberately serial. Parallel uploads of phone video compete
 * for the same thin uplink and all of them finish later.
 *
 * Nothing here reads, copies, slices or rewrites the file. `file` goes into
 * state as the very object the picker produced and comes back out by
 * reference.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { probeVideoDuration } from '@/lib/attachments/uploadGuidance';
import { oversizeRefusalMessage } from '@/lib/uploadTypes';
import type { UploadSelectionView } from '@/components/attachments/UploadSelectionList';

export type UploadQueueItem = UploadSelectionView;

export interface UploadFailure {
  name: string;
  reason: string;
}

export interface UseUploadQueueOptions {
  /**
   * Performs the transfer. Must call `onProgress` with real byte counts when
   * the transport supplies them, and must not be called with a modified file.
   */
  upload: (
    file: File,
    onProgress: (loaded: number, total?: number) => void,
    signal: AbortSignal
  ) => Promise<unknown>;
  /** Runs once the batch is finished, with whatever failed. */
  onSettled?: (failures: UploadFailure[]) => void;
  /** Turns a rejection into user-facing copy. */
  describeError?: (err: unknown) => string;
}

let sequence = 0;

export function useUploadQueue({ upload, onSettled, describeError }: UseUploadQueueOptions) {
  const [items, setItems] = useState<UploadQueueItem[]>([]);
  /** Files refused before sending, as sentences to show. Replaced on each pick. */
  const [refusals, setRefusals] = useState<string[]>([]);

  // Kept in refs so a caller re-creating these inline on every render does not
  // restart the queue effect mid-upload. Synced in an effect rather than during
  // render, and declared BEFORE the queue effect so it has already run by the
  // time the queue reads them in the same commit.
  const uploadRef = useRef(upload);
  const settledRef = useRef(onSettled);
  const describeRef = useRef(describeError);
  useEffect(() => {
    uploadRef.current = upload;
    settledRef.current = onSettled;
    describeRef.current = describeError;
  });

  const inFlight = useRef(false);
  /**
   * WHICH row holds the flight, not merely that one does.
   *
   * `cancel` releases the queue immediately rather than waiting for the transport, so the
   * cancelled upload's `.then`/`.catch` can land while a LATER file is already in flight. A
   * bare boolean would then be cleared by the wrong row and two uploads would run at once,
   * on the thin uplink this queue is serial to protect.
   */
  const inFlightKey = useRef<string | null>(null);
  /** Guards the deferred settle against a double-invoked effect scheduling it twice. */
  const settling = useRef(false);
  /**
   * One abort controller per row that has started, so `cancel` can reach a transfer the
   * effect owns. Dropped as soon as the row is terminal, because a controller for a finished
   * upload is a handle onto nothing.
   */
  const controllers = useRef(new Map<string, AbortController>());
  /**
   * Rows the user stopped.
   *
   * The rejection a cancelled transfer produces is indistinguishable from a real failure by
   * the time it reaches `.catch` — it is just an Error with a message. Without this set the
   * catch would mark the row `error` and `onSettled` would raise "Upload failed" for
   * something the user did on purpose.
   */
  const cancelled = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    // Re-arm on every (re)mount. `main.tsx` mounts the app inside StrictMode, whose dev
    // double-effect runs setup -> cleanup -> setup; refs survive that, so a ref armed only at
    // creation and disarmed in a cleanup comes out of mount DISARMED and stays that way for
    // the component's whole life. Every `alive.current` check below would then early-return,
    // the queue would never mark a file probed, and all three surfaces would sit at
    // `isUploading` for ever in every dev build. Same remedy, and the same reason, as
    // `pages/v2/estimates/NewEstimateRedirect.tsx`.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Give up the queue's turn, but only if this row still holds it. */
  const releaseFlight = useCallback((key: string) => {
    if (inFlightKey.current !== key) return;
    inFlightKey.current = null;
    inFlight.current = false;
  }, []);

  const enqueue = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    /**
     * Refuse what the server would certainly refuse, and SAY SO.
     *
     * Two things go wrong without this. The obvious one is a doomed multipart request: the
     * whole file is pushed up only to be rejected on arrival, which on a phone connection
     * costs a technician minutes and their data allowance. The subtler one is that the nudge
     * would otherwise fire on a file that cannot upload at all, ending in "You can upload it
     * as is." about something certain to be refused.
     *
     * Refusing is only acceptable because it is VISIBLE. The behaviour this replaces on
     * AttachmentSection was a bare `continue`, and a file that vanishes with no message reads
     * as data loss rather than as a limit.
     */
    const refused = list
      .map((file) => oversizeRefusalMessage(file))
      .filter((message): message is string => message !== null);
    setRefusals(refused);

    const accepted = list.filter((file) => oversizeRefusalMessage(file) === null);
    if (accepted.length === 0) return;

    const added: UploadQueueItem[] = accepted.map((file) => ({
      key: `upload-${++sequence}`,
      file,
      durationSeconds: null,
      status: 'selected',
      loaded: 0,
      total: undefined,
    }));
    setItems((prev) => [...prev, ...added]);

    // Duration is patched in when the browser answers; the upload does NOT wait for it.
    //
    // An earlier revision made the queue wait, so the long-clip nudge was guaranteed to be on
    // screen before the first byte. That guarantee bought nothing real: these surfaces upload
    // on pick, so by the time a nudge could arrive the decision it would inform has already
    // been taken. It cost up to DURATION_PROBE_TIMEOUT_MS of dead time per video,
    // `isUploading` true before any byte moved, and a gate that wedged the whole surface if
    // the probe ever failed. AttachmentSection, the one surface with an explicit Upload
    // button and therefore the one where a pre-send nudge IS a decision, has always worked
    // this way.
    //
    // S2 gave these rows a Cancel, so the nudge is no longer unactionable after the fact -
    // a long clip can now be stopped. That weakens the old wording, not the conclusion:
    // waiting would still trade guaranteed dead time on every pick for a guarantee about
    // ordering, and the row is already on screen with its size either way.
    //
    // The `.catch` stays: a duration is a nicety, and an escaping rejection is an unhandled
    // one. The most a broken probe can cost is the clip length.
    const applyDuration = (key: string, duration: number | null) => {
      if (!alive.current || duration === null) return;
      setItems((prev) =>
        prev.map((p) => (p.key === key ? { ...p, durationSeconds: duration } : p))
      );
    };
    for (const item of added) {
      void probeVideoDuration(item.file)
        .then((duration) => applyDuration(item.key, duration))
        .catch(() => {
          /* no duration to show; the row keeps its size and uploads regardless */
        });
    }
  }, []);

  useEffect(() => {
    if (inFlight.current) return;

    const next = items.find((i) => i.status === 'selected');

    if (!next) {
      // Batch finished: report failures upward and reset. Errors are surfaced
      // by the caller (a toast, on every one of these surfaces), so the rows
      // clear rather than accumulating across pickers.
      const finished =
        items.length > 0 &&
        items.every(
          (i) => i.status === 'done' || i.status === 'error' || i.status === 'cancelled'
        );
      if (finished && !settling.current) {
        settling.current = true;
        // `cancelled` is deliberately absent. A stopped upload is not a failure and must not
        // reach the caller's toast as one.
        const failures = items
          .filter((i) => i.status === 'error')
          .map((i) => ({ name: i.file.name, reason: i.error ?? 'Upload failed.' }));
        cancelled.current.clear();
        controllers.current.clear();
        // Deferred, not synchronous: `onSettled` invalidates queries and raises
        // a toast, and neither belongs in the middle of an effect body that is
        // deciding what to upload next.
        queueMicrotask(() => {
          settling.current = false;
          if (!alive.current) return;
          settledRef.current?.(failures);
          setItems([]);
        });
      }
      return;
    }

    // This being an EFFECT is what puts the cost on screen before the first byte leaves:
    // React commits the row `enqueue` added before any effect runs. `inFlight` is claimed
    // here so a re-render cannot start the same file twice.
    inFlight.current = true;
    inFlightKey.current = next.key;
    // A no-op on this line ONLY because the effect above re-arms `alive` on every mount.
    // Before that fix StrictMode's setup -> cleanup -> setup left the ref disarmed and this
    // branch swallowed every upload in a dev build - so the previous wording here, "this
    // body is synchronous, so `alive` cannot already be false", asserted exactly the thing
    // StrictMode falsified. Kept because deleting it makes the setState below the effect's
    // first unconditional statement, which `react-hooks/set-state-in-effect` then flags
    // (measured: lint exits 1 without it). The same check IS live in the async
    // continuations below, where the component really can unmount mid-upload.
    if (!alive.current) {
      inFlight.current = false;
      return;
    }
    setItems((prev) =>
      prev.map((p) => (p.key === next.key ? { ...p, status: 'uploading' } : p))
    );

    // Created HERE, not in `cancel`: the control only exists while the row is uploading, and
    // by then the transfer must already be holding the signal. Making it on demand would
    // hand `upload` a signal nobody can trip.
    const controller = new AbortController();
    controllers.current.set(next.key, controller);

    uploadRef
      .current(
        next.file,
        (loaded, total) => {
          if (!alive.current) return;
          setItems((prev) => prev.map((p) => (p.key === next.key ? { ...p, loaded, total } : p)));
        },
        controller.signal
      )
      .then(() => {
        releaseFlight(next.key);
        controllers.current.delete(next.key);
        if (!alive.current) return;
        setItems((prev) => prev.map((p) => (p.key === next.key ? { ...p, status: 'done' } : p)));
      })
      .catch((err: unknown) => {
        const reason = describeRef.current?.(err) ?? 'Upload failed.';
        const wasCancelled = cancelled.current.has(next.key);
        releaseFlight(next.key);
        controllers.current.delete(next.key);
        if (!alive.current) return;
        // The state write happens on BOTH branches, including the cancelled one where the
        // status does not change. It has to: the settle above runs from this effect, the
        // effect only re-runs on a new `items` identity, and without a write here a
        // cancelled batch would sit for ever with `inFlight` false and nothing to wake it.
        setItems((prev) =>
          prev.map((p) =>
            p.key !== next.key
              ? p
              : wasCancelled
                ? { ...p, status: 'cancelled' }
                : { ...p, status: 'error', error: reason }
          )
        );
      });
  }, [items]);

  /**
   * Stop one row.
   *
   * Marks it before aborting so the rejection that follows is already known to be a cancel
   * rather than a failure, and sets the status straight away so the control disappears the
   * moment it is pressed instead of when the network notices.
   */
  const cancel = useCallback((key: string) => {
    cancelled.current.add(key);
    controllers.current.get(key)?.abort();
    controllers.current.delete(key);
    // Released HERE, not when the transport's promise settles.
    //
    // Aborting a chunked transfer means terminating the partial at the service, which is a
    // network DELETE the client retries on its own budget - tens of seconds on a bad link.
    // Waiting for it left the row marked `cancelled` while the next queued file did not
    // start, so the queue looked dead on exactly the connection where cancelling is most
    // likely. Nothing about the cancelled upload's cleanup needs the queue's turn.
    releaseFlight(key);
    setItems((prev) => prev.map((p) => (p.key === key ? { ...p, status: 'cancelled' } : p)));
  }, []);

  const isUploading = items.some((i) => i.status === 'uploading' || i.status === 'selected');

  return { items, refusals, enqueue, cancel, isUploading };
}
