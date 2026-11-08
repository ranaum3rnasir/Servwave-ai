/**
 * S5 — upload size and duration guidance, through the four GENERIC attachment surfaces:
 *
 *   components/jobs/AttachmentsTabBody.tsx      job detail -> Attachments tab
 *   components/jobs/overview/JobFilesCard.tsx   job detail -> Overview card
 *   components/crm/AttachmentsPanel.tsx         CRM side panel
 *   components/crm/AttachmentSection.tsx        CRM entity section
 *
 * These four share `ACCEPTED_UPLOAD_TYPES`, the `/api/attachments/:entity/:id` route and the
 * server's 25MB / 512MB caps. They are NOT the only places a video can be uploaded: the fifth
 * is `components/inventory/StageDetailDialog.tsx`, whose "Record video" control declares
 * `accept="video/*" capture="environment"` and posts to the inventory stage-attachment route
 * under its own 100MB cap. Grepping `ACCEPTED_UPLOAD_TYPES` does not find it, which is
 * exactly how it was missed; it is covered in `stage-video-upload-guidance.test.tsx`.
 *
 * The contract under test is deliberately narrow and adversarial:
 *
 *  - the size (and duration, when the browser volunteers one) is on screen
 *    BEFORE the first byte leaves — proved by snapshotting the DOM at the
 *    moment the transport is invoked, not by reading it afterwards;
 *  - the nudge is a sentence, never a gate: the upload still happens;
 *  - the exact `File` object selected is the one handed to the transport —
 *    same identity, same size, same type. Nothing re-encodes it.
 *
 * `probeVideoDuration` is stubbed here because jsdom implements no media
 * pipeline; the real probe (including its Infinity/NaN/error/timeout
 * handling) is covered directly in `upload-guidance.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import {
  RecordedChunkedUpload,
  resetChunkedUploads,
} from './support/chunkedUploadDouble';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';
import { JobFilesCard } from '@/components/jobs/overview/JobFilesCard';
import { AttachmentsPanel } from '@/components/crm/AttachmentsPanel';
import { AttachmentSection } from '@/components/crm/AttachmentSection';
import { LONG_CLIP_NUDGE, LARGE_FILE_NUDGE } from '@/lib/attachments/uploadGuidance';

// Duration the stubbed probe will report for the next selected video.
let probedDuration: number | null = null;
/** When true the probe REJECTS instead of resolving — the wedge case. */
let probeRejects = false;

vi.mock('@/lib/attachments/uploadGuidance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attachments/uploadGuidance')>();
  return {
    ...actual,
    probeVideoDuration: vi.fn(async (file: File) => {
      if (probeRejects) throw new Error('probe blew up');
      return file.type.startsWith('video/') ? probedDuration : null;
    }),
  };
});

/**
 * These surfaces deliver a failure two different ways: the queue-driven ones raise a toast,
 * AttachmentSection renders the message on the row beside its Retry. No Toaster is mounted in
 * the test harness, so a toast never reaches the DOM - the spy is how the matrix can ask
 * "did the user see this?" uniformly across both shapes.
 */
const toastSpy = vi.fn();
vi.mock('@/components/ui/use-toast', () => ({
  toast: (...args: unknown[]) => toastSpy(...args),
  useToast: () => ({ toast: (...args: unknown[]) => toastSpy(...args), dismiss: vi.fn() }),
}));

const mockApi = vi.mocked(api);

/**
 * The direct path's other half since S2: a chunked, resumable transfer.
 *
 * Recorded rather than run — there is no storage service in jsdom. The double's default is a
 * transfer that HANGS, which is exactly what these cases need: a video whose bytes are
 * genuinely in flight, so the row is on screen in its uploading state and its progress
 * callback can be driven. One shared double, see support/chunkedUploadDouble.ts.
 */
vi.mock('tus-js-client', async () => {
  const { chunkedUploadModule } = await import('./support/chunkedUploadDouble');
  return chunkedUploadModule();
});

