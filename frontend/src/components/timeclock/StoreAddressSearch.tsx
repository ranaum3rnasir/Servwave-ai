import { useCallback, useEffect, useRef, useState } from 'react';
import { MapPin } from 'lucide-react';
import { Input } from '@/components/ui/input';

export type StoreAddressValue = { address: string; lat: number; lng: number };

// ─── Config ─────────────────────────────────────────
const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

type Suggestion = { id: string; main: string; secondary?: string; pick: () => void | Promise<void> };

// ─── Google Places (real mode) ──────────────────────
interface PlacePrediction {
  placePrediction: {
    placeId: string;
    text: { text: string };
    structuredFormat?: { mainText: { text: string }; secondaryText?: { text: string } };
  };
}

// ─── Component ──────────────────────────────────────

export function StoreAddressSearch({
  value,
  onChange,
  id,
}: {
  value: StoreAddressValue;
  onChange: (next: StoreAddressValue) => void;
  id?: string;
}) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const commit = useCallback(
    (next: StoreAddressValue) => {
      onChange(next);
      setShowDropdown(false);
      setSuggestions([]);
      setActiveIndex(-1);
    },
    [onChange],
  );

  // Fetch real Google Places predictions, mapped to common Suggestion shape.
  const fetchRealSuggestions = useCallback(
    async (text: string) => {
      if (!API_KEY || text.trim().length < MIN_CHARS) {
        setSuggestions([]);
        return;
      }
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = new AbortController();
      try {
        const res = await fetch(AUTOCOMPLETE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': API_KEY },
          body: JSON.stringify({ input: text, includedRegionCodes: ['us'], languageCode: 'en' }),
          signal: abortRef.current.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        const preds: PlacePrediction[] = data.suggestions ?? [];
        setSuggestions(
          preds.map((p, i) => {
            const sf = p.placePrediction.structuredFormat;
            return {
              id: p.placePrediction.placeId || `p${i}`,
              main: sf?.mainText.text ?? p.placePrediction.text.text,
              secondary: sf?.secondaryText?.text,
              pick: () => selectRealPlace(p),
            };
          }),
        );
        setActiveIndex(-1);
        setShowDropdown(true);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // Silent — user can still type freely.
      }
    },
    // selectRealPlace is stable enough for this mock-first usage; intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Fetch coordinates for a chosen Google place, with a graceful derive() fallback.
  const selectRealPlace = useCallback(
    async (p: PlacePrediction) => {
      const display = p.placePrediction.text.text;
      onChange({ ...value, address: display }); // reflect immediately
      setShowDropdown(false);
      setSuggestions([]);
      if (!API_KEY) return;
      setLoading(true);
      try {
        const res = await fetch(`${PLACE_DETAILS_URL}/${p.placePrediction.placeId}?languageCode=en`, {
          headers: { 'X-Goog-Api-Key': API_KEY, 'X-Goog-FieldMask': 'location,formattedAddress' },
        });
        if (res.ok) {
          const data = await res.json();
          const lat = data.location?.latitude;
          const lng = data.location?.longitude;
          const address = data.formattedAddress ?? display;
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            commit({ address, lat, lng });
            return;
          }
        }
        commit({ ...value, address: display }); // keep prior coords if details lacked them
      } catch {
        commit({ ...value, address: display });
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value, onChange, commit],
  );

  const handleInputChange = (text: string) => {
    if (API_KEY) {
      // Real mode: keep ONLY the typed text. Precise coordinates come exclusively from selecting a
      // Places suggestion (selectRealPlace) — never fabricate coords for a real address.
      onChange({ ...value, address: text });
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => fetchRealSuggestions(text), DEBOUNCE_MS);
    } else {
      // Keyless mode (no Maps API key — see issue #26): capture the address as free text with NO
      // fabricated suggestions or coordinates. Coordinates are entered via the "Advanced — set
      // coordinates manually" fields in StoreLocationPicker.
      onChange({ ...value, address: text });
      setSuggestions([]);
      setShowDropdown(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || suggestions.length === 0) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((p) => (p < suggestions.length - 1 ? p + 1 : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((p) => (p > 0 ? p - 1 : suggestions.length - 1));
        break;
      case 'Enter': {
        e.preventDefault();
        const s = suggestions[activeIndex];
        if (activeIndex >= 0 && s) s.pick();
        break;
      }
      case 'Escape':
        setShowDropdown(false);
        setActiveIndex(-1);
        break;
    }
  };

  // Close on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setShowDropdown(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Cleanup timers / in-flight request.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    },
    [],
  );

  const listboxId = `${id ?? 'store-address'}-listbox`;
  const open = showDropdown && suggestions.length > 0;

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
        <Input
          id={id}
          value={value.address}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => suggestions.length > 0 && setShowDropdown(true)}
          placeholder="Start typing a store address…"
          autoComplete="off"
          // Don't `disabled` during the real-mode details fetch — disabling a focused input blurs it.
          aria-busy={loading}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-opt-${activeIndex}` : undefined}
          className="w-full py-2 pl-9 pr-3"
        />
      </div>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border border-border bg-surface-light shadow-lg"
        >
          {suggestions.map((s, i) => (
            // Listbox option row (role="option") - not Button-shaped. Deferred.
            <button
              key={s.id}
              id={`${listboxId}-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              type="button"
              className={`flex w-full items-start gap-2 px-3 py-2.5 text-left text-sm hover:bg-background-light ${
                i === activeIndex ? 'bg-background-light' : ''
              }`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => s.pick()}
            >
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" />
              <span className="min-w-0">
                <span className="font-medium text-text-primary">{s.main}</span>
                {s.secondary && <span className="ml-1 text-text-secondary">{s.secondary}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default StoreAddressSearch;
