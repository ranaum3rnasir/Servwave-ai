/** Spider's starting summary (#2794): the card's sentence and what made the summary, in every case. */
import { describe, it, expect } from 'vitest';
import { summaryCardSentence, summaryMadeWhen, summaryNow } from '../summary';
import { toSpiderSummary } from '@/lib/api/spider';

describe('the starting summary words', () => {
  it("the card's sentence, plural and singular, naming what started it", () => {
    expect(summaryCardSentence({ total: 12, still_waiting: 9, trigger_kind: 'SWITCHED_ON' })).toBe(
      '12 leads were already past their limit when Spider started watching. 9 are still waiting.',
    );
    expect(summaryCardSentence({ total: 1, still_waiting: 1, trigger_kind: 'STAGE_ADDED' })).toBe(
      '1 lead was already past its limit when Spider started watching. 1 is still waiting.',
    );
    expect(summaryCardSentence({ total: 3, still_waiting: 0, trigger_kind: 'LIMIT_SHORTENED' })).toBe(
      '3 leads were already past their limit when a time limit was shortened. 0 are still waiting.',
    );
  });

  it('says what made the summary', () => {
    expect(summaryMadeWhen('SWITCHED_ON')).toBe('when Spider was turned on');
    expect(summaryMadeWhen('SCOPE_WIDENED')).toBe('when more leads came under watch');
    expect(summaryMadeWhen('SETTINGS_CHANGED')).toBe("when Spider's settings changed");
  });

  it('"Now" reads Still waiting, or where the lead moved on to', () => {
    expect(summaryNow({ moved_on: false, moved_to: null })).toBe('Still waiting');
    expect(summaryNow({ moved_on: true, moved_to: 'Contacted' })).toBe('Moved on to Contacted');
    expect(summaryNow({ moved_on: true, moved_to: null })).toBe('Moved on');
  });

  it('reads anything that is not a summary with leads as no summary', () => {
    expect(toSpiderSummary(null)).toBeNull();
    expect(toSpiderSummary({ id: 's1', leads: [] })).toBeNull();
    expect(toSpiderSummary({ error: 'x' })).toBeNull();
  });
});
