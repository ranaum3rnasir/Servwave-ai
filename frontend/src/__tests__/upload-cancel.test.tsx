/**
 * S2 — cancelling a video upload that is already moving, through every surface that starts one.
 *
 * The acceptance criterion is two claims and this file tests both, on all four generic
 * surfaces:
 *
 *   1. the user CAN cancel — there is a control on the row, it is reachable by its accessible
 *      name, and pressing it stops the transfer;
 *   2. cancelling leaves NOTHING BEHIND — the partial transfer is terminated at the service,
 *      and no attachment row is recorded.
 *
 * The second claim is the one worth being paranoid about. An incomplete chunked transfer is
 * not a stored object, so the operator-run orphan sweep (S3) lists bucket contents and never
 * sees it. If the terminate flag is dropped, the partial sits in the service until someone
 * notices the bill. Nothing else in the repo would catch that, so `abort(true)` is asserted
 * on the flag and not merely on the call.
 *
 * Driven through the real components and the real `uploadAttachment`, so a control that
 * exists but is wired to nothing fails here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';

import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import {
  RecordedChunkedUpload,
  chunkedUploadModule,
  resetChunkedUploads,
  resumeRecordKeysInStorage,
} from './support/chunkedUploadDouble';
import { AttachmentsTabBody } from '@/components/jobs/AttachmentsTabBody';
import { JobFilesCard } from '@/components/jobs/overview/JobFilesCard';
import { AttachmentsPanel } from '@/components/crm/AttachmentsPanel';
import { AttachmentSection } from '@/components/crm/AttachmentSection';

vi.mock('@/lib/attachments/uploadGuidance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/attachments/uploadGuidance')>();
  // jsdom implements no media pipeline; the duration is irrelevant here.
  return { ...actual, probeVideoDuration: vi.fn(async () => null) };
});

vi.mock('@/components/ui/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn() }),
}));

vi.mock('tus-js-client', async () => {
  const { chunkedUploadModule } = await import('./support/chunkedUploadDouble');
  return chunkedUploadModule();
});

const mockApi = vi.mocked(api);
const MB = 1024 * 1024;
const JOB_ID = 'job-1';

function videoFile(megabytes = 40, name = 'walkthrough.mp4'): File {
  const f = new File(['x'], name, { type: 'video/mp4' });
  Object.defineProperty(f, 'size', { value: megabytes * MB });
  return f;
}

function completeCalls() {
  return mockApi.post.mock.calls.filter(([url]) => String(url).endsWith('/direct-upload/complete'));
}

async function select(container: HTMLElement, file: File) {
  let input: HTMLInputElement | undefined;
  await waitFor(() => {
    input = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="file"]'))[0];
    expect(input).toBeDefined();
  });
  fireEvent.change(input!, { target: { files: [file] } });
}

/**
 * Held open by the "cancelled during the mint" case, so the ticket request can be left in
 * flight while the user presses Cancel. Resolved immediately otherwise.
 */
let releaseMint: () => void = () => {};
let mintInFlight: Promise<void> = Promise.resolve();

/** Leave the next ticket request hanging until the test lets it through. */
function holdTheMint() {
  mintInFlight = new Promise<void>((resolve) => {
    releaseMint = resolve;
  });
}

function mintCalls() {
  return mockApi.post.mock.calls.filter(([url]) => String(url).endsWith('/direct-upload'));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChunkedUploads();
  // The state a real cancel happens in: the service has already issued an upload URL.
  RecordedChunkedUpload.publishUrlOnStart =
    'https://proj.storage.supabase.co/storage/v1/upload/resumable/abc123';
  localStorage.clear();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
  mintInFlight = Promise.resolve();
  releaseMint = () => {};
  mockApi.get.mockResolvedValue({ data: { attachments: [] } });
  mockApi.post.mockImplementation((async (url: string) => {
    if (typeof url === 'string' && url.endsWith('/direct-upload')) {
      await mintInFlight;
      return {
        data: {
          upload: { bucket: 'attachments', path: 'org-1/p.mp4', token: 'tok', ticket: 'tkt' },
        },
      };
    }
    return { data: { attachment: { id: 'a1' } } };
  }) as unknown as typeof api.post);
});

