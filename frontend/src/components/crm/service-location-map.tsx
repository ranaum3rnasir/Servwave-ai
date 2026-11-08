import { useState } from 'react';
import { cn } from '@/lib/utils';

// Module scope (mirrors address-autocomplete.tsx:44) so tests can
// vi.resetModules() + vi.stubEnv() before a dynamic import.
const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
const STATIC_MAP_URL = 'https://maps.googleapis.com/maps/api/staticmap';

interface ServiceLocationMapProps {
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  className?: string;
}

// Static-image map for a service location (Static Maps API — an <img>, not the interactive
// Embed API's <iframe>). A cross-origin iframe can't be inspected by JS, so a disabled or
// misconfigured API silently rendered Google's raw HTML error page verbatim (#865). An <img>
// fails to decode on a non-2xx/non-image response, so onError lets us hide the map instead of
// ever surfacing that response to the user. Deliberately no line2/unit prop — units confuse
// geocoding.
export function ServiceLocationMap({ addressLine1, city, state, zip, className }: ServiceLocationMapProps) {
  const [failed, setFailed] = useState(false);

  if (!API_KEY || !addressLine1 || !city || !state || failed) return null;

  const query = encodeURIComponent([addressLine1, city, state, zip].filter(Boolean).join(', '));
  const src = `${STATIC_MAP_URL}?center=${query}&markers=${query}&zoom=15&size=640x240&scale=2&key=${API_KEY}`;

  return (
    <div className={cn('overflow-hidden rounded-card border border-border', className)}>
      <img
        src={src}
        alt="Service location map"
        className="h-40 w-full object-cover"
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        onError={() => setFailed(true)}
      />
    </div>
  );
}
