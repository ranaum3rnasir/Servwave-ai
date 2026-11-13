/**
 * The live line's registry (#3472, services/live/liveLines.ts): who holds a line, what reaches it, and when it ends.
 * In memory, with a stand-in for the HTTP answer: no database, no network. The HTTP door and Spider's messages on a real
 * database are in __tests__/spider-live-line-db.test.ts.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { env } from '../../../config/env';
import { _resetStopRequest, requestStop } from '../../../lib/graceful-stop';
import {
  LIVE_KEEPALIVE_MS,
  LIVE_LINE_MAX_MS,
  LIVE_LINES_PER_PERSON,
  closeLiveLinesOf,
  deliverLive,
  endAllLiveLines,
  liveLinesOpen,
  openLiveLine,
  type LivePerson,
} from '../liveLines';
import { BELL_CHANGED, publishBellChanged } from '../../notifications/bellLive';
import { SPIDER_ALERT_VERB, SPIDER_FRAME_VERB } from '../../notifications/bellHiddenVerbs';

/** The parts of an HTTP answer a line uses, recording what was written. */
class FakeAnswer extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  headersFlushed = false;
  ended = false;
  writableLength = 0;
  get writableEnded() {
    return this.ended;
  }
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: string | number) {
    this.headers[name.toLowerCase()] = String(value);
    return this;
  }
  flushHeaders() {
    this.headersFlushed = true;
  }
  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }
  end() {
    this.ended = true;
    this.emit('close');
    return this;
  }
  /** Only the messages, keep-alives and the opening comment left out. */
  messages() {
    return this.chunks.filter((c) => c.startsWith('event:'));
  }
}

const fakeRequest = () => ({ socket: { setNoDelay: vi.fn(), setKeepAlive: vi.fn() }, setTimeout: vi.fn() }) as unknown as Request;

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';
const person = (id: string, orgId = ORG_A, isAdmin = false): LivePerson => ({ id, orgId, isAdmin });

function open(p: LivePerson) {
  const res = new FakeAnswer();
  const refused = openLiveLine(p, fakeRequest(), res as unknown as Response);
  return { res, refused };
}

const message = (type: string, payload: unknown) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  endAllLiveLines();
  _resetStopRequest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('opening a line', () => {
  it('answers 200 as an event stream that no proxy may buffer or rewrite, sent at once', () => {
    const { res, refused } = open(person('p1'));
    expect(refused).toBeNull();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.headersFlushed).toBe(true);
    // The first bytes go out at once, so every hop between the browser and the server passes the line on.
    expect(res.chunks[0]).toBe(': open\n\n');
    expect(liveLinesOpen()).toBe(1);
  });

  it("sends the server's hello as the first message when one is given, and nothing more when none is (#3469)", () => {
    const res = new FakeAnswer();
    expect(openLiveLine(person('p1'), fakeRequest(), res as unknown as Response, { spider_tick: true })).toBeNull();
    expect(res.chunks).toEqual([': open\n\n', message('live.hello', { spider_tick: true })]);
    expect(open(person('p2')).res.chunks).toEqual([': open\n\n']);
  });

  it('refuses a sixth line for the same person (429), and still opens one for anyone else', () => {
    for (let i = 0; i < LIVE_LINES_PER_PERSON; i++) expect(open(person('p1')).refused).toBeNull();
    const sixth = open(person('p1'));
    expect(sixth.refused).toEqual({ status: 429, reason: 'person_cap' });
    expect(sixth.res.statusCode).toBe(0);
    expect(sixth.res.chunks).toEqual([]);
    expect(open(person('p2')).refused).toBeNull();
    expect(liveLinesOpen()).toBe(LIVE_LINES_PER_PERSON + 1);
  });

  it('refuses any line past the server-wide cap (503), whoever asks', () => {
    const before = env.LIVE_LINES_MAX;
    (env as { LIVE_LINES_MAX: number }).LIVE_LINES_MAX = 3;
    try {
      expect(open(person('p1')).refused).toBeNull();
      expect(open(person('p2')).refused).toBeNull();
      expect(open(person('p3', ORG_B)).refused).toBeNull();
      expect(open(person('p4', ORG_B)).refused).toEqual({ status: 503, reason: 'server_cap' });
      expect(liveLinesOpen()).toBe(3);
    } finally {
      (env as { LIVE_LINES_MAX: number }).LIVE_LINES_MAX = before;
    }
  });

  it('refuses a line while the server is stopping (503)', () => {
    requestStop();
    expect(open(person('p1')).refused).toEqual({ status: 503, reason: 'stopping' });
    expect(liveLinesOpen()).toBe(0);
  });
});

