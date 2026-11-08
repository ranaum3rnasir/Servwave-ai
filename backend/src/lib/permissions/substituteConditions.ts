export interface SubstitutionContext {
  userId: string;
  teamId?: string | null;
  locationId?: string | null;
}

export function substituteConditions(
  conditions: Record<string, unknown> | null | undefined,
  ctx: SubstitutionContext,
): Record<string, unknown> | undefined {
  if (conditions == null) return undefined;
  return walk(conditions, ctx) as Record<string, unknown>;
}

function walk(value: unknown, ctx: SubstitutionContext): unknown {
  if (typeof value === 'string') {
    if (value === '{{userId}}') return ctx.userId;
    if (value === '{{teamId}}') return ctx.teamId ?? null;
    if (value === '{{locationId}}') return ctx.locationId ?? null;
    if (/\{\{[^}]+\}\}/.test(value)) throw new Error(`Unknown token in condition: ${value}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, ctx);
    }
    return out;
  }
  return value;
}
