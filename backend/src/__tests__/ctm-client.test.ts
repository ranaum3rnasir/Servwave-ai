import { describe, it, expect, vi, beforeEach } from 'vitest';

// This file tests the REAL client — undo the global mock from setup.ts.
vi.unmock('../lib/ctm/client');

// Mutable env double: the client reads env.* at call time, so tests can flip
// configuration per case without re-importing the module.
const mockEnv = vi.hoisted(() => ({
  env: {
    CTM_ACCESS_KEY: 'test-access-key',
    CTM_SECRET_KEY: 'test-secret-key',
    CTM_API_BASE: undefined as string | undefined,
    CTM_RECORDINGS_BUCKET: 'call-recordings',
  },
}));
vi.mock('../config/env', () => mockEnv);
vi.mock('../lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  CtmApiError,
  isCtmConfigured,
  getCtmForOrg,
  listAccounts,
  listNumbers,
  searchNumbers,
  buyNumber,
  enableSms,
  isOptedOut,
  createWebhook,
  getCall,
  listCalls,
  placeCall,
  getRecordingResponse,
  sendSms,
} from '../lib/ctm/client';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  mockEnv.env.CTM_ACCESS_KEY = 'test-access-key';
  mockEnv.env.CTM_SECRET_KEY = 'test-secret-key';
  mockEnv.env.CTM_API_BASE = undefined;
});

describe('configuration gate', () => {
  it('isCtmConfigured is false when keys are absent', () => {
    mockEnv.env.CTM_ACCESS_KEY = undefined as unknown as string;
    expect(isCtmConfigured()).toBe(false);
  });

  it('isCtmConfigured is true when both keys are set', () => {
    expect(isCtmConfigured()).toBe(true);
  });

  it('requests refuse to run unconfigured (fetch never called)', async () => {
    mockEnv.env.CTM_SECRET_KEY = undefined as unknown as string;
    await expect(listAccounts()).rejects.toThrow(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getCtmForOrg requires a connected org', () => {
    expect(() => getCtmForOrg({ ctm_account_id: null })).toThrow(/not connected/i);
    expect(getCtmForOrg({ ctm_account_id: '500001' })).toEqual({ accountId: '500001' });
  });
});

describe('auth + base url', () => {
  it('sends HTTP Basic auth built from the access/secret keys', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [] }));
    await listAccounts();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.calltrackingmetrics.com/api/v1/accounts.json?names=1&all=1');
    const expected = 'Basic ' + Buffer.from('test-access-key:test-secret-key').toString('base64');
    expect((init.headers as Record<string, string>).Authorization).toBe(expected);
  });

  it('honors CTM_API_BASE override', async () => {
    mockEnv.env.CTM_API_BASE = 'https://api.calltrackingmetrics.com/api/v1/';
    fetchMock.mockResolvedValueOnce(jsonResponse({ numbers: [] }));
    await listNumbers('500001');
    // The trailing slash is stripped and the base is honored. listNumbers now
    // walks pages, so the query carries page=1; the point of this test is the
    // base URL, not the pagination cursor.
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://api.calltrackingmetrics.com/api/v1/accounts/500001/numbers?page=1',
    );
  });
});

describe('buyNumber response shape', () => {
  // POST /numbers wraps the created number under `number`; GET /numbers/{id}
  // returns it flat. The seam normalises so callers can always read `.id` /
  // `.number` / `.formatted` off the top level.
  it('unwraps a purchase nested under `number`', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ number: { id: 'TPN-X', number: '+16095968565', formatted: '(609) 596-8565' } }),
    );
    await expect(buyNumber('500002', { phone_number: '+16095968565' })).resolves.toMatchObject({
      id: 'TPN-X',
      number: '+16095968565',
      formatted: '(609) 596-8565',
    });
  });

  it('passes a flat purchase response through unchanged', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'TPN-Y', number: '+12015550123' }));
    await expect(buyNumber('500002', { phone_number: '+12015550123' })).resolves.toMatchObject({
      id: 'TPN-Y',
      number: '+12015550123',
    });
  });
});

