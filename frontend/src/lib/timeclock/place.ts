/** Where a clock-in or clock-out happened, as "latitude, longitude" to four places (about 10 m). */
export function formatPlace(lat: number | null, lng: number | null): string {
  if (lat === null || lng === null) return '-';
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}
