/**
 * Unplayable-video fallback — `VideoPlayer` and its two overlays.
 *
 * The defect: a phone-captured job video can be HEVC in an `.mp4`/`.mov` container. It uploads and
 * stores fine, plays on a machine with a hardware decoder, and on a desktop without one the old
 * `<video src controls autoPlay>` rendered a black rectangle with no explanation.
 *
 * TWO THINGS THIS FILE EXISTS TO STOP REGRESSING, both of them mistakes a previous revision made:
 *
 *  1. NO `canPlayType` GATE. `canPlayType('video/quicktime')` is `''` on Chrome and Firefox for
 *     `.mov` files they play perfectly, and `video/quicktime` is an accepted upload type. Gating
 *     on it hid working footage behind an error, which is worse than the bug it was meant to fix.
 *     The first block pins that a rejected container type is NOT a reason to refuse to play.
 *
 *  2. THE ERROR CODE IS NOT THE REASON. Chrome reports HTTP 403/404 as `code === 4`, the same
 *     code as a genuine format failure, and signed attachment URLs expire hourly. So the message
 *     is chosen by a reachability probe, not by the code — a file still there means the browser
 *     cannot decode it; a 403 means the link died. The `it.each` blocks over codes pin that the
 *     code does not decide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VideoPlayer } from '@/components/ui/VideoPlayer';
import { AttachmentLightbox } from '@/components/ui/AttachmentLightbox';
import { VideoPreviewDialog } from '@/components/ui/VideoPreviewDialog';
import { downloadFileNameFromUrl } from '@/lib/attachments/downloadAttachment';

const hoisted = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, downloadBlob: hoisted.downloadBlob };
});

/** `MediaError` codes. */
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

const UNSUPPORTED = "This video can't play in this browser";
const EXPIRED = "This video's link expired";
const UNAVAILABLE = "This video didn't load";
const CHECKING = "This video didn't play";

/** The file is still there — what the probe sees for a real decode failure. */
function fileIsReachable() {
  const f = vi.fn().mockResolvedValue({ ok: true, status: 206 });
  vi.stubGlobal('fetch', f);
  return f;
}

/** The signed link has expired — which Chrome also reports as MediaError code 4. */
function linkIsGone(status = 403) {
  const f = vi.fn().mockResolvedValue({ ok: false, status, text: async () => '' });
  vi.stubGlobal('fetch', f);
  return f;
}

/**
 * VERBATIM from the real staging storage host: a stored object whose signed URL was allowed to
 * lapse. Note the status — 400, NOT the 401 the vendor's error table documents — which is exactly
 * why the classifier cannot work off the status line alone.
 */
const EXPIRED_SIGNATURE_BODY = JSON.stringify({
  statusCode: '400',
  error: 'InvalidJWT',
  message: '"exp" claim timestamp check failed',
  code: 'InvalidJWT',
});

/** A 400 with an arbitrary error body. */
function badRequest(body: string) {
  const f = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => body });
  vi.stubGlobal('fetch', f);
  return f;
}

/** The probe itself cannot be read (no CORS headers on the error, offline, DNS). */
function probeUnreadable() {
  const f = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
  vi.stubGlobal('fetch', f);
  return f;
}

function queryPlayer() {
  return document.querySelector('video');
}

/**
 * Fire the element's own `error` event carrying a `MediaError`. jsdom decodes nothing, so the
 * failure is injected; `error` is a readonly accessor on the prototype, hence the instance
 * definition. `fireEvent`, not a bare `dispatchEvent`, so the state update is act()-wrapped.
 */
function failPlayback(code: number) {
  const video = queryPlayer();
  if (!video) throw new Error('expected a <video> element to be rendered');
  Object.defineProperty(video, 'error', { value: { code }, configurable: true });
  fireEvent.error(video);
}

