import { describe, it, expect, vi } from 'vitest';
import type { Request } from 'express';

// Any database read at all fails: while the Email plan feature is off, the readers answer from the request alone.
vi.mock('../../prisma', () => ({
  prisma: new Proxy({}, { get: () => { throw new Error('the database was read while the Email plan feature is off'); } }),
}));

import {
  NO_EMAIL, emailsInSectionWhereForReq, emailReadWhereForReq, emailThreadReadWhereForReq, emailSectionForReq,
} from '../communicationScope';
import { mailboxListForReq } from '../mailboxList';
import { emailFeatureOn } from '../emailFeature';

/**
 * PRD 10, S10.6. ONE gate for every reader of received mail: while the company's Email plan feature is off, each reader of the
 * Email page's filters answers "no row" without a single read, whoever asks and whatever their scope. (The record tabs'
 * and the inbound writer's halves, and every route, are proven in permission-email-plan-feature-off-db.test.ts.)
 */

const reqWith = (features: string[]) =>
  ({ user: { id: 'u-1', organization_id: 'org-1', org_features: features } }) as unknown as Request;
const OFF = reqWith(['customers', 'jobs', 'phone']);

describe('the Email plan feature, asked of the request', () => {
  it('is on only when the person\'s company has it, and fails closed with nobody signed in', () => {
    expect(emailFeatureOn(reqWith(['email']))).toBe(true);
    expect(emailFeatureOn(OFF)).toBe(false);
    expect(emailFeatureOn({} as Request)).toBe(false);
  });
});

describe('the Email page readers with the feature off', () => {
  it('lists nothing, for the whole section and for any mailbox picked', async () => {
    expect(await emailsInSectionWhereForReq(OFF)).toEqual(NO_EMAIL);
    expect(await emailsInSectionWhereForReq(OFF, 'all')).toEqual(NO_EMAIL);
    expect(await emailsInSectionWhereForReq(OFF, 'mine')).toEqual(NO_EMAIL);
  });

  it('opens no message and no conversation, so a read, mark read or unread, reply or attachment link finds nothing', async () => {
    expect(await emailReadWhereForReq(OFF, { emailId: 'e-1' })).toEqual(NO_EMAIL);
    expect(await emailReadWhereForReq(OFF, { threadId: 't-1' })).toEqual(NO_EMAIL);
    expect(await emailThreadReadWhereForReq(OFF, 't-1')).toEqual({ emails: { some: NO_EMAIL } });
  });

  it('holds no section for the mailbox list to count', async () => {
    const section = await emailSectionForReq(OFF);
    expect(section.where).toEqual(NO_EMAIL);
    expect(section.mailboxes).toEqual({ held: [], main: null, own: null, handedOver: [] });
  });

  it('answers the mailbox list with nothing to show and zero counts', async () => {
    const list = await mailboxListForReq(OFF, { selected: 'all' });
    expect(list).toMatchObject({
      selected: 'mine', selected_label: null, selected_unread: 0, total_unread: 0,
      mine: { id: null, unread: 0 }, held: [], main: null, people: null,
    });
  });
});
