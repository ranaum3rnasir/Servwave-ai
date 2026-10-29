/**
 * catalog-item-resolution.test.ts — the one place that decides which of a catalog
 * item's two image columns and two price columns a reader should use.
 *
 * A PriceBookItem carries two columns per concept, and they are two storage
 * STRATEGIES rather than duplicates:
 *   image  — `photo_url`  (@db.Text, megabyte-capped, holds inline data URIs)
 *            `image_url`  (@db.VarChar(500), URL-validated, short)
 *   price  — `sell_price` (nullable, the inventory/catalog vocabulary)
 *            `unit_price` (NOT NULL, the legacy column estimates/invoices read)
 *
 * This module only ever decides WHICH to read. It never copies one into the other.
 *
 * It also resolves `unit_cost`, which has only ONE column: cost is here not because it is
 * ambiguous but so that every reader of an item's money goes through one place and gets the
 * same present/absent answer, rather than `Number()`-ing a raw column into a confident 0.
 *
 * The matrix below is the contract every consumer (the inventory item mapper, the
 * price-book picker's endpoints) inherits: canonical only, legacy only, both equal,
 * both diverging, neither.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveItemImage,
  resolveItemSellPrice,
  resolveItemCost,
  resolvedCatalogItemFields,
  valueOrNull,
} from '../catalog/item-resolution';

describe('resolveItemImage', () => {
  it('reads the canonical column when only it is set', () => {
    expect(resolveItemImage({ photo_url: 'data:image/png;base64,AAA', image_url: null })).toEqual({
      present: true,
      value: 'data:image/png;base64,AAA',
    });
  });

  it('falls back to the legacy column when only it is set', () => {
    expect(resolveItemImage({ photo_url: null, image_url: 'https://cdn.example.com/a.png' })).toEqual({
      present: true,
      value: 'https://cdn.example.com/a.png',
    });
  });

  it('returns the one answer when both columns are set and equal', () => {
    expect(resolveItemImage({ photo_url: 'https://cdn.example.com/a.png', image_url: 'https://cdn.example.com/a.png' })).toEqual({
      present: true,
      value: 'https://cdn.example.com/a.png',
    });
  });

  it('prefers the canonical column when the two diverge', () => {
    expect(resolveItemImage({ photo_url: 'data:image/png;base64,AAA', image_url: 'https://cdn.example.com/legacy.png' })).toEqual({
      present: true,
      value: 'data:image/png;base64,AAA',
    });
  });

  it('is absent when neither column is set', () => {
    expect(resolveItemImage({ photo_url: null, image_url: null })).toEqual({ present: false });
  });

  it('treats an empty string as absent, not as an image', () => {
    expect(resolveItemImage({ photo_url: '', image_url: '' })).toEqual({ present: false });
  });

  it('falls through an empty canonical column to a populated legacy one', () => {
    expect(resolveItemImage({ photo_url: '', image_url: 'https://cdn.example.com/a.png' })).toEqual({
      present: true,
      value: 'https://cdn.example.com/a.png',
    });
  });

  it('is absent for a row that carries neither column at all', () => {
    expect(resolveItemImage({})).toEqual({ present: false });
  });
});

describe('resolveItemSellPrice', () => {
  it('reads the canonical column when only it is set', () => {
    expect(resolveItemSellPrice({ sell_price: 500, unit_price: null })).toEqual({ present: true, value: 500 });
  });

  it('falls back to the legacy column when only it is set', () => {
    expect(resolveItemSellPrice({ sell_price: null, unit_price: 500 })).toEqual({ present: true, value: 500 });
  });

  it('returns the one answer when both columns are set and equal', () => {
    expect(resolveItemSellPrice({ sell_price: 500, unit_price: 500 })).toEqual({ present: true, value: 500 });
  });

  it('prefers the canonical column when the two diverge', () => {
    expect(resolveItemSellPrice({ sell_price: 500, unit_price: 125 })).toEqual({ present: true, value: 500 });
  });

  it('is absent when neither column is set', () => {
    expect(resolveItemSellPrice({ sell_price: null, unit_price: null })).toEqual({ present: false });
  });

  it('treats an empty string as absent, not as a zero price', () => {
    expect(resolveItemSellPrice({ sell_price: '', unit_price: '' })).toEqual({ present: false });
  });

  it('keeps a genuine zero as a PRICE, distinct from absent', () => {
    const resolved = resolveItemSellPrice({ sell_price: 0, unit_price: 125 });
    expect(resolved).toEqual({ present: true, value: 0 });
    expect(resolved.present).toBe(true);
  });

  it('unwraps a Prisma Decimal through its toNumber()', () => {
    const decimal = { toNumber: () => 42.5 };
    expect(resolveItemSellPrice({ sell_price: decimal, unit_price: null })).toEqual({ present: true, value: 42.5 });
  });

  it('is absent for a row that carries neither column at all', () => {
    expect(resolveItemSellPrice({})).toEqual({ present: false });
  });
});

describe('resolvedCatalogItemFields', () => {
  // BOTH assertions below are EXHAUSTIVE `toEqual` on purpose. Do not relax either of them
  // to `toMatchObject` to make a new field fit.
  //
  // This projection is spread onto the picker's payload, and `price-book.controller`'s
  // `stripItemCost` withholds cost data from a reader without `read Invoice` by deleting
  // named keys. A field added here that the strip has never heard of is handed to that
  // reader anyway — under a camelCase name the strip does not check. That exact bypass was
  // demonstrated live while `unitCost` was being added: resolving AFTER the strip leaked
  // the cost past it. An exhaustive assertion is what makes a new key on this projection
  // impossible to add silently, so adding one MUST mean coming here, failing, and deciding
  // deliberately whether the strip needs to learn about it too.
  it('projects every resolution onto the wire, absent as null', () => {
    expect(
      resolvedCatalogItemFields({
        photo_url: null,
        image_url: null,
        sell_price: null,
        unit_price: null,
        unit_cost: null,
      }),
    ).toEqual({ photoUrl: null, sellPrice: null, unitCost: null });
  });

  it('projects a genuine zero price as 0, which is NOT the absent null', () => {
    // No `unit_cost` key at all here — that is why `unitCost` is null, and it is a
    // different absence from `sell_price: 0`. The legacy `unit_price: 125` is present to
    // prove the price side prefers the canonical column even when the canonical value is
    // zero; it says nothing about cost. Exhaustive for the reason given above.
    const fields = resolvedCatalogItemFields({
      photo_url: 'data:image/png;base64,AAA',
      image_url: null,
      sell_price: 0,
      unit_price: 125,
    });
    expect(fields).toEqual({ photoUrl: 'data:image/png;base64,AAA', sellPrice: 0, unitCost: null });
    expect(fields.sellPrice).not.toBeNull();
  });
});

describe('resolveItemCost', () => {
  // Cost has ONE column, so there is no precedence to test — what there is to test is the
  // present/absent boundary, because `Number('')` and `Number(null)` are both 0 and a 0 cost
  // against a real price is a 100% margin where an uncosted line owes an em dash.
  it('answers with the cost when the column is set', () => {
    expect(resolveItemCost({ unit_cost: 200 })).toEqual({ present: true, value: 200 });
  });

  it('keeps a genuine zero as a COST, distinct from absent', () => {
    const resolved = resolveItemCost({ unit_cost: 0 });
    expect(resolved).toEqual({ present: true, value: 0 });
    expect(resolved.present).toBe(true);
  });

  it('is absent for a null column', () => {
    expect(resolveItemCost({ unit_cost: null })).toEqual({ present: false });
  });

  it('treats an empty string as absent, not as a zero cost', () => {
    expect(resolveItemCost({ unit_cost: '' })).toEqual({ present: false });
  });

  it('is absent for a row that carries no cost column at all', () => {
    expect(resolveItemCost({})).toEqual({ present: false });
  });

  it('unwraps a Prisma Decimal through its toNumber()', () => {
    expect(resolveItemCost({ unit_cost: { toNumber: () => 12.25 } })).toEqual({ present: true, value: 12.25 });
  });
});

describe('the absent arm carries no value at all', () => {
  // The shape itself is the guard. An earlier version gave the absent arm `value: null`,
  // which made `.value` readable on both arms — and `if (resolved.value)` then compiles
  // and silently reads a genuine 0 as absent, the one defect this module exists to stop.
  // With `{ present: false }` that read is a type error. These assertions pin the runtime
  // half of the same contract, so a well-meaning "let's add value: null back" fails here.

  it('an absent image has no `value` key to read by accident', () => {
    const resolved = resolveItemImage({ photo_url: null, image_url: null });
    expect(resolved.present).toBe(false);
    expect('value' in resolved).toBe(false);
  });

  it('an absent price has no `value` key to read by accident', () => {
    const resolved = resolveItemSellPrice({ sell_price: null, unit_price: null });
    expect(resolved.present).toBe(false);
    expect('value' in resolved).toBe(false);
  });
});

describe('valueOrNull', () => {
  it('unwraps a present value', () => {
    expect(valueOrNull(resolveItemSellPrice({ sell_price: 500 }))).toBe(500);
  });

  it('gives null for an absent one', () => {
    expect(valueOrNull(resolveItemSellPrice({}))).toBeNull();
  });

  it('gives 0 — not null — for a genuine zero, so `?? fallback` leaves it alone', () => {
    const price = valueOrNull(resolveItemSellPrice({ sell_price: 0, unit_price: 125 }));
    expect(price).toBe(0);
    expect(price).not.toBeNull();
    expect(price ?? 999).toBe(0);
  });
});