/** Report intrinsic dimensions, then announce metadata — the dropped-video-track tell. */
function loadMetadata({ width, height }: { width: number; height: number }) {
  const video = queryPlayer();
  if (!video) throw new Error('expected a <video> element to be rendered');
  Object.defineProperty(video, 'videoWidth', { value: width, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: height, configurable: true });
  fireEvent.loadedMetadata(video);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('VideoPlayer — a container type is never a reason to refuse playback', () => {
  // The regression that matters most: `video/quicktime` is an accepted upload type and Chrome
  // answers `canPlayType('video/quicktime') === ''` for files it plays perfectly.
  it.each([
    ['video/quicktime', 'https://signed.example/site.mov'],
    ['video/mp4', 'https://signed.example/site.mp4'],
    [undefined, 'https://signed.example/site.mp4'],
  ])('renders the player for %s and shows no fallback', (mimeType, src) => {
    // jsdom's canPlayType answers '' for every type. If anything still consulted it, every one
    // of these would render the fallback — so this also proves the pre-check is really gone.
    render(<VideoPlayer src={src} mimeType={mimeType} />);

    expect(queryPlayer()).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download video' })).toBeNull();
  });

  it('does not probe, download or refresh anything while the video is playing', () => {
    const fetchMock = fileIsReachable();
    const onRefreshUrl = vi.fn();

    render(
      <VideoPlayer
        src="https://signed.example/site.mov"
        mimeType="video/quicktime"
        onRefreshUrl={onRefreshUrl}
      />,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(onRefreshUrl).not.toHaveBeenCalled();
  });

  it('keeps playing when metadata reports real dimensions', () => {
    render(<VideoPlayer src="https://signed.example/site.mov" mimeType="video/quicktime" />);

    loadMetadata({ width: 1920, height: 1080 });

    expect(queryPlayer()).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
  });
});

describe('VideoPlayer — the reachability probe, not the error code, picks the message', () => {
  it.each([
    ['a format error', MEDIA_ERR_SRC_NOT_SUPPORTED],
    ['a decode error', MEDIA_ERR_DECODE],
    ['a network error', MEDIA_ERR_NETWORK],
    ['an aborted load', MEDIA_ERR_ABORTED],
  ])('says the browser cannot play it when the file is still there, after %s', async (_l, code) => {
    fileIsReachable();
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);

    failPlayback(code);

    expect(await screen.findByText(UNSUPPORTED)).toBeInTheDocument();
    expect(queryPlayer()).toBeNull();
    expect(screen.getByRole('button', { name: 'Download video' })).toBeInTheDocument();
  });

  it.each([
    ['a format error', MEDIA_ERR_SRC_NOT_SUPPORTED],
    ['a decode error', MEDIA_ERR_DECODE],
  ])('says the link expired when the file is gone, after %s', async (_l, code) => {
    // This is the inversion the old code-only reading got wrong: Chrome reports an expired
    // signed URL as code 4, identical to a genuine format failure.
    linkIsGone(403);
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);

    failPlayback(code);

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it.each([[401], [403], [404], [410]])('treats HTTP %i as a dead link', async (status) => {
    linkIsGone(status);
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);

    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
  });

  it('reads an expired signature out of a 400 body, the status the real host actually returns', async () => {
    // THE REGRESSION THIS BLOCK EXISTS FOR. A classifier that knows only [401,403,404,410]
    // calls this 'unknown' and shows "This video didn't load / Check your connection" for the
    // single commonest real failure: a 1h signed URL that lapsed while the page sat open.
    badRequest(EXPIRED_SIGNATURE_BODY);
    render(<VideoPlayer src="https://signed.example/phone.mp4?token=stale" mimeType="video/mp4" />);

    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
  });

  it('re-mints on that same 400, so the rescue fires on the case it was built for', async () => {
    badRequest(EXPIRED_SIGNATURE_BODY);
    const onRefreshUrl = vi.fn().mockResolvedValue('https://signed.example/phone.mp4?token=fresh');

    render(
      <VideoPlayer
        src="https://signed.example/phone.mp4?token=stale"
        mimeType="video/mp4"
        onRefreshUrl={onRefreshUrl}
      />,
    );
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    await waitFor(() => expect(onRefreshUrl).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(queryPlayer()).toHaveAttribute('src', 'https://signed.example/phone.mp4?token=fresh'),
    );
  });

  it.each([
    ['a sibling signature code', JSON.stringify({ code: 'SignatureDoesNotMatch' })],
    ['the code in the error field', JSON.stringify({ error: 'ExpiredToken' })],
    ['a differently-cased code', JSON.stringify({ code: 'invalidJWT' })],
  ])('also treats %s as a dead link', async (_l, body) => {
    badRequest(body);
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);

    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
  });

  it.each([
    ['a genuine malformed request', JSON.stringify({ error: 'Bad Request', message: 'bad range' })],
    ['a non-JSON body', '<html><body>400 Bad Request</body></html>'],
    ['an empty body', ''],
    ['a JSON array', '[1,2,3]'],
    ['JSON null', 'null'],
  ])('does not mistake %s for an expired signature', async (_l, body) => {
    // A bare 400 is far too generic to read as expiry; only the payload may promote it.
    badRequest(body);
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);

    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByText(EXPIRED)).toBeNull();
  });

  it('survives an error body that cannot be read at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => {
          throw new TypeError('body stream already read');
        },
      }),
    );
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);

    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
  });

  it('claims nothing it cannot know when the probe itself is unreadable', async () => {
    probeUnreadable();
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);

    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(screen.queryByText(EXPIRED)).toBeNull();
  });

  it('asks for a single byte, so probing never streams the whole video', async () => {
    const fetchMock = fileIsReachable();
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);

    failPlayback(MEDIA_ERR_DECODE);
    await screen.findByText(UNSUPPORTED);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://signed.example/phone.mp4',
      expect.objectContaining({ headers: { Range: 'bytes=0-0' } }),
    );
  });

  it('says nothing it might have to take back while the probe is in flight', async () => {
    let release!: (v: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise((res) => {
          release = res;
        }),
      ),
    );
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);

    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    // Neither cause is named yet, and the download is already reachable.
    expect(screen.getByText(CHECKING)).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(screen.queryByText(EXPIRED)).toBeNull();
    expect(screen.getByRole('button', { name: 'Download video' })).toBeInTheDocument();

    release({ ok: true, status: 206 });
    expect(await screen.findByText(UNSUPPORTED)).toBeInTheDocument();
  });

  it('gives a new file a fresh verdict instead of inheriting the last one', async () => {
    fileIsReachable();
    const { rerender } = render(
      <VideoPlayer src="https://signed.example/broken.mp4" mimeType="video/mp4" />,
    );
    failPlayback(MEDIA_ERR_DECODE);
    expect(await screen.findByText(UNSUPPORTED)).toBeInTheDocument();

    rerender(<VideoPlayer src="https://signed.example/fine.mp4" mimeType="video/mp4" />);

    expect(queryPlayer()).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
  });
});

