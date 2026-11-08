import { useState, useRef, useEffect, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────

export interface ParsedAddress {
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  zip: string;
}

interface PlacePrediction {
  placePrediction: {
    placeId: string;
    text: { text: string };
    structuredFormat?: {
      mainText: { text: string };
      secondaryText: { text: string };
    };
  };
}

interface AddressComponent {
  longText: string;
  shortText: string;
  types: string[];
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelect: (address: ParsedAddress) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}

// ─── Constants ──────────────────────────────────────

const API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places';
const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

// ─── Helpers ────────────────────────────────────────

function parseAddressComponents(
  components: AddressComponent[],
  fallbackLine1 = ''
): ParsedAddress {
  let streetNumber = '';
  let route = '';
  let subpremise = '';
  let premise = '';
  let city = '';
  let state = '';
  let zip = '';

  for (const c of components) {
    if (c.types.includes('street_number')) streetNumber = c.longText;
    else if (c.types.includes('route')) route = c.longText;
    else if (c.types.includes('subpremise')) subpremise = c.longText;
    else if (c.types.includes('premise')) premise = c.longText;
    else if (c.types.includes('locality')) city = c.longText;
    else if (c.types.includes('sublocality_level_1') && !city) city = c.longText;
    else if (c.types.includes('administrative_area_level_1')) state = c.shortText;
    else if (c.types.includes('postal_code')) zip = c.longText;
  }

  // Points of interest (airport terminals, malls, campuses) come back with no
  // street_number/route at all - fall back to the premise, then to the name the
  // user picked, so selecting a suggestion never empties the field.
  const street = [streetNumber, route].filter(Boolean).join(' ');
  const address_line1 = street || premise || fallbackLine1;
  const address_line2 = subpremise;
  return { address_line1, address_line2, city, state, zip };
}

// First segment of "JFK Terminal 5, Queens, NY 11430, USA" -> "JFK Terminal 5".
function firstAddressSegment(formatted: string): string {
  return formatted.split(',')[0]?.trim() ?? '';
}

// ─── Component ──────────────────────────────────────

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = 'Start typing an address...',
  className,
  disabled,
  id,
}: AddressAutocompleteProps) {
  const [suggestions, setSuggestions] = useState<PlacePrediction[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchSuggestions = useCallback(async (text: string) => {
    if (!API_KEY || text.length < MIN_CHARS) {
      setSuggestions([]);
      return;
    }

    // Cancel any in-flight request
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    try {
      const res = await fetch(AUTOCOMPLETE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': API_KEY,
        },
        body: JSON.stringify({
          input: text,
          includedRegionCodes: ['us'],
          languageCode: 'en',
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) return;

      const data = await res.json();
      setSuggestions(data.suggestions || []);
      setActiveIndex(-1);
      setShowDropdown(true);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      // Silently fail — user can still type manually
    }
  }, []);

  // Debounced input handler
  const handleChange = (text: string) => {
    onChange(text);
    if (!API_KEY) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => fetchSuggestions(text), DEBOUNCE_MS);
  };

  // Fetch place details and emit parsed address
  const handleSelect = async (prediction: PlacePrediction) => {
    const placeId = prediction.placePrediction.placeId;
    const displayText = prediction.placePrediction.text.text;

    // Immediately update the input and close dropdown
    onChange(displayText);
    setShowDropdown(false);
    setSuggestions([]);

    if (!API_KEY) return;

    setLoading(true);
    try {
      const res = await fetch(
        `${PLACE_DETAILS_URL}/${placeId}?languageCode=en`,
        {
          headers: {
            'X-Goog-Api-Key': API_KEY,
            'X-Goog-FieldMask': 'addressComponents,formattedAddress',
          },
        }
      );

      if (!res.ok) return;

      const data = await res.json();
      const fallbackLine1 =
        prediction.placePrediction.structuredFormat?.mainText.text ||
        firstAddressSegment(data.formattedAddress || '') ||
        displayText;
      const parsed = parseAddressComponents(
        data.addressComponents || [],
        fallbackLine1
      );
      onSelect(parsed);
    } catch {
      // Silently fail — address text is already in the input
    } finally {
      setLoading(false);
    }
  };

  // Keyboard navigation for suggestions dropdown
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || suggestions.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : 0
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((prev) =>
          prev > 0 ? prev - 1 : suggestions.length - 1
        );
        break;
      case 'Enter': {
        e.preventDefault();
        const selected = suggestions[activeIndex];
        if (activeIndex >= 0 && selected) {
          handleSelect(selected);
        }
        break;
      }
      case 'Escape':
        setShowDropdown(false);
        setActiveIndex(-1);
        break;
    }
  };

  // Cleanup timer and abort controller
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // No API key → plain input (after all hooks)
  if (!API_KEY) {
    return (
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={className}
        disabled={disabled}
      />
    );
  }

  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setShowDropdown(true);
        }}
        onBlur={() => setTimeout(() => setShowDropdown(false), 120)}
        placeholder={placeholder}
        className={className}
        disabled={disabled || loading}
        autoComplete="off"
      />

      {showDropdown && suggestions.length > 0 && (
        <div className={cn(
          'absolute z-50 mt-1 w-full rounded-lg border border-border bg-surface-light shadow-lg',
          'max-h-60 overflow-y-auto'
        )}>
          {suggestions.map((suggestion, i) => {
            const structured = suggestion.placePrediction.structuredFormat;
            const mainText = structured?.mainText.text;
            const secondaryText = structured?.secondaryText.text;

            return (
              // Dropdown-menu-item suggestion row, not Button-shaped - left raw.
              <button
                key={i}
                type="button"
                className={cn(
                  'w-full px-3 py-2.5 text-left text-sm hover:bg-background-light',
                  i === activeIndex && 'bg-background-light'
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelect(suggestion)}
              >
                {mainText ? (
                  <>
                    <span className="font-medium">{mainText}</span>
                    {secondaryText && (
                      <span className="text-text-secondary ml-1">{secondaryText}</span>
                    )}
                  </>
                ) : (
                  suggestion.placePrediction.text.text
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
