/**
 * Text length limits (spec md_files/plans/text-length-limits, 2026-10-14).
 *
 * Long free text (descriptions, notes, reasons) is capped at 20,000 characters, email bodies and
 * document terms at 65,000, anything sent as a text at 1,600. A rejected value reaches the user as
 * "<Label> is too long (maximum N characters)", never Zod's raw "String must contain at most N".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import type { ZodTypeAny } from 'zod';
import {
  createLeadSchema, updateLeadSchema, walkthroughSchema, markLostSchema, contactLeadSchema,
  cancelWalkthroughSchema, createLeadNoteSchema, scheduleWalkthroughSchema,
} from '../controllers/lead.controller';
import { cancelJobSchema } from '../controllers/job.controller';
import { sendEmailConfigSchema } from '../services/automations/workflowValidation';
import { createTaskSchema, updateTaskSchema, commentSchema, subtaskCreateSchema, subtaskUpdateSchema } from '../controllers/task.controller';
import { createCalendarEntrySchema, updateCalendarEntrySchema } from '../controllers/calendar-entry.controller';
import { sendEmailSchema } from '../controllers/comm-whatsapp-email.controller';
import { createTemplateSchema, updateTemplateSchema } from '../controllers/comm-threads.controller';
import { createInvoiceSchema } from '../controllers/invoice.controller';
import {
  LOST_REASON_NOTE_MAX, createFromJobItemsSchema, sendEstimateSchema, bulkSendEstimateRemindersSchema, markSentEstimateSchema, cancelEstimateSchema,
} from '../controllers/estimate.controller';
import { createPurchaseOrderSchema, updateRfqSchema } from '../controllers/inv-po.controller';
import { updateCustomerSchema } from '../controllers/customer.controller';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('POST /api/leads - service request length', () => {
  it('refuses 20,001 characters with a readable message', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'x'.repeat(20_001) });

    expect(res.status).toBe(400);
    expect(res.body.details).toEqual([
      { field: 'service_request', message: 'Service request is too long (maximum 20,000 characters)' },
    ]);
  });

  it('accepts exactly 20,000 characters', () => {
    const parsed = createLeadSchema.safeParse({ customer_id: CUSTOMER_FIXTURE.id, service_request: 'x'.repeat(20_000) });
    expect(parsed.success).toBe(true);
  });
});

/** The messages Zod raised at exactly `path` (array indexes included). */
function messagesAt(schema: ZodTypeAny, input: unknown, path: (string | number)[]): string[] {
  const parsed = schema.safeParse(input);
  if (parsed.success) return [];
  return parsed.error.issues.filter((i) => JSON.stringify(i.path) === JSON.stringify(path)).map((i) => i.message);
}

/** Accepts `max` characters at `path`, refuses `max + 1` with the readable too-long message. */
function expectCap(schema: ZodTypeAny, build: (value: string) => unknown, path: (string | number)[], max: number) {
  expect(messagesAt(schema, build('x'.repeat(max)), path)).toEqual([]);
  const refused = messagesAt(schema, build('x'.repeat(max + 1)), path);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toMatch(new RegExp(`is too long \\(maximum ${max.toLocaleString('en-US')} characters\\)$`));
}

describe('fields that had no cap now have one (spec section 4)', () => {
  it('task title 255, description and comment 20,000, subtask text 1,000', () => {
    expectCap(createTaskSchema, (v) => ({ title: v }), ['title'], 255);
    expectCap(updateTaskSchema, (v) => ({ title: v }), ['title'], 255);
    expectCap(createTaskSchema, (v) => ({ title: 't', description: v }), ['description'], 20_000);
    expectCap(updateTaskSchema, (v) => ({ description: v }), ['description'], 20_000);
    expectCap(commentSchema, (v) => ({ body: v }), ['body'], 20_000);
    expectCap(subtaskCreateSchema, (v) => ({ text: v }), ['text'], 1_000);
    expectCap(subtaskUpdateSchema, (v) => ({ text: v }), ['text'], 1_000);
  });

  it('calendar entry title 255, description 20,000', () => {
    const base = { start: '2026-10-14T09:00:00.000Z', end: '2026-10-14T10:00:00.000Z' };
    expectCap(createCalendarEntrySchema, (v) => ({ ...base, title: v }), ['title'], 255);
    expectCap(updateCalendarEntrySchema, (v) => ({ title: v }), ['title'], 255);
    expectCap(createCalendarEntrySchema, (v) => ({ ...base, title: 't', description: v }), ['description'], 20_000);
    expectCap(updateCalendarEntrySchema, (v) => ({ description: v }), ['description'], 20_000);
    // The notify message is an email body, like the lead and job visit emails.
    expectCap(createCalendarEntrySchema, (v) => ({ ...base, title: 't', notify_message: v }), ['notify_message'], 65_000);
  });

  it('email compose: the joined plain body is capped at 65,000, the html at 260,000', () => {
    const half = 32_500;
    expect(messagesAt(sendEmailSchema, { to: 'a@b.co', body: ['x'.repeat(half - 1), 'x'.repeat(half)] }, ['body'])).toEqual([]);
    expect(messagesAt(sendEmailSchema, { to: 'a@b.co', body: ['x'.repeat(half), 'x'.repeat(half)] }, ['body'])).toEqual([
      'Body is too long (maximum 65,000 characters)',
    ]);
    expectCap(sendEmailSchema, (v) => ({ to: 'a@b.co', body_html: v }), ['body_html'], 260_000);
  });

  it('text template body and default body are capped at the text-message maximum, 1,600', () => {
    const base = { name: 'n', info: 'i', audience: 'customer' };
    expectCap(createTemplateSchema, (v) => ({ ...base, body: v }), ['body'], 1_600);
    expectCap(createTemplateSchema, (v) => ({ ...base, body: 'b', defaultBody: v }), ['defaultBody'], 1_600);
    expectCap(updateTemplateSchema, (v) => ({ body: v }), ['body'], 1_600);
    expectCap(updateTemplateSchema, (v) => ({ defaultBody: v }), ['defaultBody'], 1_600);
  });

  it('standalone invoice line description matches every other line path, 50,000', () => {
    expectCap(
      createInvoiceSchema,
      (v) => ({ customer_id: 'c', line_items: [{ description: v, quantity: 1, unit_price: 1 }] }),
      ['line_items', 0, 'description'],
      50_000,
    );
  });

  it('estimate from job items scope notes, 20,000', () => {
    expectCap(createFromJobItemsSchema, (v) => ({ scope_notes: v }), ['scope_notes'], 20_000);
  });

  it('PO line item name 300 and unit 100; RFQ line sku 100, name 300, unit 100', () => {
    const poLine = { itemName: 'n', uom: 'ea', qtyOrdered: 1 };
    const po = (line: object) => ({ vendor: 'v', lines: [{ ...poLine, ...line }] });
    expectCap(createPurchaseOrderSchema, (v) => po({ itemName: v }), ['lines', 0, 'itemName'], 300);
    expectCap(createPurchaseOrderSchema, (v) => po({ uom: v }), ['lines', 0, 'uom'], 100);
    const rfqLine = { itemSku: 's', itemName: 'n', qty: 1, uom: 'ea' };
    const rfq = (line: object) => ({ lines: [{ ...rfqLine, ...line }] });
    expectCap(updateRfqSchema, (v) => rfq({ itemSku: v }), ['lines', 0, 'itemSku'], 100);
    expectCap(updateRfqSchema, (v) => rfq({ itemName: v }), ['lines', 0, 'itemName'], 300);
    expectCap(updateRfqSchema, (v) => rfq({ uom: v }), ['lines', 0, 'uom'], 100);
  });
});

