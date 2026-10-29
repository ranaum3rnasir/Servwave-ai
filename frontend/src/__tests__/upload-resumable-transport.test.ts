/**
 * S2 — resumable transport, at the seam.
 *
 * S1 put video on a single PUT: one request, no progress, and a drop at 90% meant starting
 * again from zero. This file pins the replacement. It drives `uploadAttachment` — the public
 * entry point — and never the transport module directly, because the property that matters is
 * that the SEAM behaves this way, not that a helper exists somewhere that could.
 *
 * The chunked client is mocked, for the same reason jsdom cannot run a media pipeline: there
 * is no storage service here and no sixty megabytes to push at one. What is NOT mocked is any
 * of our own decision-making — which URL, which header, which chunk size, whether to resume,
 * whether to verify afterwards, what the user is told when it finally gives up. Every one of
 * those is read back off the options object we handed the client.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import api from '@/lib/axios';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';
import {
  DEFAULT_UPLOAD_URL,
  RecordedChunkedUpload,
  lastChunkedUpload,
  resetChunkedUploads,
  resumeRecordKeysInStorage,
} from './support/chunkedUploadDouble';
import { resetAccountScopedStores } from '@/lib/storeReset';
import { clearAllResumeRecords } from '@/lib/attachments/resumeRecordStore';
import {
  RESUMABLE_CHUNK_BYTES,
  RESUME_RECORD_MAX_AGE_MS,
  UPLOAD_CANCELLED_MESSAGE,
  UPLOAD_INTERRUPTED_MESSAGE,
  resumableUploadEndpoint,
  resumeRecordKey,
  readResumeRecord,
} from '@/lib/attachments/resumableTransport';

// ─── The chunked client, recorded rather than run ───────────────────────────
//
// The double is shared with every other suite that touches this path — see
// `support/chunkedUploadDouble.ts` for why there is exactly one of it.

vi.mock('tus-js-client', async () => {
  const { chunkedUploadModule } = await import('./support/chunkedUploadDouble');
  return chunkedUploadModule();
});

const mockApi = vi.mocked(api);

const MB = 1024 * 1024;

function videoOf(name = 'walkthrough.mp4', size = 40 * MB): File {
  const f = new File(['x'], name, { type: 'video/mp4' });
  Object.defineProperty(f, 'size', { value: size });
  Object.defineProperty(f, 'lastModified', { value: 1_700_000_000_000 });
  return f;
}

/** The mint, then the verify-and-record. Re-armed per test: `clearAllMocks` keeps neither. */
function armApi(path = 'org-1/job/job-1/1700000000000-walkthrough.mp4') {
  mockApi.post.mockImplementation((async (url: string) => {
    if (typeof url === 'string' && url.endsWith('/direct-upload')) {
      return {
        data: { upload: { bucket: 'attachments', path, token: 'signed-token', ticket: 'tkt-1' } },
      };
    }
    return { data: { attachment: { id: 'a1' } } };
  }) as unknown as typeof api.post);
}

function mintCalls() {
  return mockApi.post.mock.calls.filter(([url]) => String(url).endsWith('/direct-upload'));
}
function completeCalls() {
  return mockApi.post.mock.calls.filter(([url]) => String(url).endsWith('/direct-upload/complete'));
}

