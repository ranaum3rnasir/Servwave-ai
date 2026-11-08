/**
 * VideoPlayer — the one interactive `<video>` this app renders, plus the fallback that replaces
 * it when the browser genuinely cannot play the file.
 *
 * WHY THIS EXISTS. Technicians film jobs on phones. Since iOS 13.6.1 the mobile browser no longer
 * transcodes on upload, so what reaches storage is the original capture, which for the default
 * camera setting is an H.265/HEVC track. Those files upload and store fine and play on machines
 * with a hardware decoder, and fail to decode on the desktops dispatchers sit at. A bare
 * `<video src controls>` renders a black rectangle with no explanation and no way out.
 *
 * DETECTION IS THE RUNTIME `error` EVENT, AND ONLY THAT.
 *
 * An earlier revision also ran a `canPlayType(mimeType)` pre-check. It was REMOVED, and the
 * deletion is the point of this comment: we store the CONTAINER type, never the codec, and
 * `canPlayType('video/quicktime')` answers `''` on Chrome and Firefox for `.mov` files those
 * browsers play perfectly (measured on Chrome 152: `readyState 4`, real `videoWidth`,
 * `error: null`). `video/quicktime` is a first-class accepted upload type (`lib/uploadTypes.ts`),
 * so an H.264 `.mov` — the iPhone "Most Compatible" setting, Android, every Mac export — is the
 * COMMON case, and the pre-check hid all of it behind "can't play". A false positive that buries
 * working footage is worse than the bug this component exists to fix. Qualifying the string with
 * codec parameters would not save it either: those parameters are exactly what we do not have.
 *
 * WHAT THE ERROR CODE CANNOT TELL US. Chrome reports HTTP 403 and 404 as `MediaError.code === 4`
 * (`MEDIA_ELEMENT_ERROR: Format error`) — the same code as a real unsupported-format failure.
 * Attachment URLs are signed with a 1h TTL and an expired one is an ordinary occurrence, not an
 * edge case, so a code-only reading tells a user whose link merely timed out that their browser
 * cannot play the file and to go try another browser. The code is therefore a hint only; the
 * file's REACHABILITY is the discriminator, and it is measured (see `probeUrl`).
 *
 * And reachability is not read off the status line alone. Measured against the real storage host,
 * an expired signature answers HTTP 400 — not the 401 the vendor documents — so the error BODY is
 * what identifies expiry. Classifying a bare 400 as "gone" would swallow every genuine
 * malformed-request failure, which is why `probeUrl` looks at the payload instead.
 *
 * SCOPE. Native `<video>` stays; no transcode step, no player library.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RotateCcw, VideoOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { downloadFromUrl } from '@/lib/attachments/downloadAttachment';

/** What the fallback says, once we know enough to say something true. */
type Status =
  /** The element is live; nothing is wrong. */
  | 'playing'
  /** It failed, and the reachability probe has not answered yet. Copy must hold for any outcome. */
  | 'checking'
  /** The bytes are there and this browser cannot decode them. Downloading is the way out. */
  | 'unsupported'
  /** The link is gone (expired signature, deleted object). Retrying is the way out. */
  | 'expired'
  /** Something else, or the probe itself could not be read. Say only what we know. */
  | 'unavailable';

interface PlayerState {
  /** The `src` PROP this state belongs to, so a new file resets rather than inherits a verdict. */
  forSrc: string;
  /** What the element is actually pointed at — a refreshed signed URL replaces it in place. */
  activeSrc: string;
  status: Status;
}

function freshState(src: string): PlayerState {
  return { forSrc: src, activeSrc: src, status: 'playing' };
}

export interface VideoPlayerProps {
  /** The video URL. Signed and short-lived for stored attachments. */
  src: string;
  /**
   * The stored container MIME type, when the caller has it. It no longer gates playback (see the
   * header) — it is used only to give a downloaded file the right extension when the URL carries
   * no usable filename.
   */
  mimeType?: string | null;
  className?: string;
  autoPlay?: boolean;
  /**
   * Preferred download path, for callers holding the attachment record: they get the correct
   * save-as name, a re-minted link on a stale-URL retry, and a failure toast. Omitted, the
   * fallback still downloads, just with a name derived from the URL.
   */
  onDownload?: () => void;
  /**
   * Re-reads a fresh signed URL for this file, returning `null` when there is none. Supplied, an
   * expired link is rescued silently — the video just plays — instead of being reported to
   * someone who can do nothing about a signature TTL.
   * `lib/attachments/downloadAttachment.ts` exports `makeAttachmentUrlRefresher` to build one.
   */
  onRefreshUrl?: () => Promise<string | null>;
}

type Reachability = 'ok' | 'gone' | 'unknown';

/**
 * Statuses that mean "the object is not there for you" on their own, with no body to read.
 *
 * The storage host this app actually talks to does NOT use these for an expired signature (see
 * `SIGNATURE_FAILURE_CODES`), but they are what the HTTP semantics say and what another
 * deployment — or a future version of this one — may well answer, so they cost nothing to keep.
 */
