export type PunchType = 'IN' | 'OUT';
export type ReviewState = 'none' | 'pending' | 'approved' | 'rejected';

/** One clock-in or clock-out. `lat` / `lng` is where it happened. */
export type Punch = {
  id: string;
  userId: string;
  userName: string;
  type: PunchType;
  ts: number; // epoch ms
  lat: number;
  lng: number;
  accuracyM: number | null;
};
