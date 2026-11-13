/**
 * A fake server end for the live line (#3472, lib/live/liveLine.ts): replaces `fetch` so a test opens, feeds, drops
 * and refuses lines without a network. Not a page harness: Spider's alert and summary tests share it.
 *
 *   const live = fakeLiveLine();          // every line opens, with the hello of a server where Spider's check runs and the bell is live (#3473)
 *   live.helloWith({ spider_tick: false }) // later lines open with this hello instead (null: no hello, an older server)
 *   live.answerWith('fail');              // the network is down: every attempt fails
 *   live.send('spider.alert.added', {...}) // a message on the newest line
 *   live.last.drop()                      // the newest line breaks
 *   live.keepAlives(false)                // the server goes silent (a dead connection): no more keep-alives, as in a real line they come every 25 s
 *
 * Call `closeLiveLine()` and `vi.unstubAllGlobals()` after each test.
 */
import { vi } from 'vitest';

export interface FakeLine {
  url: string;
  init: RequestInit;
  /** Writes raw text down the line. */
  push: (text: string) => void;
  /** The line breaks (a network error on the reader). */
  drop: () => void;
  /** The server ends the line cleanly. */
  end: () => void;
  /** The browser closed it (its signal was aborted). */
  aborted: () => boolean;
}

type Answer = 'open' | 'fail' | { status: number; retryAfter?: string };

export function fakeLiveLine() {
  const lines: FakeLine[] = [];
  let answer: Answer = 'open';
  let hello: object | null = { spider_tick: true, bell: true };
  let keepAlives = true;
  const encoder = new TextEncoder();
  const fetchMock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    if (answer === 'fail') throw new TypeError('Failed to fetch');
    if (typeof answer === 'object') {
      const { status, retryAfter } = answer;
      return { ok: false, status, body: null, headers: { get: (n: string) => (n.toLowerCase() === 'retry-after' ? (retryAfter ?? null) : null) } } as unknown as Response;
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const opening = `: open\n\n${hello ? `event: live.hello\ndata: ${JSON.stringify(hello)}\n\n` : ''}`;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        controller.enqueue(encoder.encode(opening));
      },
    });
    let closed = false;
    // The server's keep-alive comment every 25 s (liveLines.ts LIVE_KEEPALIVE_MS): it is what holds the screen's idle watchdog off.
    const keepAliveTimer = setInterval(() => {
      if (keepAlives) line.push(': k\n\n');
    }, 25_000);
    const line: FakeLine = {
      url,
      init,
      push: (text) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      },
      drop: () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveTimer);
        controller.error(new TypeError('network'));
      },
      end: () => {
        if (closed) return;
        closed = true;
        clearInterval(keepAliveTimer);
        controller.close();
      },
      aborted: () => !!init.signal?.aborted,
    };
    init.signal?.addEventListener('abort', () => line.drop());
    lines.push(line);
    return { ok: true, status: 200, body, headers: { get: () => null } } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    fetchMock,
    lines,
    get last(): FakeLine {
      return lines[lines.length - 1]!;
    },
    answerWith(next: Answer) {
      answer = next;
    },
    /** The hello the next lines open with (the server's first message, #3469); null for none. */
    helloWith(next: object | null) {
      hello = next;
    },
    /** Whether the server keeps sending its keep-alive comment (default yes); false makes every line go silent. */
    keepAlives(on: boolean) {
      keepAlives = on;
    },
    /** One message on the newest line. */
    send(type: string, data: object) {
      lines[lines.length - 1]!.push(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
}
