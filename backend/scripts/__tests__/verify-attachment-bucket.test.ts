/**
 * The bucket-ceiling rule, pinned at the boundary with LITERAL byte counts.
 *
 * The rule inverted in this change. It used to flag `limit <= appCap`, so it reported a
 * problem whenever the bucket's file_size_limit equalled the app's cap. That is now the
 * intended configuration on every environment — MAX_VIDEO_FILE_SIZE is deliberately pinned
 * to the bucket's own 536,870,912 — so the old rule fired everywhere and taught operators
 * to ignore the script's output.
 *
 * The premise behind the old rule was that at equality the bucket would refuse the file
 * first. Measured 2026-09-20 with a resumable-upload creation POST: 536870912 answers
 * 201 Created, 536870913 answers 413. The ceiling is INCLUSIVE.
 *
 * The numbers below are written out rather than derived from MAX_VIDEO_FILE_SIZE. A fixture
 * spelled with the constant moves whenever the constant moves, so it could never catch the
 * app cap and the measured storage ceiling drifting apart — and that drift is the only thing
 * this rule exists to detect.
 */
import { describe, it, expect } from 'vitest';
import { bucketLimitWarning } from '../verify-attachment-bucket';
import { MAX_VIDEO_FILE_SIZE } from '../../src/controllers/attachment.controller';

const BUCKET_LIMIT = 536870912; // 512 MiB, the measured file_size_limit on staging and prod

describe('bucketLimitWarning — equality is fine, below is not', () => {
  it('ACCEPTS a bucket limit exactly equal to the app cap', () => {
    expect(bucketLimitWarning(536870912, 536870912)).toBeUndefined();
  });

  it('REPORTS a bucket limit one byte below the app cap', () => {
    const warning = bucketLimitWarning(536870911, 536870912);
    expect(warning).toBeDefined();
    expect(warning).toContain('536870911');
    expect(warning).toContain('536870912');
    // The wording has to say which way round the problem is. "does not exceed" was the old
    // message and is simply wrong for a rule that now only fires when the bucket is smaller.
    expect(warning).toMatch(/BELOW/);
    expect(warning).not.toMatch(/does not exceed/);
  });

  it('accepts a bucket limit above the app cap', () => {
    expect(bucketLimitWarning(536870913, 536870912)).toBeUndefined();
  });

  it('accepts a null limit — no bucket ceiling is never narrower than the app', () => {
    expect(bucketLimitWarning(null, 536870912)).toBeUndefined();
    expect(bucketLimitWarning(undefined, 536870912)).toBeUndefined();
  });

  /**
   * The drift detector. If someone raises MAX_VIDEO_FILE_SIZE without also raising the
   * bucket, the app starts minting tickets for files storage will 413 — and because the app
   * cap is what the UI quotes, the user is told the file fits and then watches it fail. This
   * asserts against the measured bucket number, not against the constant.
   */
  it('pins the app cap to the measured bucket limit of 536,870,912 bytes', () => {
    expect(MAX_VIDEO_FILE_SIZE).toBe(BUCKET_LIMIT);
    expect(bucketLimitWarning(BUCKET_LIMIT, MAX_VIDEO_FILE_SIZE)).toBeUndefined();
  });
});
