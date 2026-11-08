// A text the phone service rejected carries the reason code PROVIDER_ERROR.
// An old backend still sends the previous code, CTM_ERROR: the frontend and
// backend deploy minutes apart in no fixed order, so for one release both read
// the same plain sentence, and neither code ever reaches the screen raw.
import { describe, it, expect } from 'vitest';
import { deliveryNote } from '../messageDelivery';

describe('deliveryNote - a provider rejection', () => {
  it.each(['PROVIDER_ERROR', 'CTM_ERROR'])('explains %s in plain words', (statusReason) => {
    const note = deliveryNote({ direction: 'out', status: 'failed', statusReason });

    expect(note.tone).toBe('danger');
    expect(note.label).toBe('Failed to send');
    expect(note.title).toBe('Not delivered - the provider rejected it');
    expect(note.title).not.toContain(statusReason);
  });
});