describe('VideoPlayer — the silent failure that fires no error at all', () => {
  it('treats zero intrinsic dimensions at metadata as nothing to show', () => {
    // A container whose video track the browser drops but whose audio it keeps plays sound over
    // a black frame and raises no `error` event. Per spec videoWidth/videoHeight are "0 if no
    // video is available", and they are populated at loadedmetadata when a track IS available.
    render(<VideoPlayer src="https://signed.example/hevc-with-aac.mp4" mimeType="video/mp4" />);

    loadMetadata({ width: 0, height: 0 });

    expect(queryPlayer()).toBeNull();
    expect(screen.getByText(UNSUPPORTED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download video' })).toBeInTheDocument();
  });
});

describe('VideoPlayer — an expired link is rescued, not reported', () => {
  it('re-mints the URL and plays, telling the user nothing', async () => {
    linkIsGone(403);
    const onRefreshUrl = vi.fn().mockResolvedValue('https://signed.example/phone.mp4?token=fresh');

    render(
      <VideoPlayer
        src="https://signed.example/phone.mp4?token=stale"
        mimeType="video/mp4"
        onRefreshUrl={onRefreshUrl}
      />,
    );
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    await waitFor(() => expect(onRefreshUrl).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(queryPlayer()).toHaveAttribute('src', 'https://signed.example/phone.mp4?token=fresh'),
    );
    expect(screen.queryByText(EXPIRED)).toBeNull();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
  });

  it('gives up honestly, and only once, when the refresher cannot help', async () => {
    linkIsGone(403);
    const onRefreshUrl = vi.fn().mockResolvedValue(null);

    render(
      <VideoPlayer
        src="https://signed.example/phone.mp4?token=stale"
        mimeType="video/mp4"
        onRefreshUrl={onRefreshUrl}
      />,
    );
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(onRefreshUrl).toHaveBeenCalledTimes(1);
  });

  it('does not loop when the refresher keeps handing back the same dead link', async () => {
    linkIsGone(403);
    const stale = 'https://signed.example/phone.mp4?token=stale';
    const onRefreshUrl = vi.fn().mockResolvedValue(stale);

    render(<VideoPlayer src={stale} mimeType="video/mp4" onRefreshUrl={onRefreshUrl} />);
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(onRefreshUrl).toHaveBeenCalledTimes(1);
  });

  // F1 — the one-attempt-per-file guard. Deleting it left every other test in this file green,
  // so it had no net under it. These two pin it from both sides: it must not fire twice for the
  // same file, and it must not be a once-ever latch either.
  it('re-mints at most once per file, even when the re-minted link fails too', async () => {
    badRequest(EXPIRED_SIGNATURE_BODY);
    const STALE = 'https://signed.example/phone.mp4?token=stale';
    const FRESH = 'https://signed.example/phone.mp4?token=fresh';
    const onRefreshUrl = vi.fn().mockResolvedValue(FRESH);

    render(<VideoPlayer src={STALE} mimeType="video/mp4" onRefreshUrl={onRefreshUrl} />);

    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);
    await waitFor(() => expect(queryPlayer()).toHaveAttribute('src', FRESH));
    expect(onRefreshUrl).toHaveBeenCalledTimes(1);

    // The re-minted link fails as well. Without the guard this refreshes again — and with a
    // refresher handing back a rotating URL it would never stop.
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(onRefreshUrl).toHaveBeenCalledTimes(1);
  });

  it('gives the next file its own attempt, so the guard is per file and not once ever', async () => {
    badRequest(EXPIRED_SIGNATURE_BODY);
    const onRefreshUrl = vi.fn().mockResolvedValue(null);

    const { rerender } = render(
      <VideoPlayer
        src="https://signed.example/first.mp4?token=stale"
        mimeType="video/mp4"
        onRefreshUrl={onRefreshUrl}
      />,
    );
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(onRefreshUrl).toHaveBeenCalledTimes(1);

    rerender(
      <VideoPlayer
        src="https://signed.example/second.mp4?token=stale"
        mimeType="video/mp4"
        onRefreshUrl={onRefreshUrl}
      />,
    );
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();
    expect(onRefreshUrl).toHaveBeenCalledTimes(2);
  });

  it('lets Try again put the element back on the file', async () => {
    linkIsGone(403);
    const user = userEvent.setup();
    render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);
    expect(await screen.findByText(EXPIRED)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(queryPlayer()).toBeInTheDocument();
  });
});

describe('VideoPlayer — the download affordance is never a no-op', () => {
  it("calls the caller's own download handler when it has one", async () => {
    fileIsReachable();
    const onDownload = vi.fn();
    const user = userEvent.setup();
    render(
      <VideoPlayer src="https://signed.example/a.mp4" mimeType="video/mp4" onDownload={onDownload} />,
    );
    failPlayback(MEDIA_ERR_DECODE);
    await screen.findByText(UNSUPPORTED);

    await user.click(screen.getByRole('button', { name: 'Download video' }));

    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(hoisted.downloadBlob).not.toHaveBeenCalled();
  });

  it('without a handler, reads the cross-origin file and saves it through a same-origin blob', async () => {
    const blob = new Blob(['bytes'], { type: 'video/mp4' });
    const fetchMock = vi
      .fn()
      // the probe, then the download read
      .mockResolvedValueOnce({ ok: true, status: 206 })
      .mockResolvedValueOnce({ ok: true, status: 200, blob: async () => blob });
    vi.stubGlobal('fetch', fetchMock);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();

    render(
      <VideoPlayer src="https://signed.example/walk%20through.mp4?token=abc" mimeType="video/mp4" />,
    );
    failPlayback(MEDIA_ERR_DECODE);
    await screen.findByText(UNSUPPORTED);

    await user.click(screen.getByRole('button', { name: 'Download video' }));

    // The signature query string is not part of the save-as name, and the name is decoded.
    await waitFor(() => expect(hoisted.downloadBlob).toHaveBeenCalledWith(blob, 'walk through.mp4'));
    // A blob save is a real save; nothing navigates.
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('falls back to opening the file when the cross-origin read fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 206 })
      .mockRejectedValueOnce(new TypeError('CORS'));
    vi.stubGlobal('fetch', fetchMock);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();

    render(<VideoPlayer src="https://signed.example/a.mp4" mimeType="video/mp4" />);
    failPlayback(MEDIA_ERR_DECODE);
    await screen.findByText(UNSUPPORTED);

    await user.click(screen.getByRole('button', { name: 'Download video' }));

    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        'https://signed.example/a.mp4',
        '_blank',
        'noopener,noreferrer',
      ),
    );
    expect(hoisted.downloadBlob).not.toHaveBeenCalled();
  });
});

