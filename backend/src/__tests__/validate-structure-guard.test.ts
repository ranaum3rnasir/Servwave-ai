/**
 * GHSA-mrhx-c7xc-m3w5 interim guard: validate() refuses a body whose shape is too big BEFORE zod
 * parses it, and a 400 carries at most MAX_DETAILS issues. zod 3 records one issue per failing
 * array element and keeps parsing past `.max()`, so without the guard a single body inside the
 * 1mb cap produced ~1M issues, hundreds of MB of heap and a 60MB response.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  validate,
  checkStructure,
  zodValidationFailure,
  MAX_ARRAY_LENGTH,
  MAX_NODES,
  MAX_DEPTH,
  MAX_DETAILS,
  TOO_COMPLEX_MESSAGE,
} from '../middleware/validate';
import { updateSpiderSettingsSchema } from '../services/spider/config';

function run(schema: z.ZodSchema, body: unknown, limits?: Parameters<typeof validate>[1]) {
  const req = { body } as Request;
  let status = 0;
  let payload: any;
  const res = {
    status: vi.fn((c: number) => { status = c; return res; }),
    json: vi.fn((b: unknown) => { payload = b; return res; }),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  validate(schema, limits)(req, res, next);
  return { req, status, payload, next: next as unknown as ReturnType<typeof vi.fn> };
}

/** `depth` objects, each inside the last. Depth counts containers; a leaf value adds none. */
function nested(depth: number): unknown {
  let v: unknown = { leaf: 1 };
  for (let i = 1; i < depth; i++) v = { a: v };
  return v;
}

const selection = z.object({ kind: z.enum(['line', 'scope']), id: z.string().uuid(), is_selected: z.boolean() });
const selectionsSchema = z.object({ selections: z.array(selection).min(1).max(200) });

describe('checkStructure', () => {
  it('passes primitives, null and realistic payloads', () => {
    expect(checkStructure(undefined)).toBeNull();
    expect(checkStructure(null)).toBeNull();
    expect(checkStructure('text')).toBeNull();
    const estimate = {
      title: 'Install',
      line_items: Array.from({ length: 300 }, (_, i) => ({
        description: `Line ${i}`, quantity: 1, unit_price: 10, is_taxable: true, is_optional: false,
        meta: { sku: 'A', tags: ['x', 'y'] },
      })),
    };
    expect(checkStructure(estimate)).toBeNull();
    expect(checkStructure({ items: Array.from({ length: 2000 }, () => ({ item_key: 'k', entry_id: 'e' })) })).toBeNull();
  });

  it('flags a single array longer than MAX_ARRAY_LENGTH, and allows exactly the limit', () => {
    expect(checkStructure({ a: new Array(MAX_ARRAY_LENGTH).fill(0) })).toBeNull();
    expect(checkStructure({ a: new Array(MAX_ARRAY_LENGTH + 1).fill(0) })).toBe('array_length');
  });

  it('flags too many values in total even when every array is under the length limit', () => {
    const chunk = () => new Array(MAX_ARRAY_LENGTH).fill(0);
    const body = { parts: Array.from({ length: Math.ceil(MAX_NODES / MAX_ARRAY_LENGTH) + 1 }, chunk) };
    expect(checkStructure(body)).toBe('nodes');
  });

  it('counts object keys toward the node limit', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i <= MAX_NODES; i++) wide[`k${i}`] = i;
    expect(checkStructure(wide)).toBe('nodes');
  });

  it('flags nesting deeper than MAX_DEPTH, allows exactly the limit', () => {
    expect(checkStructure(nested(MAX_DEPTH))).toBeNull();
    expect(checkStructure(nested(MAX_DEPTH + 1))).toBe('depth');
  });

  it('walks very deep input without overflowing the stack', () => {
    let deep: unknown = [];
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(checkStructure(deep, { maxArrayLength: Infinity, maxNodes: Infinity, maxDepth: Infinity })).toBeNull();
    expect(checkStructure(deep)).toBe('depth');
  });
});