/** Let the pending microtasks around the mint settle so the upload exists. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetChunkedUploads();
  localStorage.clear();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
  armApi();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ─── Where the bytes go, and with what ──────────────────────────────────────

describe('resumableUploadEndpoint', () => {
  /**
   * THE ROUTE, SPELLED OUT, because getting it wrong is what broke production.
   *
   * There are two resumable routes and they differ by one path segment. The plain one,
   * `/storage/v1/upload/resumable`, authenticates the CALLER — a session bearer token — and
   * answers `400 Invalid signature` to a presigned request. The signed one,
   * `/storage/v1/upload/resumable/sign`, authenticates the REQUEST, validating the
   * `x-signature` token server-side against the exact object path it was minted for. We hold
   * a path-scoped token and no session credential, so the signed route is the only one that
   * can work for us.
   *
   * The first shipped version pointed at the unsigned route. Every video upload failed with a
   * `400` that reads as a credential problem — which sent the first investigation after the
   * token, the header name and the hostname, none of which were wrong. Hence a test that
   * NAMES the URL rather than a constant nobody asserts: the next person to see that 400
   * should find this case first.
   *
   * Measured against live staging with the token our own mint endpoint issues: POST to the
   * `/sign` route answers `201` with a `Location`, PATCH advances the offset (`204`), HEAD
   * reports it back (`200`). No `Authorization`, no `apikey`, no session token on any request.
   */
  it('targets the SIGNED resumable route, not the session-authenticated one', () => {
    expect(resumableUploadEndpoint('https://proj.supabase.co')).toBe(
      'https://proj.storage.supabase.co/storage/v1/upload/resumable/sign'
    );
  });

  it('never points at the unsigned route, which cannot accept a presigned upload', () => {
    // Asserted as its own case, negatively, because this is the exact regression: the
    // unsigned path is a strict prefix of the signed one, so a check written as
    // `toContain('/upload/resumable')` would pass on the broken URL.
    const url = new URL(resumableUploadEndpoint('https://proj.supabase.co'));
    expect(url.pathname).toBe('/storage/v1/upload/resumable/sign');
    expect(url.pathname).not.toBe('/storage/v1/upload/resumable');
    expect(url.pathname.endsWith('/sign')).toBe(true);
  });

  it('leaves a host it does not recognise alone rather than inventing a subdomain', () => {
    // Self-hosted and custom-domain deployments have no `<ref>.storage.` twin. Rewriting
    // blindly would point every upload at a name that does not resolve.
    expect(resumableUploadEndpoint('https://storage.example.test')).toBe(
      'https://storage.example.test/storage/v1/upload/resumable/sign'
    );
  });
});

describe('uploadAttachment — video goes up in resumable chunks', () => {
  it('sends the bytes to the direct storage hostname in 6MB chunks, signed with the mint token', async () => {
    const file = videoOf();
    const done = uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file,
      displayName: 'Walkthrough',
    });
    await settle();

    const u = lastChunkedUpload();
    // The literal the transport was configured with. `resumableUploadEndpoint` has its own
    // cases above; this one exists because a correct helper wired to the wrong call site is
    // the same outage.
    expect(u.options.endpoint).toBe(
      'https://proj.storage.supabase.co/storage/v1/upload/resumable/sign'
    );
    // The S1 token carries over as a signature header — it is not traded for anything else.
    expect(u.options.headers?.['x-signature']).toBe('signed-token');
    expect(u.options.headers?.authorization).toBeUndefined();
    // 6 MiB BINARY — 6,291,456 bytes on the wire. The vendor's "6MB" is ambiguous between
    // this and 6,000,000 decimal, so the literal is spelled out rather than left to be
    // re-derived from prose.
    expect(u.options.chunkSize).toBe(6_291_456);
    expect(RESUMABLE_CHUNK_BYTES).toBe(6_291_456);
    expect(RESUMABLE_CHUNK_BYTES).not.toBe(6_000_000);
    // Every field of `Upload-Metadata`, `cacheControl` included.
    //
    // It is here because the request measured working end to end carried it, and that is a
    // policy a comment alone cannot defend: a later cleanup reasoning "this isn't documented
    // as required, drop it" would pass every other gate. On a branch that exists BECAUSE one
    // element of the request shape was wrong, the newest element of the known-good request is
    // the last one that should be left unpinned.
    expect(u.options.metadata).toEqual({
      bucketName: 'attachments',
      objectName: 'org-1/job/job-1/1700000000000-walkthrough.mp4',
      contentType: 'video/mp4',
      cacheControl: '3600',
    });
    // Identity, not equivalence — the same rope S5 and S1 hold: a re-encode would
    // necessarily produce a different object.
    expect(u.file).toBe(file);
    expect(u.started).toBe(1);

    u.options.onSuccess?.({});
    await done;
  });

  it('has a retry budget rather than failing on the first dropped packet', async () => {
    void uploadAttachment({ entityType: 'job', entityId: 'job-1', file: videoOf() }).catch(
      () => {}
    );
    await settle();
    const delays = lastChunkedUpload().options.retryDelays;
    expect(Array.isArray(delays)).toBe(true);
    expect(delays!.length).toBeGreaterThanOrEqual(3);
  });

  it('reports real bytes transferred through the transport-neutral callback', async () => {
    const onProgress = vi.fn();
    const done = uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file: videoOf(),
      onProgress,
    });
    await settle();

    const u = lastChunkedUpload();
    // Numbers the transport measured, forwarded unchanged and unrounded.
    u.options.onProgress?.(6 * MB, 40 * MB);
    expect(onProgress).toHaveBeenCalledWith(6 * MB, 40 * MB);
    u.options.onProgress?.(30 * MB, 40 * MB);
    expect(onProgress).toHaveBeenLastCalledWith(30 * MB, 40 * MB);

    u.options.onSuccess?.({});
    await done;
  });

  it('records the attachment only after the bytes have landed — the sniff is not skipped', async () => {
    const done = uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file: videoOf(),
      displayName: 'Walkthrough',
    });
    await settle();

    // Nothing recorded while the transfer is still running.
    expect(completeCalls()).toHaveLength(0);

    lastChunkedUpload().options.onSuccess?.({});
    await done;

    expect(completeCalls()).toHaveLength(1);
    expect(completeCalls()[0]![1]).toMatchObject({ ticket: 'tkt-1', display_name: 'Walkthrough' });
  });
});

