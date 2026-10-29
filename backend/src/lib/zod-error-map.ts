/**
 * The one global Zod error map. Registered at boot (imported first by app.ts).
 *
 * A string over its `.max()` would otherwise reach the user through `extractApiError` as
 * `service_request: String must contain at most 2000 character(s)`. This turns it into
 * `Service request is too long (maximum 20,000 characters)`. Every other issue keeps Zod's
 * default, and a schema that passes its own message keeps that message (Zod prefers it over any
 * error map).
 */
import { z, ZodIssueCode } from 'zod';

/** `service_request` -> `Service request`, `reviewComment` -> `Review comment`. */
export function fieldLabel(path: (string | number)[]): string {
  const key = [...path].reverse().find((p): p is string => typeof p === 'string');
  if (!key) return 'Text';
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const textLengthErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === ZodIssueCode.too_big && issue.type === 'string' && !issue.exact) {
    return { message: `${fieldLabel(issue.path)} is too long (maximum ${Number(issue.maximum).toLocaleString('en-US')} characters)` };
  }
  return { message: ctx.defaultError };
};

z.setErrorMap(textLengthErrorMap);
