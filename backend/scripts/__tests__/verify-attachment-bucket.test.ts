/**
 * S4 — the one check that would have caught the mismatch S4 creates.
 *
 * Raising `MAX_VIDEO_FILE_SIZE` to 512MB (536,870,912 bytes) while the storage bucket's own
 * `file_size_limit` stays at 64 MiB gives the user the worst of both: the app happily accepts a 300MB clip, the
 * bytes are pushed the whole way, and storage refuses them at the end with a message we do not
 * control and did not write. `verify-attachment-bucket` is the tool that detects exactly that
 * — and until this slice it answered it with `console.warn` and then `process.exit(0)`.
 *
 * A warning on a run nobody watches is not a check. The size mismatch now fails the run, the
 * same way the mime-list mismatch already did.
 *
 * Both halves are tested: `bucketProblems` for the rule, and `verifyAttachmentBucket` for the
 * EXIT CODE, because the rule being right buys nothing if the script does not act on it. That
 * gap is precisely how the size check came to be a warning in the first place.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  bucketProblems,
  verifyAttachmentBucket,
  type AttachmentBucket,
} from '../verify-attachment-bucket';
import { ALLOWED_MIME_TYPES, MAX_VIDEO_FILE_SIZE } from '../../src/controllers/attachment.controller';

const MiB = 1024 * 1024;

/** A bucket that is wide enough in every respect. Narrow it per test. */
function healthyBucket(overrides: Partial<AttachmentBucket> = {}): AttachmentBucket {
  return {
    allowed_mime_types: [...ALLOWED_MIME_TYPES],
    file_size_limit: MAX_VIDEO_FILE_SIZE + 1,
    ...overrides,
  };
}

describe('bucketProblems — the size ceiling is a PROBLEM, not a note', () => {
  it('is silent about a bucket that is wider than the app in every respect', () => {
    expect(bucketProblems(healthyBucket())).toEqual([]);
  });

  it('fails a bucket whose ceiling is below the app cap', () => {
    // 64 MiB is the measured value on both projects as of 2026-09-18, and is what makes this
    // the live case rather than a hypothetical.
    const problems = bucketProblems(healthyBucket({ file_size_limit: 64 * MiB }));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/file_size_limit/);
  });

  it('ACCEPTS a bucket whose ceiling exactly equals the app cap', () => {
    // Reversed 2026-09-20. The rule used to demand strictly-above on the premise that a file
    // at the app limit lands on the bucket's boundary and either gate might answer. Measured
    // against staging's live bucket with a resumable-upload creation POST, that premise is
    // false: 536870912 -> 201 Created, 536870913 -> 413. The ceiling is INCLUSIVE, so at
    // equality the bucket never fires and our own 400 is the only gate at the boundary —
    // which is what the old rule wanted. Equality is now the shipped configuration, because
    // the app cap is pinned to the bucket limit.
    expect(bucketProblems(healthyBucket({ file_size_limit: MAX_VIDEO_FILE_SIZE }))).toEqual([]);
  });

  it('accepts a ceiling one byte above the app cap', () => {
    expect(bucketProblems(healthyBucket({ file_size_limit: MAX_VIDEO_FILE_SIZE + 1 }))).toEqual([]);
  });

  it('fails a ceiling one byte BELOW the app cap', () => {
    expect(
      bucketProblems(healthyBucket({ file_size_limit: MAX_VIDEO_FILE_SIZE - 1 })),
    ).toHaveLength(1);
  });

  it('treats an absent ceiling as unlimited rather than as zero', () => {
    expect(bucketProblems(healthyBucket({ file_size_limit: null }))).toEqual([]);
  });

  it('still fails a bucket that rejects a type the API accepts', () => {
    // The original reason this script exists (#1605). Kept under test so the size check being
    // promoted to a problem cannot quietly displace it.
    const problems = bucketProblems(
      healthyBucket({ allowed_mime_types: ALLOWED_MIME_TYPES.filter((t) => t !== 'text/csv') }),
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('text/csv');
  });

  it('reports BOTH kinds at once rather than stopping at the first', () => {
    const problems = bucketProblems({
      allowed_mime_types: ALLOWED_MIME_TYPES.filter((t) => t !== 'video/mp4'),
      file_size_limit: 64 * MiB,
    });

    expect(problems).toHaveLength(2);
  });
});

/**
 * The boundary in LITERAL BYTES, which is the only fixture that can catch the constant and
 * the rule drifting together.
 *
 * Every fixture above derives from `MAX_VIDEO_FILE_SIZE`. That is right for the relative
 * invariants — a derived expectation cannot go stale — but it is exactly why this suite stayed
 * green while the real invariant broke: the app cap moved to 536,870,912, the rule still said
 * "strictly above", and the derived cases happily re-asserted the new wrong rule against the
 * new number. `verify-attachment-bucket` then exited 1 against a bucket that is correctly
 * configured.
 *
 * So the two numbers below are typed out. If someone changes the cap, these fail and the
 * boundary is re-decided rather than drifted past.
 *
 * 536,870,912 = 512 MiB = the `file_size_limit` on the `attachments` bucket on BOTH staging
 * and production (read from `storage.buckets`, 2026-09-20), and the value `MAX_VIDEO_FILE_SIZE`
 * is pinned to.
 */
