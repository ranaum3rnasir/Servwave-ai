/**
 * Upload size and duration guidance (direct-to-storage PRD, slice 5).
 *
 * GUIDANCE ONLY. Nothing in this module touches the file's bytes. Every
 * function reads `File.size` / `File.type`, or a duration the browser
 * volunteered about a file it already had, and returns a string or a number.
 * There is deliberately no re-encode, no trim and no compression path here:
 * job footage can end up as evidence in a dispute, so degrading it silently to
 * save bandwidth is not a trade this product makes. The bytes uploaded are
 * exactly the bytes selected.
 *
 * The thresholds below are chosen against measured phone-camera output:
 * 1080p runs ~40-60 MB/min and 4K ~85-135 MB/min. See the notes on each.
 */

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/**
 * Past this, say something.
 *
 * It MUST stay below the size the client refuses at
 * (`MAX_VIDEO_UPLOAD_BYTES`), or the nudge is doomed copy: every file that
 * tripped it would be one the upload was never going to carry, and telling
 * someone they can "upload it as is" about a file that is about to be refused
 * is worse than saying nothing. `upload-guidance.test.ts` pins that inequality
 * so it cannot rot back.
 *
 * 25MB is roughly 30 seconds of 1080p. On a weak cell uplink (~2 Mbps) that is
 * already a couple of minutes and climbing, which is where it starts being
 * worth warning someone standing in a driveway. Below it the upload lands
 * inside their attention span even on a poor signal.
 *
 * THE CAP WENT TO 512MB AND THIS STAYED AT 25MB — deliberately, but not
 * confidently. It was originally picked as half of a 50MB cap; it is now a
 * twentieth of the cap, so the nudge fires far earlier relative to what is
 * allowed. The threshold that matters is the one where the WAIT becomes worth
 * mentioning, and that is a property of the uplink rather than of the cap:
 * 25MB is still a couple of minutes on a weak one, so the number is defensible
 * on its own terms even though its original derivation is gone. Retuning it
 * against the size distribution the raise exists to produce is the honest
 * move. The reachability test passes either way, so no gate will raise it:
 * this comment is the reminder.
 */
export const LARGE_UPLOAD_BYTES = 25 * MB;

/**
 * Past this, say something, however small the file came out.
 *
 * Duration is the honest predictor a technician can act on: they control how
 * long they film, not the bitrate their phone picked. Two minutes is the
 * walkthrough length the PRD works from, and a 2-minute clip is 80-120MB at
 * 1080p or 170-270MB at 4K — the point where a phone connection starts to
 * show. (Housecall Pro caps at ~1 minute; this only suggests, so it can
 * afford to be more generous.)
 */
export const LONG_CLIP_SECONDS = 120;

/** How long to wait for the browser to volunteer a duration before moving on. */
export const DURATION_PROBE_TIMEOUT_MS = 4000;

/**
 * Deliberately plain and deliberately short.
 *
 * No vendor name, no codec name, no file-format name, and nothing that reads as "you did
 * this wrong" - the clip is long, the person is not at fault.
 *
 * Three things the first draft got wrong, all of them user-facing:
 *
 *  - It ended "You can upload it as is." That implies an alternative - a trim, a quality
 *    setting - that exists nowhere in this product; it was a fossil of the re-encode design
 *    Ran rejected. On the surfaces that upload on pick it also granted permission for
 *    something already happening.
 *  - Both branches shared a tail reading "a shorter clip goes faster". The long-clip branch
 *    wins whenever both apply, so the LARGE branch is only ever seen by a file that is big
 *    and NOT long - a 30-second 4K clip - and that person was being told to film shorter.
 *    The advice is true for one branch only, so it now lives on that branch only.
 *  - Sentence one restated the duration already rendered two lines above, at 11px.
 */
export const LONG_CLIP_NUDGE =
  'Long clip — this can take a while on a phone connection. A shorter clip uploads faster.';

export const LARGE_FILE_NUDGE = 'Large file — this can take a while on a phone connection.';