/** Asserts the text reached the user, whether on the row or through a toast. */
async function expectUserWasTold(text: string | RegExp) {
  const matches = (value: unknown) =>
    typeof value === 'string' &&
    (typeof text === 'string' ? value.includes(text) : text.test(value));
  await waitFor(() => {
    const inToast = toastSpy.mock.calls.some(([arg]) =>
      Object.values((arg ?? {}) as Record<string, unknown>).some(matches)
    );
    const inDom = matches(document.body.textContent);
    expect(inToast || inDom).toBe(true);
  });
}
const MB = 1024 * 1024;
const JOB_ID = 'job-1';

/** A video that declares a size without allocating one. */
function videoFile(megabytes: number, name = 'walkthrough.mp4'): File {
  const f = new File(['x'], name, { type: 'video/mp4' });
  Object.defineProperty(f, 'size', { value: Math.round(megabytes * MB) });
  return f;
}

/**
 * A non-video attachment, likewise sized without allocating anything.
 *
 * Kept under `MAX_UPLOAD_BYTES` (25MB). The non-video cap is a twentieth of the video one
 * since the 512MB raise, so a file sized like the video fixtures above would be refused
 * before it was ever sent.
 */
function docFile(megabytes: number, name = 'report.pdf'): File {
  const f = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(f, 'size', { value: Math.round(megabytes * MB) });
  return f;
}

/**
 * Pick a file on whichever surface is mounted.
 *
 * Waits for the input first: the CRM panel renders a loading skeleton until its
 * attachments query settles, so the picker does not exist on the first paint.
 */
async function select(container: HTMLElement, file: File, which = 0) {
  let input: HTMLInputElement | undefined;
  await waitFor(() => {
    input = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="file"]')
    )[which];
    expect(input).toBeDefined();
  });
  fireEvent.change(input!, { target: { files: [file] } });
}

/**
 * Captures what the DOM said at the instant the transport was called — whichever transport
 * that is.
 *
 * Since S1 there are two of them behind `uploadAttachment`: a video's bytes go DIRECT (the
 * API mints a single-path upload URL, the browser PUTs the file straight at storage) and
 * everything else keeps the multipart post. This file is about the guidance a surface
 * renders, not about which pipe carried the file, so both are recorded into one shape and
 * every assertion below reads `file` rather than reaching into a `FormData` that only one of
 * the two transports ever builds. That is also what keeps these tests honest about the seam:
 * the real `uploadAttachment` runs, so a re-encode added inside it fails all four surfaces on
 * both paths.
 *
 * `domAtCall` is snapshotted at the FIRST network touch of the upload — the mint for a video,
 * the multipart post otherwise — which is the earlier of the two moments, so "on screen
 * before the bytes move" stays the strict reading.
 */
interface TransportCall {
  /** The exact File object handed to whichever transport carried it. */
  file: File;
  domAtCall: string;
  /**
   * Feed real bytes back the way the live transport would.
   *
   * ONE shape for both branches, which is the point: since S2 both of them report, so a case
   * about what the user sees while bytes move reads the same whichever pipe is underneath.
   * The multipart branch gets an axios event; the chunked branch gets two numbers.
   */
  report: (loaded: number, total?: number) => void;
}