describe('downloadFileNameFromUrl — a save-as name is never unbounded', () => {
  it('refuses to mine a base64 data URL for a filename', () => {
    const payload = `data:video/mp4;base64,${'A'.repeat(4000)}`;

    const name = downloadFileNameFromUrl(payload, { mimeType: 'video/mp4' });

    expect(name).toBe('video.mp4');
    expect(name.length).toBeLessThanOrEqual(120);
  });

  it('caps and sanitises a caption, and gives it the container extension', () => {
    const name = downloadFileNameFromUrl('data:video/quicktime;base64,AAAA', {
      name: 'B'.repeat(400),
      mimeType: 'video/quicktime',
    });

    expect(name.length).toBeLessThanOrEqual(124); // 120-char cap + '.mov'
    expect(name.endsWith('.mov')).toBe(true);
  });

  it('strips a path prefix and control characters out of a caption', () => {
    const name = downloadFileNameFromUrl('https://signed.example/x.mp4', {
      name: '../../etc/pa ss wd',
      mimeType: 'video/mp4',
    });

    expect(name).toBe('pass wd.mp4');
  });

  it('does not double up an extension the name already has', () => {
    expect(
      downloadFileNameFromUrl('https://signed.example/clip.mp4', { mimeType: 'video/mp4' }),
    ).toBe('clip.mp4');
  });
});

