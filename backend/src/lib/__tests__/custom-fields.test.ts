import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mergeCustomFields, validateCustomFieldValues, CustomFieldValidationError } from '../custom-fields';
import { prisma } from '../prisma';

const mockPrisma = prisma as unknown as {
  customFieldDefinition: { findMany: ReturnType<typeof vi.fn> };
};

const ORG_ID = '00000000-0000-0000-0000-000000000001';
const DEF_TEXT = 'aaaaaaaa-0000-0000-0000-000000000001';
const DEF_ARCHIVED = 'aaaaaaaa-0000-0000-0000-000000000002';
const DEF_OTHER_ENTITY = 'aaaaaaaa-0000-0000-0000-000000000003';
const DEF_NUMBER = 'aaaaaaaa-0000-0000-0000-000000000004';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('mergeCustomFields', () => {
  it('shallow-merges the patch onto an existing bag, leaving untouched keys alone', () => {
    const existing = { [DEF_TEXT]: 'old value', 'other-key': 'kept' };
    const merged = mergeCustomFields(existing, { [DEF_TEXT]: 'new value' });
    expect(merged).toEqual({ [DEF_TEXT]: 'new value', 'other-key': 'kept' });
  });

  it('treats a missing/undefined existing bag as empty', () => {
    expect(mergeCustomFields(undefined, { [DEF_TEXT]: 'value' })).toEqual({ [DEF_TEXT]: 'value' });
    expect(mergeCustomFields(null, { [DEF_TEXT]: 'value' })).toEqual({ [DEF_TEXT]: 'value' });
  });

  it('deletes the key when the patch sends an explicit null', () => {
    const existing = { [DEF_TEXT]: 'value' };
    const merged = mergeCustomFields(existing, { [DEF_TEXT]: null });
    expect(merged).toEqual({});
  });

  it('does not mutate the existing bag it was given', () => {
    const existing = { [DEF_TEXT]: 'value' };
    mergeCustomFields(existing, { [DEF_TEXT]: 'changed' });
    expect(existing).toEqual({ [DEF_TEXT]: 'value' });
  });
});

describe('validateCustomFieldValues', () => {
  it('resolves without querying Prisma for an empty patch', async () => {
    await expect(validateCustomFieldValues(ORG_ID, 'JOB', {})).resolves.toBeUndefined();
    expect(mockPrisma.customFieldDefinition.findMany).not.toHaveBeenCalled();
  });

  it('accepts a string value against an active TEXT definition scoped to the entity type', async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_TEXT, entity_types: ['JOB'], type: 'TEXT', archived_at: null },
    ]);
    await expect(
      validateCustomFieldValues(ORG_ID, 'JOB', { [DEF_TEXT]: 'PO-1234' }),
    ).resolves.toBeUndefined();
  });

  it('scopes the lookup to the caller org and the keys in the patch', async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_TEXT, entity_types: ['JOB'], type: 'TEXT', archived_at: null },
    ]);
    await validateCustomFieldValues(ORG_ID, 'JOB', { [DEF_TEXT]: 'value' });
    const callArgs = mockPrisma.customFieldDefinition.findMany.mock.calls[0][0];
    expect(callArgs.where.organization_id).toBe(ORG_ID);
    expect(callArgs.where.id).toEqual({ in: [DEF_TEXT] });
  });

  it('rejects a key with no matching definition (including one belonging to another org)', async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([]);
    await expect(
      validateCustomFieldValues(ORG_ID, 'JOB', { [DEF_TEXT]: 'value' }),
    ).rejects.toBeInstanceOf(CustomFieldValidationError);
  });

  it('rejects a definition that does not apply to the given entity type', async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_OTHER_ENTITY, entity_types: ['LEAD'], type: 'TEXT', archived_at: null },
    ]);
    await expect(
      validateCustomFieldValues(ORG_ID, 'JOB', { [DEF_OTHER_ENTITY]: 'value' }),
    ).rejects.toBeInstanceOf(CustomFieldValidationError);
  });

  it('rejects a non-null value against an archived definition', async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_ARCHIVED, entity_types: ['JOB'], type: 'TEXT', archived_at: new Date('2026-01-01') },
    ]);
    await expect(
      validateCustomFieldValues(ORG_ID, 'JOB', { [DEF_ARCHIVED]: 'value' }),
    ).rejects.toBeInstanceOf(CustomFieldValidationError);
  });

  it('allows an explicit null against an archived definition (clearing a stale value)', async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_ARCHIVED, entity_types: ['JOB'], type: 'TEXT', archived_at: new Date('2026-01-01') },
    ]);
    await expect(
      validateCustomFieldValues(ORG_ID, 'JOB', { [DEF_ARCHIVED]: null }),
    ).resolves.toBeUndefined();
  });

  it('rejects a definition whose type is not TEXT (not exercised end to end this slice)', async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_NUMBER, entity_types: ['JOB'], type: 'NUMBER', archived_at: null },
    ]);
    await expect(
      validateCustomFieldValues(ORG_ID, 'JOB', { [DEF_NUMBER]: 42 }),
    ).rejects.toBeInstanceOf(CustomFieldValidationError);
  });

  it('rejects a non-string value against a TEXT definition', async () => {
    mockPrisma.customFieldDefinition.findMany.mockResolvedValue([
      { id: DEF_TEXT, entity_types: ['JOB'], type: 'TEXT', archived_at: null },
    ]);
    await expect(
      validateCustomFieldValues(ORG_ID, 'JOB', { [DEF_TEXT]: 42 }),
    ).rejects.toBeInstanceOf(CustomFieldValidationError);
  });
});
