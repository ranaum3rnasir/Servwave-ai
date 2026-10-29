import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  resolveOrAccreteLocation,
  buildLocationTaxWarning,
  LocationResolutionError,
} from '../lib/service-location';

// ─── Minimal tx mock surface (serviceLocation only) ──────

interface TxMock {
  serviceLocation: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
}

function makeTx(): TxMock {
  return {
    serviceLocation: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };
}

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const ORG_ID = '00000000-0000-0000-0000-000000000001';
const LOCATION_ID = 'b0000000-0000-0000-0000-000000000001';

const ADDRESS = {
  address_line1: '123 Main St',
  address_line2: null,
  city: 'Austin',
  state: 'TX',
  zip: '78701',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveOrAccreteLocation', () => {
  it('returns a service_location_id (with its state) that belongs to the customer (no create)', async () => {
    const tx = makeTx();
    tx.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_ID, state: 'TX' });

    const result = await resolveOrAccreteLocation(tx as any, {
      customerId: CUSTOMER_ID,
      orgId: ORG_ID,
      service_location_id: LOCATION_ID,
    });

    expect(result).toEqual({ id: LOCATION_ID, state: 'TX' });
    // The explicit-id branch selects state so the id-pick path can raise a tax-warning.
    expect(tx.serviceLocation.findFirst.mock.calls[0][0].select).toMatchObject({ id: true, state: true });
    // Validated against the customer; never created
    const where = tx.serviceLocation.findFirst.mock.calls[0][0].where;
    expect(where.id).toBe(LOCATION_ID);
    expect(where.customer_id).toBe(CUSTOMER_ID);
    expect(tx.serviceLocation.create).not.toHaveBeenCalled();
  });

  it('rejects a service_location_id not owned by the customer', async () => {
    const tx = makeTx();
    tx.serviceLocation.findFirst.mockResolvedValue(null);

    await expect(
      resolveOrAccreteLocation(tx as any, {
        customerId: CUSTOMER_ID,
        orgId: ORG_ID,
        service_location_id: 'b0000000-0000-0000-0000-0000000000ff',
      }),
    ).rejects.toBeInstanceOf(LocationResolutionError);

    expect(tx.serviceLocation.create).not.toHaveBeenCalled();
  });

  it('accretes a new ServiceLocation when only an address is given and none matches', async () => {
    const tx = makeTx();
    // No existing location matches the normalized line1+zip
    tx.serviceLocation.findFirst.mockResolvedValue(null);
    tx.serviceLocation.create.mockResolvedValue({ id: 'new-loc-id' });

    const result = await resolveOrAccreteLocation(tx as any, {
      customerId: CUSTOMER_ID,
      orgId: ORG_ID,
      address: ADDRESS,
    });

    expect(result).toEqual({ id: 'new-loc-id', state: 'TX' });
    const createData = tx.serviceLocation.create.mock.calls[0][0].data;
    expect(createData.customer_id).toBe(CUSTOMER_ID);
    expect(createData.address_line1).toBe('123 Main St');
    expect(createData.zip).toBe('78701');
    expect(createData.is_primary).toBe(false);
  });

  it('reuses an existing location matching the normalized line1+zip (dedupe, no create)', async () => {
    const tx = makeTx();
    tx.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_ID });

    const result = await resolveOrAccreteLocation(tx as any, {
      customerId: CUSTOMER_ID,
      orgId: ORG_ID,
      // Same address with different casing / whitespace must still dedupe.
      address: { ...ADDRESS, address_line1: '  123 MAIN st ', zip: '78701-0000' },
    });

    // Deduped to the existing row; state falls back to the incoming address when
    // the (id-only) mock didn't return one.
    expect(result).toEqual({ id: LOCATION_ID, state: 'TX' });
    expect(tx.serviceLocation.create).not.toHaveBeenCalled();
  });

  it('throws when neither service_location_id nor address resolve', async () => {
    const tx = makeTx();

    await expect(
      resolveOrAccreteLocation(tx as any, {
        customerId: CUSTOMER_ID,
        orgId: ORG_ID,
      }),
    ).rejects.toBeInstanceOf(LocationResolutionError);
  });
});

describe('buildLocationTaxWarning', () => {
  it('returns null when states match (case-insensitive)', () => {
    expect(buildLocationTaxWarning('TX', 'tx')).toBeNull();
  });

  it('returns null when either state is missing', () => {
    expect(buildLocationTaxWarning(null, 'TX')).toBeNull();
    expect(buildLocationTaxWarning('TX', null)).toBeNull();
    expect(buildLocationTaxWarning(undefined, undefined)).toBeNull();
  });

  it('returns a warning object when states differ', () => {
    expect(buildLocationTaxWarning('TX', 'CA')).toEqual({
      tax_warning: true,
      old_state: 'TX',
      new_state: 'CA',
    });
  });

  it('upper-cases the displayed states so stored lower-case codes do not leak', () => {
    expect(buildLocationTaxWarning('ny', 'FL')).toEqual({
      tax_warning: true,
      old_state: 'NY',
      new_state: 'FL',
    });
  });

  it('upper-cases both sides when both are lower/mixed case', () => {
    expect(buildLocationTaxWarning('tx', 'Ca')).toEqual({
      tax_warning: true,
      old_state: 'TX',
      new_state: 'CA',
    });
  });

  it('trims surrounding whitespace off the displayed states', () => {
    expect(buildLocationTaxWarning('  ny  ', ' fl ')).toEqual({
      tax_warning: true,
      old_state: 'NY',
      new_state: 'FL',
    });
  });

  it('passes through non-two-letter values without validating them', () => {
    expect(buildLocationTaxWarning('new york', 'florida')).toEqual({
      tax_warning: true,
      old_state: 'NEW YORK',
      new_state: 'FLORIDA',
    });
  });
});