// ─── Resuming ───────────────────────────────────────────────────────────────

describe('uploadAttachment — an interrupted video resumes where it stopped', () => {
  async function interruptedAttempt(file: File) {
    const attempt = uploadAttachment({ entityType: 'job', entityId: 'job-1', file }).catch(
      (err: unknown) => err
    );
    await settle();
    const u = lastChunkedUpload();
    u.publishUrl();
    u.options.onProgress?.(18 * MB, 40 * MB);
    u.options.onError?.(new Error('network gone'));
    return { failure: await attempt, upload: u };
  }

  it('picks the transfer back up at the stored upload URL instead of minting a new one', async () => {
    const file = videoOf();
    await interruptedAttempt(file);

    expect(mintCalls()).toHaveLength(1);
    expect(completeCalls()).toHaveLength(0);

    // Second attempt: same file, same record.
    const done = uploadAttachment({ entityType: 'job', entityId: 'job-1', file });
    await settle();

    const resumed = lastChunkedUpload();
    expect(resumed.options.uploadUrl).toBe(
      DEFAULT_UPLOAD_URL
    );
    // No second mint: a fresh ticket would name a fresh storage path, and the verify step
    // would then go looking for an object the resumed transfer never wrote.
    expect(mintCalls()).toHaveLength(1);

    resumed.options.onSuccess?.({});
    await done;

    // Still verified and recorded, against the ORIGINAL ticket.
    expect(completeCalls()).toHaveLength(1);
    expect(completeCalls()[0]![1]).toMatchObject({ ticket: 'tkt-1' });
  });

  it('tells the user it stopped, and offers the resume without promising it', async () => {
    const { failure } = await interruptedAttempt(videoOf());
    expect((failure as Error).message).toBe(UPLOAD_INTERRUPTED_MESSAGE);
    // De-branded: the storage service's own name never reaches this sentence.
    expect((failure as Error).message.toLowerCase()).not.toMatch(/supabase|storage|bucket|tus/);
  });

  it('throws away a record missing any field the resumed transfer needs', async () => {
    /**
     * Every field on a record is load-bearing, so validation has to cover every field. A
     * record missing `bucket` does not fail loudly — it resumes with
     * `metadata.bucketName === undefined`, which is a transfer aimed at nowhere.
     */
    const file = videoOf();
    await interruptedAttempt(file);
    const key = resumeRecordKey('job', 'job-1', file);

    for (const field of ['uploadUrl', 'ticket', 'bucket', 'path', 'token', 'mintedAt']) {
      const stored = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
      const damaged = { ...stored };
      delete damaged[field];
      localStorage.setItem(key, JSON.stringify(damaged));

      expect(readResumeRecord(key), `a record with no \`${field}\` must not be honoured`).toBeNull();
      // Rejected AND removed: a record that cannot be used is only a trap to re-read.
      expect(localStorage.getItem(key)).toBeNull();

      localStorage.setItem(key, JSON.stringify(stored));
    }
  });

  it('starts over rather than resuming once the record is older than the ticket outlives', async () => {
    const file = videoOf();
    await interruptedAttempt(file);

    // Age the record past its window. Resuming on a dead ticket would fail the verify step
    // with nothing the user could do about it, so a stale record is thrown away.
    const key = resumeRecordKey('job', 'job-1', file);
    const stored = JSON.parse(localStorage.getItem(key)!) as { mintedAt: number };
    localStorage.setItem(
      key,
      JSON.stringify({ ...stored, mintedAt: Date.now() - RESUME_RECORD_MAX_AGE_MS - 1 })
    );
    expect(readResumeRecord(key)).toBeNull();

    const done = uploadAttachment({ entityType: 'job', entityId: 'job-1', file });
    await settle();
    expect(lastChunkedUpload().options.uploadUrl).toBeUndefined();
    expect(mintCalls()).toHaveLength(2);

    lastChunkedUpload().options.onSuccess?.({});
    await done;
  });

  it('does not restart the 90-minute window every time it resumes', async () => {
    /**
     * The invariant the whole window rests on, and the one thing about it that is not
     * self-evident from the code.
     *
     * Each resume rewrites the record — that is how the new upload URL gets stored. If it
     * also rewrote `mintedAt`, the window would reset on every attempt and a record could be
     * honoured indefinitely: the client would keep resuming, and keep pushing bytes at a
     * signature that died when the two-hour ticket expired. The upload would fail at the
     * very end, every time, having spent the whole file. `RESUME_RECORD_MAX_AGE_MS` exists
     * precisely to stop that, and it can only do so if the clock starts at the MINT.
     */
    const file = videoOf();
    const key = resumeRecordKey('job', 'job-1', file);

    await interruptedAttempt(file);

    // Age it deliberately rather than relying on two Date.now() calls differing: on a fast
    // machine they do not, and the assertion would pass for the wrong reason.
    const mintedAt = Date.now() - 30 * 60 * 1000;
    const stored = JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
    localStorage.setItem(key, JSON.stringify({ ...stored, mintedAt }));

    // A second attempt, which resumes and is interrupted again.
    const second = uploadAttachment({ entityType: 'job', entityId: 'job-1', file }).catch(
      () => {}
    );
    await settle();
    lastChunkedUpload().publishUrl('https://proj.storage.supabase.co/storage/v1/upload/resumable/def456');
    lastChunkedUpload().options.onError?.(new Error('network gone again'));
    await second;

    const after = JSON.parse(localStorage.getItem(key)!) as { mintedAt: number; uploadUrl: string };
    // The URL moved on; the clock did not.
    expect(after.uploadUrl).toContain('def456');
    expect(after.mintedAt).toBe(mintedAt);
  });

  it('does not resume one record onto a different record', async () => {
    const file = videoOf();
    await interruptedAttempt(file);

    // Same file, different job. Resuming here would write another job's video into this one.
    const done = uploadAttachment({ entityType: 'job', entityId: 'job-2', file });
    await settle();
    expect(lastChunkedUpload().options.uploadUrl).toBeUndefined();

    lastChunkedUpload().options.onSuccess?.({});
    await done;
  });

  it('uploads the same file twice in a row — the record is cleared once it is recorded', async () => {
    const file = videoOf();

    const first = uploadAttachment({ entityType: 'job', entityId: 'job-1', file });
    await settle();
    lastChunkedUpload().publishUrl();
    lastChunkedUpload().options.onSuccess?.({});
    await first;

    expect(readResumeRecord(resumeRecordKey('job', 'job-1', file))).toBeNull();

    const second = uploadAttachment({ entityType: 'job', entityId: 'job-1', file });
    await settle();
    // A leftover record would resume the FINISHED upload, and the verify step would answer
    // with the first attachment — the second upload silently doing nothing.
    expect(lastChunkedUpload().options.uploadUrl).toBeUndefined();
    expect(mintCalls()).toHaveLength(2);

    lastChunkedUpload().options.onSuccess?.({});
    await second;
    expect(completeCalls()).toHaveLength(2);
  });
});

