/**
 * S5 — upload size and duration guidance (pure layer).
 *
 * The slice's contract is guidance ONLY: nothing here may touch, re-encode or
 * otherwise alter the selected file. Every function below reads `File.size` /
 * `File.type` and a duration the browser volunteered, and returns a string.
 *
 * The `Infinity` / `NaN` duration cases are not hypothetical: a fragmented MP4
 * or a still-recording capture reports exactly that from `loadedmetadata`, and
 * rendering it produces "InfinityNaN:NaN" in the UI.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LARGE_UPLOAD_BYTES,
  LONG_CLIP_SECONDS,
  formatUploadSize,
  formatClipDuration,
  normalizeClipDuration,
  describeSelection,
  uploadNudge,
  LONG_CLIP_NUDGE,
  LARGE_FILE_NUDGE,
  probeVideoDuration,
  progressPercent,
} from '@/lib/attachments/uploadGuidance';
import {
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  maxUploadBytesFor,
  oversizeRefusalMessage,
} from '@/lib/uploadTypes';

const MB = 1024 * 1024;

function videoFile(sizeBytes: number, name = 'clip.mp4'): File {
  // A 1-byte blob wearing a declared size: constructing a real 250MB buffer in
  // jsdom is pointless when every function under test reads `.size` only.
  const f = new File(['x'], name, { type: 'video/mp4' });
  Object.defineProperty(f, 'size', { value: sizeBytes });
  return f;
}

describe('formatUploadSize', () => {
  it('renders bytes, KB and MB at human precision', () => {
    expect(formatUploadSize(512)).toBe('512 B');
    expect(formatUploadSize(20 * 1024)).toBe('20.0 KB');
    expect(formatUploadSize(2.5 * MB)).toBe('2.5 MB');
    expect(formatUploadSize(248.5 * MB)).toBe('248.5 MB');
  });

  it('rolls over to GB so a large clip does not read as a four-digit MB number', () => {
    expect(formatUploadSize(1.5 * 1024 * MB)).toBe('1.5 GB');
  });
});

describe('normalizeClipDuration', () => {
  it('accepts a real duration', () => {
    expect(normalizeClipDuration(125)).toBe(125);
  });

  it('rejects the values a browser actually returns for an unseekable container', () => {
    expect(normalizeClipDuration(Infinity)).toBeNull();
    expect(normalizeClipDuration(NaN)).toBeNull();
    expect(normalizeClipDuration(0)).toBeNull();
    expect(normalizeClipDuration(-1)).toBeNull();
    expect(normalizeClipDuration(undefined)).toBeNull();
    expect(normalizeClipDuration(null)).toBeNull();
  });
});

describe('formatClipDuration', () => {
  it('renders m:ss', () => {
    expect(formatClipDuration(125)).toBe('2:05');
    expect(formatClipDuration(9)).toBe('0:09');
    expect(formatClipDuration(60)).toBe('1:00');
  });

  it('renders h:mm:ss past an hour', () => {
    expect(formatClipDuration(3725)).toBe('1:02:05');
  });
});

describe('describeSelection', () => {
  it('shows size alone when the browser would not say how long the clip is', () => {
    expect(describeSelection(videoFile(120 * MB), null)).toBe('120.0 MB');
  });

  it('shows size and duration together when duration is known', () => {
    expect(describeSelection(videoFile(120 * MB), 125)).toBe('120.0 MB · 2:05');
  });
});

describe('uploadNudge', () => {
  it('stays silent on a short, small clip', () => {
    expect(uploadNudge(videoFile(20 * MB), 30)).toBeNull();
  });

  it('stays silent exactly AT the thresholds — only past them does it speak', () => {
    expect(uploadNudge(videoFile(LARGE_UPLOAD_BYTES), LONG_CLIP_SECONDS)).toBeNull();
  });

  it('nudges on a large file even when duration is unknown', () => {
    expect(uploadNudge(videoFile(LARGE_UPLOAD_BYTES + 1), null)).toBe(LARGE_FILE_NUDGE);
  });

  it('nudges on a long clip even when the file is small', () => {
    expect(uploadNudge(videoFile(5 * MB), LONG_CLIP_SECONDS + 1)).toBe(LONG_CLIP_NUDGE);
  });

  it('says one thing, not two, when the clip is both long and large', () => {
    expect(uploadNudge(videoFile(300 * MB), 600)).toBe(LONG_CLIP_NUDGE);
  });

  it('only advises a shorter clip on the branch where that is the actual remedy', () => {
    // The long branch wins whenever both apply, so LARGE is only ever seen by a file that is
    // big and NOT long - a short 4K clip. Telling that person to film shorter is wrong.
    expect(LONG_CLIP_NUDGE).toContain('shorter clip');
    expect(LARGE_FILE_NUDGE).not.toContain('shorter');
  });

  it('promises no alternative the product does not offer', () => {
    // There is no trimmer and no quality selector: Ran rejected re-encoding. "upload it as
    // is" implied a choice that does not exist, and on the auto-upload surfaces it granted
    // permission for something already in flight.
    for (const copy of [LONG_CLIP_NUDGE, LARGE_FILE_NUDGE]) {
      expect(copy).not.toContain('as is');
      expect(copy.split(/[.!?]/).filter((part) => part.trim()).length).toBeLessThanOrEqual(2);
    }
  });

  it('leaves non-video files alone — the caps keep them small and "clip" is wrong for a PDF', () => {
    const pdf = new File(['x'], 'permit.pdf', { type: 'application/pdf' });
    Object.defineProperty(pdf, 'size', { value: 400 * MB });
    expect(uploadNudge(pdf, null)).toBeNull();
  });

  it('never blames the person and never names a vendor or a codec', () => {
    const all = [LONG_CLIP_NUDGE, LARGE_FILE_NUDGE].join(' ');
    // Blame
    expect(all).not.toMatch(/\byou (filmed|shot|recorded|should)\b/i);
    expect(all).not.toMatch(/\btoo (long|big|large)\b/i);
    // Vendor / infrastructure / codec vocabulary
    for (const banned of [
      'supabase',
      'render',
      'ctm',
      'calltrackingmetrics',
      'hevc',
      'h.265',
      'h265',
      'h.264',
      'codec',
      'transcode',
      'compress',
      'bitrate',
      'mp4',
      'quicktime',
    ]) {
      expect(all.toLowerCase()).not.toContain(banned);
    }
  });
});

describe('progressPercent', () => {
  it('returns a real percentage from real byte counts', () => {
    expect(progressPercent(50, 200)).toBe(25);
  });

  it('returns null rather than inventing a number when the transport reports no total', () => {
    expect(progressPercent(50, 0)).toBeNull();
    expect(progressPercent(50, undefined)).toBeNull();
  });

  it('clamps rather than reporting over 100', () => {
    expect(progressPercent(300, 200)).toBe(100);
  });
});

describe('probeVideoDuration', () => {
  /**
   * A stand-in for the throwaway <video> element. jsdom implements no media
   * pipeline at all, so the real element never fires `loadedmetadata` — the
   * factory is injected precisely so this behaviour is testable rather than
   * asserted by inspection.
   */
  function fakeVideo() {
    const listeners: Record<string, Array<() => void>> = {};
    const el = {
      preload: '',
      src: '',
      duration: NaN as number,
      addEventListener: (ev: string, cb: () => void) => {
        (listeners[ev] ??= []).push(cb);
      },
      removeEventListener: vi.fn(),
    };
    return {
      el: el as unknown as HTMLVideoElement,
      fire: (ev: string) => (listeners[ev] ?? []).forEach((cb) => cb()),
    };
  }

  it('resolves the duration the browser reports', async () => {
    const fake = fakeVideo();
    const promise = probeVideoDuration(videoFile(10 * MB), {
      createVideo: () => fake.el,
      timeoutMs: 1000,
    });
    (fake.el as { duration: number }).duration = 125;
    fake.fire('loadedmetadata');
    await expect(promise).resolves.toBe(125);
  });

  it('resolves null — not Infinity — for a container the browser cannot measure', async () => {
    const fake = fakeVideo();
    const promise = probeVideoDuration(videoFile(10 * MB), {
      createVideo: () => fake.el,
      timeoutMs: 1000,
    });
    (fake.el as { duration: number }).duration = Infinity;
    fake.fire('loadedmetadata');
    await expect(promise).resolves.toBeNull();
  });

  it('resolves null when the browser errors on the file instead of hanging the picker', async () => {
    const fake = fakeVideo();
    const promise = probeVideoDuration(videoFile(10 * MB), {
      createVideo: () => fake.el,
      timeoutMs: 1000,
    });
    fake.fire('error');
    await expect(promise).resolves.toBeNull();
  });

  it('gives up after the timeout rather than leaving the caller waiting forever', async () => {
    vi.useFakeTimers();
    const fake = fakeVideo();
    const promise = probeVideoDuration(videoFile(10 * MB), {
      createVideo: () => fake.el,
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(600);
    await expect(promise).resolves.toBeNull();
    vi.useRealTimers();
  });

  /**
   * The probe hands the file to a <video> through an object URL. Every one of those pins the
   * whole clip in memory for the lifetime of the document, so a probe that forgets to revoke
   * leaks a 40MB video per pick on a dispatcher's long-lived tab — and this module exists to
   * stop the app holding video bytes, so leaking them here would be self-defeating.
   *
   * Asserted on EVERY exit path, because the interesting leak is the failure path nobody runs.
   */
  describe('releases the object URL on every exit path', () => {
    let created: string[];
    let revoked: string[];

    beforeEach(() => {
      created = [];
      revoked = [];
      vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
        const url = `blob:probe-${created.length + 1}`;
        created.push(url);
        return url;
      });
      vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
        revoked.push(url);
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function probeEnding(ending: 'loaded' | 'infinite' | 'error'): Promise<void> {
      const fake = fakeVideo();
      const promise = probeVideoDuration(videoFile(10 * MB), {
        createVideo: () => fake.el,
        timeoutMs: 1000,
      });
      if (ending === 'error') {
        fake.fire('error');
      } else {
        (fake.el as { duration: number }).duration = ending === 'infinite' ? Infinity : 125;
        fake.fire('loadedmetadata');
      }
      await promise;
    }

    it('after a successful read', async () => {
      await probeEnding('loaded');
      expect(created).toHaveLength(1);
      expect(revoked).toEqual(created);
    });

    it('after an unmeasurable duration', async () => {
      await probeEnding('infinite');
      expect(revoked).toEqual(created);
    });

    it('after the browser errors on the file', async () => {
      await probeEnding('error');
      expect(revoked).toEqual(created);
    });

    it('after the timeout', async () => {
      vi.useFakeTimers();
      const fake = fakeVideo();
      const promise = probeVideoDuration(videoFile(10 * MB), {
        createVideo: () => fake.el,
        timeoutMs: 500,
      });
      await vi.advanceTimersByTimeAsync(600);
      await promise;
      vi.useRealTimers();
      expect(created).toHaveLength(1);
      expect(revoked).toEqual(created);
    });
  });

  it('does not probe a non-video file at all', async () => {
    const createVideo = vi.fn();
    const pdf = new File(['x'], 'permit.pdf', { type: 'application/pdf' });
    await expect(probeVideoDuration(pdf, { createVideo })).resolves.toBeNull();
    expect(createVideo).not.toHaveBeenCalled();
  });
});