describe('a browser that gave up before its line was registered (#3473, #3472 verifier)', () => {
  it('registers nothing for an answer that is already closed (its close event came and went during the sign-in check)', () => {
    for (const closed of [{ destroyed: true }, { ended: true }]) {
      const res = new FakeAnswer();
      Object.assign(res, closed);
      expect(openLiveLine(person('p1'), fakeRequest(), res as unknown as Response)).toEqual({ status: 503, reason: 'gone' });
      expect(res.chunks).toEqual([]);
      expect(res.statusCode).toBe(0);
    }
    // And a destroyed socket (the browser went away) the same.
    const req = { socket: { destroyed: true, setNoDelay: vi.fn(), setKeepAlive: vi.fn() }, setTimeout: vi.fn() } as unknown as Request;
    expect(openLiveLine(person('p1'), req, new FakeAnswer() as unknown as Response)).toEqual({ status: 503, reason: 'gone' });
    expect(liveLinesOpen()).toBe(0);
    // The person's places were never used: five lines still open.
    for (let i = 0; i < LIVE_LINES_PER_PERSON; i++) expect(open(person('p1')).refused).toBeNull();
  });
});

describe('the bell on the line (#3473)', () => {
  const rang = (res: FakeAnswer) => res.messages().filter((m) => m.startsWith(`event: ${BELL_CHANGED}\n`));
  const bell = message(BELL_CHANGED, {});

  it('rings each recipient once on every line they hold, with no content, and nobody else in the company or another company', () => {
    const rep1 = open(person('rep')).res;
    const rep2 = open(person('rep')).res;
    const bystander = open(person('bystander')).res;
    const admin = open(person('boss', ORG_A, true)).res;
    const otherCompany = open(person('rep', ORG_B)).res; // the same person id, in another company: not this company's recipient

    publishBellChanged([{ organizationId: ORG_A, verb: 'lead.assigned', recipientIds: ['rep'] }]);

    expect(rang(rep1)).toEqual([bell]);
    expect(rang(rep2)).toEqual([bell]);
    expect(rang(bystander)).toEqual([]);
    expect(rang(admin)).toEqual([]);
    expect(rang(otherCompany)).toEqual([]);
  });

  it('one message per person for a whole write, however many of its alerts name them (emitMany)', () => {
    const rep = open(person('rep')).res;
    const other = open(person('other')).res;
    publishBellChanged([
      { organizationId: ORG_A, verb: 'lead.assigned', recipientIds: ['rep', 'other'] },
      { organizationId: ORG_A, verb: 'estimate.approved', recipientIds: ['rep'] },
      { organizationId: ORG_A, verb: 'lead.assigned', recipientIds: ['rep'] },
    ]);
    expect(rang(rep)).toEqual([bell]);
    expect(rang(other)).toEqual([bell]);
  });

  it("a write that spans companies rings each company's own people on its own lines only", () => {
    const a = open(person('a1')).res;
    const b = open(person('b1', ORG_B)).res;
    publishBellChanged([
      { organizationId: ORG_A, verb: 'lead.assigned', recipientIds: ['a1', 'b1'] },
      { organizationId: ORG_B, verb: 'lead.assigned', recipientIds: ['b1'] },
    ]);
    expect(rang(a)).toEqual([bell]);
    expect(rang(b)).toEqual([bell]); // once, from company B's own write: company A's naming "b1" does not reach B's line
  });

  it("Spider's per-lead alerts and red-frame records ring nothing; a write mixing them with a bell notification rings only for the latter's people", () => {
    const spiderOnly = open(person('spider-only')).res;
    const both = open(person('both')).res;
    publishBellChanged([{ organizationId: ORG_A, verb: SPIDER_ALERT_VERB, recipientIds: ['spider-only', 'both'] }]);
    publishBellChanged([{ organizationId: ORG_A, verb: SPIDER_FRAME_VERB, recipientIds: ['spider-only', 'both'] }]);
    expect(spiderOnly.messages()).toEqual([]);
    expect(both.messages()).toEqual([]);
    publishBellChanged([
      { organizationId: ORG_A, verb: SPIDER_ALERT_VERB, recipientIds: ['spider-only', 'both'] },
      { organizationId: ORG_A, verb: 'spider.starting_summary', recipientIds: ['both'] },
    ]);
    expect(rang(both)).toEqual([bell]);
    expect(spiderOnly.messages()).toEqual([]);
  });

  it('says nothing for nobody, for no line, and never throws', () => {
    const res = open(person('rep')).res;
    publishBellChanged([]);
    publishBellChanged([{ organizationId: ORG_A, verb: 'lead.assigned', recipientIds: [] }]);
    publishBellChanged([{ organizationId: ORG_B, verb: 'lead.assigned', recipientIds: ['rep'] }]);
    expect(res.messages()).toEqual([]);
    res.write = () => {
      throw new Error('socket gone');
    };
    expect(() => publishBellChanged([{ organizationId: ORG_A, verb: 'lead.assigned', recipientIds: ['rep'] }])).not.toThrow();
  });
});

