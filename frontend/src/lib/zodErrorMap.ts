/**
 * The one global Zod error map for the frontend. Imported by main.tsx and by lib/textLimits.ts.
 *
 * A string over its `.max()` shows `Too long (maximum 20,000 characters)` under the field instead of
 * Zod's `String must contain at most 20000 character(s)`. The field's label is already on screen, so
 * the message does not repeat it. A schema that passes its own message keeps it.
 */
import { z, ZodIssueCode } from 'zod';

export const textLengthErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === ZodIssueCode.too_big && issue.type === 'string' && !issue.exact) {
    return { message: `Too long (maximum ${Number(issue.maximum).toLocaleString('en-US')} characters)` }; // = tooLongMessage() in textLimits.ts
  }
  return { message: ctx.defaultError };
};

z.setErrorMap(textLengthErrorMap);