describe('VideoPlayer — a late answer never lands on the file the user moved on to', () => {
  // F2 — both `prev.forSrc !== ownerSrc` guards. Deleting either left every other test green.
  it('drops a probe answer that resolves after the user opened a different video', async () => {
    let release!: (v: unknown) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise((res) => {
          release = res;
        }),
      ),
    );

    const { rerender } = render(
      <VideoPlayer src="https://signed.example/first.mp4" mimeType="video/mp4" />,
    );
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);
    expect(screen.getByText(CHECKING)).toBeInTheDocument();

    // The user closes that one and opens another before the probe comes back.
    rerender(<VideoPlayer src="https://signed.example/second.mp4" mimeType="video/mp4" />);
    expect(queryPlayer()).toHaveAttribute('src', 'https://signed.example/second.mp4');

    // The FIRST file's verdict arrives now. It must not touch the second file's state.
    await act(async () => {
      release({ ok: true, status: 206 });
    });

    expect(queryPlayer()).toHaveAttribute('src', 'https://signed.example/second.mp4');
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
  });

  it('drops a re-mint that resolves after the user opened a different video', async () => {
    badRequest(EXPIRED_SIGNATURE_BODY);
    let releaseRefresh!: (v: string | null) => void;
    const onRefreshUrl = vi.fn().mockReturnValue(
      new Promise((res) => {
        releaseRefresh = res;
      }),
    );

    const { rerender } = render(
      <VideoPlayer
        src="https://signed.example/first.mp4?token=stale"
        mimeType="video/mp4"
        onRefreshUrl={onRefreshUrl}
      />,
    );
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);
    await waitFor(() => expect(onRefreshUrl).toHaveBeenCalledTimes(1));

    rerender(
      <VideoPlayer
        src="https://signed.example/second.mp4"
        mimeType="video/mp4"
        onRefreshUrl={onRefreshUrl}
      />,
    );
    expect(queryPlayer()).toHaveAttribute('src', 'https://signed.example/second.mp4');

    // The FIRST file's fresh URL arrives. Pointing the element at it now would swap the video
    // out from under the user.
    await act(async () => {
      releaseRefresh('https://signed.example/first.mp4?token=fresh');
    });

    expect(queryPlayer()).toHaveAttribute('src', 'https://signed.example/second.mp4');
    expect(screen.queryByText(EXPIRED)).toBeNull();
  });
});

