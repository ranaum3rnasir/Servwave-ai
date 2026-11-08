import { useEffect, useRef, useState } from 'react';
import { StoreAddressSearch } from './StoreAddressSearch';
import { Input } from '@/components/ui/input';
import { FormField } from '@/components/patterns/FormField';

export type StoreDraft = { label: string; address: string; lat: number; lng: number };

// Input now owns its own border/radius/background/focus-ring appearance
// (design-system layering guard) - this constant is layout-only.
const INPUT_CLASS = 'w-full px-3 py-2';

export function StoreLocationPicker({
  value,
  onChange,
}: {
  value: StoreDraft;
  onChange: (next: StoreDraft) => void;
}) {
  return (
    <div className="space-y-3">
      {/* Wrapping label (span+input inside <label>), not a FormField-shape site - left raw. */}
      <label className="block text-sm">
        <span className="mb-1 block text-text-secondary">Store name</span>
        <Input
          className={INPUT_CLASS}
          value={value.label}
          onChange={(e) => onChange({ ...value, label: e.target.value })}
          placeholder="e.g. Downtown HQ"
        />
      </label>

      <div className="block text-sm">
        <FormField label="Service address" htmlFor="store-address">
          <StoreAddressSearch
            value={{ address: value.address, lat: value.lat, lng: value.lng }}
            onChange={(next) => onChange({ ...value, ...next })}
          />
        </FormField>
        <p className="mt-1 text-xs text-text-secondary">
          Technicians clock in within range of this address.
        </p>
      </div>

      <details className="text-sm">
        <summary className="cursor-pointer select-none text-xs text-text-secondary hover:text-text-primary">
          Advanced — set coordinates manually
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <CoordInput
            label="Latitude"
            value={value.lat}
            onCommit={(n) => onChange({ ...value, lat: n })}
          />
          <CoordInput
            label="Longitude"
            value={value.lng}
            onCommit={(n) => onChange({ ...value, lng: n })}
          />
        </div>
      </details>
    </div>
  );
}

/**
 * A numeric coordinate field that holds its own raw text while editing, so partial inputs
 * ("-", "1.", "") aren't coerced away. Commits the parsed number only when it's finite, and
 * re-syncs from the prop (e.g. when the address search updates coords) only while unfocused.
 */
function CoordInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setText(String(value));
  }, [value]);

  return (
    // Wrapping label (span+input inside <label>), not a FormField-shape site - left raw.
    <label className="text-sm">
      <span className="mb-1 block text-text-secondary">{label}</span>
      <Input
        className={INPUT_CLASS}
        value={text}
        inputMode="decimal"
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          setText(String(value)); // canonicalise once editing ends
        }}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const n = Number(t);
          if (t.trim() !== '' && Number.isFinite(n)) onCommit(n);
        }}
      />
    </label>
  );
}

export default StoreLocationPicker;
