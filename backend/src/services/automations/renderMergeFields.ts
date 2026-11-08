/**
 * renderMergeFields - pure {{merge.field}} interpolation for automation copy.
 *
 * Rules (pinned by tests):
 * - Known field -> its value. Values are user-controlled data (names, addresses), so html
 *   mode escapes every substitution via esc().
 * - Known field whose value is EMPTY -> the step's fallback for that field when one is
 *   declared ("If empty, fill with"), else ''. A fallback is author-controlled text and is
 *   escaped in html mode exactly as a value is.
 * - Unknown field -> left literal, so a typo'd {{customer.frist_name}} is visible in previews
 *   and sent messages instead of silently vanishing. A fallback declared for an unknown field
 *   never substitutes: the token is the visible defect, not the fallback.
 */

import { esc } from '../../lib/email';

const FIELD_RE = /\{\{([a-z_.]+)\}\}/g;

export interface RenderOptions {
  html: boolean;
  /** Per-field "If empty, fill with" text, keyed by merge field. */
  fallbacks?: Record<string, string>;
}

export function renderMergeFields(
  text: string,
  ctx: Record<string, string | undefined>,
  opts: RenderOptions,
): string {
  const fallbacks = opts.fallbacks ?? {};
  return text.replace(FIELD_RE, (raw, field: string) => {
    // hasOwnProperty (not `in`) so inherited prototype keys like {{constructor}}
    // and {{__proto__}} stay literal instead of resolving to functions/objects.
    if (!Object.prototype.hasOwnProperty.call(ctx, field)) return raw;
    const value = ctx[field] ?? '';
    const resolved =
      value !== '' || !Object.prototype.hasOwnProperty.call(fallbacks, field) ? value : (fallbacks[field] ?? '');
    return opts.html ? esc(resolved) : resolved;
  });
}
