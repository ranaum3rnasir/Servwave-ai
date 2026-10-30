/**
 * The History line a lead conversion writes on the new job for each person slot reads like the Owner and Sold By
 * lines, "<name> set as <Slot> on job <n> (<how>)", with the slot name capitalised. Seam: the sentence writer.
 */
import { describe, it, expect } from 'vitest';
import { historySentence } from '../lib/permissions/conversionPeople';

const person = { id: 'u-1', first_name: 'Dee', last_name: 'Spatch' };

describe('History sentence for the people a lead conversion gives the new job', () => {
  it('capitalises Dispatcher when it was copied from the lead', () => {
    expect(historySentence('dispatcher', { person, source: 'lead' } as never, 'J00726')).toBe(
      'Dee Spatch set as Dispatcher on job J00726 (copied from the lead)',
    );
  });

  it('capitalises Dispatcher when it was set to the person converting', () => {
    expect(historySentence('dispatcher', { person, source: 'converter' } as never, 'J00726')).toBe(
      'Dee Spatch set as Dispatcher on job J00726 (set to the person converting)',
    );
  });

  it('keeps the Sold By line in the same shape', () => {
    expect(historySentence('sold_by', { person, source: 'lead' } as never, 'J00726')).toBe(
      'Dee Spatch set as Sold By on job J00726 (copied from the lead)',
    );
  });
});
