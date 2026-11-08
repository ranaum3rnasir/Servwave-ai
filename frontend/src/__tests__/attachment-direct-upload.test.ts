/**
 * Direct-to-storage uploads, client half (S1).
 *
 * A video's bytes must leave the browser for storage WITHOUT passing through the API, and
 * everything else must keep going exactly where it went before. Both halves of that sentence
 * are load-bearing: a regression in either direction is invisible in the UI (the file appears
 * in the list either way) and only shows up as a dead 512MB instance under real video.
 *
 * The third thing checked here is the vendor boundary. A storage rejection arrives wearing the
 * vendor's name; that message must never become the toast the user reads.
 *
 * S2 NOTE. S1 sent a video in one PUT through the storage SDK; S2 replaced that with a
 * chunked, resumable transfer. Every assertion in this file is S1's and means the same thing
 * it always did — it is only re-pointed at the transport that now carries the bytes. What a
 * chunked transfer adds (resume, cancel, the retry budget) is not tested here; it is in
 * `upload-resumable-transport.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import api from '@/lib/axios';
import { uploadAttachment } from '@/lib/attachments/uploadAttachment';
import {
  RecordedChunkedUpload,
  resetChunkedUploads,
} from './support/chunkedUploadDouble';

// The chunked client, recorded rather than run: jsdom has no storage service to talk to.
// One shared double across every suite on this path — see support/chunkedUploadDouble.ts.

vi.mock('tus-js-client', async () => {
  const { chunkedUploadModule } = await import('./support/chunkedUploadDouble');
  return chunkedUploadModule();
});

function videoFile(name = 'walkthrough.mp4') {
  return new File(['fake-mp4-bytes'], name, { type: 'video/mp4' });
}

function mintResponse(path = 'org-1/job/job-1/1758000000000-walkthrough.mp4') {
  return {
    data: {
      // Exactly what the API returns: the client builds its own URL from bucket + path +
      // token, so no signed URL is handed out.
      upload: {
        bucket: 'attachments',
        path,
        token: 'signed-upload-token',
        ticket: 'ticket.signature',
      },
    },
  };
}

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  resetChunkedUploads();
  // This suite is about the end-to-end shape, so the transfer settles by itself.
  RecordedChunkedUpload.startBehaviour = 'success';
  // A resume record from an earlier case would skip the mint every assertion below counts on.
  localStorage.clear();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://proj.supabase.co');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Which transport a file takes, asserted through what the module DOES rather than through
 * the predicate.
 *
 * `usesDirectUpload` was exported purely so this block could call it; it is now private,
 * because a transport-detector exported from the module whose job is to hide the transport
 * invites a call site to branch on it, which is the two-paths failure the PRD names. The
 * observable difference is complete and is what actually matters: the direct path mints and
 * PUTs and never posts the file to the API, the proxy path posts multipart and never touches
 * storage.
 */
describe('transport selection', () => {
  async function transportFor(file: File): Promise<'direct' | 'proxy'> {
    vi.mocked(api.post).mockReset();
    RecordedChunkedUpload.instances = [];
    localStorage.clear();
    vi.mocked(api.post)
      .mockResolvedValueOnce(mintResponse() as never)
      .mockResolvedValueOnce({ data: {} } as never);

    await uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file,
      displayName: 'X',
    });
    return RecordedChunkedUpload.instances.length > 0 ? 'direct' : 'proxy';
  }

  it('sends video straight to storage', async () => {
    expect(await transportFor(new File([''], 'a.mp4', { type: 'video/mp4' }))).toBe('direct');
    expect(await transportFor(new File([''], 'a.mov', { type: 'video/quicktime' }))).toBe(
      'direct'
    );
  });

  it('keeps everything else on the proxy path', async () => {
    expect(await transportFor(new File([''], 'a.jpg', { type: 'image/jpeg' }))).toBe('proxy');
    expect(await transportFor(new File([''], 'a.pdf', { type: 'application/pdf' }))).toBe(
      'proxy'
    );
    // The two types that keep the whole-file text check by staying on the proxy path.
    expect(await transportFor(new File([''], 'a.csv', { type: 'text/csv' }))).toBe('proxy');
    expect(await transportFor(new File([''], 'a.txt', { type: 'text/plain' }))).toBe('proxy');
  });
});

