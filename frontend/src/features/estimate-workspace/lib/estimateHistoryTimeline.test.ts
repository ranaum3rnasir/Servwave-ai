/**
 * #2030 slice 4 — merging the version stream into the activity stream.
 *
 * The ordering is the whole difficulty, so it is tested here, away from any rendering: ties,
 * unusable timestamps, and the two degenerate streams (no versions, no events).
 */
import { describe, it, expect } from 'vitest';
import {
  buildEstimateHistoryTimeline,
  type EstimateActivityEvent,
  type EstimateVersionSummary,
} from './estimateHistoryTimeline';

function event(id: string, created_at: string, action = 'estimate.updated'): EstimateActivityEvent {
  return { id, action, actor_email: 'rep@example.com', created_at };
}

function version(v: number, sent_at: string): EstimateVersionSummary {
  return { id: `snap-${v}`, version: v, trigger: 'SEND', total_amount: 1000 * v, sent_at };
}

describe('the estimate history timeline', () => {
  it('puts versions and events in one list, newest first', () => {
    const timeline = buildEstimateHistoryTimeline(
      [event('e-2', '2026-03-02T12:00:00Z'), event('e-1', '2026-01-02T12:00:00Z')],
      [version(1, '2026-02-01T12:00:00Z')],
    );

    expect(timeline.map((entry) => entry.key)).toEqual(['event:e-2', 'version:snap-1', 'event:e-1']);
  });
});

describe('when two entries share an instant', () => {
  it('puts the version above the event it was minted with — the version is the anchor', () => {
    // A send writes the audit row and mints the snapshot in the same breath, so this tie is the
    // COMMON case, not an edge one.
    const timeline = buildEstimateHistoryTimeline(
      [event('e-sent', '2026-02-01T12:00:00Z', 'estimate.sent')],
      [version(1, '2026-02-01T12:00:00Z')],
    );

    expect(timeline.map((entry) => entry.key)).toEqual(['version:snap-1', 'event:e-sent']);
  });

  it('puts the newer version above the older one', () => {
    const timeline = buildEstimateHistoryTimeline(
      [],
      [version(1, '2026-02-01T12:00:00Z'), version(2, '2026-02-01T12:00:00Z')],
    );

    expect(timeline.map((entry) => entry.key)).toEqual(['version:snap-2', 'version:snap-1']);
  });
});

/**
 * Rows written before minting assigned its own ordinal can still share a version number, and the
 * number is NOT what identifies a snapshot — `id` is. Keying React off the number put two children
 * under one key, which is a warning today and a wrongly-reused DOM node the moment either row
 * gains state.
 */
describe('when two snapshots share a version number', () => {
  it('keys each off its own identity, not off the number they collide on', () => {
    const timeline = buildEstimateHistoryTimeline(
      [],
      [
        { id: 'snap-a', version: 1, trigger: 'SEND', total_amount: 1000, sent_at: '2026-02-01T12:00:00Z' },
        { id: 'snap-b', version: 1, trigger: 'COPY_TO_INVOICE', total_amount: 1000, sent_at: '2026-02-03T12:00:00Z' },
      ],
    );

    const keys = timeline.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual(['version:snap-b', 'version:snap-a']);
  });
});

describe('when a stream is degenerate', () => {
  it('sinks an entry whose timestamp cannot be read, instead of scrambling the rest', () => {
    const timeline = buildEstimateHistoryTimeline(
      [event('e-broken', 'not a date'), event('e-1', '2026-01-02T12:00:00Z')],
      [version(1, '2026-02-01T12:00:00Z')],
    );

    expect(timeline.map((entry) => entry.key)).toEqual(['version:snap-1', 'event:e-1', 'event:e-broken']);
  });

  it('returns just the events when the estimate has no versions', () => {
    const timeline = buildEstimateHistoryTimeline([event('e-1', '2026-01-02T12:00:00Z')], []);

    expect(timeline.map((entry) => entry.kind)).toEqual(['event']);
  });

  it('returns just the versions when there are no events', () => {
    const timeline = buildEstimateHistoryTimeline([], [version(1, '2026-02-01T12:00:00Z')]);

    expect(timeline.map((entry) => entry.kind)).toEqual(['version']);
  });

  it('is empty, not broken, when neither stream has loaded yet', () => {
    expect(buildEstimateHistoryTimeline(undefined, undefined)).toEqual([]);
  });
});
