import { env } from '../../config/env';
import { logger } from '../logger';
import { prisma } from '../prisma';
import { supabaseAdmin } from '../supabase';
import { CtmApiError, getRecordingResponse } from './client';

/**
 * Call-recording ingest: CTM → private Supabase Storage bucket.
 *
 * The recording is ALWAYS fetched by stored sid through getRecordingResponse
 * (client.ts SSRF/redirect rules) — never from a payload-derived URL. The body
 * is buffered under a hard 50MB cap (download aborted beyond it), uploaded to
 * env.CTM_RECORDINGS_BUCKET at `{orgId}/{callSessionId}.{ext}` and the
 * CallSession row is stamped with `recording_key` on success.
 *
 * FAILURE CONTRACT: ingestRecording never throws. Transient failures
 * (network/429/5xx) retry up to 3 attempts with backoff; a terminal failure
 * leaves recording_key null (playback 404s "not available") and emits ONE
 * warn log — the backfill script re-attempts missing recordings later.
 */

const MAX_RECORDING_BYTES = 50 * 1024 * 1024; // 50MB — mirrors the plan §0 cap
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const MAX_CONCURRENT_DOWNLOADS = 2;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class RecordingTooLargeError extends Error {
  constructor() {
    super(`Recording exceeds the ${MAX_RECORDING_BYTES}-byte cap`);
    this.name = 'RecordingTooLargeError';
  }
}

/**
 * Tiny in-module concurrency limiter: at most `max` tasks run at once, the
 * rest queue FIFO. Recording downloads are webhook-triggered fire-and-forget,
 * so without this a burst of `end` events could open unbounded CTM downloads.
 * Exported for tests.
 */
export function createDownloadLimiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** The shared limiter every recording ingest goes through (cap = 2). */
export const runWithDownloadSlot = createDownloadLimiter(MAX_CONCURRENT_DOWNLOADS);

// Only network/timeouts, 429 and 5xx are worth retrying — a CTM 4xx (missing
// recording, bad sid) will never succeed, and an oversized body never shrinks.
function isTransient(err: unknown): boolean {
  if (err instanceof RecordingTooLargeError) return false;
  if (err instanceof CtmApiError) {
    return err.httpStatus === 0 || err.httpStatus === 429 || err.httpStatus >= 500;
  }
  // Unknown failure shape (fetch TypeError/AbortError, storage hiccup):
  // retrying is bounded by MAX_ATTEMPTS, so err on the side of retrying.
  return true;
}

// wav or mp3 from the response content-type; CTM recordings default to mp3.
function extFromContentType(contentType: string): 'wav' | 'mp3' {
  return contentType.toLowerCase().includes('wav') ? 'wav' : 'mp3';
}

/** Buffer the response body, aborting the download past the size cap. */
async function bufferBodyWithCap(res: Response): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_RECORDING_BYTES) {
    throw new RecordingTooLargeError();
  }

  if (!res.body) {
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_RECORDING_BYTES) throw new RecordingTooLargeError();
    return Buffer.from(ab);
  }

  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RECORDING_BYTES) {
      await reader.cancel(); // abort the transfer, don't just stop reading
      throw new RecordingTooLargeError();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export interface IngestRecordingArgs {
  orgId: string;
  callSessionId: string;
  ctmAccountId: string;
  callSid: string;
}

export async function ingestRecording(args: IngestRecordingArgs): Promise<void> {
  const { orgId, callSessionId, ctmAccountId, callSid } = args;

  await runWithDownloadSlot(async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Fetch by sid ONLY (never a payload URL — SSRF rule, client.ts).
        const res = await getRecordingResponse(ctmAccountId, callSid);
        const contentType = res.headers.get('content-type') ?? '';
        const ext = extFromContentType(contentType);
        const body = await bufferBodyWithCap(res);

        const key = `${orgId}/${callSessionId}.${ext}`;
        // upsert:true — the backfill re-attempts recordings; a re-ingest of the
        // same call must overwrite, not 409 (key is deterministic per call).
        const { error: uploadError } = await supabaseAdmin.storage
          .from(env.CTM_RECORDINGS_BUCKET)
          .upload(key, body, {
            contentType: ext === 'wav' ? 'audio/wav' : 'audio/mpeg',
            upsert: true,
          });
        if (uploadError) {
          throw new Error(`storage upload failed: ${uploadError.message}`);
        }

        await prisma.callSession.update({
          where: { id: callSessionId },
          data: { recording_key: key },
        });
        return;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS && isTransient(err)) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        // Terminal: recording_key stays null (playback 404s; backfill retries).
        // ONE warn, no throw — and no payload data in the log (sid only).
        logger.warn(
          `[ctm] recording ingest failed (callSessionId=${callSessionId}, sid=${callSid}, attempts=${attempt}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    }
  });
}
