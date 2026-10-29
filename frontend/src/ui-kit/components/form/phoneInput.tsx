"use client";

import * as React from "react";

import { Input } from "@/ui-kit/components/ui/input";
import { cn } from "@/ui-kit/lib/utils";
import { setsLargeTextSize } from "@/ui-kit/lib/textEntry";
import { fieldKindProps } from "@/ui-kit/lib/fieldKind";
import { nextPhoneValue, type PhoneFormat } from "@/ui-kit/lib/phoneField";

export type { PhoneFormat } from "@/ui-kit/lib/phoneField";
export { phoneFieldValue, isUsPhoneValue, isUnmaskedPhoneNumber } from "@/ui-kit/lib/phoneField";

type NativeInputProps = Omit<
  React.ComponentProps<"input">,
  "value" | "defaultValue" | "onChange" | "type" | "inputMode" | "autoComplete" | "size"
>;

export interface PhoneInputProps extends NativeInputProps {
  /** The form's own string. Show a stored number through `phoneFieldValue()`. */
  value: string;
  /** The next value, already masked (format 'us') or exactly as typed ('as-typed'). */
  onValueChange: (value: string) => void;
  /**
   * 'us' (default): the US typing mask, "(512) 555-0147", ten digits; an
   * international number typed with "+" or a stored long number is kept whole.
   * 'as-typed': no mask at all - for fields that never had one (dial pads,
   * forwarding numbers, the block list), so they send exactly what they sent before.
   */
  format?: PhoneFormat;
  /**
   * False where staff record a third party's number (a customer, a vendor, a
   * caller to block): the browser does not offer the staff member's own number.
   * The telephone type and keypad stay. See src/ui-kit/lib/fieldKind.ts.
   */
  personalAutofill?: boolean;
  /**
   * Which field to draw, so a phone field looks like the fields around it:
   * 'kit' (default) the kit Input; 'bare' a plain <input> styled only by
   * `className`, for the screens that style their own fields.
   */
  appearance?: "kit" | "bare";
  /**
   * A screen whose fields are the app's own Input (components/ui/input) passes
   * that component here, so the phone field matches them. It replaces the kit
   * Input of the 'kit' appearance; the kit itself never imports the app
   * (src/ui-kit/__tests__/import-purity.test.ts).
   */
  component?: React.ComponentType<PhoneFieldComponentProps>;
}

/** What PhoneInput hands the field component it draws. */
export type PhoneFieldComponentProps = NativeInputProps & {
  kind: "phone";
  personalAutofill?: boolean;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
};

/**
 * THE phone field (mobile slice 36, KB-02): every phone number a user types goes
 * through this. It is the "phone" field kind - telephone type, telephone keypad,
 * phone autofill - plus the value rules in src/ui-kit/lib/phoneField.ts, which
 * keep a stored international number or one of more than ten digits whole: it is
 * shown and re-saved exactly as stored, never truncated and never given a +1.
 *
 * There is deliberately no fixed "US +1" prefix: the field also holds
 * international numbers, and a +1 drawn beside "+44 ..." would misstate them.
 * The extension is the form's own box beside this one, with
 * `kind="phone-extension"`, so no form had to change the shape of its state.
 *
 * The source guard src/__tests__/input-guards/phone-field.guard.test.ts rejects a
 * phone field that is not this component.
 */
function PhoneInput({
  value,
  onValueChange,
  format = "us",
  personalAutofill,
  appearance = "kit",
  component: Field = Input,
  className,
  ...props
}: PhoneInputProps) {
  const onChange = (e: React.ChangeEvent<HTMLInputElement>) =>
    onValueChange(nextPhoneValue(e.target.value, value, format));

  if (appearance === "bare") {
    return (
      <input
        {...fieldKindProps("phone", { personalAutofill })}
        {...props}
        // 16 px on a phone or tablet like every text entry primitive (mobile slice 14):
        // iOS zooms a focused field under 16 px.
        className={cn(!setsLargeTextSize(className) && "mobile:!text-base", className)}
        value={value}
        onChange={onChange}
      />
    );
  }
  return <Field kind="phone" personalAutofill={personalAutofill} {...props} className={className} value={value} onChange={onChange} />;
}

export { PhoneInput };
