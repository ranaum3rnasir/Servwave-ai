import type { Request } from 'express';

/**
 * Resolve the real client IP behind Cloudflare → Render.
 *
 * Order: Cloudflare's authoritative `CF-Connecting-IP` (set by the edge, cannot
 * be spoofed by the client) → Express `req.ip` (already applies `trust proxy: 1`
 * to X-Forwarded-For) → the first XFF hop → the raw socket address.
 */
export function getClientIp(req: Request): string | null {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();

  if (req.ip) return req.ip;

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();

  return req.socket?.remoteAddress ?? null;
}