// ─── Cancelling ─────────────────────────────────────────────────────────────

describe('uploadAttachment — cancelling an in-flight video', () => {
  it('terminates the partial transfer rather than abandoning it in the bucket', async () => {
    const controller = new AbortController();
    const attempt = uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file: videoOf(),
      signal: controller.signal,
    }).catch((err: unknown) => err);
    await settle();

    const u = lastChunkedUpload();
    u.publishUrl();
    controller.abort();
    const failure = await attempt;

    // `true` is the terminate flag. Without it the partial upload survives on the service,
    // and the operator-run orphan sweep does not see incomplete transfers at all.
    expect(u.aborts).toEqual([true]);
    expect((failure as Error).message).toBe(UPLOAD_CANCELLED_MESSAGE);
    // Nothing recorded: a cancelled upload must not produce a row.
    expect(completeCalls()).toHaveLength(0);
  });

  it('KEEPS the resume record when the terminate itself fails', async () => {
    /**
     * The terminate is a network DELETE, and the likeliest moment for it to fail is the dead
     * connection that made the user reach for Cancel in the first place. A live path, not a
     * curiosity.
     *
     * Two things must not happen when it fails. The record must not be cleared — it holds
     * the upload URL, the ONLY handle that could ever remove that partial, and an abandoned
     * chunked transfer is not a stored object, so S3's sweep cannot find it either. Clearing
     * on a failed terminate turns a recoverable leak into a permanent one. And the rejection
     * must not escape: `void promise.finally(...)` re-throws whatever the promise rejected
     * with, which here is an unhandled rejection every time someone cancels while offline.
     */
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandled.push(event.reason);
      event.preventDefault();
    };
    window.addEventListener('unhandledrejection', onUnhandled);

    try {
      RecordedChunkedUpload.abortRejectsWith = new Error('DELETE failed: offline');
      const controller = new AbortController();
      const file = videoOf();
      const attempt = uploadAttachment({
        entityType: 'job',
        entityId: 'job-1',
        file,
        signal: controller.signal,
      }).catch((err: unknown) => err);
      await settle();

      lastChunkedUpload().publishUrl();
      controller.abort();
      const failure = await attempt;

      // The user is still told it is cancelled — our cleanup trouble is not their problem.
      expect((failure as Error).message).toBe(UPLOAD_CANCELLED_MESSAGE);
      expect(lastChunkedUpload().aborts).toEqual([true]);
      expect(completeCalls()).toHaveLength(0);

      // The handle survives, so the partial is still removable.
      const kept = readResumeRecord(resumeRecordKey('job', 'job-1', file));
      expect(kept).not.toBeNull();
      expect(kept!.uploadUrl).toBe(DEFAULT_UPLOAD_URL);

      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener('unhandledrejection', onUnhandled);
    }
  });

  it('records nothing when the cancel lands between the last chunk and the verify call', async () => {
    /**
     * Narrow, but it is the window the docstring used to claim was impossible. The abort
     * listener comes off when the transfer resolves, so without a re-check the signal is
     * never consulted again and `complete` creates a row for an upload the user stopped —
     * after the UI has already removed the row.
     *
     * The landed object is deliberately NOT a problem here: by this point it is a stored
     * object with no row pointing at it, which is exactly what S3's sweep collects. Bytes we
     * have to sweep beat a row the user did not ask for.
     */
    const controller = new AbortController();
    const file = videoOf();
    const attempt = uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file,
      signal: controller.signal,
    }).catch((err: unknown) => err);
    await settle();

    // The transfer finishes and the cancel lands in the same tick.
    controller.abort();
    lastChunkedUpload().options.onSuccess?.({});

    const failure = await attempt;
    expect((failure as Error).message).toBe(UPLOAD_CANCELLED_MESSAGE);
    expect(completeCalls()).toHaveLength(0);
    expect(readResumeRecord(resumeRecordKey('job', 'job-1', file))).toBeNull();
  });

  it('leaves no resume record behind, so a cancel is not silently resumed later', async () => {
    const controller = new AbortController();
    const file = videoOf();
    const attempt = uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file,
      signal: controller.signal,
    }).catch(() => {});
    await settle();
    lastChunkedUpload().publishUrl();
    controller.abort();
    await attempt;

    expect(readResumeRecord(resumeRecordKey('job', 'job-1', file))).toBeNull();
  });

  it('never starts the transfer at all when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadAttachment({
        entityType: 'job',
        entityId: 'job-1',
        file: videoOf(),
        signal: controller.signal,
      })
    ).rejects.toThrow(UPLOAD_CANCELLED_MESSAGE);
    // Nothing was minted and nothing exists at the service, so there is nothing to terminate
    // and no reason to build a transfer in order to find that out.
    expect(RecordedChunkedUpload.instances).toHaveLength(0);
    expect(completeCalls()).toHaveLength(0);
  });

  it('still terminates the leftover partial when an already-aborted signal meets a resume record', async () => {
    /**
     * The mirror of the case above, and the reason "already aborted" cannot simply throw on
     * the way in. With a resume record in hand there IS something at the service — the
     * partial a previous attempt left — and terminating it means going through the
     * transport. Throwing early would be quicker and would leak it.
     */
    const file = videoOf();
    const first = uploadAttachment({ entityType: 'job', entityId: 'job-1', file }).catch(() => {});
    await settle();
    lastChunkedUpload().publishUrl();
    lastChunkedUpload().options.onError?.(new Error('network gone'));
    await first;
    expect(readResumeRecord(resumeRecordKey('job', 'job-1', file))).not.toBeNull();

    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadAttachment({ entityType: 'job', entityId: 'job-1', file, signal: controller.signal })
    ).rejects.toThrow(UPLOAD_CANCELLED_MESSAGE);

    expect(lastChunkedUpload().aborts).toEqual([true]);
    // And it never started pushing bytes in order to do it.
    expect(lastChunkedUpload().started).toBe(0);
    expect(readResumeRecord(resumeRecordKey('job', 'job-1', file))).toBeNull();
    expect(completeCalls()).toHaveLength(0);
  });

  it('stops an upload cancelled DURING the mint, rather than completing it behind the user', async () => {
    /**
     * The window this closes is the mint round-trip, and it is not theoretical: the queue
     * marks a row `uploading` BEFORE it calls the transport, so the Cancel control is on
     * screen for the whole of it. On cell signal that round-trip is exactly the moment
     * someone realises they picked the wrong clip.
     *
     * `addEventListener('abort')` is the trap. A signal already aborted by the time the
     * listener is attached never fires again, so the abort was simply lost: the transfer
     * started, ran to completion and `complete` created an attachment row — a whole video
     * and a row, for an upload the user had stopped. The promise never settled either, so
     * the row sat in flight for ever.
     */
    const controller = new AbortController();
    let releaseMint!: () => void;
    const mintInFlight = new Promise<void>((resolve) => {
      releaseMint = resolve;
    });
    mockApi.post.mockImplementation((async (url: string) => {
      if (typeof url === 'string' && url.endsWith('/direct-upload')) {
        await mintInFlight;
        return {
          data: {
            upload: { bucket: 'attachments', path: 'org-1/p.mp4', token: 'tok', ticket: 'tkt-1' },
          },
        };
      }
      return { data: { attachment: { id: 'a1' } } };
    }) as unknown as typeof api.post);

    const attempt = uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file: videoOf(),
      signal: controller.signal,
    }).catch((err: unknown) => err);
    await settle();

    // Mid-flight: the ticket has been asked for and has not come back.
    expect(mintCalls()).toHaveLength(1);
    expect(RecordedChunkedUpload.instances).toHaveLength(0);

    controller.abort();
    releaseMint();

    // Settling at all is half the assertion — the defect left this pending for ever.
    const outcome = await Promise.race([
      attempt,
      new Promise((resolve) => setTimeout(() => resolve('STILL PENDING'), 100)),
    ]);
    expect(outcome).not.toBe('STILL PENDING');
    expect((outcome as Error).message).toBe(UPLOAD_CANCELLED_MESSAGE);

    // No bytes pushed, and above all no row recorded.
    expect(RecordedChunkedUpload.instances).toHaveLength(0);
    expect(completeCalls()).toHaveLength(0);
  });
});