const GONE_STATUSES = new Set([401, 403, 404, 410]);

/**
 * Error codes that mean the SIGNATURE failed, not that the request was malformed.
 *
 * Measured against the real storage host: an expired signed URL answers **HTTP 400**, not the 401
 * the vendor's published error table claims, with
 * `{"statusCode":"400","error":"InvalidJWT","message":"\"exp\" claim timestamp check failed",
 * "code":"InvalidJWT"}`. A bare 400 is far too generic to read as expiry — it would swallow every
 * genuine malformed-request failure — so the STATUS alone is not enough and the BODY is what
 * identifies it. The error responses carry `access-control-allow-origin: *`, so the body is
 * readable cross-origin.
 *
 * The siblings are included because the same family of failures surfaces under different names
 * depending on how the object is addressed; all of them mean "this link no longer authenticates",
 * which is precisely the condition a re-mint fixes.
 */
const SIGNATURE_FAILURE_CODES = new Set([
  'invalidjwt',
  'invalidtoken',
  'expiredtoken',
  'invalidsignature',
  'signaturedoesnotmatch',
]);

/**
 * A probe must settle. Without a deadline a hung request parks the user in `checking` for ever,
 * which offers no Try again and no way back to the player — a nicer-looking version of the dead
 * rectangle this whole component exists to remove.
 */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Does this error body say the signature failed? Anything we cannot parse, or that is shaped
 * differently, is NOT expiry: the safe default is `unknown`, which tells the user only what we
 * actually know. Never throws.
 */
function isSignatureFailure(body: string): boolean {
  if (!body) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const { code, error } = parsed as { code?: unknown; error?: unknown };
  return [code, error].some(
    (v) => typeof v === 'string' && SIGNATURE_FAILURE_CODES.has(v.toLowerCase()),
  );
}

/**
 * Is the file still THERE? This is the discriminator the `MediaError` code cannot give us.
 *
 * `Range: bytes=0-0` asks for a single byte: it is a CORS-safelisted header, so no preflight, and
 * the host answers 206 with a 1-byte body instead of streaming a whole video down a metered
 * connection. A success is abandoned the moment the status line is read; an error body is small
 * and IS read, because on this host the status alone cannot tell expiry from a bad request.
 *
 * `unknown` is a real answer and is kept distinct from both others. When we cannot tell an
 * expired link from a dead network, we say that, rather than guessing at the user's expense.
 */
async function probeUrl(url: string): Promise<Reachability> {
  // Nothing to expire, and no request worth making.
  if (/^(data|blob):/i.test(url)) return 'ok';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal: controller.signal });
    if (res.ok) {
      controller.abort(); // stop the body; we only wanted the status
      return 'ok';
    }
    if (GONE_STATUSES.has(res.status)) return 'gone';
    // The deadline still bounds this read, so a pathological error body cannot hang the probe.
    const body = await res.text().catch(() => '');
    return isSignatureFailure(body) ? 'gone' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

