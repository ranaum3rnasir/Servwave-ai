// The phone vendor's script runs in our document, so its console.* calls go through our
// page's console and put the vendor's name in front of anyone who opens dev tools. These
// tests pin the filter that keeps it out: the vendor's chatter is dropped, its two real
// errors keep their detail under a neutral "[Phone]" prefix, and nothing else is touched.
//
// The message strings below are copied from the vendor's shipped script (measured
// 2026-10-01), so a change to the filter's match list is checked against what the script
// actually prints.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VENDOR_CONSOLE_PATTERNS, installVendorConsoleFilter } from '../vendorConsoleFilter';

type Method = 'log' | 'info' | 'debug' | 'warn' | 'error';
type Spies = Record<Method, ReturnType<typeof vi.fn>>;

// A stand-in console whose methods record what actually reaches "the output", so every
// test installs onto a fresh object and never on the real global console.
function makeConsole(): { target: Console; spies: Spies } {
  const spies = {
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies Spies;
  const target = { ...spies } as unknown as Console;
  return { target, spies };
}

describe('installVendorConsoleFilter', () => {
  let target: Console;
  let spies: Spies;

  beforeEach(() => {
    ({ target, spies } = makeConsole());
    installVendorConsoleFilter(target);
  });

  describe('drops the vendor lines that carry its name', () => {
    it.each([
      ['[CTM Embed] requesting access', { url: '/api/phone/access' }],
      ['[CTM Embed] access response', { ok: true, status: 200, url: '/api/phone/access' }],
      ['[CTM Embed] access token assigned', { hasToken: true }],
      ['[CTM Embed] iframe requested access', undefined],
      ['attach ctm-phone-skeleton', undefined],
    ])('drops console.log(%j)', (message, extra) => {
      if (extra === undefined) target.log(message);
      else target.log(message, extra);
      expect(spies.log).not.toHaveBeenCalled();
    });

    it.each(['log', 'info', 'debug', 'warn'] as const)(
      'drops a vendor-prefixed line on console.%s too',
      (method) => {
        target[method]('[CTM Embed] access token assigned', { hasToken: true });
        expect(spies[method]).not.toHaveBeenCalled();
      },
    );
  });

  describe("renames the vendor's errors instead of dropping them", () => {
    // Part 2 (Ran, 2026-10-02): the extra arguments are now forwarded as a sanitised COPY,
    // not the same objects - an Error's stack and an Event's target named the vendor. These
    // two tests asserted identity (`toBe`) before; they now assert the cleaned shape.
    it('forwards "access request failed" under [Phone] with its detail kept diagnosable', () => {
      const detail = { url: '/api/phone/access', error: new Error('network down') };
      target.error('[CTM Embed] access request failed', detail);
      expect(spies.error).toHaveBeenCalledTimes(1);
      expect(spies.error).toHaveBeenCalledWith('[Phone] access request failed', {
        url: '/api/phone/access',
        error: 'Error: network down',
      });
      expect(spies.error.mock.calls[0]![1]).not.toBe(detail);
    });

    it('forwards "device embed script failed" under [Phone] with the error\'s name and message', () => {
      const err = new Error('script load failed');
      target.error('[CTM Embed] device embed script failed', err);
      expect(spies.error).toHaveBeenCalledTimes(1);
      expect(spies.error).toHaveBeenCalledWith('[Phone] device embed script failed', {
        name: 'Error',
        message: 'script load failed',
      });
    });

    it('keeps every remaining argument, in order', () => {
      const a = { a: 1 };
      const b = [2];
      target.error('[CTM Embed] access request failed', a, b, 3, null);
      expect(spies.error).toHaveBeenCalledWith('[Phone] access request failed', a, b, 3, null);
    });

    it('never forwards the vendor name on an error', () => {
      target.error('[CTM Embed] access request failed', {});
      target.error('[CTM Embed] device embed script failed', new Error('x'));
      // Both must be forwarded (renamed, not dropped), or the loop below proves nothing.
      expect(spies.error).toHaveBeenCalledTimes(2);
      for (const call of spies.error.mock.calls) {
        expect(String(call[0])).toMatch(/^\[Phone\] /);
        expect(String(call[0])).not.toContain('CTM');
      }
    });
  });

  describe('passes everything else through untouched', () => {
    it.each([
      ['error', ['No access URL provided']],
      ['log', ['valHook set:', 'some value']],
      ['log', ['received paste:', 'pasted text']],
      ['log', ['[Softphone] booted', { ready: true }]],
      ['warn', ['React Router Future Flag Warning']],
      ['info', ['upload resumed', 3]],
      ['debug', ['cache hit']],
      ['error', ['Request failed with status code 500']],
      // Only a message that STARTS with the prefix is the vendor's.
      ['log', ['note: [CTM Embed] appears mid-string']],
      // A near-miss of the exact skeleton line is not that line.
      ['log', ['attach ctm-phone-skeleton now']],
    ] as const)('console.%s(%j) reaches the output unchanged', (method, args) => {
      (target[method] as (...a: unknown[]) => void)(...args);
      expect(spies[method]).toHaveBeenCalledTimes(1);
      expect(spies[method]).toHaveBeenCalledWith(...args);
    });

    it.each([
      [{ message: '[CTM Embed] access token assigned' }],
      [new Error('[CTM Embed] boom')],
      [42],
      [undefined],
      [null],
    ])('passes a non-string first argument (%j) through untouched', (first) => {
      target.log(first, 'second');
      target.error(first, 'second');
      expect(spies.log).toHaveBeenCalledWith(first, 'second');
      expect(spies.error).toHaveBeenCalledWith(first, 'second');
    });

    it('passes a call with no arguments through', () => {
      target.log();
      expect(spies.log).toHaveBeenCalledTimes(1);
      expect(spies.log).toHaveBeenCalledWith();
    });

    it('calls the original with the caller\'s `this`', () => {
      target.log('hello');
      expect(spies.log.mock.contexts[0]).toBe(target);
    });
  });

  describe('installs idempotently', () => {
    it('a second install does not wrap the console again', () => {
      const wrappedLog = target.log;
      const wrappedError = target.error;

      expect(installVendorConsoleFilter(target)).toBe(false);
      expect(target.log).toBe(wrappedLog);
      expect(target.error).toBe(wrappedError);

      target.log('ordinary');
      target.error('[CTM Embed] access request failed', {});
      expect(spies.log).toHaveBeenCalledTimes(1);
      expect(spies.error).toHaveBeenCalledTimes(1);
      expect(spies.error).toHaveBeenCalledWith('[Phone] access request failed', {});
    });

    it('reports a first install as having happened', () => {
      const fresh = makeConsole();
      expect(installVendorConsoleFilter(fresh.target)).toBe(true);
      expect(fresh.target.log).not.toBe(fresh.spies.log);
    });
  });
});

// ---------------------------------------------------------------------------------------
// Part 2 (Ran, 2026-10-02): the renamed errors' OTHER arguments must be clean too. The
// vendor passes a TypeError whose stack names its class and its script URL, and an Event
// whose target is its <script data-ctm-device-embed-script> element. On the renamed-error
// path only, every argument after the first is forwarded as a sanitised copy.
// ---------------------------------------------------------------------------------------

// Not the module's pattern, on purpose: the test's own idea of "a vendor name". Not global,
// so .test() carries no lastIndex state between calls.
const VENDOR_NAME = /ctm|calltracking/i;

/** Every key and every string value reachable from `value` (cycle-safe). */
function allStrings(value: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    out.push(key);
    allStrings(child, out, seen);
  }
  return out;
}