// ─── Client-side caps, mirrored from the server ─────────────────────────────

describe('upload caps', () => {
  // The literals used to be asserted here. That guard fired when someone CORRECTED the
  // frontend and stayed silent when the backend drifted ahead of it, which is the direction
  // that actually breaks users. It now lives in `upload-limits-match-backend.test.ts`, which
  // reads the controller source.

  it('picks the video cap for video and the general cap for everything else', () => {
    expect(maxUploadBytesFor(videoFile(1))).toBe(MAX_VIDEO_UPLOAD_BYTES);
    const pdf = new File(['x'], 'permit.pdf', { type: 'application/pdf' });
    expect(maxUploadBytesFor(pdf)).toBe(MAX_UPLOAD_BYTES);
  });

  it('names the file, its REAL size, the limit and what to do next', () => {
    // 620MB rather than the 62MB this used to say. The whole sentence is asserted, so the
    // fixture has to be genuinely over whatever the cap currently is or the test stops
    // testing a refusal at all — and the cap is now 512MB, which 62MB comfortably clears.
    const big = videoFile(620 * MB, 'walkthrough.mp4');
    expect(oversizeRefusalMessage(big)).toBe(
      '"walkthrough.mp4" is 620 MB — over the 512 MB limit, so it wasn\'t uploaded. ' +
        'Record a shorter clip, or contact support to send it another way.'
    );
  });

  it('distinguishes a file just over the cap from one far over it', () => {
    // The reason the size is in the sentence at all: "over the limit" reads identically for
    // both, and only one of them is worth re-filming.
    expect(oversizeRefusalMessage(videoFile(513 * MB, 'a.mp4'))).toContain('is 513 MB');
    expect(oversizeRefusalMessage(videoFile(4000 * MB, 'a.mp4'))).toContain('is 4000 MB');
  });

  it('does not tell someone to re-film a PDF', () => {
    const pdf = new File(['x'], 'plans.pdf', { type: 'application/pdf' });
    Object.defineProperty(pdf, 'size', { value: 40 * MB });
    const message = oversizeRefusalMessage(pdf)!;
    expect(message).toContain('over the 25 MB limit');
    expect(message).not.toContain('Record a shorter clip');
    expect(message).toContain('Contact support');
  });

  it('takes an explicit cap, so a route with its own limit quotes that one', () => {
    const big = videoFile(150 * MB, 'huge.mp4');
    expect(oversizeRefusalMessage(big, 100 * MB)).toContain('over the 100 MB limit');
  });

  it('points at support, never at a vendor dashboard', () => {
    const message = oversizeRefusalMessage(videoFile(600 * MB, 'a.mp4'))!.toLowerCase();
    for (const banned of ['supabase', 'dashboard', 'bucket', 'storage console', 'render']) {
      expect(message).not.toContain(banned);
    }
  });

  it('accepts a file exactly at the cap — the server does', () => {
    expect(oversizeRefusalMessage(videoFile(MAX_VIDEO_UPLOAD_BYTES))).toBeNull();
  });
});

describe('the nudge is reachable', () => {
  /**
   * THE regression guard for this slice.
   *
   * The first cut set the nudge at 100MB while the server refused video over
   * 50MB, so every file that tripped the nudge was one the upload could not
   * carry — the copy said "You can upload it as is" about a file that was
   * certainly going to be refused. A nudge above the cap is doomed copy by
   * construction, and no amount of testing the string catches that.
   */
  it('fires below the cap, so a nudged file is one that can actually upload', () => {
    expect(LARGE_UPLOAD_BYTES).toBeLessThan(MAX_VIDEO_UPLOAD_BYTES);
  });

  it('has a real window between the nudge and the refusal', () => {
    const nudgedAndAccepted = videoFile(LARGE_UPLOAD_BYTES + 1);
    expect(uploadNudge(nudgedAndAccepted, null)).not.toBeNull();
    expect(oversizeRefusalMessage(nudgedAndAccepted)).toBeNull();
  });

  it('never promises "upload it as is" about a file the client is going to refuse', () => {
    const refused = videoFile(MAX_VIDEO_UPLOAD_BYTES + 1);
    expect(oversizeRefusalMessage(refused)).not.toBeNull();
  });
});
