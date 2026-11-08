import crypto from 'crypto';
import type { Request } from 'express';

/**
 * Helpers shared by every raw-body webhook receiver (phone system, call
 * tracking). Lifted out of ctm-webhook.controller.ts unchanged.
 */

// Constant-time compare (same hash-first idiom as middleware/originVerify.ts —
// only the compare is reused; NOT the fail-open guard around it).
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// req.body arrives as a Buffer (route-level express.raw). Under supertest the
// Buffer may be serialised to {"type":"Buffer","data":[...]} — rehydrate it
// exactly like the Stripe handler does.
export function rawBodyString(req: Request): string {
  const raw = req.body;
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) {
    const text = raw.toString('utf8');
    try {
      const intermediate = JSON.parse(text);
      if (intermediate && intermediate.type === 'Buffer' && Array.isArray(intermediate.data)) {
        return Buffer.from(intermediate.data).toString('utf8');
      }
    } catch {
      // plain (non-JSON) body — fall through with the utf8 text
    }
    return text;
  }
  return raw ? JSON.stringify(raw) : '';
}
