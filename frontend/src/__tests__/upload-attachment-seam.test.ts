/**
 * `uploadAttachment` — the one place that knows how an attachment's bytes travel.
 *
 * This file exists because "shared seam" was previously a claim rather than a fact: the same
 * multipart block was written out four times, once per surface, so swapping the transport
 * would have meant a four-way edit and four chances to diverge.
 *
 * It has now been through TWO of the swaps it was written for. S5 shipped this seam with a
 * multipart body and a note that S1 would "replace this file wholesale" behind the same
 * signature; S1 landed and it did. S2 then replaced S1's single PUT with a chunked, resumable
 * transfer. The surfaces did not change on either occasion, which is the property the seam was
 * extracted to buy, and the assertions below are the S5 ones re-pointed at whichever transport
 * now carries the case:
 *
 *   non-video -> multipart, unchanged, progress included
 *   video     -> direct to storage, chunked and resumable (mint, chunks, verify), progress
 *                included — S1's silent window is closed
 *
 * The routing rule itself, the vendor-wording boundary and the "never verify what never
 * landed" rule are S1's and are covered in `attachment-direct-upload.test.ts`; resume, cancel
 * and the retry budget are S2's and live in `upload-resumable-transport.test.ts`. What is here
 * is the part a SURFACE depends on: the request shape, the File arriving untouched, the
 * description default, progress forwarding, and failures propagating so each surface can
 * word its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import api from '@/lib/axios';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';
import { lastChunkedUpload, resetChunkedUploads } from './support/chunkedUploadDouble';

// The chunked client, recorded rather than run: there is no storage service here and no
// sixty megabytes to push at one. Our own decisions are still real — the seam picks the
// options and the seam reads the callbacks back. One shared double, see support/.

vi.mock('tus-js-client', async () => {
  const { chunkedUploadModule } = await import('./support/chunkedUploadDouble');
  return chunkedUploadModule();
});

/** Let the mint's promise settle so the transfer exists. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

const mockApi = vi.mocked(api);

beforeEach(() => {
  vi.clearAllMocks();
  resetChunkedUploads();
  // A resume record surviving from an earlier case would skip the mint and change what every
  // video case below observes. `clearAllMocks` does not touch browser storage.
  localStorage.clear();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
  mockApi.post.mockResolvedValue({ data: {} });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A non-video attachment: still the multipart path, byte-for-byte as before. */
function docOf(name = 'report.pdf', type = 'application/pdf'): File {
  return new File(['x'], name, { type });
}

function videoOf(name = 'clip.mp4'): File {
  return new File(['x'], name, { type: 'video/mp4' });
}

function mintOnce() {
  mockApi.post
    .mockResolvedValueOnce({
      data: {
        upload: { bucket: 'attachments', path: 'org-1/clip.mp4', token: 'tok', ticket: 'tkt' },
      },
    } as never)
    .mockResolvedValueOnce({ data: { attachment: { id: 'a1' } } } as never);
}

describe('uploadAttachment — multipart path (everything that is not video)', () => {
  it('posts multipart to the entity route', async () => {
    await uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file: docOf(),
      displayName: 'Walkthrough',
      description: 'Front door',
    });

    expect(mockApi.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockApi.post.mock.calls[0]!;
    expect(url).toBe('/api/attachments/job/job-1');
    expect((config as { headers: Record<string, string> }).headers['Content-Type']).toBe(
      'multipart/form-data'
    );
    const form = body as FormData;
    expect(form.get('display_name')).toBe('Walkthrough');
    expect(form.get('description')).toBe('Front door');
  });

  /**
   * THE rope. Slice 5's central promise is that the bytes uploaded are the bytes selected -
   * Ran rejected client-side re-encoding outright, and job footage can end up as evidence in
   * a dispute. `toBe` is an IDENTITY check and that is the whole point: weakening it to
   * `toEqual` would silently permit a copy, and a copy is precisely where a re-encode
   * enters. `uploadAttachment.ts` names this test in the `file` field's doc comment so a
   * reader arriving from either side finds the other.
   */
  it('sends the exact File it was given — the seam does not re-encode either', async () => {
    const file = docOf('evidence.pdf');
    await uploadAttachment({
      entityType: 'customer',
      entityId: 'c-1',
      file,
      displayName: 'Evidence',
    });
    const form = mockApi.post.mock.calls[0]![1] as FormData;
    expect(form.get('file')).toBe(file);
  });

  it('defaults description to empty rather than omitting the part', async () => {
    await uploadAttachment({
      entityType: 'lead',
      entityId: 'l-1',
      file: docOf(),
      displayName: 'Clip',
    });
    const form = mockApi.post.mock.calls[0]![1] as FormData;
    expect(form.get('description')).toBe('');
  });

  it('reports real byte counts to a transport-neutral callback', async () => {
    // The caller says `(loaded, total)` and never sees an axios event: adapting is this
    // module's job, once, because hiding the transport is what it exists for. When S2 swaps
    // the body the callback signature is unchanged and no call site moves.
    const onProgress = vi.fn();
    await uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file: docOf(),
      displayName: 'Clip',
      onProgress,
    });
    const config = mockApi.post.mock.calls[0]![2] as {
      onUploadProgress?: (e: { loaded: number; total?: number }) => void;
    };
    expect(config.onUploadProgress).toBeTypeOf('function');

    config.onUploadProgress!({ loaded: 25, total: 100 });
    expect(onProgress).toHaveBeenCalledWith(25, 100);

    // An absent total stays absent rather than becoming a zero the renderer would draw.
    config.onUploadProgress!({ loaded: 25, total: undefined });
    expect(onProgress).toHaveBeenLastCalledWith(25, undefined);
  });

  it('defaults the display name to the file name without its extension', async () => {
    // Was written out identically at four call sites before it moved in here.
    await uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file: docOf('site walkthrough.pdf'),
    });
    const form = mockApi.post.mock.calls[0]![1] as FormData;
    expect(form.get('display_name')).toBe('site walkthrough');
  });

  it('omits the progress key entirely when no callback is given', async () => {
    await uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file: docOf(),
      displayName: 'Clip',
    });
    const config = mockApi.post.mock.calls[0]![2] as Record<string, unknown>;
    expect('onUploadProgress' in config).toBe(false);
  });

  it('lets the rejection through so each surface can word its own failure', async () => {
    const boom = new Error('nope');
    mockApi.post.mockRejectedValueOnce(boom);
    await expect(
      uploadAttachment({
        entityType: 'job',
        entityId: 'job-1',
        file: docOf(),
        displayName: 'Clip',
      })
    ).rejects.toBe(boom);
  });
});

