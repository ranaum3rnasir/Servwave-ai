// Roles & Permissions, PRD 10, slice S10.17 - the three calls that reach the mail provider for a RECEIVED message's attachments:
// the message with its attachment metadata, the list with the addresses their bytes can be read from, and one attachment's bytes.
// Everything else of the slice replaces these three at their boundary (permission-email-received-content-db.test.ts), so this is
// where their own mapping and failure behaviour is proved against the provider's documented answer shapes.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { getReceiving, listAttachments } = vi.hoisted(() => ({ getReceiving: vi.fn(), listAttachments: vi.fn() }));

vi.mock('../config/env', () => ({ env: { RESEND_API_KEY: 're_test_key', EMAIL_REPLY_DOMAIN: 'reply.test.com' } }));
vi.mock('resend', () => ({
  Resend: class {
    emails = { receiving: { get: getReceiving, attachments: { list: listAttachments } } };
  },
}));

import { fetchReceivedEmail, listReceivedAttachments, downloadReceivedAttachment, type ReceivedAttachmentRef } from '../lib/inbound-email';

const REF: ReceivedAttachmentRef = { id: 'att_1', filename: 'door.jpg', content_type: 'image/jpeg', size: 4, downloadUrl: 'https://files.example.com/att_1' };

describe('the received message, with its attachments', () => {
  beforeEach(() => getReceiving.mockReset());

  it('carries each attachment\'s id, name, type and size', async () => {
    getReceiving.mockResolvedValue({
      data: {
        id: 'rcv_1', from: 'Pat <pat@example.com>', received_for: ['a@mail.test.com'], to: ['a@mail.test.com'], subject: 'Hi',
        message_id: '<m@x>', created_at: '2026-07-01T15:00:00.000Z', text: 't', html: '<p>t</p>', headers: {},
        attachments: [{ id: 'att_1', filename: 'door.jpg', size: 42, content_type: 'image/jpeg', content_id: null, content_disposition: 'attachment' }],
      },
      error: null,
    });

    const message = await fetchReceivedEmail('rcv_1');

    expect(message.attachments).toEqual([{ id: 'att_1', filename: 'door.jpg', content_type: 'image/jpeg', size: 42 }]);
  });
});

describe('the list of a received message\'s attachments', () => {
  beforeEach(() => listAttachments.mockReset());

  it('maps each to its id, name, type, size and the address its bytes can be read from, in one call', async () => {
    listAttachments.mockResolvedValue({
      data: {
        object: 'list', has_more: false,
        data: [
          { id: 'att_1', filename: 'door.jpg', size: 42, content_type: 'image/jpeg', content_disposition: 'attachment', download_url: 'https://files.example.com/att_1', expires_at: 'x' },
          { id: 'att_2', size: 7, content_type: 'application/pdf', content_disposition: 'attachment', download_url: 'https://files.example.com/att_2', expires_at: 'x' },
        ],
      },
      error: null,
    });

    const refs = await listReceivedAttachments('rcv_1');

    expect(listAttachments).toHaveBeenCalledTimes(1);
    expect(listAttachments).toHaveBeenCalledWith({ emailId: 'rcv_1' });
    expect(refs).toEqual([
      { id: 'att_1', filename: 'door.jpg', content_type: 'image/jpeg', size: 42, downloadUrl: 'https://files.example.com/att_1' },
      { id: 'att_2', filename: null, content_type: 'application/pdf', size: 7, downloadUrl: 'https://files.example.com/att_2' },
    ]);
  });

  it('throws when the provider answers with an error, so the attempt is recorded and tried again', async () => {
    listAttachments.mockResolvedValue({ data: null, error: { message: 'rate limited', name: 'rate_limit_exceeded' } });

    await expect(listReceivedAttachments('rcv_1')).rejects.toThrow(/rcv_1/);
  });
});

describe('one attachment\'s bytes', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => vi.unstubAllGlobals());

  const answer = (body: Buffer, init: { status?: number; contentLength?: string } = {}) =>
    new Response(new Uint8Array(body), { status: init.status ?? 200, headers: init.contentLength ? { 'content-length': init.contentLength } : {} });

  it('reads the bytes from the address the list gave', async () => {
    fetchMock.mockResolvedValue(answer(Buffer.from([1, 2, 3, 4])));

    const bytes = await downloadReceivedAttachment(REF, 1024);

    expect(fetchMock.mock.calls[0]![0]).toBe(REF.downloadUrl);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it('throws on a refusal, without naming the address', async () => {
    fetchMock.mockResolvedValue(answer(Buffer.from('expired'), { status: 403 }));

    const failure = await downloadReceivedAttachment(REF, 1024).catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('403');
    expect((failure as Error).message).not.toContain('files.example.com');
  });

  it('throws when the body is bigger than the ceiling, whether it says so up front or only shows it on arrival', async () => {
    fetchMock.mockResolvedValueOnce(answer(Buffer.from([1]), { contentLength: '5000' }));
    await expect(downloadReceivedAttachment(REF, 1024)).rejects.toThrow(/allowed size/);

    fetchMock.mockResolvedValueOnce(answer(Buffer.alloc(2000)));
    await expect(downloadReceivedAttachment(REF, 1024)).rejects.toThrow(/allowed size/);
  });
});