describe('error envelope + retry policy', () => {
  it('parses the {"status":"error","reason"} envelope into CtmApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'error', reason: 'number not available' }, 406));
    await expect(buyNumber('500001', { phone_number: '+12015551234' })).rejects.toMatchObject({
      name: 'CtmApiError',
      httpStatus: 406,
      reason: 'number not available',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 4xx = NO retry
  });

  it('treats a 200 body with status:error as an error (CTM convention)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'error', reason: 'bad params' }, 200));
    await expect(listNumbers('500001')).rejects.toBeInstanceOf(CtmApiError);
  });

  it('retries on 5xx with backoff, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: 'error', reason: 'oops' }, 500))
      .mockResolvedValueOnce(jsonResponse({ numbers: [{ id: 'TPN1' }] }));
    const numbers = await listNumbers('500001');
    expect(numbers).toEqual([{ id: 'TPN1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 attempts on persistent 5xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: 'error', reason: 'down' }, 503));
    await expect(listNumbers('500001')).rejects.toBeInstanceOf(CtmApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('never leaks the secret key into thrown errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'error', reason: 'denied' }, 403));
    try {
      await listNumbers('500001');
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain('test-secret-key');
      expect(String(err)).not.toContain('test-access-key');
    }
  });
});

describe('pagination (page-based envelope)', () => {
  it('iterates page/next_page until exhausted', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ page: 1, next_page: 2, total_pages: 2, calls: [{ sid: 'CA1' }] }))
      .mockResolvedValueOnce(jsonResponse({ page: 2, next_page: null, total_pages: 2, calls: [{ sid: 'CA2' }] }));
    const seen: string[] = [];
    for await (const page of listCalls('500001')) {
      for (const call of page) seen.push(String(call.sid));
    }
    expect(seen).toEqual(['CA1', 'CA2']);
    expect(String(fetchMock.mock.calls[0][0])).toContain('page=1');
    expect(String(fetchMock.mock.calls[1][0])).toContain('page=2');
  });

  it('stops on a single page with no next_page', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ page: 1, next_page: null, calls: [] }));
    const pages = [];
    for await (const page of listCalls('500001')) pages.push(page);
    expect(pages).toEqual([[]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // The live envelope, captured from account 500001 on 2026-08-13: `next_page`
  // is a URL, NOT a page number. The fixture above invented the numeric form,
  // so it passed while production stopped after page 1. Page size is 10, so
  // every list silently truncated - 10 of 20 numbers, 10 of 123 calls.
  it('follows next_page when it is a URL rather than a number', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          page: 1,
          next_page: 'https://api.calltrackingmetrics.com/api/v1/accounts/500001/calls?page=2',
          total_pages: 2,
          calls: [{ sid: 'CA1' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ page: 2, next_page: null, total_pages: 2, calls: [{ sid: 'CA2' }] }),
      );

    const seen: string[] = [];
    for await (const page of listCalls('500001')) for (const c of page) seen.push(String(c.sid));

    expect(seen).toEqual(['CA1', 'CA2']);
  });

  it('stops at total_pages even if next_page keeps pointing forward', async () => {
    // Runaway guard: a next_page that never goes null must not loop forever.
    // A fresh Response per call - a Response body can only be read once, so a
    // single shared object would fail on the second fetch for the wrong reason.
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        page: 1,
        next_page: 'https://api.calltrackingmetrics.com/api/v1/accounts/500001/calls?page=2',
        total_pages: 2,
        calls: [{ sid: 'CA1' }],
      }),
    );

    const pages = [];
    for await (const page of listCalls('500001')) pages.push(page);

    expect(pages).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops on an empty page even when the envelope claims more', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ page: 1, next_page: 'x?page=2', total_pages: 99, calls: [{ sid: 'CA1' }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ page: 2, next_page: 'x?page=3', total_pages: 99, calls: [] }));

    const pages = [];
    for await (const page of listCalls('500001')) pages.push(page);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pages.flat()).toHaveLength(1);
  });
});