/**
 * Asserts `value` carries no vendor name, AND that there was something to check: a JSON
 * dump and a string walk of an empty or missing value would pass vacuously.
 */
function expectNoVendorName(value: unknown) {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  const json = JSON.stringify(value);
  expect(typeof json).toBe('string');
  expect(json.length).toBeGreaterThan(2);
  expect(json).not.toMatch(VENDOR_NAME);
  const strings = allStrings(value);
  expect(strings.length).toBeGreaterThan(0);
  for (const s of strings) expect(s).not.toMatch(VENDOR_NAME);
}

describe('renamed errors: the extra arguments are sanitised', () => {
  let target: Console;
  let spies: Spies;

  beforeEach(() => {
    ({ target, spies } = makeConsole());
    installVendorConsoleFilter(target);
  });

  /** The single forwarded console.error call, asserted to exist. */
  function forwarded(): unknown[] {
    expect(spies.error).toHaveBeenCalledTimes(1);
    return spies.error.mock.calls[0]!;
  }

  /** Forward one value on the renamed path and return what reached the output for it. */
  function cleaned(value: unknown): unknown {
    expect(() => target.error('[CTM Embed] access request failed', value)).not.toThrow();
    const call = forwarded();
    expect(call).toHaveLength(2);
    return call[1];
  }

  describe('the two measured vendor errors', () => {
    // The vendor's real call: console.error("[CTM Embed] access request failed",
    // {url:this.access,error:d}) where d is what fetch() threw.
    function vendorFetchError(): TypeError {
      const err = new TypeError('Failed to fetch');
      err.stack =
        'TypeError: Failed to fetch\n' +
        '    at CtmPhoneEmbed.fetchUserAccess (https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js:1:61700)\n' +
        '    at CtmPhoneEmbed.getUserAccess (https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js:1:61900)';
      return err;
    }

    it('access request failed: the stack is gone, name and message survive', () => {
      const error = vendorFetchError();
      // Precondition: the raw error really does name the vendor, so the check below is real.
      expect(error.stack).toMatch(/calltrackingmetrics/);
      expect(error.stack).toMatch(/CtmPhoneEmbed/);

      target.error('[CTM Embed] access request failed', { url: undefined, error });
      const [first, detail] = forwarded();
      expect(first).toBe('[Phone] access request failed');
      // A nested error is flattened to one string so it survives Sentry's normalise depth.
      expect(detail).toEqual({ url: undefined, error: 'TypeError: Failed to fetch' });
      expectNoVendorName(detail);
      expect(JSON.stringify(detail)).toContain('Failed to fetch');
    });

    it('access request failed: a vendor token in the URL is redacted, the rest of the URL kept', () => {
      const error = vendorFetchError();
      target.error('[CTM Embed] access request failed', {
        url: 'https://api.servwave.com/api/ctm/phone-access?via=CallTrackingMetrics',
        error,
      });
      const [, detail] = forwarded();
      expect(detail).toEqual({
        url: 'https://api.servwave.com/api/[redacted]/phone-access?via=[redacted]',
        error: 'TypeError: Failed to fetch',
      });
      expectNoVendorName(detail);
    });

    it('device embed script failed: a real Event targeting the vendor script becomes { type }', () => {
      const script = document.createElement('script');
      script.dataset.ctmDeviceEmbedScript = 'true';
      script.src = 'https://app.calltrackingmetrics.com/x.js';
      document.body.appendChild(script);
      let seenTarget: EventTarget | null = null;
      // The vendor logs from inside the script's error listener, while target and
      // currentTarget are both set.
      script.addEventListener('error', (event) => {
        seenTarget = event.currentTarget;
        target.error('[CTM Embed] device embed script failed', event);
      });
      script.dispatchEvent(new Event('error'));
      script.remove();

      // Precondition: the raw event really pointed at the vendor's element.
      expect(seenTarget).toBe(script);
      expect(script.outerHTML).toMatch(/data-ctm-device-embed-script/);

      const [first, detail] = forwarded();
      expect(first).toBe('[Phone] device embed script failed');
      expect(detail).toEqual({ type: 'error' });
      expectNoVendorName(detail);
    });
  });

  describe('the first argument', () => {
    it('redacts a vendor token in the message after the prefix', () => {
      target.error('[CTM Embed] ctm-device-embed refused (CallTrackingMetrics)');
      const [first] = forwarded();
      expect(first).toBe('[Phone] [redacted]-device-embed refused ([redacted])');
    });
  });

  describe('generic shapes, so a new vendor error is still cleaned', () => {
    it('strings: every vendor token is redacted, case-insensitively', () => {
      expect(cleaned('see CTM and ctm and CallTrackingMetrics and calltracking')).toBe(
        'see [redacted] and [redacted] and [redacted] and [redacted]',
      );
    });

    it('other primitives are unchanged', () => {
      for (const value of [0, 42, -1.5, true, false, null, undefined]) {
        spies.error.mockClear();
        expect(cleaned(value)).toBe(value);
      }
    });

    it('an Error-like object (message + name or stack) becomes { name, message } plus redacted primitives', () => {
      const errorLike = {
        name: 'CtmError',
        message: 'ctm said no',
        stack: 'at https://app.calltrackingmetrics.com/a.js',
        code: 'CTM_DENIED',
        status: 403,
        nested: { url: 'https://app.calltrackingmetrics.com' },
      };
      const out = cleaned(errorLike);
      expect(out).toEqual({
        name: '[redacted]Error',
        message: '[redacted] said no',
        code: '[redacted]_DENIED',
        status: 403,
      });
      expectNoVendorName(out);
    });

    it('a real Error keeps primitive own properties and drops object ones and the stack', () => {
      const err = Object.assign(new RangeError('bad ctm range'), {
        code: 7,
        cause: { at: 'calltrackingmetrics' },
      });
      const out = cleaned(err);
      expect(out).toEqual({ name: 'RangeError', message: 'bad [redacted] range', code: 7 });
      expect(out).not.toHaveProperty('stack');
      expect(out).not.toHaveProperty('cause');
    });

    it('nested objects and arrays are copied with keys and values redacted', () => {
      const input = {
        ctmAccount: 'acct on calltrackingmetrics',
        list: ['ctm', 1, { deep: 'CTM' }],
        ok: true,
      };
      const out = cleaned(input);
      expect(out).toEqual({
        '[redacted]Account': 'acct on [redacted]',
        list: ['[redacted]', 1, { deep: '[redacted]' }],
        ok: true,
      });
      expect(out).not.toBe(input);
      expect((out as { list: unknown }).list).not.toBe(input.list);
      expectNoVendorName(out);
    });

    it('a top-level array is sanitised element by element', () => {
      const out = cleaned(['CallTrackingMetrics', new Error('ctm'), 3]);
      expect(out).toEqual(['[redacted]', 'Error: [redacted]', 3]);
    });

    it('values deeper than 3 levels become "[…]"', () => {
      const out = cleaned({ l1: { l2: { l3: { l4: 'calltrackingmetrics' } }, s: 'ctm' } });
      expect(out).toEqual({ l1: { l2: { l3: '[…]' }, s: '[redacted]' } });
    });

    it('a cycle does not recurse forever and is marked', () => {
      const a: Record<string, unknown> = { name: 'ctm loop' };
      a.self = a;
      const out = cleaned(a) as Record<string, unknown>;
      expect(out.name).toBe('[redacted] loop');
      expect(out.self).toBe('[circular]');
    });

    it('a throwing getter does not throw; that value becomes "[unavailable]"', () => {
      const input = {
        fine: 'ctm',
        get bad(): string {
          throw new Error('getter blew up at calltrackingmetrics');
        },
      };
      const out = cleaned(input);
      expect(out).toEqual({ fine: '[redacted]', bad: '[unavailable]' });
    });

    it('an object that cannot be inspected at all becomes "[unavailable]"', () => {
      const hostile = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('nope');
          },
          getPrototypeOf() {
            throw new Error('nope');
          },
        },
      );
      expect(cleaned(hostile)).toBe('[unavailable]');
    });

    it('a nested Error-like becomes one "Name: message" string, and never its stack', () => {
      const out = cleaned({
        inner: { name: 'CtmError', message: 'ctm refused', stack: 'at calltrackingmetrics', code: 9 },
        bare: new Error(''),
      });
      expect(out).toEqual({ inner: '[redacted]Error: [redacted] refused', bare: 'Error' });
      expectNoVendorName(out);
    });

    it('an own "__proto__" key stays a key and does not re-point the copy\'s prototype', () => {
      const input = JSON.parse('{"__proto__": {"polluted": "ctm"}, "ok": 1}') as object;
      const out = cleaned(input) as Record<string, unknown>;
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
      expect(Object.keys(out)).toEqual(['__proto__', 'ok']);
      expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toEqual({ polluted: '[redacted]' });
      expect((out as { polluted?: unknown }).polluted).toBeUndefined();
    });

    it('a DOM node becomes "[element]"', () => {
      const el = document.createElement('ctm-device-embed');
      expect(cleaned(el)).toBe('[element]');
      spies.error.mockClear();
      expect(cleaned({ host: el })).toEqual({ host: '[element]' });
    });

    it('a Map, a Set, a class instance and a function become "[object]"', () => {
      class CtmPhoneEmbed {
        account = 'ctm';
      }
      const cases: unknown[] = [
        new Map([['ctm', 'calltrackingmetrics']]),
        new Set(['ctm']),
        new CtmPhoneEmbed(),
        function ctmHandler() {},
      ];
      for (const value of cases) {
        spies.error.mockClear();
        expect(cleaned(value)).toBe('[object]');
      }
    });

    it('several extra arguments are each sanitised, in order', () => {
      target.error('[CTM Embed] access request failed', 'ctm', { a: 'CTM' }, 3, null);
      expect(spies.error).toHaveBeenCalledWith(
        '[Phone] access request failed',
        '[redacted]',
        { a: '[redacted]' },
        3,
        null,
      );
    });
  });

  // Verifier finding on #2389: jsdom iframes share one realm, so no test reached the
  // duck-typed checks. These values fail this realm's instanceof, as an Event, Node or Error
  // from another frame would, and must still be recognised by shape.
  describe('values from another realm (they fail instanceof)', () => {
    /** A stand-in for the vendor's <script> element from another frame: Node-shaped, not a Node. */
    function foreignVendorScript() {
      return {
        nodeType: 1,
        nodeName: 'SCRIPT',
        src: 'https://app.calltrackingmetrics.com/x.js',
        dataset: { ctmDeviceEmbedScript: 'true' },
        outerHTML: '<script data-ctm-device-embed-script="true" src="https://app.calltrackingmetrics.com/x.js">',
      };
    }

    it('an Event from another realm (Event methods on its prototype) becomes { type }', () => {
      const foreignEventPrototype = { preventDefault() {}, stopPropagation() {} };
      const script = foreignVendorScript();
      const event = Object.assign(Object.create(foreignEventPrototype) as object, {
        type: 'error',
        target: script,
        currentTarget: script,
        srcElement: script,
        isTrusted: true,
      });
      expect(event instanceof Event).toBe(false);
      expect(JSON.stringify(event)).toMatch(/calltrackingmetrics/);
      const out = cleaned(event);
      expect(out).toEqual({ type: 'error' });
      expectNoVendorName(out);
    });

    it('an Event-shaped plain object (type, target, currentTarget, isTrusted) becomes { type }', () => {
      const script = foreignVendorScript();
      const event = { type: 'error', target: script, currentTarget: script, isTrusted: true };
      expect(event instanceof Event).toBe(false);
      const out = cleaned(event);
      expect(out).toEqual({ type: 'error' });
      expectNoVendorName(out);
    });

    it('a Node from another realm becomes "[element]"', () => {
      const node = foreignVendorScript();
      expect(node instanceof Node).toBe(false);
      expect(cleaned(node)).toBe('[element]');
    });

    it('an Error from another realm keeps name and message and drops the stack', () => {
      const foreign = runInNewContext(
        "const e = new TypeError('Failed to fetch'); e.stack = 'at CtmPhoneEmbed (https://app.calltrackingmetrics.com/x.js)'; e",
      ) as Error;
      expect(foreign instanceof Error).toBe(false);
      expect(foreign.stack).toMatch(/calltrackingmetrics/);
      const top = cleaned(foreign);
      expect(top).toEqual({ name: 'TypeError', message: 'Failed to fetch' });
      spies.error.mockClear();
      const nested = cleaned({ error: foreign });
      expect(nested).toEqual({ error: 'TypeError: Failed to fetch' });
      expectNoVendorName(top);
      expectNoVendorName(nested);
    });
  });

  describe('only the renamed path is sanitised', () => {
    it('a pass-through console.error forwards its extra arguments as the same objects', () => {
      const err = new TypeError('Failed to fetch');
      err.stack = 'at CtmPhoneEmbed (https://app.calltrackingmetrics.com/x.js)';
      const detail = { err };
      target.error('Request failed with status code 500', detail, err);
      expect(spies.error).toHaveBeenCalledTimes(1);
      const call = spies.error.mock.calls[0]!;
      expect(call[0]).toBe('Request failed with status code 500');
      expect(call[1]).toBe(detail);
      expect(call[2]).toBe(err);
    });

    it('the vendor\'s own nameless lines still pass through with the same objects', () => {
      const pasted = { text: 'ctm' };
      target.log('received paste:', pasted);
      target.log('valHook set:', pasted);
      target.error('No access URL provided');
      expect(spies.log.mock.calls).toEqual([
        ['received paste:', pasted],
        ['valHook set:', pasted],
      ]);
      expect(spies.log.mock.calls[0]![1]).toBe(pasted);
      expect(spies.log.mock.calls[1]![1]).toBe(pasted);
      expect(spies.error).toHaveBeenCalledWith('No access URL provided');
    });

    it('a dropped line stays dropped, whatever it carries', () => {
      target.log('[CTM Embed] requesting access', { url: 'x', error: new Error('ctm') });
      target.warn('[CTM Embed] access token assigned', new Event('error'));
      target.log('attach ctm-phone-skeleton');
      expect(spies.log).not.toHaveBeenCalled();
      expect(spies.warn).not.toHaveBeenCalled();
    });
  });
});

