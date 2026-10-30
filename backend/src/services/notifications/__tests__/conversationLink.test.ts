import { describe, it, expect } from 'vitest';
import { conversationLink } from '../conversationLink';

const THREAD = '5f1c0f5e-0000-4000-8000-000000000001';
const MAILBOX = '5f1c0f5e-0000-4000-8000-0000000000aa';

describe('conversationLink', () => {
  it('names the mailbox the conversation sits in and the conversation', () => {
    expect(conversationLink(THREAD, MAILBOX)).toBe(`/communication/inbox?mailbox=${MAILBOX}&thread=${THREAD}`);
  });

  it('names only the conversation when it sits in no mailbox', () => {
    expect(conversationLink(THREAD, null)).toBe(`/communication/inbox?thread=${THREAD}`);
  });
});