describe('bucketProblems — the 512 MiB boundary, in literal bytes', () => {
  const FIVE_HUNDRED_TWELVE_MIB = 536870912;

  it('pins the app cap to the bucket limit these literals describe', () => {
    // Without this, the two cases below would silently start testing some other boundary.
    expect(MAX_VIDEO_FILE_SIZE).toBe(FIVE_HUNDRED_TWELVE_MIB);
  });

  it('ACCEPTS a file_size_limit of exactly 536870912 against a 536870912 cap', () => {
    expect(bucketProblems({
      allowed_mime_types: [...ALLOWED_MIME_TYPES],
      file_size_limit: 536870912,
    })).toEqual([]);
  });

  it('REPORTS a file_size_limit of 536870911 against a 536870912 cap', () => {
    const problems = bucketProblems({
      allowed_mime_types: [...ALLOWED_MIME_TYPES],
      file_size_limit: 536870911,
    });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('536870911');
  });
});

describe('verifyAttachmentBucket — the exit code, which is the only thing cron reads', () => {
  it('exits 0 when the bucket is wide enough', async () => {
    const code = await verifyAttachmentBucket(async () => ({ bucket: healthyBucket() }));

    expect(code).toBe(0);
  });

  it('exits NON-ZERO on a too-small ceiling, rather than warning and passing', async () => {
    // This is the assertion the slice is for. Before S4 the same input printed `WARN - ...`
    // and returned success, so a green run proved nothing about the size at all.
    const code = await verifyAttachmentBucket(async () => ({
      bucket: healthyBucket({ file_size_limit: 64 * MiB }),
    }));

    expect(code).not.toBe(0);
  });

  it('says what was wrong on the way out', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });

    await verifyAttachmentBucket(async () => ({
      bucket: healthyBucket({ file_size_limit: 64 * MiB }),
    }));
    spy.mockRestore();

    // A phrase unique to this gate. Asserting only on the byte count would also be satisfied
    // by the "OK - ..." line, which echoes nothing but happens to run in the same script.
    expect(errors.join('\n')).toMatch(/file_size_limit/);
    expect(errors.join('\n')).toMatch(/narrower than the API/i);
  });

  it('exits non-zero when the bucket cannot be read at all', async () => {
    const code = await verifyAttachmentBucket(async () => ({ bucket: null, error: 'not found' }));

    expect(code).not.toBe(0);
  });
});

/**
 * The PASSING output, which nothing checked until it was caught being wrong.
 *
 * The whole argument for deriving a message from the constant it enforces is that a message
 * misstating what was checked is worse than no message: the reader believes it and stops
 * looking. That applies to a success line exactly as much as to a refusal — and it was the
 * success line this slice got wrong. The OK sentence asserted "its ceiling is above the API's
 * cap" on every clean run, including the run where `file_size_limit` is null and no ceiling
 * was ever compared to anything.
 *
 * Null is not a hypothetical shape: three of the five buckets on staging carry it today.
 */
describe('verifyAttachmentBucket — the OK line may only claim what it checked', () => {
  function captureLog() {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    });
    return { read: () => lines.join('\n'), restore: () => spy.mockRestore() };
  }

  it('claims the ceiling clears the cap only when there IS a ceiling', async () => {
    const log = captureLog();
    const code = await verifyAttachmentBucket(async () => ({
      bucket: healthyBucket({ file_size_limit: MAX_VIDEO_FILE_SIZE + 1 }),
    }));
    log.restore();

    expect(code).toBe(0);
    expect(log.read()).toMatch(/ceiling is above/i);
    expect(log.read()).toContain(String(MAX_VIDEO_FILE_SIZE));
  });

  it('does NOT say the ceiling is ABOVE the cap when it exactly equals it', async () => {
    // The shipped configuration. "above" would be a false claim about the one comparison
    // this script does make — the same defect as the null branch below, one byte along.
    const log = captureLog();
    const code = await verifyAttachmentBucket(async () => ({
      bucket: healthyBucket({ file_size_limit: MAX_VIDEO_FILE_SIZE }),
    }));
    log.restore();

    expect(code).toBe(0);
    expect(log.read()).not.toMatch(/ceiling is above/i);
    expect(log.read()).toMatch(/ceiling is exactly/i);
  });

  it('does NOT claim a ceiling clears the cap when the bucket has no ceiling', async () => {
    const log = captureLog();
    const code = await verifyAttachmentBucket(async () => ({
      bucket: healthyBucket({ file_size_limit: null }),
    }));
    log.restore();

    // Still a pass: no ceiling cannot be narrower than the API.
    expect(code).toBe(0);
    // But it must not report a comparison it never made.
    expect(log.read()).not.toMatch(/ceiling is above/i);
    expect(log.read()).toMatch(/no bucket ceiling set/i);
  });

  /**
   * The limit above the bucket limit, which this script structurally cannot see.
   *
   * A bucket's `file_size_limit` cannot exceed the project-level global, so a bucket value
   * clearing the app cap is necessary and NOT sufficient: the global can still refuse the
   * upload, and it lives somewhere no code in this repo can read. An operator reading a green
   * run as "512MB uploads work now" is drawing the one conclusion this script is not entitled
   * to support — and before this fix neither the script nor its tests mentioned the global at
   * all, so nothing stopped them.
   */
  it('says out loud that a limit it cannot see sits above the one it can', async () => {
    const log = captureLog();
    await verifyAttachmentBucket(async () => ({ bucket: healthyBucket() }));
    log.restore();

    expect(log.read()).toMatch(/project-level/i);
  });
});