afterEach(() => {
  // Never leave a held mint behind: the next case would hang on it.
  releaseMint();
  vi.unstubAllEnvs();
});

const SURFACES = [
  {
    name: 'AttachmentsTabBody (job Attachments tab)',
    render: () => renderWithProviders(<AttachmentsTabBody jobId={JOB_ID} attachments={[]} />),
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
    confirm: async () => {
      const description = await screen.findByPlaceholderText('Description *');
      fireEvent.change(description, { target: { value: 'Site walkthrough' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Upload' }));
    },
  },
];

describe.each(SURFACES)('$name — cancelling an upload in flight', ({ render, confirm }) => {
  it('offers a cancel control only while bytes are actually moving', async () => {
    const { container } = render();

    await select(container, videoFile());
    if (confirm) {
      // Before the confirm there is nothing in flight, so there is nothing to cancel.
      expect(screen.queryByRole('button', { name: /cancel upload/i })).not.toBeInTheDocument();
      await confirm();
    }

    expect(
      await screen.findByRole('button', { name: /cancel upload/i })
    ).toBeInTheDocument();
  });

  it('terminates the partial transfer and records nothing', async () => {
    const { container } = render();

    await select(container, videoFile());
    if (confirm) await confirm();

    await waitFor(() => expect(RecordedChunkedUpload.instances).toHaveLength(1));
    const upload = RecordedChunkedUpload.instances[0]!;

    fireEvent.click(await screen.findByRole('button', { name: /cancel upload/i }));

    // `true` is the terminate flag. Without it the partial upload survives at the service,
    // and nothing in the system is watching for it.
    await waitFor(() => expect(upload.aborts).toEqual([true]));

    // No attachment row for an upload the user stopped.
    await waitFor(() => expect(completeCalls()).toHaveLength(0));

    // And the row goes: a cancelled upload that keeps sitting there looking active is the
    // same as a cancel that did not work.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /cancel upload/i })).not.toBeInTheDocument()
    );
  });

  it('honours a cancel pressed while the ticket request is still in flight', async () => {
    /**
     * The Cancel control is on screen for the whole mint round-trip — the queue marks the
     * row `uploading` before it calls the transport — so this is a window a real user can
     * hit, and on cell signal it is a wide one.
     *
     * The failure it guards against was not a stalled upload. The abort was LOST, the
     * transfer started after the cancel, ran to completion, and an attachment row was
     * created: a whole video and a row for an upload the user had stopped, while the UI
     * showed the row gone.
     */
    holdTheMint();
    const { container } = render();

    await select(container, videoFile());
    if (confirm) await confirm();

    // The ticket has been asked for and has not come back.
    await waitFor(() => expect(mintCalls()).toHaveLength(1));
    expect(RecordedChunkedUpload.instances).toHaveLength(0);

    fireEvent.click(await screen.findByRole('button', { name: /cancel upload/i }));
    releaseMint();

    // The row goes, which is what the user is told.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /cancel upload/i })).not.toBeInTheDocument()
    );

    // And what the user is told is TRUE. Settle the microtask queue and the timers the
    // transport would have run on, then look again.
    await new Promise((r) => setTimeout(r, 50));
    expect(RecordedChunkedUpload.instances).toHaveLength(0);
    expect(completeCalls()).toHaveLength(0);
    expect(
      resumeRecordKeysInStorage()
    ).toHaveLength(0);
  });

  it('leaves no resume record, so the next pick is not silently resumed', async () => {
    const { container } = render();

    await select(container, videoFile());
    if (confirm) await confirm();

    await waitFor(() => expect(RecordedChunkedUpload.instances).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: /cancel upload/i }));
    await waitFor(() => expect(RecordedChunkedUpload.instances[0]!.aborts).toEqual([true]));

    await waitFor(() =>
      expect(
        resumeRecordKeysInStorage()
      ).toHaveLength(0)
    );
  });
});

