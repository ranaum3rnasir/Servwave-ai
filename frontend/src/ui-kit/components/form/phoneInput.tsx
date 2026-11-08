"use client";

import * as React from "react";

import { cn } from "@/ui-kit/lib/utils";
import { Input } from "@/ui-kit/components/ui/input";

export interface PhoneValue {
  /** Digits only, no country code: "5125550147" */
  number: string;
  /** Digits only: "214" */
  extension: string;
}

export interface PhoneInputProps {
  value: PhoneValue;
  onChange: (value: PhoneValue) => void;
  invalid?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** Digits in, (512) 555-0147 out. Formats progressively so the caret behaves. */
export function formatUsPhone(digits: string) {
  const d = digits.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** E.164 for storage: +15125550147 */
export function toE164(value: PhoneValue) {
  return value.number ? `+1${value.number}` : "";
}

/**
 * US phone with extension.
 *
 * Extension is a separate control on purpose. Merged into one field it has to
 * be re-parsed out of "555-0147 x214" on every submit, and autofill breaks:
 * browsers fill tel-national and tel-extension independently, so a combined
 * field gets one value and drops the other.
 *
 * State is digits-only; formatting is presentation. That keeps validation
 * trivial (`number.length === 10`) and storage canonical.
 */
function PhoneInput({ value, onChange, invalid, disabled, id, className }: PhoneInputProps) {
  return (
    <div className={cn("flex items-stretch gap-2", className)}>
      <span
        className={cn(
          "bg-muted border-input text-foreground flex h-10 shrink-0 items-center gap-2",
          "rounded-md border px-3 shadow-xs",
          disabled && "opacity-50",
        )}
      >
        <span className="bg-kit-card text-muted-foreground rounded-[4px] border px-1 py-0.5 text-[10.5px] font-extrabold tracking-wide">
          US
        </span>
        <span className="text-sm font-semibold">+1</span>
      </span>

      <Input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        placeholder="(555) 123-4567"
        aria-label="Phone number"
        aria-invalid={invalid}
        disabled={disabled}
        className="min-w-0 flex-1"
        value={formatUsPhone(value.number)}
        onChange={(e) => onChange({ ...value, number: e.target.value.replace(/\D/g, "").slice(0, 10) })}
      />

      <Input
        type="text"
        inputMode="numeric"
        autoComplete="tel-extension"
        placeholder="ext."
        aria-label="Extension"
        disabled={disabled}
        maxLength={6}
        className="w-24 shrink-0 text-center"
        value={value.extension}
        onChange={(e) => onChange({ ...value, extension: e.target.value.replace(/\D/g, "").slice(0, 6) })}
      />
    </div>
  );
}

export { PhoneInput };