describe('an email longer than the column is a 400, not a database 500 (spec section 5)', () => {
  // 245 + '@example.com' = 257 characters, past the VarChar(255) column; 242 + 12 = 254 fits.
  const email = (local: number) => `${'a'.repeat(local)}@example.com`;

  it('extra customer email', () => {
    expect(messagesAt(updateCustomerSchema, { extra_emails: [{ email: email(242) }] }, ['extra_emails', 0, 'email'])).toEqual([]);
    expect(messagesAt(updateCustomerSchema, { extra_emails: [{ email: email(245) }] }, ['extra_emails', 0, 'email'])).toEqual([
      'Email is too long (maximum 254 characters)',
    ]);
  });
});

describe('existing caps raised to the shared tiers (spec section 3)', () => {
  it('an estimate email body takes 65,000 characters (very long tier)', () => {
    expectCap(sendEstimateSchema, (v) => ({ message_body: v }), ['message_body'], 65_000);
    expectCap(bulkSendEstimateRemindersSchema, (v) => ({ ids: [CUSTOMER_FIXTURE.id], message_body: v }), ['message_body'], 65_000);
    expectCap(markSentEstimateSchema, (v) => ({ message_body: v }), ['message_body'], 65_000);
  });

  it('every lead free-text field takes 20,000 characters', () => {
    expectCap(createLeadSchema, (v) => ({ customer_id: CUSTOMER_FIXTURE.id, service_request: 's', notes: v }), ['notes'], 20_000);
    expectCap(updateLeadSchema, (v) => ({ service_request: v }), ['service_request'], 20_000);
    expectCap(updateLeadSchema, (v) => ({ notes: v }), ['notes'], 20_000);
    expectCap(walkthroughSchema, (v) => ({ walkthrough_notes: v }), ['walkthrough_notes'], 20_000);
    expectCap(markLostSchema, (v) => ({ lost_reason: v }), ['lost_reason'], 20_000);
    expectCap(contactLeadSchema, (v) => ({ contacted_note: v }), ['contacted_note'], 20_000);
    expectCap(cancelWalkthroughSchema, (v) => ({ cancelled_reason: v }), ['cancelled_reason'], 20_000);
    expectCap(createLeadNoteSchema, (v) => ({ content: v }), ['content'], 20_000);
  });

  it('the visit email a lead sends takes 65,000 characters', () => {
    expectCap(scheduleWalkthroughSchema, (v) => ({ notify_message: v }), ['notify_message'], 65_000);
  });

  it('the four job and estimate cancel reasons agree at 20,000', () => {
    expectCap(cancelEstimateSchema, (v) => ({ cancelled_reason: v }), ['cancelled_reason'], 20_000);
    expectCap(cancelJobSchema, (v) => ({ cancelled_reason: v }), ['cancelled_reason'], 20_000);
  });
});

describe('caps that are checked outside the shared schemas', () => {
  it('a customer decline note is cut at 20,000, not refused', () => {
    expect(LOST_REASON_NOTE_MAX).toBe(20_000);
  });

  it('an automation email body takes 65,000 characters and keeps its own message', () => {
    const step = (body: string) => sendEmailConfigSchema.safeParse({ recipients: ['customer'], subject: 'Hi', body });
    expect(step('x'.repeat(65_000)).success).toBe(true);
    expect(JSON.stringify(step('x'.repeat(65_001)).error?.issues)).toContain('Email is too long (65,000 characters max)');
  });
});