// ─── The window this depends on ─────────────────────────────────────────────

describe('the client resume window against the server ticket it depends on', () => {
  /**
   * The resume record is only useful for as long as the ticket minted beside it is still
   * accepted. Read the server's own number rather than restating it: if someone shortens
   * `DIRECT_UPLOAD_TTL_SECONDS`, a client that kept resuming past it would push a whole video
   * at a URL whose signature has expired and then fail the verify step.
   */
  const ROOT = join(__dirname, '..', '..', '..');
  const LIB_PATH = 'backend/src/lib/attachment-direct-upload.ts';

  it('stays strictly inside the server ticket TTL', () => {
    const source = readFileSync(join(ROOT, LIB_PATH), 'utf8');
    const match = /const DIRECT_UPLOAD_TTL_SECONDS = (\d+) \* (\d+) \* (\d+);/.exec(source);
    if (!match) {
      throw new Error(
        `Could not find \`const DIRECT_UPLOAD_TTL_SECONDS = A * B * C\` in ${LIB_PATH}. If it ` +
          'was renamed or restructured, update this test - do not delete it: it is the only ' +
          'check that reads both trees for this coupling.'
      );
    }
    const ttlMs = Number(match[1]) * Number(match[2]) * Number(match[3]) * 1000;
    expect(RESUME_RECORD_MAX_AGE_MS).toBeLessThan(ttlMs);
  });
});

