/**
 * Fails when the `attachments` bucket's own rules are narrower than the app's (#1605).
 *
 * The .docx outage came from exactly this drift: `ALLOWED_MIME_TYPES`, the magic-byte sniffer
 * and the browser `accept` filter were all widened to Office/CSV/TXT, while the bucket's
 * `allowed_mime_types` still held the original seven. Every app-side gate passed and the
 * storage service rejected the object, which surfaced as an unexplained "Failed to upload file".
 *
 * Nothing in code can see that config, so this check has to talk to the project. Run it against
 * staging and prod after any change to the allow-list or the size caps:
 *
 *   npm run verify:attachment-bucket --workspace=backend
 *
 * S4 — THE SIZE MISMATCH IS NOW A FAILURE, NOT A WARNING. It used to `console.warn` and then
 * exit 0, so a green run proved nothing at all about the size. That is the wrong way round: a
 * bucket ceiling below the app cap is the single most likely thing to be wrong on the day the
 * app cap is raised, which is the day this script is most likely to be run. A warning on a run
 * nobody watches is not a check.
 *
 * The rule and the exit code are split below so BOTH can be tested. The exit code being
 * untested is how the size check came to be a warning in the first place.
 *
 * WHAT A GREEN RUN DOES NOT MEAN. A bucket's `file_size_limit` cannot exceed the PROJECT-LEVEL
 * global file size limit, which lives in the storage platform's own settings and which nothing
 * in this repo can read. So a bucket wide enough to clear the app cap is necessary and not
 * sufficient, and this script cannot tell anyone that an upload of that size succeeds — only
 * that the bucket would not be the thing to stop it. That caveat is printed on every pass
 * rather than living here, because the person most likely to over-read a green run is the one
 * running it straight after a cap change, and they are reading the terminal, not this header.
 */
import { supabaseAdmin } from '../src/lib/supabase';
import { ALLOWED_MIME_TYPES, MAX_VIDEO_FILE_SIZE } from '../src/controllers/attachment.controller';
import { ATTACHMENTS_BUCKET } from '../src/lib/attachment-access';

/** Only the two fields this check reads, so a test need not fake a whole bucket. */
export interface AttachmentBucket {
  allowed_mime_types: string[] | null;
  file_size_limit: number | null;
}

export interface BucketRead {
  bucket: AttachmentBucket | null;
  error?: string;
}

/**
 * Every way the bucket is narrower than the API, as sentences. Empty means healthy.
 *
 * Reports ALL of them rather than stopping at the first: whoever fixes this is in the storage
 * settings already, and sending them back for a second round trip is how a check stops being
 * run at all.
 */
export function bucketProblems(bucket: AttachmentBucket): string[] {
  const problems: string[] = [];

  // A null allow-list means "anything", which is permissive enough to never cause this failure.
  const allowed = bucket.allowed_mime_types;
  if (allowed) {
    const missing = ALLOWED_MIME_TYPES.filter((t) => !allowed.includes(t));
    if (missing.length) {
      problems.push(
        `the bucket rejects ${missing.length} type(s) the API accepts:\n    ${missing.join('\n    ')}`,
      );
    }
  }

  // EQUALITY IS FINE, AND IT IS THE INTENDED CONFIGURATION. This rule used to demand the
  // bucket ceiling sit STRICTLY above the app cap, on the premise that a file at exactly the
  // app limit "lands on the bucket's own boundary, and whichever gate answers first decides
  // what the user is told". That premise is empirically false, which is why the rule changed
  // and not because equality became convenient.
  //
  // Measured on staging 2026-09-20, against the live bucket, with a resumable-upload creation
  // POST — the real ceiling, not the documented one:
  //
  //   Upload-Length: 536870912  (exactly 512 MiB)  -> HTTP 201 Created   (then DELETE -> 204)
  //   Upload-Length: 536870913  (one byte more)    -> HTTP 413 "Maximum size exceeded"
  //
  // The storage ceiling is INCLUSIVE. At equality the bucket does not fire at all, so a file
  // at exactly the app cap is accepted by storage and our own 400 remains the only gate that
  // can refuse at the boundary — which is exactly what the old rule was trying to guarantee.
  //
  // The app cap is now deliberately PINNED to the bucket limit (536,870,912 on both projects,
  // Ran 2026-09-20), so equality is the configuration we ship, not a drift to be flagged.
  //
  // A ceiling BELOW the app cap is still a genuine failure and still fails this run: there,
  // storage refuses with a 413 we neither raise nor phrase, after the user has already paid
  // for the whole upload.
  const limit = bucket.file_size_limit;
  if (limit != null && limit < MAX_VIDEO_FILE_SIZE) {
    problems.push(
      `the bucket's file_size_limit (${limit} bytes) is below the API's largest accepted ` +
      `file (${MAX_VIDEO_FILE_SIZE} bytes)`,
    );
  }

  return problems;
}