describe('uploadAttachment — direct path (video)', () => {
  it('hands the transport the exact File it was given, and never builds a FormData for it', async () => {
    mintOnce();
    const file = videoOf('evidence.mp4');

    const done = uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file,
      displayName: 'Evidence',
      description: 'Front door',
    });
    await settle();

    // Identity, not equivalence: a re-encode would necessarily produce a different object.
    const sent = lastChunkedUpload().file;
    expect(sent).toBe(file);
    expect(sent.type).toBe('video/mp4');
    expect(sent.name).toBe('evidence.mp4');

    lastChunkedUpload().options.onSuccess?.({});
    await done;

    // Nothing about this file went through the API as a body. Both API calls are metadata.
    for (const [, body] of mockApi.post.mock.calls) {
      expect(body instanceof FormData).toBe(false);
    }
  });

  it('defaults description to empty on the verify call too', async () => {
    mintOnce();
    const done = uploadAttachment({
      entityType: 'lead',
      entityId: 'l-1',
      file: videoOf(),
      displayName: 'Clip',
    });
    await settle();
    lastChunkedUpload().options.onSuccess?.({});
    await done;

    const [, completeBody] = mockApi.post.mock.calls[1]!;
    expect((completeBody as { description: string }).description).toBe('');
  });

  it('lets the rejection through so each surface can word its own failure', async () => {
    const boom = new Error('mint refused');
    mockApi.post.mockRejectedValueOnce(boom);
    await expect(
      uploadAttachment({
        entityType: 'job',
        entityId: 'job-1',
        file: videoOf(),
        displayName: 'Clip',
      })
    ).rejects.toBe(boom);
  });

  it('reports real byte counts to the same transport-neutral callback the multipart path uses', async () => {
    /**
     * PIN 1 of 5, rewritten by S2 rather than deleted.
     *
     * It used to assert the opposite — that the direct path called nothing back — because S1
     * routed video at a single PUT that reports no progress, and every surface rendered an
     * indeterminate "Uploading…" for video as a result. That was a regression against S5,
     * pinned deliberately so it could not be forgotten. The chunked transport reports per
     * chunk, so the pin now asserts the numbers arrive, through the SAME `(loaded, total)`
     * callback the multipart branch uses. No caller distinguishes the two.
     *
     * Note the argument name. The old version of this case passed `onUploadProgress`, which
     * is not a field this module accepts — so it could only ever have passed. That is why it
     * is spelled out here: the callback is `onProgress`.
     */
    mintOnce();
    const onProgress = vi.fn();
    const done = uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file: videoOf(),
      displayName: 'Clip',
      onProgress,
    });
    await settle();

    const { options } = lastChunkedUpload();
    expect(options.onProgress).toBeTypeOf('function');

    options.onProgress!(6 * 1024 * 1024, 40 * 1024 * 1024);
    expect(onProgress).toHaveBeenCalledWith(6 * 1024 * 1024, 40 * 1024 * 1024);

    options.onProgress!(24 * 1024 * 1024, 40 * 1024 * 1024);
    expect(onProgress).toHaveBeenLastCalledWith(24 * 1024 * 1024, 40 * 1024 * 1024);

    options.onSuccess?.({});
    await done;
  });
});
