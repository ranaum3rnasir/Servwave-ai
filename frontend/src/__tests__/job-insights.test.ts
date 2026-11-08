import { deriveJobInsights } from '@/lib/jobs/insights';

/**
 * The "capture after/completion photos" warning is GONE, and these tests exist to keep it gone.
 *
 * It keyed on `attachment.context === 'AFTER_PHOTO'`. Nothing ever wrote that value - all four
 * photo contexts had 0 rows in production - so the flag was permanently false and the warning
 * fired on every IN_PROGRESS and COMPLETED job, ~7,400 of them, with no upload able to clear it.
 * Worse, it was ANDed into the photos_uploaded check, so the jobs that were nagged for photos
 * were exactly the jobs forbidden from being credited for the photos they already had.
 *
 * `context` is retired (an after-photo is not distinguishable from any other image), so the
 * detector cannot be repaired - only removed. Restoring either half must fail here.
 */
it('never warns about missing after-photos, on any status', () => {
  for (const status of ['UNSCHEDULED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED']) {
    const out = deriveJobInsights({ status, signature_at: null }, [{ file_type: 'image/jpeg' }], {});
    expect(out.map((i) => i.key)).not.toContain('missing_photos');
  }
});

// The suppression this warning imposed: before, an IN_PROGRESS job with photos got the nag and
// NOT the credit, because photos_uploaded was gated on the always-true needsAfterPhoto.
it('credits uploaded photos on a job that is under way', () => {
  const out = deriveJobInsights(
    { status: 'IN_PROGRESS', signature_at: null },
    [{ file_type: 'image/jpeg' }, { file_type: 'image/png' }],
    {},
  );
  const photos = out.find((i) => i.key === 'photos_uploaded');
  expect(photos?.title).toBe('2 job photos uploaded');
});

it('credits uploaded photos on a completed job', () => {
  const out = deriveJobInsights(
    { status: 'COMPLETED', signature_at: '2026-05-12T00:00:00Z' },
    [{ file_type: 'image/jpeg' }],
    {},
  );
  expect(out.map((i) => i.key)).toContain('photos_uploaded');
});

// Non-images stay on the documents track; a job with only a PDF is not "photographed".
it('counts non-image files as documents, not photos', () => {
  const out = deriveJobInsights(
    { status: 'COMPLETED', signature_at: null },
    [{ file_type: 'application/pdf' }],
    {},
  );
  const keys = out.map((i) => i.key);
  expect(keys).toContain('documents_on_file');
  expect(keys).not.toContain('photos_uploaded');
});

it('does NOT nag for a signature on a completed unsigned job (signature capture removed)', () => {
  const out = deriveJobInsights({ status: 'COMPLETED', signature_at: null }, [{ file_type: 'image/jpeg' }], {});
  expect(out.map((i) => i.key)).not.toContain('awaiting_signature');
});

it('returns no insights for a brand-new unassigned job', () => {
  const out = deriveJobInsights({ status: 'UNSCHEDULED', signature_at: null }, [], {});
  expect(out).toEqual([]);
});