/** Human-readable size: "512 B", "20.0 KB", "248.5 MB", "1.5 GB". */
export function formatUploadSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${(bytes / GB).toFixed(1)} GB`;
}

/**
 * A duration is only usable if it is a finite, positive number.
 *
 * This is not defensive padding: `HTMLMediaElement.duration` genuinely reports
 * `Infinity` for a fragmented or still-recording capture and `NaN` before
 * metadata arrives. Rendering either produces visible garbage, so an
 * unmeasurable clip is treated as "duration unknown" and simply omitted.
 */
export function normalizeClipDuration(raw: number | null | undefined): number | null {
  if (raw == null) return null;
  if (!Number.isFinite(raw)) return null;
  if (raw <= 0) return null;
  return raw;
}

/** Seconds -> "0:09", "2:05", "1:02:05". */
export function formatClipDuration(seconds: number): string {
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = String(secs).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

/** The one-line cost summary shown against a selected file, before it uploads. */
export function describeSelection(
  file: { size: number },
  durationSeconds: number | null
): string {
  const size = formatUploadSize(file.size);
  const duration = normalizeClipDuration(durationSeconds);
  return duration === null ? size : `${size} · ${formatClipDuration(duration)}`;
}

/**
 * The non-blocking nudge, or null when there is nothing worth saying.
 *
 * Returning a string is the whole of its power: no caller may treat it as a
 * veto. Video only — the non-video caps keep those files small, and "clip" is
 * the wrong word for a PDF.
 */
export function uploadNudge(
  file: { size: number; type: string },
  durationSeconds: number | null
): string | null {
  if (!file.type.startsWith('video/')) return null;
  const duration = normalizeClipDuration(durationSeconds);
  // Duration first: it is the thing the technician can actually change, and
  // saying both at once is a lecture.
  if (duration !== null && duration > LONG_CLIP_SECONDS) return LONG_CLIP_NUDGE;
  if (file.size > LARGE_UPLOAD_BYTES) return LARGE_FILE_NUDGE;
  return null;
}

/**
 * Real bytes -> a percentage, or null when the transport did not say how many
 * bytes there are in total.
 *
 * Null means "unknown", and callers must render it as unknown. Inventing a
 * number here would produce a progress bar that moves without describing
 * anything, which is worse than admitting the number is not available yet.
 */
export function progressPercent(loaded: number, total: number | undefined): number | null {
  if (!total || total <= 0) return null;
  return Math.min(100, Math.round((loaded * 100) / total));
}

export interface ProbeVideoDurationOptions {
  /** Injected in tests: jsdom implements no media pipeline. */
  createVideo?: () => HTMLVideoElement;
  timeoutMs?: number;
}

/**
 * Ask the browser how long a clip is, cheaply.
 *
 * `preload = 'metadata'` reads the container header only — it does not
 * download or decode the whole file, and it does not modify it. Resolves
 * null, never throws and never rejects: duration is a nicety, and a file
 * whose length cannot be determined must still upload normally.
 */
export function probeVideoDuration(
  file: File,
  opts: ProbeVideoDurationOptions = {}
): Promise<number | null> {
  const {
    createVideo = () => document.createElement('video'),
    timeoutMs = DURATION_PROBE_TIMEOUT_MS,
  } = opts;

  if (!file.type.startsWith('video/')) return Promise.resolve(null);

  return new Promise<number | null>((resolve) => {
    let settled = false;
    let objectUrl: string | null = null;
    const video = createVideo();

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('error', onError);
      // Drop the element's handle on the file and release the blob URL. A
      // retained <video> keeps the whole clip alive in memory, which is the
      // precise cost this PRD exists to stop paying.
      try {
        video.src = '';
      } catch {
        /* detached or stubbed element — nothing to release */
      }
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(value);
    };

    const onLoadedMetadata = () => finish(normalizeClipDuration(video.duration));
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);

    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('error', onError);
    video.preload = 'metadata';

    try {
      objectUrl = URL.createObjectURL(file);
      video.src = objectUrl;
    } catch {
      // No object-URL support (or a stubbed element): give up quietly.
      finish(null);
    }
  });
}