describe('uploadAttachment — video', () => {
  it('mints, sends the bytes to storage, then verifies — and never posts the file to the API', async () => {
    vi.mocked(api.post)
      .mockResolvedValueOnce(mintResponse() as never)
      .mockResolvedValueOnce({ data: { attachment: { id: 'a1' } } } as never);

    const file = videoFile();
    await uploadAttachment({
      entityType: 'job',
      entityId: 'job-1',
      file,
      displayName: 'Walkthrough',
      description: '',
    });

    const [mintCall, completeCall] = vi.mocked(api.post).mock.calls;
    expect(mintCall[0]).toBe('/api/attachments/job/job-1/direct-upload');
    expect(mintCall[1]).toEqual({
      file_name: 'walkthrough.mp4',
      content_type: 'video/mp4',
      file_size: file.size,
    });

    // The bytes went to storage at the path and under the credential the SERVER chose.
    // Nothing on the client contributes to either, which is what makes "write into another
    // org's prefix" unreachable rather than merely unlikely.
    expect(RecordedChunkedUpload.instances).toHaveLength(1);
    expect(RecordedChunkedUpload.instances[0].file).toBe(file);
    expect(RecordedChunkedUpload.instances[0].options.metadata).toMatchObject({
      bucketName: 'attachments',
      objectName: 'org-1/job/job-1/1758000000000-walkthrough.mp4',
      contentType: 'video/mp4',
    });
    expect(RecordedChunkedUpload.instances[0].options.headers?.['x-signature']).toBe(
      'signed-upload-token',
    );

    expect(completeCall[0]).toBe('/api/attachments/job/job-1/direct-upload/complete');
    expect(completeCall[1]).toEqual({
      ticket: 'ticket.signature',
      display_name: 'Walkthrough',
      description: '',
    });

    // Nothing was ever sent as multipart to the proxy route.
    for (const call of vi.mocked(api.post).mock.calls) {
      expect(call[1] instanceof FormData).toBe(false);
    }
  });

  it('does not call the verify step when the bytes never landed', async () => {
    vi.mocked(api.post).mockResolvedValueOnce(mintResponse() as never);
    RecordedChunkedUpload.startBehaviour = 'error';
    RecordedChunkedUpload.errorMessage = 'supabase storage: signature verification failed';

    await expect(
      uploadAttachment({
        entityType: 'job',
        entityId: 'job-1',
        file: videoFile(),
        displayName: 'Walkthrough',
        description: '',
      }),
    ).rejects.toThrow();

    expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1);
  });

  it('never surfaces the storage vendor\'s own wording to the user', async () => {
    vi.mocked(api.post).mockResolvedValueOnce(mintResponse() as never);
    RecordedChunkedUpload.startBehaviour = 'error';
    RecordedChunkedUpload.errorMessage =
      'supabase storage: bucket "attachments" rejected the object';

    let message = '';
    try {
      await uploadAttachment({
        entityType: 'job',
        entityId: 'job-1',
        file: videoFile(),
        displayName: 'Walkthrough',
        description: '',
      });
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toBeTruthy();
    expect(message).not.toMatch(/supabase|bucket|storage api/i);
  });
});

describe('uploadAttachment — everything else keeps the existing path', () => {
  it.each([
    ['image/jpeg', 'photo.jpg'],
    ['application/pdf', 'invoice.pdf'],
    ['text/csv', 'parts.csv'],
    ['text/plain', 'notes.txt'],
  ])('posts %s as multipart to the unchanged route', async (type, name) => {
    vi.mocked(api.post).mockResolvedValue({ data: { attachment: { id: 'a1' } } } as never);

    await uploadAttachment({
      entityType: 'customer',
      entityId: 'cust-1',
      file: new File(['bytes'], name, { type }),
      displayName: name,
      description: '',
    });

    expect(vi.mocked(api.post)).toHaveBeenCalledTimes(1);
    const [url, body, config] = vi.mocked(api.post).mock.calls[0];
    expect(url).toBe('/api/attachments/customer/cust-1');
    expect(body instanceof FormData).toBe(true);
    expect((config as { headers: Record<string, string> }).headers['Content-Type']).toBe('multipart/form-data');
    expect(RecordedChunkedUpload.instances).toHaveLength(0);
  });
});
