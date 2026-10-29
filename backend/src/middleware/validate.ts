import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/**
 * Structural ceilings checked on a request body BEFORE zod sees it (GHSA-mrhx-c7xc-m3w5).
 *
 * zod 3 records one issue per failing array element with no cap, and `.max()` does not stop it:
 * the too_big issue is added and every element is still parsed. So the work a failing parse does
 * grows with the size of the input, not the size of the schema, and the body cap alone allows
 * far more of it than any real request needs. Bounding the input's shape bounds the parse.
 * Interim until the zod 4 migration (#2889).
 *
 * Every limit sits well above the largest real payload:
 * - MAX_ARRAY_LENGTH: the largest `.max()` on a validated array is 5000 (Spider's selected leads);
 *   the rest are 2000 or less, most 5-200. The price-book CSV import is the one route that needs
 *   more and overrides it; the public selection routes override it downward.
 * - MAX_NODES: ten times the array ceiling. A large estimate or invoice (hundreds of lines with ~20
 *   fields each), a full check-all or a full Spider lead list is under 10,000 values.
 * - MAX_DEPTH: the deepest real bodies (call-flow menus, custom fields) nest under 10 levels.
 */
export const MAX_ARRAY_LENGTH = 10_000;
export const MAX_NODES = 100_000;
export const MAX_DEPTH = 32;

/** How many zod issues a 400 carries. The first few are what a person can act on. */
export const MAX_DETAILS = 20;

export interface StructureLimits {
  maxArrayLength: number;
  maxNodes: number;
  maxDepth: number;
}

const DEFAULT_LIMITS: StructureLimits = { maxArrayLength: MAX_ARRAY_LENGTH, maxNodes: MAX_NODES, maxDepth: MAX_DEPTH };

/** The defaults with `overrides` on top. An undefined override keeps the default, never disables it. */
export function structureLimits(overrides: Partial<StructureLimits> = {}): StructureLimits {
  const defined = Object.entries(overrides).filter(([, v]) => v !== undefined);
  return { ...DEFAULT_LIMITS, ...Object.fromEntries(defined) };
}

export type StructureViolation = 'array_length' | 'nodes' | 'depth';

/**
 * Walk `input` and report the first ceiling it breaks, or null. Iterative (an explicit stack, not
 * recursion) so a deeply nested body cannot overflow the call stack, and it stops at the first
 * breach, so the walk itself is bounded by the limits rather than by the body.
 */
export function checkStructure(input: unknown, overrides: Partial<StructureLimits> = {}): StructureViolation | null {
  if (input === null || typeof input !== 'object') return null;
  const limits = structureLimits(overrides);
  let nodes = 1;
  const stack: { value: object; depth: number }[] = [{ value: input, depth: 1 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > limits.maxDepth) return 'depth';
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayLength) return 'array_length';
      nodes += value.length;
      if (nodes > limits.maxNodes) return 'nodes';
      for (const child of value) {
        if (child !== null && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
    } else {
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (++nodes > limits.maxNodes) return 'nodes';
        const child = (value as Record<string, unknown>)[key];
        if (child !== null && typeof child === 'object') stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return null;
}

/** The standard 400 body for a failed validation - single owner of this shape. */
export function validationFailure(details: { field: string; message: string }[]) {
  return { error: 'Validation failed', details };
}

export function zodValidationFailure(err: ZodError) {
  // Map only the first MAX_DETAILS: a failing array can carry one issue per element.
  return validationFailure(err.issues.slice(0, MAX_DETAILS).map((e) => ({ field: e.path.join('.'), message: e.message })));
}

/** Generic on purpose: it names no field and echoes nothing from the body. */
export const TOO_COMPLEX_MESSAGE = 'This request has too many entries to process.';

/**
 * `limits` overrides the structural ceilings for one route. Raise them per route, never globally,
 * and only for a route whose real payloads need it.
 */
export function validate(schema: ZodSchema, limits: Partial<StructureLimits> = {}) {
  const ceilings = structureLimits(limits);
  return (req: Request, res: Response, next: NextFunction) => {
    if (checkStructure(req.body, ceilings)) {
      res.status(400).json(validationFailure([{ field: '', message: TOO_COMPLEX_MESSAGE }]));
      return;
    }
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json(zodValidationFailure(err));
        return;
      }
      next(err);
    }
  };
}