async function readAttachmentBucket(): Promise<BucketRead> {
  const { data, error } = await supabaseAdmin.storage.getBucket(ATTACHMENTS_BUCKET);
  if (error || !data) return { bucket: null, error: error?.message ?? 'not found' };
  return {
    bucket: {
      allowed_mime_types: data.allowed_mime_types ?? null,
      file_size_limit: data.file_size_limit ?? null,
    },
  };
}

/**
 * The whole run, returning the process exit code.
 *
 * Extracted from `main()` with an injectable reader for the same reason `sweepExitProblem` was
 * extracted in `attachment-orphan-sweep.ts`: a rule with no harness over its CALLER can be
 * right while the program ignores it. The exit code is the only thing cron or a `&&` chain
 * ever reads, so the exit code is what the tests assert.
 */
export async function verifyAttachmentBucket(
  readBucket: () => Promise<BucketRead> = readAttachmentBucket,
): Promise<number> {
  const { bucket, error } = await readBucket();
  if (!bucket) {
    console.error(`Could not read the ${ATTACHMENTS_BUCKET} bucket: ${error ?? 'not found'}`);
    return 1;
  }

  const problems = bucketProblems(bucket);
  if (problems.length) {
    console.error(`FAIL - ${ATTACHMENTS_BUCKET} bucket is narrower than the API:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }

  // Claim only what was actually compared. A null `file_size_limit` means there is no bucket
  // ceiling to compare against: the run still passes — nothing can be narrower than the API
  // when there is no limit at all — but "its ceiling is above the cap" would report a check
  // that never ran. That is the same defect as a refusal naming the wrong limit, sitting in
  // the branch nobody reads carefully because it says OK.
  // Three outcomes, not two, because the ceiling may now legitimately EQUAL the cap and
  // "above" would be a false claim on the configuration we actually ship. Same rule as the
  // null branch below it: the line may only say what was compared.
  const ceiling = bucket.file_size_limit == null
    ? 'no bucket ceiling set'
    : bucket.file_size_limit === MAX_VIDEO_FILE_SIZE
      ? `its ceiling is exactly the API's ${MAX_VIDEO_FILE_SIZE}-byte cap`
      : `its ceiling is above the API's ${MAX_VIDEO_FILE_SIZE}-byte cap`;

  console.log(
    `OK - ${ATTACHMENTS_BUCKET} accepts every type the API does ` +
    `(${ALLOWED_MIME_TYPES.length} types), ${ceiling}.`,
  );

  // The standing caveat, printed on every pass rather than left in a comment. A bucket's
  // file_size_limit cannot exceed the PROJECT-LEVEL global limit, and no code in this repo can
  // read that number — so a green run here is necessary and not sufficient. "Uploads of that
  // size work now" is the one conclusion this script cannot support, and whoever runs it the
  // day a cap is raised is exactly the person about to draw it.
  console.log(
    '     Note: a project-level global file size limit sits above the bucket limit and is not ' +
    'visible from here, so this check cannot prove an upload of that size succeeds.',
  );
  return 0;
}

// Guarded so importing this module in a test does not fire a live check at the project.
if (require.main === module) {
  verifyAttachmentBucket()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
