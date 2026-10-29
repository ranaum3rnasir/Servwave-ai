/**
 * Fails when the `attachments` bucket's own rules are narrower than the app's (#1605).
 *
 * The .docx outage came from exactly this drift: `ALLOWED_MIME_TYPES`, the magic-byte sniffer
 * and the browser `accept` filter were all widened to Office/CSV/TXT, while the bucket's
 * `allowed_mime_types` still held the original seven. Every app-side gate passed and Supabase
 * rejected the object, which surfaced as an unexplained "Failed to upload file".
 *
 * Nothing in code can see that config, so this check has to talk to the project. Run it against
 * staging and prod after any change to the allow-list or the size caps:
 *
 *   npm run verify:attachment-bucket --workspace=backend
 */
import { supabaseAdmin } from '../src/lib/supabase';
import { ALLOWED_MIME_TYPES, MAX_VIDEO_FILE_SIZE } from '../src/controllers/attachment.controller';
import { ATTACHMENTS_BUCKET } from '../src/lib/attachment-access';

/**
 * Is the bucket's own size ceiling narrower than the app's?
 *
 * The rule used to be `limit <= appCap`: equality was treated as a problem, on the theory
 * that "a file at exactly the app limit lands on the bucket's boundary" and so the app cap
 * would not really be reachable. That premise is empirically FALSE, which is why this rule
 * changed — not because it was in the way.
 *
 * Measured 2026-09-20 against the attachments bucket with a resumable-upload creation POST:
 *
 *   Upload-Length: 536870912  (exactly 512 MiB)  -> HTTP 201 Created  (then DELETE -> 204)
 *   Upload-Length: 536870913  (one byte more)    -> HTTP 413 "Maximum size exceeded"
 *
 * The storage ceiling is INCLUSIVE. At equality the bucket does not fire, so the app's own
 * 400 stays the only gate that can refuse at the boundary — which is exactly what the old
 * rule was trying to guarantee. Equality is now the INTENDED configuration: MAX_VIDEO_FILE_SIZE
 * is deliberately pinned to the bucket's file_size_limit (536,870,912 on both staging and
 * production, confirmed by SQL on 2026-09-20), so a rule that flags equality reports a problem
 * on every environment we run and teaches operators to ignore the output.
 *
 * A bucket limit BELOW the app cap is still a real failure and still reported: storage then
 * refuses with a 413 that we neither raise nor phrase, so the user sees an unexplained upload
 * failure — the same shape as the .docx outage this script was written for.
 *
 * Extracted and exported so the boundary is unit-testable; `main()` has no harness.
 * Returns the warning text, or undefined when the bucket is wide enough.
 */
export function bucketLimitWarning(
  limit: number | null | undefined,
  appCap: number,
): string | undefined {
  // A null limit means "no bucket ceiling", which can never be narrower than the app's.
  if (limit == null) return undefined;
  if (limit >= appCap) return undefined;
  return (
    `the bucket's file_size_limit (${limit} bytes) is BELOW the API's largest accepted ` +
    `file (${appCap} bytes), so storage will refuse those uploads with a 413 the app never ` +
    `phrases`
  );
}

async function main(): Promise<void> {
  const { data: bucket, error } = await supabaseAdmin.storage.getBucket(ATTACHMENTS_BUCKET);
  if (error || !bucket) {
    console.error(`Could not read the ${ATTACHMENTS_BUCKET} bucket: ${error?.message ?? 'not found'}`);
    process.exit(1);
  }

  const problems: string[] = [];
  const warnings: string[] = [];

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

  const limit = bucket.file_size_limit;
  const limitWarning = bucketLimitWarning(limit, MAX_VIDEO_FILE_SIZE);
  if (limitWarning) warnings.push(limitWarning);

  for (const w of warnings) console.warn(`WARN - ${w}`);

  if (problems.length) {
    console.error(`FAIL - ${ATTACHMENTS_BUCKET} bucket is narrower than the API:\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  console.log(`OK - ${ATTACHMENTS_BUCKET} accepts every type the API does (${ALLOWED_MIME_TYPES.length} types).`);
}

// Guarded so the pure helper above can be imported by its unit test without the import
// running a live check against a Supabase project.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