describe('validate() structural guard', () => {
  it('lets a normal body through to zod and on to the handler', () => {
    const body = { selections: [{ kind: 'line', id: '00000000-0000-4000-8000-000000000001', is_selected: true }] };
    const r = run(selectionsSchema, body);
    expect(r.next).toHaveBeenCalledWith();
    expect(r.req.body).toEqual(body);
  });

  it('answers 400 in the standard shape, with a generic message that echoes nothing', () => {
    const r = run(selectionsSchema, { selections: new Array(MAX_ARRAY_LENGTH + 1).fill({ marker: 'ECHO-ME' }) });
    expect(r.status).toBe(400);
    expect(r.payload).toEqual({ error: 'Validation failed', details: [{ field: '', message: TOO_COMPLEX_MESSAGE }] });
    expect(JSON.stringify(r.payload)).not.toContain('ECHO-ME');
    expect(r.next).not.toHaveBeenCalled();
  });

  it('refuses too-deep and too-many-node bodies before parsing', () => {
    const parse = vi.fn();
    const spy = { parse } as unknown as z.ZodSchema;
    expect(run(spy, nested(MAX_DEPTH + 1)).status).toBe(400);
    const chunk = () => new Array(MAX_ARRAY_LENGTH).fill(0);
    expect(run(spy, { p: Array.from({ length: 11 }, chunk) }).status).toBe(400);
    expect(parse).not.toHaveBeenCalled();
  });

  it('takes a per-route override without changing the default', () => {
    const schema = z.object({ items: z.array(z.unknown()).min(1) });
    const rows = new Array(20_000).fill({ name: 'x', sellPrice: 1 });
    expect(run(schema, { items: rows }).status).toBe(400);
    const overridden = run(schema, { items: rows }, { maxArrayLength: 50_000, maxNodes: 400_000 });
    expect(overridden.next).toHaveBeenCalledWith();
    // The override is per call: a fresh validate() still uses the defaults.
    expect(run(schema, { items: rows }).status).toBe(400);
  });

  it('ignores an undefined override instead of switching that check off', () => {
    const schema = z.object({ a: z.array(z.number()) });
    const body = { a: new Array(MAX_ARRAY_LENGTH + 1).fill(0) };
    expect(run(schema, body, { maxArrayLength: undefined }).status).toBe(400);
    expect(checkStructure(body, { maxArrayLength: undefined, maxNodes: undefined })).toBe('array_length');
    expect(checkStructure(nested(MAX_DEPTH + 1), { maxDepth: undefined })).toBe('depth');
  });

  it('passes the largest real validated array: a Spider settings save with 5000 selected leads', () => {
    const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const body = {
      status_limits: { NEW: { enabled: true, value: 2, unit: 'HOUR' } },
      channels: { in_app: true, red_frame: true, email: false, text: false },
      recipients: { roles: ['ADMIN'], user_ids: Array.from({ length: 500 }, (_, i) => uuid(100_000 + i)), lead_owner: true },
      watch_all_leads: false,
      selected_lead_ids: Array.from({ length: 5000 }, (_, i) => uuid(i)),
    };
    const r = run(updateSpiderSettingsSchema, body);
    expect(r.payload).toBeUndefined();
    expect(r.next).toHaveBeenCalledWith();
    expect(r.req.body.selected_lead_ids).toHaveLength(5000);
  });

  it('a 1MB body of bad elements answers 400 quickly with no more than MAX_DETAILS details', () => {
    const n = Math.floor((1024 * 1024 - 20) / 3);
    const body = JSON.parse('{"selections":[' + Array(n).fill('{}').join(',') + ']}');
    const t0 = performance.now();
    const r = run(selectionsSchema, body);
    const ms = performance.now() - t0;
    expect(r.status).toBe(400);
    expect(r.payload.details.length).toBeLessThanOrEqual(MAX_DETAILS);
    expect(ms).toBeLessThan(500);
  });

  it('caps details at MAX_DETAILS when a body inside the limits still fails on many elements', () => {
    const r = run(selectionsSchema, { selections: new Array(MAX_ARRAY_LENGTH).fill({}) });
    expect(r.status).toBe(400);
    expect(r.payload.error).toBe('Validation failed');
    expect(r.payload.details).toHaveLength(MAX_DETAILS);
    expect(r.payload.details[0]).toEqual({ field: expect.any(String), message: expect.any(String) });
  });
});

describe('zodValidationFailure', () => {
  it('maps at most MAX_DETAILS issues', () => {
    const parsed = z.array(z.string()).safeParse(new Array(100).fill(1));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(zodValidationFailure(parsed.error).details).toHaveLength(MAX_DETAILS);
  });
});
