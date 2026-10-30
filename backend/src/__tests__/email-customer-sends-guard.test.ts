import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';

/**
 * PRD 10, S10.13: the guard behind "no send to a customer is stored as loose system email".
 *
 * An email to a customer carries a hidden reply address tied to its record and is stored on that record's conversation. That
 * holds because every sender of mail to a customer takes the same three steps (prepare the reply address, dispatch, store on
 * the conversation: `prepareTransactionalReply` / `finalizeTransactionalSend`, or `sendToCustomerAboutRecord`, which does all
 * three), and because the only writer of the stored copy that skips them is a declared exception; not because each new
 * sender remembers to. This fails the day a sender stores a copy of its own (`persistTransactionalEmail`) or a new sender
 * dispatches mail without saying here what it is.
 */

const SRC = path.resolve(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' || name === 'node_modules' ? [] : walk(full);
    return full.endsWith('.ts') ? [full] : [];
  });

/** The top-level functions of lib/email.ts, each with its text (parameters and body). */
function functionsOf(text: string): { name: string; text: string }[] {
  const starts = [...text.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)];
  return starts.map((m, i) => ({ name: m[1]!, text: text.slice(m.index!, starts[i + 1]?.index ?? text.length) }));
}

const EMAIL = functionsOf(read('lib/email.ts'));
const named = (name: string) => EMAIL.find((f) => f.name === name)!;

/** Senders that dispatch mail but are not a send to a customer about a record, and why. */
const NOT_A_CUSTOMER_SEND: Record<string, string> = {
  sendComposedEmail: 'hand-written by a person from the Email page, which stores its own conversation and rows',
  sendStagePickupEmail: 'a pickup ticket to a technician or pickup contacts, not a customer; it names the job and stays a job-linked system email',
  sendDepositPaidAlert: 'a teammate alert (the estimate\'s creator); names no record',
  sendPaymentMethodSelectedAlert: 'a teammate alert (the estimate\'s creator); names no record',
  sendPaymentsActionNeededEmail: 'the platform voice to the company (no-reply); names no record',
  sendOwnerPaymentNoticeEmail: 'the platform voice to the company (no-reply); names no record',
  sendSalesContactEmail: 'the platform voice, a contractor writing to ServWave; names no record',
};

/** Where the stored copy of a send is written, and why each is allowed to. */
const MAY_STORE_A_COPY = ['finalizeTransactionalSend', 'sendStagePickupEmail'];

describe('every email to a customer is tied to its record', () => {
  it('stores a copy of a send through no file but lib/email.ts', () => {
    const writers = walk(SRC)
      .map((file) => ({ rel: path.relative(SRC, file).split(path.sep).join('/'), text: readFileSync(file, 'utf8') }))
      .filter(({ text }) => /\bpersistTransactionalEmail\s*\(/.test(text))
      .map(({ rel }) => rel)
      .filter((rel) => rel !== 'lib/comm-persist.ts');
    expect(writers).toEqual(['lib/email.ts']);
  });

  it('stores a copy inside no sender but the declared ones', () => {
    const storing = EMAIL.filter((f) => /\bpersistTransactionalEmail\s*\(/.test(f.text)).map((f) => f.name);
    expect(storing.sort()).toEqual([...MAY_STORE_A_COPY].sort());
  });

  it('dispatches mail from no function that is neither a customer send nor declared as something else', () => {
    const dispatching = EMAIL.filter((f) => f.name !== 'dispatchEmail' && /\bdispatchEmail\s*\(|\bsendToCustomerAboutRecord\s*\(/.test(f.text));
    const undeclared = dispatching
      .filter((f) => !(f.name in NOT_A_CUSTOMER_SEND) && f.name !== 'sendToCustomerAboutRecord')
      .filter((f) => !/record\??: TransactionalEmailRecord/.test(f.text) && !/handRecord/.test(f.text))
      .map((f) => f.name);
    expect(undeclared, 'a sender of mail to a customer takes a record (TransactionalEmailRecord); anything else must be declared in NOT_A_CUSTOMER_SEND with its reason').toEqual([]);
  });

  it('names no function that no longer dispatches mail', () => {
    const dispatching = new Set(EMAIL.filter((f) => /\bdispatchEmail\s*\(/.test(f.text)).map((f) => f.name));
    expect(Object.keys(NOT_A_CUSTOMER_SEND).filter((name) => !dispatching.has(name))).toEqual([]);
  });

  it('takes the three steps in every sender of mail to a customer', () => {
    const customerSends = EMAIL.filter((f) => f.name !== 'sendToCustomerAboutRecord' && f.name !== 'dispatchEmail')
      .filter((f) => /\bdispatchEmail\s*\(|\bsendToCustomerAboutRecord\s*\(/.test(f.text))
      .filter((f) => !(f.name in NOT_A_CUSTOMER_SEND));
    expect(customerSends.length, 'the guard found the customer senders').toBeGreaterThan(15);
    const lacking = customerSends
      .filter((f) => !/\bsendToCustomerAboutRecord\s*\(/.test(f.text))
      .filter((f) => !(/\bprepareTransactionalReply\s*\(/.test(f.text) && /\bfinalizeTransactionalSend\s*\(/.test(f.text)))
      .map((f) => f.name);
    expect(lacking, 'each must prepare the reply address and store the send on its conversation').toEqual([]);
  });

  it('keeps the shared path whole: reply address, dispatch with it, then the stored copy on the conversation', () => {
    const shared = named('sendToCustomerAboutRecord').text;
    expect(shared).toMatch(/prepareTransactionalReply\(/);
    expect(shared).toMatch(/replyTo: reply\.address/);
    expect(shared).toMatch(/finalizeTransactionalSend\(/);
    // A stored copy with no conversation is the loose email this guards against: it is written only through a conversation.
    const finalize = named('finalizeTransactionalSend').text;
    expect(finalize).toMatch(/recordConversationData\(/);
    expect(finalize).toMatch(/threadId/);
  });

  it('keeps the automation engine naming the record of a send to the customer', () => {
    const executors = read('services/automations/executors.ts');
    expect(executors).toMatch(/\.\.\.\(customerAddresses\.has\(to\.toLowerCase\(\)\) \? automationRecordOf\(bundle\) : \{\}\)/);
  });
});