describe('listNumbers pagination', () => {
  // Northwind Services holds 20 tracking numbers across 2 pages. listNumbers fetched
  // page 1 and stopped, so Sync imported exactly half the account and the
  // Numbers table under-reported what the customer is billed for.
  const numbersPage = (n: number, ids: string[], totalPages: number) =>
    jsonResponse({
      page: n,
      next_page:
        n < totalPages
          ? `https://api.calltrackingmetrics.com/api/v1/accounts/500001/numbers?page=${n + 1}`
          : null,
      total_pages: totalPages,
      numbers: ids.map((id) => ({ id, number: `+1201555${id.padStart(4, '0')}` })),
    });

  it('returns every number on the account, not just the first page', async () => {
    fetchMock
      .mockResolvedValueOnce(numbersPage(1, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], 2))
      .mockResolvedValueOnce(
        numbersPage(2, ['11', '12', '13', '14', '15', '16', '17', '18', '19', '20'], 2),
      );

    const numbers = await listNumbers('500001');

    expect(numbers).toHaveLength(20);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('still works for an account that fits on one page', async () => {
    fetchMock.mockResolvedValueOnce(numbersPage(1, ['1', '2', '3', '4'], 1));

    const numbers = await listNumbers('500002');

    expect(numbers).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('numbers', () => {
  it('searchNumbers hits the search endpoint with area-code params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ numbers: [{ number: '+12015550000' }] }));
    const found = await searchNumbers('500001', { searchby: 'area', areacode: '201' });
    expect(found).toHaveLength(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/accounts/500001/numbers/search.json');
    expect(url).toContain('searchby=area');
    expect(url).toContain('areacode=201');
    expect(url).toContain('country=US');
  });

  // CTM asks for toll-free inventory via searchby, not via a `type` parameter
  // (there is no such parameter - CTM drops it and returns local numbers).
  it('searchNumbers passes searchby=tollfree through untouched', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ numbers: [{ number: '+18335550000' }] }));
    await searchNumbers('500001', { searchby: 'tollfree' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('searchby=tollfree');
    expect(url).not.toContain('areacode');
    expect(url).not.toMatch(/[?&]type=/);
  });

  it('enableSms maps all four documented outcomes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'ok' }));
    expect(await enableSms('500001', 'TPN1')).toBe('ok');

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'alreadyenabled' }));
    expect(await enableSms('500001', 'TPN1')).toBe('alreadyenabled');

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'error', reason: 'notfound' }, 404));
    expect(await enableSms('500001', 'TPN1')).toBe('notfound');

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'error', reason: 'failure' }, 406));
    expect(await enableSms('500001', 'TPN1')).toBe('failure');
  });
});

describe('sms', () => {
  it('sends form-encoded from(TPN id)/to/msg', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'MSG123' }));
    await sendSms('500001', { from: 'TPNC3C4B23', to: '+12015551234', msg: 'hello' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/accounts/500001/sms');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = String(init.body);
    expect(body).toContain('from=TPNC3C4B23');
    expect(body).toContain('msg=hello');
  });

  it('rejects >1600 chars before any network call (CTM truncates beyond that)', async () => {
    await expect(
      sendSms('500001', { from: 'TPN1', to: '+12015551234', msg: 'x'.repeat(1601) }),
    ).rejects.toThrow(/1600/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('isOptedOut matches entries by trailing digits', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ opt_out_texts: [{ phone_number: '(201) 555-1234' }] }));
    expect(await isOptedOut('500001', '+12015551234')).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse({ opt_out_texts: [] }));
    expect(await isOptedOut('500001', '+12015551234')).toBe(false);
  });
});

describe('webhooks', () => {
  it('createWebhook sends BOTH position and trigger plus Basic credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 77 }));
    await createWebhook('500001', {
      name: 'servwave-end',
      weburl: 'https://alpha-crm-test-env.onrender.com/api/webhooks/ctm/end?token=t',
      position: 'end',
      username: 'servwave',
      password: 'hook-token',
    });
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.position).toBe('end');
    expect(body.trigger).toBe('end');
    expect(body.hooktype).toBe('call');
    expect(body.username).toBe('servwave');
    expect(body.password).toBe('hook-token');
  });
});

