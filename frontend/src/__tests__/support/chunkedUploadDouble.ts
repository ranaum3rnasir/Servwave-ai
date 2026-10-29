/**
 * ONE recorded stand-in for the chunked upload client, shared by every suite that exercises
 * the direct path.
 *
 * Five files used to hand-roll their own `vi.mock('tus-js-client')`. That is five edits every
 * time the transport's surface moves, and — much worse — a stale one keeps passing, because a
 * double that still implements the old shape happily answers calls the real client no longer
 * receives. One double means one edit and one place to be wrong.
 *
 * Nothing here decides anything on our behalf. It records the options the seam chose and lets
 * a test drive the callbacks; what it does on `start()` is configuration, because the suites
 * genuinely need different things — the guidance suite needs a transfer that hangs so a row
 * stays visibly in flight, the S1 suite needs one that settles by itself.
 */

export interface ChunkedUploadOptions {
  endpoint?: string;
  uploadUrl?: string | null;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
  chunkSize?: number;
  retryDelays?: number[] | null;
  storeFingerprintForResuming?: boolean;
  uploadDataDuringCreation?: boolean;
  onProgress?: (loaded: number, total: number) => void;
  onSuccess?: (payload: unknown) => void;
  onError?: (err: Error) => void;
  onUploadUrlAvailable?: () => void;
}

/** What `start()` does. `hang` (the default) leaves the transfer in flight for ever. */
export type StartBehaviour = 'hang' | 'success' | 'error';

const DEFAULT_UPLOAD_URL =
  'https://proj.storage.supabase.co/storage/v1/upload/resumable/abc123';

export class RecordedChunkedUpload {
  /** Every transfer constructed since the last reset, in order. */
  static instances: RecordedChunkedUpload[] = [];
  static startBehaviour: StartBehaviour = 'hang';
  /** When set, `start()` publishes this URL first — the state a real cancel happens in. */
  static publishUrlOnStart: string | null = null;
  static errorMessage = 'the transfer failed';
  /**
   * Makes `abort()` REJECT. The terminate is a network DELETE and it fails on exactly the
   * dead connection that prompted the cancel, so this is a live path, not a curiosity.
   */
  static abortRejectsWith: Error | null = null;
  /**
   * Makes `abort()` never settle. The terminate is a network DELETE that the client retries
   * on the same budget, so on a flaky link it can take tens of seconds — long enough that
   * anything waiting on it looks stuck.
   */
  static abortNeverSettles = false;

  url: string | null;
  started = 0;
  /** Every abort, with the terminate flag it was given. */
  aborts: Array<boolean | undefined> = [];

  constructor(
    public file: File,
    public options: ChunkedUploadOptions
  ) {
    this.url = options.uploadUrl ?? null;
    RecordedChunkedUpload.instances.push(this);
  }

  start() {
    this.started += 1;
    if (RecordedChunkedUpload.publishUrlOnStart) {
      this.publishUrl(RecordedChunkedUpload.publishUrlOnStart);
    }
    const behaviour = RecordedChunkedUpload.startBehaviour;
    if (behaviour === 'hang') return;
    // Asynchronous, as the real client is: a transfer that settled inside `start()` would
    // let an ordering that cannot work against a network pass here.
    queueMicrotask(() => {
      if (behaviour === 'success') this.options.onSuccess?.({});
      else this.options.onError?.(new Error(RecordedChunkedUpload.errorMessage));
    });
  }

  abort(shouldTerminate?: boolean): Promise<void> {
    this.aborts.push(shouldTerminate);
    if (RecordedChunkedUpload.abortNeverSettles) return new Promise<void>(() => {});
    return RecordedChunkedUpload.abortRejectsWith
      ? Promise.reject(RecordedChunkedUpload.abortRejectsWith)
      : Promise.resolve();
  }

  /** Stand in for the service handing back an upload URL mid-transfer. */
  publishUrl(url: string = DEFAULT_UPLOAD_URL) {
    this.url = url;
    this.options.onUploadUrlAvailable?.();
  }
}

/** Call in `beforeEach`. `vi.clearAllMocks()` does not reach any of this. */
export function resetChunkedUploads(): void {
  RecordedChunkedUpload.instances = [];
  RecordedChunkedUpload.startBehaviour = 'hang';
  RecordedChunkedUpload.publishUrlOnStart = null;
  RecordedChunkedUpload.errorMessage = 'the transfer failed';
  RecordedChunkedUpload.abortRejectsWith = null;
  RecordedChunkedUpload.abortNeverSettles = false;
}

/** The transfer the case under test started. Throws rather than returning undefined. */
export function lastChunkedUpload(): RecordedChunkedUpload {
  const upload = RecordedChunkedUpload.instances.at(-1);
  if (!upload) throw new Error('no chunked upload was constructed');
  return upload;
}

/**
 * The module shape `tus-js-client` exports, for `vi.mock`.
 *
 * Returning a plain object from the constructor is what lets the double keep its own class
 * identity while the production code holds what it thinks is a `tus.Upload`.
 */
export function chunkedUploadModule() {
  return {
    Upload: class {
      constructor(file: File, options: ChunkedUploadOptions) {
        return new RecordedChunkedUpload(file, options) as unknown as object;
      }
    },
  };
}

export { DEFAULT_UPLOAD_URL };

/**
 * The resume-record keys currently in browser storage.
 *
 * Enumerated through the Storage API (`length` + `key(i)`) and NOT with
 * `Object.keys(localStorage)`. The harness installs a class-based in-memory shim whose
 * entries live in a field holding a `Map`, and TypeScript's `private` is compile-time only,
 * so at runtime that field is a real own property: `Object.keys(localStorage)` answers
 * `["store"]` and never the stored keys.
 *
 * Both ways of writing it are wrong and they fail differently, which is worth knowing when
 * fixing this class of bug. FILTERED by a key prefix it always answers `[]` — a test that
 * cannot fail. UNFILTERED, `expect(Object.keys(localStorage)).toHaveLength(0)` FAILS on that
 * stray `"store"`, and looks like real signal while saying nothing about storage at all.
 */
export function resumeRecordKeysInStorage(): string[] {
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('servwave:upload-resume:')) keys.push(key);
  }
  return keys;
}