describe('what reaches a line', () => {
  it('a message goes only to the lines the sender picks, in the sender\'s company, written as one event', () => {
    const a1 = open(person('p1')).res;
    const a1second = open(person('p1')).res;
    const a2 = open(person('p2')).res;
    const b1 = open(person('p1-other-company', ORG_B)).res;

    const reached = deliverLive(ORG_A, 'spider.alert.ended', (p) => (p.id === 'p1' ? { ids: ['r1'] } : null));

    expect(reached).toBe(2);
    expect(a1.messages()).toEqual([message('spider.alert.ended', { ids: ['r1'] })]);
    expect(a1second.messages()).toEqual([message('spider.alert.ended', { ids: ['r1'] })]);
    expect(a2.messages()).toEqual([]);
    expect(b1.messages()).toEqual([]);
  });

  it('a message for a whole company never reaches another company, even for a person id the sender names', () => {
    const a1 = open(person('p1')).res;
    const b1 = open(person('p9', ORG_B)).res;
    deliverLive(ORG_A, 'spider.settings.changed', () => ({}));
    deliverLive(ORG_A, 'spider.alert.ended', (p) => (p.id === 'p9' ? { ids: ['r9'] } : null));
    expect(a1.messages()).toEqual([message('spider.settings.changed', {})]);
    expect(b1.messages()).toEqual([]);
  });

  it('the sender sees whether each person is an Admin (as they were when the line opened)', () => {
    const admin = open(person('boss', ORG_A, true)).res;
    const sales = open(person('rep')).res;
    deliverLive(ORG_A, 'spider.summary.ready', (p) => (p.isAdmin ? {} : null));
    expect(admin.messages()).toHaveLength(1);
    expect(sales.messages()).toEqual([]);
  });

  it('keeps the line alive with a comment every 25 seconds, and nothing else when there is nothing to say', () => {
    const { res } = open(person('p1'));
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MS - 1);
    expect(res.chunks).toEqual([': open\n\n']);
    vi.advanceTimersByTime(1);
    expect(res.chunks).toEqual([': open\n\n', ': k\n\n']);
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MS * 2);
    expect(res.chunks.filter((c) => c === ': k\n\n')).toHaveLength(3);
    expect(res.messages()).toEqual([]);
  });

  it('closes a line whose browser stopped reading, rather than piling up what it cannot send', () => {
    const { res } = open(person('p1'));
    res.writableLength = 1024 * 1024;
    expect(deliverLive(ORG_A, 'spider.settings.changed', () => ({}))).toBe(0);
    expect(res.ended).toBe(true);
    expect(res.messages()).toEqual([]);
    expect(liveLinesOpen()).toBe(0);
  });
});

describe('when a line ends', () => {
  it('the server closes it after about 55 minutes (spread over the last 5, so lines opened together do not all return together)', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const late = open(person('p1')).res;
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const early = open(person('p2')).res;

    vi.advanceTimersByTime(LIVE_LINE_MAX_MS - 5 * 60_000 - 1);
    expect(early.ended).toBe(false);
    vi.advanceTimersByTime(1);
    expect(early.ended).toBe(true);

    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(late.ended).toBe(false);
    vi.advanceTimersByTime(1);
    expect(late.ended).toBe(true);
    expect(liveLinesOpen()).toBe(0);
  });

  it('a browser that goes away frees its place, and the line gets nothing more', () => {
    for (let i = 0; i < LIVE_LINES_PER_PERSON; i++) open(person('p1'));
    const { res } = open(person('p2'));
    res.emit('close');
    expect(liveLinesOpen()).toBe(LIVE_LINES_PER_PERSON);
    vi.advanceTimersByTime(LIVE_KEEPALIVE_MS * 3);
    deliverLive(ORG_A, 'spider.settings.changed', () => ({}));
    expect(res.chunks).toEqual([': open\n\n']);
    // The person who was at the cap gets a place again once one of theirs closes.
    expect(open(person('p1')).refused).toEqual({ status: 429, reason: 'person_cap' });
    closeLiveLinesOf('p1');
    expect(open(person('p1')).refused).toBeNull();
  });

  it("closing one person's lines (their sign-in was thrown away) leaves everyone else's open", () => {
    const mine = [open(person('p1')).res, open(person('p1')).res];
    const theirs = open(person('p2')).res;
    closeLiveLinesOf('p1');
    expect(mine.every((r) => r.ended)).toBe(true);
    expect(theirs.ended).toBe(false);
    expect(liveLinesOpen()).toBe(1);
  });

  it('on shutdown every line is ended cleanly, so each screen reconnects after its own random wait', () => {
    const lines = [open(person('p1')).res, open(person('p2')).res, open(person('p3', ORG_B)).res];
    expect(endAllLiveLines()).toBe(3);
    expect(lines.every((r) => r.ended)).toBe(true);
    expect(liveLinesOpen()).toBe(0);
  });
});
