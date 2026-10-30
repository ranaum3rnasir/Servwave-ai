/** What a pickup mark needs to read as a sentence: the one display both a stage and a logistic order share. */
export interface PickupMark {
  takenAt?: string | null;
  takenById?: string | null;
  takenByName?: string | null;
  recordedById?: string | null;
  recordedByName?: string | null;
}

/** "Taken by Tom" and the time, plus ", recorded by Lee" when someone else recorded it. */
export function pickupLabel(mark: PickupMark): string {
  const when = mark.takenAt
    ? new Date(mark.takenAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  const recordedByOther = !!mark.recordedByName && mark.recordedById !== mark.takenById;
  return `Taken by ${mark.takenByName ?? 'a colleague'}${recordedByOther ? `, recorded by ${mark.recordedByName}` : ''}${when ? ` · ${when}` : ''}`;
}
