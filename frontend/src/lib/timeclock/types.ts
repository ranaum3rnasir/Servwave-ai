export type LatLng = { lat: number; lng: number };

export type Zone = {
  id: string;
  kind: 'store' | 'job';
  label: string;
  lat: number;
  lng: number;
  jobNumber?: string;
};

export type PunchType = 'IN' | 'OUT';
export type PunchStatus = 'in_zone' | 'override';
export type ReviewState = 'none' | 'pending' | 'approved' | 'rejected';

export type Punch = {
  id: string;
  userId: string;
  userName: string;
  type: PunchType;
  ts: number; // epoch ms
  lat: number;
  lng: number;
  matchedZoneId: string | null;
  matchedZoneLabel: string | null;
  matchedZoneKind: 'store' | 'job' | null;
  matchedJobNumber: string | null;
  distanceM: number;
  status: PunchStatus;
  review: ReviewState;
};

export type StoreLocation = {
  id: string;
  label: string;
  address: string;
  lat: number;
  lng: number;
};

export type GeofenceConfig = {
  stores: StoreLocation[];
  radiusM: number; // global clock-in radius, meters
};