// ─── Account-scoped state ───────────────────────────────────────────────────

describe('resume records are account-scoped browser state', () => {
  /**
   * A resume record holds a signed WRITE credential for a storage path, good for about two
   * hours. This repo has already decided what happens to account-scoped browser state at
   * logout — `storeReset.ts` exists for it, and `auth.store.ts` calls it — and this state
   * opted out silently by living in `localStorage` rather than in a store.
   *
   * The concrete case is a technician signing out of a shared tablet and leaving a live
   * write credential behind for whoever signs in next.
   *
   * The same sweep is the only thing that ever garbage-collects these at all: reading ages
   * out the one key it was asked about and nothing walks the rest, so a record for a file
   * nobody re-picks sits in storage for good.
   */
  it('are cleared by the account-scoped reset that logout runs', async () => {
    const file = videoOf();
    const attempt = uploadAttachment({ entityType: 'job', entityId: 'job-1', file }).catch(
      () => {}
    );
    await settle();
    lastChunkedUpload().publishUrl();
    lastChunkedUpload().options.onError?.(new Error('network gone'));
    await attempt;

    // Something unrelated, to prove the sweep is scoped and not a `localStorage.clear()`.
    localStorage.setItem('servwave:nav-layout', 'wide');
    expect(readResumeRecord(resumeRecordKey('job', 'job-1', file))).not.toBeNull();

    resetAccountScopedStores();

    expect(
      resumeRecordKeysInStorage()
    ).toHaveLength(0);
    expect(localStorage.getItem('servwave:nav-layout')).toBe('wide');
  });

  it('clears every record, not only the ones a read happens to touch', () => {
    // Nothing else walks the prefix, so without this the store only ever grows.
    localStorage.setItem('servwave:upload-resume:job|a|x.mp4|1|1|video/mp4', '{}');
    localStorage.setItem('servwave:upload-resume:lead|b|y.mov|2|2|video/quicktime', '{}');

    clearAllResumeRecords();

    expect(
      resumeRecordKeysInStorage()
    ).toHaveLength(0);
  });
});