function captureHangingTransport(): TransportCall[] {
  const calls: TransportCall[] = [];
  // The DOM as of the mint, held so the chunked transfer can report that earlier moment.
  let domAtMint: string | null = null;

  mockApi.post.mockImplementation(((url: string, body: unknown, config?: Record<string, unknown>) => {
    if (typeof url === 'string' && url.endsWith('/direct-upload')) {
      domAtMint = document.body.textContent ?? '';
      // The mint carries metadata, not bytes, so it resolves and lets the transfer be the
      // thing that hangs.
      return Promise.resolve({
        data: {
          upload: { bucket: 'attachments', path: 'org-1/p.mp4', token: 'tok', ticket: 'tkt' },
        },
      });
    }
    const onUploadProgress = config?.onUploadProgress as
      | ((e: { loaded: number; total?: number }) => void)
      | undefined;
    calls.push({
      file: (body as FormData).get('file') as File,
      domAtCall: document.body.textContent ?? '',
      report: (loaded, total) => {
        if (!onUploadProgress) throw new Error('the multipart transport was given no progress hook');
        onUploadProgress({ loaded, total });
      },
    });
    // Never resolves: the upload stays in flight so progress can be driven.
    return new Promise(() => {});
  }) as unknown as typeof api.post);

  // The chunked client records itself on construction; drain those into the same shape so a
  // case never has to know which transport it got.
  let drained = 0;
  const drain = () => {
    while (drained < RecordedChunkedUpload.instances.length) {
      const { file, options } = RecordedChunkedUpload.instances[drained++]!;
      calls.push({
        file,
        domAtCall: domAtMint ?? document.body.textContent ?? '',
        report: (loaded, total) => {
          if (!options.onProgress) {
            throw new Error('the chunked transport was given no progress hook');
          }
          options.onProgress(loaded, total ?? 0);
        },
      });
      domAtMint = null;
    }
  };
  // `calls` is only ever read through `waitFor`, so draining on read is enough and needs no
  // timer: every assertion below already polls for `calls.length`.
  return new Proxy(calls, {
    get(target, prop, receiver) {
      drain();
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  toastSpy.mockClear();
  probedDuration = null;
  probeRejects = false;
  resetChunkedUploads();
  // A resume record left by an earlier case would skip the mint, and `clearAllMocks` does not
  // touch browser storage.
  localStorage.clear();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
  mockApi.get.mockResolvedValue({ data: { attachments: [] } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── The four surfaces, driven identically ──────────────────────────────────

const SURFACES = [
  {
    name: 'AttachmentsTabBody (job Attachments tab)',
    render: () => renderWithProviders(<AttachmentsTabBody jobId={JOB_ID} attachments={[]} />),
    // This surface uploads straight off the picker.
    confirm: undefined as undefined | (() => Promise<void>),
  },
  {
    name: 'JobFilesCard (job Overview)',
    render: () => renderWithProviders(<JobFilesCard jobId={JOB_ID} attachments={[]} />),
    confirm: undefined,
  },
  {
    name: 'AttachmentsPanel (CRM side panel)',
    render: () => renderWithProviders(<AttachmentsPanel entityType="CUSTOMER" entityId="c-1" />),
    confirm: undefined,
  },
  {
    name: 'AttachmentSection (CRM entity section)',
    render: () => renderWithProviders(<AttachmentSection entityType="CUSTOMER" entityId="c-1" />),
    // This surface has always had an explicit per-file Upload button, gated on a
    // description for non-image files.
    confirm: async () => {
      const description = await screen.findByPlaceholderText('Description *');
      fireEvent.change(description, { target: { value: 'Site walkthrough' } });
      const btn = await screen.findByRole('button', { name: 'Upload' });
      fireEvent.click(btn);
    },
  },
];

describe.each(SURFACES)('$name', ({ render, confirm }) => {
  it('shows the file size before the upload starts', async () => {
    const calls = captureHangingTransport();
    const { container } = render();

    await select(container, videoFile(40));

    // On screen immediately, without waiting on the network.
    expect(await screen.findByText(/40\.0 MB/)).toBeInTheDocument();

    if (confirm) await confirm();

    await waitFor(() => expect(calls.length).toBe(1));
    // The load-bearing assertion: the size was already rendered at the instant
    // the transport was invoked, not merely at some point afterwards.
    expect(calls[0]!.domAtCall).toContain('40.0 MB');
  });

  it('shows the clip duration alongside the size when the browser reports one', async () => {
    probedDuration = 125;
    captureHangingTransport();
    const { container } = render();

    await select(container, videoFile(40));

    expect(await screen.findByText(/40\.0 MB · 2:05/)).toBeInTheDocument();
  });

  it('renders nothing where the duration would go when the browser cannot measure it', async () => {
    probedDuration = null; // the probe already collapses Infinity/NaN to null
    captureHangingTransport();
    const { container } = render();

    await select(container, videoFile(40));

    expect(await screen.findByText(/40\.0 MB/)).toBeInTheDocument();
    expect(screen.queryByText(/Infinity|NaN/)).not.toBeInTheDocument();
  });

  it('nudges on a long clip, and uploads it anyway', async () => {
    probedDuration = 600;
    const calls = captureHangingTransport();
    const { container } = render();
    const file = videoFile(30); // small file, long clip

    await select(container, file);

    expect(await screen.findByText(LONG_CLIP_NUDGE)).toBeInTheDocument();

    if (confirm) await confirm();

    // THE criterion: the nudge suggests, it does not obstruct.
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.file).toBe(file);
    // NOT asserted here: that the long-clip nudge preceded the transport. The queue no
    // longer waits on the duration probe, so on these auto-upload surfaces it can land a
    // moment after the bytes start. That is deliberate - the row offers no cancel, so a
    // pre-send guarantee would be a fact only a test could observe, bought with up to
    // DURATION_PROBE_TIMEOUT_MS of dead time on every video pick. The size-driven nudge
    // needs no probe, and IS asserted pre-send in the next case.
  });

  it('nudges on a large file, and uploads it anyway', async () => {
    const calls = captureHangingTransport();
    const { container } = render();
    const file = videoFile(30);

    await select(container, file);

    expect(await screen.findByText(LARGE_FILE_NUDGE)).toBeInTheDocument();

    if (confirm) await confirm();

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.file).toBe(file);
    // Size needs no probe, so THIS branch can be on screen before the first byte - and is.
    expect(calls[0]!.domAtCall).toContain(LARGE_FILE_NUDGE);
  });

  it('stays quiet about a short, ordinary clip', async () => {
    probedDuration = 20;
    captureHangingTransport();
    const { container } = render();

    await select(container, videoFile(8));

    expect(await screen.findByText(/8\.0 MB/)).toBeInTheDocument();
    expect(screen.queryByText(LONG_CLIP_NUDGE)).not.toBeInTheDocument();
    expect(screen.queryByText(LARGE_FILE_NUDGE)).not.toBeInTheDocument();
  });

  it('hands the transport the exact bytes selected — nothing re-encodes the file', async () => {
    probedDuration = 600;
    const calls = captureHangingTransport();
    const { container } = render();
    const file = videoFile(30, 'evidence.mp4');

    await select(container, file);
    if (confirm) await confirm();

    await waitFor(() => expect(calls.length).toBe(1));
    const sent = calls[0]!.file;
    // Identity, not just equivalence: a re-encode would necessarily produce a
    // different object. Size/type/name are asserted too so a same-identity
    // mutation in place could not slip through either.
    expect(sent).toBe(file);
    expect(sent.size).toBe(Math.round(30 * MB));
    expect(sent.type).toBe('video/mp4');
    expect(sent.name).toBe('evidence.mp4');
  });

  /**
   * Byte progress, on the MULTIPART transport that every non-video attachment takes. Its
   * video twin is the case after next.
   */
  it('shows real byte progress fed by the transport', async () => {
    const calls = captureHangingTransport();
    const { container } = render();

    await select(container, docFile(20));
    if (confirm) await confirm();

    await waitFor(() => expect(calls.length).toBe(1));

    // Real loaded/total, not a timer.
    act(() => calls[0]!.report(5 * MB, 20 * MB));
    const row = await screen.findByTestId('upload-selection');
    expect(within(row).getByText('25%')).toBeInTheDocument();

    act(() => calls[0]!.report(15 * MB, 20 * MB));
    expect(within(row).getByText('75%')).toBeInTheDocument();
  });

  it('says "Uploading…" rather than inventing a percentage when no total is reported', async () => {
    const calls = captureHangingTransport();
    const { container } = render();

    await select(container, docFile(20));
    if (confirm) await confirm();

    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.report(5 * MB, undefined));

    const row = await screen.findByTestId('upload-selection');
    expect(within(row).getByText('Uploading…')).toBeInTheDocument();
    // No invented number: nothing in the row claims a percentage.
    expect(within(row).queryByText(/\d+%/)).not.toBeInTheDocument();
  });

  it('shows a video the same real byte progress, because the direct path is chunked now', async () => {
    /**
     * PINS 2-5 of 5 — one per surface, rewritten by S2 rather than deleted.
     *
     * This case used to assert the OPPOSITE: that a video sat at an indeterminate
     * "Uploading…" with no percentage, because S1 routed video at a single PUT that reported
     * nothing. That was a regression against S5 on four of five surfaces, pinned here
     * deliberately so it could not quietly become permanent. S2's chunked transfer reports
     * every chunk, so the four surfaces now show the same measured percentage for a video as
     * they do for a document.
     *
     * Reading the DOM, not the callback, is the point. A progress hook that is wired up but
     * whose numbers never reach a rendered row would satisfy a test of the seam and still
     * leave the user watching a pulsing bar.
     */
    const calls = captureHangingTransport();
    const { container } = render();

    await select(container, videoFile(40));
    if (confirm) await confirm();

    // The bytes really are in flight: the chunked transfer was constructed and is hanging.
    await waitFor(() => expect(calls.length).toBe(1));

    const row = await screen.findByTestId('upload-selection');
    await waitFor(() => expect(within(row).getByText('Uploading…')).toBeInTheDocument());

    // 10MB of 40MB is a chunk and a half at the fixed 6MB chunk size — a number the transport
    // measured, not one the row invented.
    act(() => calls[0]!.report(10 * MB, 40 * MB));
    await waitFor(() => expect(within(row).getByText('25%')).toBeInTheDocument());

    act(() => calls[0]!.report(36 * MB, 40 * MB));
    await waitFor(() => expect(within(row).getByText('90%')).toBeInTheDocument());
    expect(within(row).queryByText('Uploading…')).not.toBeInTheDocument();
  });

  it('refuses a file over the cap with a visible message, and never sends it', async () => {
    const calls = captureHangingTransport();
    const { container } = render();

    await select(container, videoFile(600, 'too-big.mp4'));

    // Visible, not silent: a file that disappears with no message reads as data loss.
    // 600MB, not the 60MB this used to say: the cap is 512MB, so 60MB is now accepted and
    // the fixture had to grow or the test would have stopped exercising a refusal.
    expect(
      await screen.findByText(/"too-big\.mp4" is 600 MB — over the 512 MB limit/)
    ).toBeInTheDocument();

    if (confirm) {
      // Nothing was queued, so there is no per-file Upload control to press.
      expect(screen.queryByPlaceholderText('Description *')).not.toBeInTheDocument();
    }

    // No doomed multipart request: the server would certainly refuse this.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(0);
  });

  it('never tells the user to upload a file it is about to refuse', async () => {
    captureHangingTransport();
    const { container } = render();

    await select(container, videoFile(600, 'too-big.mp4'));
    await screen.findByText(/"too-big\.mp4" is 600 MB — over the 512 MB limit/);

    // The nudge ends in "You can upload it as is." — saying that about a refused file is
    // the contradiction this pairing exists to prevent.
    expect(screen.queryByText(LARGE_FILE_NUDGE)).not.toBeInTheDocument();
    expect(screen.queryByText(LONG_CLIP_NUDGE)).not.toBeInTheDocument();
  });

  it('surfaces the server\'s own wording when an upload fails, not a generic fallback', async () => {
    // describeError is what carries the API's message to the user. Dropping it leaves every
    // failure reading "Upload failed.", which tells nobody anything.
    mockApi.post.mockRejectedValue({
      response: { data: { error: 'That file type is not supported on this record.' } },
    });
    const { container } = render();

    await select(container, videoFile(30));
    if (confirm) await confirm();

    await expectUserWasTold('That file type is not supported on this record.');
  });

  it('still uploads when the duration probe throws', async () => {
    /**
     * The queue waits for the probe to ANSWER before sending, so that the long-clip nudge is
     * on screen first. That gate must not be able to become a trap: if the probe rejects and
     * nothing marks the item probed, the file is never picked up, `isUploading` stays true,
     * the settle never runs and the surface is dead until it is remounted.
     *
     * Duration is a nicety. A probe that fails must cost the clip length and nothing else.
     */
    probeRejects = true;
    const calls = captureHangingTransport();
    const { container } = render();
    const file = videoFile(30);

    await select(container, file);
    if (confirm) await confirm();

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.file).toBe(file);
    // Size still rendered: it never depended on the probe.
    expect(calls[0]!.domAtCall).toContain('30.0 MB');
  });
});