export function VideoPlayer({
  src,
  mimeType,
  className,
  autoPlay,
  onDownload,
  onRefreshUrl,
}: VideoPlayerProps) {
  const [state, setState] = useState<PlayerState>(() => freshState(src));

  // A new file gets a fresh verdict. Without this, one unplayable video poisons every video
  // opened after it: these overlays stay mounted and swap `src` rather than remounting.
  //
  // Adjusted DURING render off the tracked previous value, not in an effect — React re-runs the
  // component before committing, so a stale fallback never paints against the new file, and the
  // effect version of this is the cascading render `set-state-in-effect` exists to stop.
  if (state.forSrc !== src) setState(freshState(src));
  const current = state.forSrc === src ? state : freshState(src);

  // `onRefreshUrl` is usually an inline arrow, so it has a new identity every render. Held in a
  // ref so the diagnosis callback is not rebuilt and re-armed on each parent render.
  const refreshRef = useRef(onRefreshUrl);
  useEffect(() => {
    refreshRef.current = onRefreshUrl;
  }, [onRefreshUrl]);

  // One refresh attempt per file: a refresher that keeps handing back dead links must not loop.
  //
  // A REF, not part of `PlayerState`, because the claim has to be made synchronously — a
  // functional `setState` updater runs during the next render, not at the call site, so a flag
  // read back out of one would always be the stale value.
  //
  // It stores the `src` the attempt was claimed for, never a boolean, so it needs no reset when
  // the file changes: a leftover value from a previous video simply does not match the new
  // `ownerSrc`. That is also what keeps it out of the render path, where touching a ref is
  // forbidden.
  const refreshAttemptedFor = useRef<string | null>(null);

  /**
   * Work out WHY playback failed, then say it. Every transition is guarded on `forSrc`: the user
   * can open a different video while a probe is in flight, and a late answer must not overwrite
   * the new file's state.
   */
  const diagnose = useCallback(async (failedSrc: string, ownerSrc: string) => {
    const reach = await probeUrl(failedSrc);

    if (reach === 'gone') {
      // Claim the single attempt synchronously, so two errors racing for the same file cannot
      // both fire the refresher.
      const canRefresh = Boolean(refreshRef.current) && refreshAttemptedFor.current !== ownerSrc;

      if (canRefresh) {
        refreshAttemptedFor.current = ownerSrc;
        const fresh = await refreshRef.current?.().catch(() => null);
        setState((prev) => {
          if (prev.forSrc !== ownerSrc) return prev;
          // A refresher that hands back the same dead string has rescued nothing.
          if (fresh && fresh !== prev.activeSrc) {
            return { ...prev, activeSrc: fresh, status: 'playing' };
          }
          return { ...prev, status: 'expired' };
        });
        return;
      }
    }

    setState((prev) => {
      if (prev.forSrc !== ownerSrc) return prev;
      const status: Status =
        reach === 'ok' ? 'unsupported' : reach === 'gone' ? 'expired' : 'unavailable';
      return { ...prev, status };
    });
  }, []);

  const handleError = useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const failedSrc = e.currentTarget.currentSrc || e.currentTarget.src;
      // Any error leaves a dead player, so any error gets the fallback. Which message it gets is
      // the probe's decision, not the code's.
      setState((prev) => (prev.forSrc === src ? { ...prev, status: 'checking' } : prev));
      void diagnose(failedSrc, src);
    },
    [diagnose, src],
  );

  /**
   * The silent failure the `error` event never fires for.
   *
   * When a container holds an undecodable video track next to a decodable audio one, a browser
   * may drop the video track and play the audio: sound, a black frame, and no error at all. The
   * spec pins the tell — `videoWidth`/`videoHeight` are "0 if no video is available", and they
   * are populated at `loadedmetadata` exactly when a video track IS available — so zero
   * dimensions at metadata time mean there is no video to show, whatever the audio is doing.
   * (If instead the decoder accepts the track and fails later, that path raises
   * `MEDIA_ERR_DECODE` and the `error` handler above already covers it.)
   */
  const handleLoadedMetadata = useCallback(
    (e: React.SyntheticEvent<HTMLVideoElement>) => {
      const el = e.currentTarget;
      if (el.videoWidth === 0 && el.videoHeight === 0) {
        setState((prev) => (prev.forSrc === src ? { ...prev, status: 'unsupported' } : prev));
      }
    },
    [src],
  );

  const handleDownload = useCallback(() => {
    if (onDownload) {
      onDownload();
      return;
    }
    void downloadFromUrl(current.activeSrc, { mimeType });
  }, [onDownload, current.activeSrc, mimeType]);

  /** Point the element at the file again, allowing one more link re-mint. */
  const handleRetry = useCallback(() => {
    refreshAttemptedFor.current = null;
    setState((prev) => (prev.forSrc === src ? { ...prev, status: 'playing' } : prev));
  }, [src]);

  if (current.status === 'playing') {
    return (
      <video
        key={current.activeSrc}
        src={current.activeSrc}
        controls
        autoPlay={autoPlay}
        onError={handleError}
        onLoadedMetadata={handleLoadedMetadata}
        className={className}
        data-testid="video-player"
      />
    );
  }

  const { heading, body } = FALLBACK_COPY[current.status];
  const retryable = current.status === 'expired' || current.status === 'unavailable';

  return (
    <div
      className="flex max-w-md flex-col items-center gap-3 rounded-md bg-surface-light p-8 text-center shadow-2xl ring-1 ring-border"
      role="status"
    >
      <VideoOff className="h-8 w-8 text-text-secondary" aria-hidden="true" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-primary">{heading}</p>
        <p className="text-xs text-text-secondary">{body}</p>
      </div>
      <div className="flex items-center gap-2">
        {retryable && (
          <Button type="button" size="sm" variant="outline" tone="neutral" onClick={handleRetry}>
            <RotateCcw className="h-3.5 w-3.5" />
            Try again
          </Button>
        )}
        <Button type="button" size="sm" onClick={handleDownload}>
          <Download className="h-3.5 w-3.5" />
          Download video
        </Button>
      </div>
    </div>
  );
}

const FALLBACK_COPY: Record<Exclude<Status, 'playing'>, { heading: string; body: string }> = {
  // Must hold whatever the probe comes back with: no cause named, and no advice that could turn
  // out to be the wrong thing to go and do.
  checking: {
    heading: "This video didn't play",
    body: 'Download it to watch on your device.',
  },
  unsupported: {
    heading: "This video can't play in this browser",
    body: 'The video itself is fine. Download it to watch on your device, or try a different browser.',
  },
  expired: {
    heading: "This video's link expired",
    body: 'Links time out after a while. Try again, or download it to watch on your device.',
  },
  unavailable: {
    heading: "This video didn't load",
    body: 'Check your connection and try again, or download it to watch on your device.',
  },
};
