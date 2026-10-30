import { describe, it, expect } from 'vitest';
import {
  addressesIn, awaitsCustomer, isUnverifiedSenderLink, senderAddressOfRow, soleCustomerOf, type AddressCustomers,
} from '../customerByAddress';

describe('addressesIn', () => {
  it('reads bare addresses out of names, brackets, commas and semicolons, lower-cased and once each', () => {
    expect(addressesIn('"Doe, Jane" <Jane.Doe@Example.com>, bob@x.org; BOB@x.org')).toEqual(['jane.doe@example.com', 'bob@x.org']);
  });
  it('keeps an apostrophe in the local part, which is a valid address character', () => {
    expect(addressesIn("Pat <o'brien@example.com>")).toEqual(["o'brien@example.com"]);
    expect(addressesIn("o'brien@example.com, x@y.com")).toEqual(["o'brien@example.com", 'x@y.com']);
    expect(senderAddressOfRow({ from: { email: "O'Brien@Example.com" } })).toBe("o'brien@example.com");
  });
  it('drops the quotes that wrap an address or a display name', () => {
    expect(addressesIn("'Pat' <pat@example.com>")).toEqual(['pat@example.com']);
    expect(addressesIn("'pat@example.com', \"d'angelo@example.com\"")).toEqual(['pat@example.com', "d'angelo@example.com"]);
  });
  it('gives nothing for an empty value or one with no address', () => {
    expect(addressesIn('')).toEqual([]);
    expect(addressesIn(null)).toEqual([]);
    expect(addressesIn('Jane Doe')).toEqual([]);
  });
});

describe('soleCustomerOf', () => {
  const one = (id: string): AddressCustomers => ({ count: 1, customerId: id });
  it('names the customer when every matched address names the same one', () => {
    expect(soleCustomerOf(new Map([['a@x.com', one('c1')], ['b@x.com', one('c1')]]))).toBe('c1');
  });
  it('names none when there are no matches, when an address is shared, or when the addresses are different customers', () => {
    expect(soleCustomerOf(new Map())).toBeNull();
    expect(soleCustomerOf(new Map([['a@x.com', one('c1')], ['b@x.com', { count: 2, customerId: null }]]))).toBeNull();
    expect(soleCustomerOf(new Map([['a@x.com', one('c1')], ['b@x.com', one('c2')]]))).toBeNull();
  });
});

describe('isUnverifiedSenderLink', () => {
  const linked = { direction: 'in', customer_id: 'c1', reply_token: null };
  it('is true for a linked received message on a mailbox address whose sender could not be checked', () => {
    expect(isUnverifiedSenderLink({ ...linked, inbound_auth: 'NO_POLICY' })).toBe(true);
    expect(isUnverifiedSenderLink({ ...linked, inbound_auth: 'UNAVAILABLE' })).toBe(true);
  });
  it('is false for a verified sender, a failed one, an unlinked message, a sent message and a reply on a reply address', () => {
    expect(isUnverifiedSenderLink({ ...linked, inbound_auth: 'PASS' })).toBe(false);
    expect(isUnverifiedSenderLink({ ...linked, inbound_auth: 'FAIL' })).toBe(false);
    expect(isUnverifiedSenderLink({ ...linked, customer_id: null, inbound_auth: 'NO_POLICY' })).toBe(false);
    expect(isUnverifiedSenderLink({ ...linked, direction: 'out', inbound_auth: null })).toBe(false);
    expect(isUnverifiedSenderLink({ ...linked, reply_token: 'tok', inbound_auth: 'NO_POLICY' })).toBe(false);
  });
});

describe('what a message is waiting for', () => {
  const waiting = { id: 'e1', direction: 'in', customer_id: null, reply_token: null, review_reason: null, job_id: null, lead_id: null, vendor_id: null };
  it('waits for a customer when it was received on a mailbox address and is tied to nothing', () => {
    expect(awaitsCustomer(waiting)).toBe(true);
  });
  it.each([
    ['linked to a customer', { customer_id: 'c1' }],
    ['attached to a job', { job_id: 'j1' }],
    ['attached to a lead', { lead_id: 'l1' }],
    ['tied to a vendor', { vendor_id: 'v1' }],
    ['held for review', { review_reason: 'automatic' }],
    ['a reply on a reply address', { reply_token: 'tok' }],
    ['sent', { direction: 'out' }],
  ])('does not wait when it is %s', (_what, change) => {
    expect(awaitsCustomer({ ...waiting, ...change })).toBe(false);
  });
  it('reads the sender out of the stored From', () => {
    expect(senderAddressOfRow({ from: { name: 'Pat', email: 'Pat@Example.com' } })).toBe('pat@example.com');
    expect(senderAddressOfRow({ from: null })).toBeNull();
    expect(senderAddressOfRow({ from: { name: 'Pat' } })).toBeNull();
  });
});