describe('cancelling one row does not stall the rest of the batch', () => {
  it('starts the next queued file immediately, without waiting on the terminate', async () => {
    /**
     * The queue is serial, so exactly one thing may release it. That release used to sit in
     * the upload promise's `.then`/`.catch` — which, on a cancel, waits for
     * `upload.abort(true)`: a network DELETE the client retries on the same budget, up to
     * roughly 38 seconds.
     *
     * The row flips to `cancelled` at once, so the UI looks right while nothing moves. And
     * the connection that makes a terminate slow is the connection that makes people cancel,
     * so "cancel one file and the queue appears to die" is the common case, not the rare one.
     *
     * `abortNeverSettles` is the honest extreme of that: if the release is coupled to the
     * terminate at all, the second file never starts.
     */
    RecordedChunkedUpload.abortNeverSettles = true;

    const { container } = renderWithProviders(
      <AttachmentsTabBody jobId={JOB_ID} attachments={[]} />
    );
    let input: HTMLInputElement | undefined;
    await waitFor(() => {
      input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      expect(input).toBeTruthy();
    });
    fireEvent.change(input!, {
      target: { files: [videoFile(40, 'first.mp4'), videoFile(30, 'second.mp4')] },
    });

    // The first file is in flight; the queue is serial, so the second has not started.
    await waitFor(() => expect(RecordedChunkedUpload.instances).toHaveLength(1));
    expect(RecordedChunkedUpload.instances[0]!.file.name).toBe('first.mp4');

    fireEvent.click((await screen.findAllByRole('button', { name: /cancel upload/i }))[0]!);

    // The terminate is still outstanding and always will be. The queue must move anyway.
    await waitFor(() => expect(RecordedChunkedUpload.instances).toHaveLength(2));
    expect(RecordedChunkedUpload.instances[1]!.file.name).toBe('second.mp4');
  });

  it('keeps the queue serial: the cancelled row does not release a LATER file\'s turn', async () => {
    /**
     * The other half of releasing the queue early.
     *
     * A cancelled upload's promise settles some time after the cancel, once its terminate
     * comes back — by which point a LATER file already holds the queue's turn. If the
     * release is keyed on "something is in flight" rather than on WHICH row, that late
     * rejection clears the wrong row's turn and the queue starts a second upload while the
     * first is still running.
     *
     * Two concurrent uploads of phone video on one thin uplink is exactly what this queue is
     * serial to prevent, and it would show up as both finishing later rather than as an
     * error, so nothing else would catch it.
     */
    const { container } = renderWithProviders(
      <AttachmentsTabBody jobId={JOB_ID} attachments={[]} />
    );
    let input: HTMLInputElement | undefined;
    await waitFor(() => {
      input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      expect(input).toBeTruthy();
    });
    fireEvent.change(input!, {
      target: {
        files: [
          videoFile(40, 'first.mp4'),
          videoFile(30, 'second.mp4'),
          videoFile(20, 'third.mp4'),
        ],
      },
    });

    await waitFor(() => expect(RecordedChunkedUpload.instances).toHaveLength(1));
    fireEvent.click((await screen.findAllByRole('button', { name: /cancel upload/i }))[0]!);

    // Second takes the turn the cancel gave up.
    await waitFor(() => expect(RecordedChunkedUpload.instances).toHaveLength(2));
    expect(RecordedChunkedUpload.instances[1]!.file.name).toBe('second.mp4');

    // The first file's rejection lands about now. It must not hand the turn away again:
    // second is still going, and third must wait for it.
    await new Promise((r) => setTimeout(r, 60));
    expect(RecordedChunkedUpload.instances.map((u) => u.file.name)).toEqual([
      'first.mp4',
      'second.mp4',
    ]);
  });
});