describe('VideoPlayer — a probe always settles', () => {
  // F3 — without a deadline a hung request parks the user in `checking` for ever, which offers
  // no Try again and no way back to the player.
  it('gives up on a probe that never answers, and offers a way out', async () => {
    vi.useFakeTimers();
    try {
      // Model fetch faithfully: it rejects when its signal aborts.
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init: { signal: AbortSignal }) =>
            new Promise((_res, rej) => {
              init.signal.addEventListener('abort', () =>
                rej(new DOMException('Aborted', 'AbortError')),
              );
            }),
        ),
      );

      render(<VideoPlayer src="https://signed.example/phone.mp4" mimeType="video/mp4" />);
      failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);
      expect(screen.getByText(CHECKING)).toBeInTheDocument();

      // Any sane deadline is well inside this.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });

      expect(screen.getByText(UNAVAILABLE)).toBeInTheDocument();
      expect(screen.queryByText(CHECKING)).toBeNull();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AttachmentLightbox — the image path is untouched', () => {
  it('renders the image, never a player and never the fallback', () => {
    render(
      <AttachmentLightbox
        url="https://signed.example/site-photo.jpg"
        caption="Site photo"
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Attachment preview' });
    expect(within(dialog).getByAltText('Site photo')).toBeInTheDocument();
    expect(queryPlayer()).toBeNull();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
    expect(screen.queryByText(UNAVAILABLE)).toBeNull();
  });

  it('keeps its corner cluster when an image lightbox carries download and delete', () => {
    render(
      <AttachmentLightbox
        url="https://signed.example/site-photo.jpg"
        caption="Site photo"
        onDownload={vi.fn()}
        onDelete={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Attachment preview' });
    expect(within(dialog).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      'Download attachment',
      'Delete attachment',
      'Close preview',
    ]);
  });
});

describe('AttachmentLightbox — the video path', () => {
  it('plays a .mov without complaint', () => {
    render(
      <AttachmentLightbox
        url="https://signed.example/site.mov"
        kind="video"
        mimeType="video/quicktime"
        onClose={vi.fn()}
      />,
    );

    expect(queryPlayer()).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
  });

  it('shows the fallback on an unplayable file, and its download reuses the lightbox handler', async () => {
    fileIsReachable();
    const onDownload = vi.fn();
    const user = userEvent.setup();

    render(
      <AttachmentLightbox
        url="https://signed.example/site.mp4"
        kind="video"
        mimeType="video/mp4"
        onDownload={onDownload}
        onClose={vi.fn()}
      />,
    );
    failPlayback(MEDIA_ERR_DECODE);

    const dialog = screen.getByRole('dialog', { name: 'Video preview' });
    expect(await within(dialog).findByText(UNSUPPORTED)).toBeInTheDocument();
    // The overlay's own controls survive the swap.
    expect(within(dialog).getByLabelText('Close preview')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Download video' }));

    expect(onDownload).toHaveBeenCalledTimes(1);
  });
});

describe('VideoPreviewDialog', () => {
  it('renders the player for a .mov', () => {
    render(
      <VideoPreviewDialog
        url="https://signed.example/site.mov"
        mimeType="video/quicktime"
        onClose={vi.fn()}
      />,
    );

    expect(queryPlayer()).toBeInTheDocument();
    expect(screen.queryByText(UNSUPPORTED)).toBeNull();
  });

  it('replaces the dead player with the fallback, keeping the dialog and its close control', async () => {
    fileIsReachable();
    const onDownload = vi.fn();
    const user = userEvent.setup();

    render(
      <VideoPreviewDialog
        url="https://signed.example/phone.mp4"
        mimeType="video/mp4"
        onDownload={onDownload}
        onClose={vi.fn()}
      />,
    );
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    const dialog = screen.getByRole('dialog', { name: 'Video preview' });
    expect(await within(dialog).findByText(UNSUPPORTED)).toBeInTheDocument();
    expect(queryPlayer()).toBeNull();
    expect(within(dialog).getByLabelText('Close preview')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Download video' }));

    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it('rescues an expired link through the refresher it was given', async () => {
    linkIsGone(403);
    const onRefreshUrl = vi.fn().mockResolvedValue('https://signed.example/phone.mp4?token=fresh');

    render(
      <VideoPreviewDialog
        url="https://signed.example/phone.mp4?token=stale"
        mimeType="video/mp4"
        onRefreshUrl={onRefreshUrl}
        onClose={vi.fn()}
      />,
    );
    failPlayback(MEDIA_ERR_SRC_NOT_SUPPORTED);

    await waitFor(() => expect(onRefreshUrl).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(queryPlayer()).toHaveAttribute('src', 'https://signed.example/phone.mp4?token=fresh'),
    );
    expect(screen.queryByText(EXPIRED)).toBeNull();
  });
});