describe('VENDOR_CONSOLE_PATTERNS', () => {
  // Every first argument the vendor script passes to console.* (measured 2026-10-01).
  const vendorLinesWithItsName = [
    '[CTM Embed] requesting access',
    '[CTM Embed] access response',
    '[CTM Embed] access token assigned',
    '[CTM Embed] iframe requested access',
    'attach ctm-phone-skeleton',
    '[CTM Embed] access request failed',
    '[CTM Embed] device embed script failed',
  ];
  const vendorLinesWithoutItsName = ['No access URL provided', 'received paste:', 'valHook set:'];
  const covered = (line: string) =>
    (VENDOR_CONSOLE_PATTERNS.exact as readonly string[]).includes(line) ||
    VENDOR_CONSOLE_PATTERNS.prefixes.some((prefix) => line.startsWith(prefix));

  it('covers every measured vendor line that carries its name', () => {
    expect(vendorLinesWithItsName.filter((line) => !covered(line))).toEqual([]);
  });

  it('covers none of the vendor lines that carry no name', () => {
    expect(vendorLinesWithoutItsName.filter(covered)).toEqual([]);
  });

  it('has one vendor-token pattern matching the vendor name case-insensitively', () => {
    const tokens = VENDOR_CONSOLE_PATTERNS.vendorTokens;
    expect(tokens).toBeInstanceOf(RegExp);
    expect(tokens.flags).toContain('i');
    expect(tokens.flags).toContain('g');
    for (const word of ['ctm', 'CTM', 'CallTrackingMetrics', 'calltrackingmetrics', 'calltracking']) {
      expect(word.replace(tokens, '')).toBe('');
    }
    expect('ServWave phone'.replace(tokens, '')).toBe('ServWave phone');
  });

  it('never renames to a vendor name', () => {
    expect(VENDOR_CONSOLE_PATTERNS.errorPrefixReplacement).not.toMatch(/ctm|calltracking/i);
  });
});

describe('app wiring', () => {
  // Importing the module is what installs the filter on the real console, so the import in
  // main.tsx is the whole fix. It must come straight after the Sentry instrument import
  // (which must stay first), and before anything else runs.
  it('main.tsx imports the filter right after ./instrument', () => {
    const main = readFileSync(path.resolve(__dirname, '../../../main.tsx'), 'utf8');
    const imports = main
      .split('\n')
      .filter((line) => /^import\s/.test(line))
      .map((line) => line.match(/['"]([^'"]+)['"]/)?.[1]);
    expect(imports[0]).toBe('./instrument');
    expect(imports[1]).toBe('@/lib/communication/vendorConsoleFilter');
  });
});
