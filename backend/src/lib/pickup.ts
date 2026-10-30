/**
 * The pieces a pickup mark shares wherever it is recorded (Roles & Permissions, PRD 7: a staged item in S07.6 and S07.7,
 * a Processed logistic order in S07.11): who the record names, and how the history says it.
 */
import type { Request } from 'express';

export type PickupPerson = { id: string; name: string };

export const personName = (u: { first_name: string | null; last_name: string | null }): string =>
  `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || 'Unknown';

/** The caller, as the record names the person who recorded a pickup. */
export const callerOf = (req: Request): PickupPerson => ({ id: req.user!.id, name: personName(req.user!) });

/** "Taken by Tom", plus ", recorded by Lee" when someone else recorded it. */
export const pickupComment = (takenBy: PickupPerson, recordedBy: PickupPerson): string =>
  takenBy.id === recordedBy.id
    ? `Taken by ${takenBy.name}`
    : `Taken by ${takenBy.name}, recorded by ${recordedBy.name}`;