describe('click-to-call', () => {
  it('POSTs from_number (TPN id) + call_number', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ queued: true }));
    const res = await placeCall('500001', { from_number: 'TPN1', call_number: '+12015551234' });
    expect(res).toEqual({ queued: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/accounts/500001/calls/');
    expect(JSON.parse(String(init.body))).toMatchObject({ from_number: 'TPN1', call_number: '+12015551234' });
  });

  it('sends a ring-first leg when given one, and no key at all for an absent or undefined leg', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ queued: true }));
    await placeCall('500001', {
      from_number: 'TPN1',
      call_number: '+12015551234',
      to_number: '+16095550142',
      user_id: undefined,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body))).toStrictEqual({
      from_number: 'TPN1',
      call_number: '+12015551234',
      to_number: '+16095550142',
    });
  });
});

// CTM's call-detail endpoint is keyed by the NUMERIC activity id, not the CA…
// sid we store: GET /accounts/500001/calls/CA96f6… answers 404 "call not found"
// for a call the same account returns 200 for by its numeric id. We only ever
// hold the sid, so getCall resolves it through the list endpoint's `search`
// term, which matches a sid exactly (verified live against account 500001).
describe('getCall (sid → activity resolution)', () => {
  const SID = 'CA96f6f290523bc59bd930eebc84d324c9';

  it('never requests the sid-keyed detail path (CTM 404s it)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ total_entries: 1, calls: [{ sid: SID }] }));
    await getCall('500001', SID);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(`/calls/${SID}`);
  });

  it('searches the list endpoint for the sid and returns the matched activity', async () => {
    const activity = { id: 4367824697, sid: SID, summary: 'AI summary', transcription_text: 'A: hi' };
    fetchMock.mockResolvedValueOnce(jsonResponse({ total_entries: 1, calls: [activity] }));
    const res = await getCall('500001', SID);
    expect(res).toEqual(activity);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `https://api.calltrackingmetrics.com/api/v1/accounts/500001/calls?search=${SID}`,
    );
  });

  // A miss is a 200 with total_entries 0, NOT a 404 - normalize it so callers
  // keep seeing one typed not-found regardless of which shape CTM answers with.
  it('raises a typed 404 when the search returns no match', async () => {
    // A fresh Response per call - a body can only be read once.
    fetchMock.mockImplementation(async () => jsonResponse({ total_entries: 0, calls: [] }));
    await expect(getCall('500001', SID)).rejects.toThrow(CtmApiError);
    await expect(getCall('500001', SID)).rejects.toMatchObject({ httpStatus: 404 });
  });

  // `search` is a free-text term; never hand back a call we did not ask for.
  it('rejects a result whose sid does not match the request', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ total_entries: 1, calls: [{ id: 1, sid: 'CAsomeothercall' }] }),
    );
    await expect(getCall('500001', SID)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('url-encodes the sid into the search term', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ total_entries: 0, calls: [] }));
    await expect(getCall('500001', 'CA weird/sid')).rejects.toThrow(CtmApiError);
    expect(String(fetchMock.mock.calls[0][0])).toContain('search=CA%20weird%2Fsid');
  });
});

describe('recording fetch (SSRF + redirect rules)', () => {
  it('refuses a non-allowlisted initial host', async () => {
    mockEnv.env.CTM_API_BASE = 'https://evil.example/api/v1';
    await expect(getRecordingResponse('500001', 'CA123')).rejects.toThrow(/not allowlisted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows one https redirect and drops Authorization off-host', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/rec.mp3' } }),
      )
      .mockResolvedValueOnce(new Response('audio-bytes', { status: 200 }));
    const res = await getRecordingResponse('500001', 'CA123');
    expect(res.status).toBe(200);
    const firstInit = fetchMock.mock.calls[0][1];
    const secondInit = fetchMock.mock.calls[1][1];
    expect((firstInit.headers as Record<string, string>).Authorization).toBeDefined();
    expect((secondInit.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://cdn.example.com/rec.mp3');
  });

  it('blocks non-https redirect targets', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://cdn.example.com/rec.mp3' } }),
    );
    await expect(getRecordingResponse('500001', 'CA123')).rejects.toThrow(/non-https/i);
  });

  it('gives up after the redirect depth cap', async () => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/loop' } }),
    );
    await expect(getRecordingResponse('500001', 'CA123')).rejects.toThrow(/too many redirects/i);
  });
});
