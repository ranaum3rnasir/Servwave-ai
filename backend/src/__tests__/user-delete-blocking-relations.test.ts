import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  DELETE_BLOCKING_RELATIONS,
  DELETE_RELATION_LABELS,
} from '../controllers/user.controller';

// permanentDelete feeds DELETE_BLOCKING_RELATIONS straight into a Prisma
// `_count: { select: ... }`. Prisma validates that selection CLIENT-SIDE, so a
// single key that is not a real User relation throws PrismaClientValidationError
// on the very first statement of the handler - before the self-delete guard,
// before the is_active check, before the history check. The outer catch turns it
// into a blanket 500, and permanent delete is dead for every user in every org,
// including users with no history at all.
//
// The rest of the user suite mocks `../lib/prisma`, so a fake `_count` happily
// accepts keys the real client rejects - which is exactly how the bad
// `walkthrough_leads_canceller` key shipped. This guard reads the real schema
// (setup.ts mocks `../lib/prisma`, never `@prisma/client`) so drift between the
// constant and the Prisma model fails here instead of in production.
describe('DELETE_BLOCKING_RELATIONS', () => {
  const userModel = Prisma.dmmf.datamodel.models.find((m) => m.name === 'User');

  // Only list relations are countable via `_count`; scalars and to-one
  // relations are rejected by the same validator.
  const countableRelations = new Set(
    (userModel?.fields ?? [])
      .filter((f) => f.kind === 'object' && f.isList)
      .map((f) => f.name),
  );

  it('resolves the User model from the Prisma schema', () => {
    expect(userModel).toBeDefined();
    expect(countableRelations.size).toBeGreaterThan(0);
  });

  it('names only countable relations that exist on the Prisma User model', () => {
    const unknown = Object.keys(DELETE_BLOCKING_RELATIONS).filter(
      (key) => !countableRelations.has(key),
    );
    expect(unknown).toEqual([]);
  });

  it('gives every blocking relation a human-readable label', () => {
    const unlabelled = Object.keys(DELETE_BLOCKING_RELATIONS).filter(
      (key) => !DELETE_RELATION_LABELS[key],
    );
    expect(unlabelled).toEqual([]);
  });

  it('does not label relations that are not actually blocking', () => {
    const orphanLabels = Object.keys(DELETE_RELATION_LABELS).filter(
      (key) => !(key in DELETE_BLOCKING_RELATIONS),
    );
    expect(orphanLabels).toEqual([]);
  });
});
