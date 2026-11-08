"use client";

import * as React from "react";
import { X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";

export interface TagInputProps {
  value: string[];
  onValueChange: (tags: string[]) => void;
  placeholder?: string;
  /** Offered below the field; already-selected ones are filtered out. */
  suggestions?: string[];
  maxTags?: number;
  disabled?: boolean;
  invalid?: boolean;
  id?: string;
  className?: string;
}

/**
 * Free-text tags with suggestions.
 *
 * Commits on Enter *and* on comma, because people type both. Backspace on an
 * empty field removes the last tag - the behaviour every chip input has, and
 * its absence is immediately noticeable.
 *
 * Duplicates are rejected case-insensitively: "Urgent" and "urgent" as separate
 * tags makes filtering quietly wrong later.
 */
function TagInput({
  value, onValueChange, placeholder = "Add a tag…",
  suggestions = [], maxTags, disabled, invalid, id, className,
}: TagInputProps) {
  const [draft, setDraft] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  const atLimit = maxTags != null && value.length >= maxTags;
  const normalised = value.map((tag) => tag.toLowerCase());

  const add = (raw: string) => {
    const tag = raw.trim().replace(/,$/, "");
    if (!tag || atLimit || normalised.includes(tag.toLowerCase())) { setDraft(""); return; }
    onValueChange([...value, tag]);
    setDraft("");
  };

  const remove = (index: number) => onValueChange(value.filter((_, i) => i !== index));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(draft); }
    else if (e.key === "Backspace" && !draft && value.length) { remove(value.length - 1); }
  };

  const remaining = suggestions.filter((s) => !normalised.includes(s.toLowerCase()));

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        onClick={() => inputRef.current?.focus()}
        className={cn(
          "border-input bg-kit-card flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-md border px-2 py-1.5 shadow-xs",
          "transition-[border-color,box-shadow] cursor-text",
          "[&:hover:not(:focus-within)]:border-input-hover",
          "focus-within:border-brand focus-within:ring-[3px] focus-within:ring-ring/25",
          invalid && "border-destructive focus-within:ring-destructive/25",
          disabled && "bg-muted cursor-not-allowed opacity-60",
        )}
      >
        {value.map((tag, index) => (
          <span
            key={`${tag}-${index}`}
            className="bg-brand-subtle text-brand-emphasis inline-flex items-center gap-1 rounded-[5px] py-1 ps-2 pe-1 text-[12px] font-semibold"
          >
            {tag}
            <button
              type="button"
              disabled={disabled}
              onClick={(e) => { e.stopPropagation(); remove(index); }}
              aria-label={`Remove ${tag}`}
              className="hover:bg-kit-card grid size-4 place-items-center rounded-full transition-colors"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          value={draft}
          disabled={disabled || atLimit}
          aria-invalid={invalid}
          placeholder={atLimit ? `Limit of ${maxTags} reached` : value.length ? "" : placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          // Commit on blur too: a typed-but-uncommitted tag silently lost on
          // submit is the classic chip-input bug.
          onBlur={() => add(draft)}
          className="placeholder:text-subtle-foreground min-w-24 flex-1 bg-transparent px-1 text-sm outline-none disabled:cursor-not-allowed"
        />
      </div>

      {remaining.length > 0 && !atLimit && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-subtle-foreground text-[11.5px] font-semibold">Suggested</span>
          {remaining.slice(0, 6).map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={disabled}
              onClick={() => add(suggestion)}
              className="border-input text-muted-foreground hover:border-brand hover:text-brand rounded-full border px-2 py-0.5 text-[11.5px] font-medium transition-colors"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export { TagInput };
