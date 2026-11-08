"use client";

import * as React from "react";
import { Search, X } from "lucide-react";

import { cn } from "@/ui-kit/lib/utils";
import { useDebounce } from "@/ui-kit/hooks/useDebounce";
import { Input } from "@/ui-kit/components/ui/input";

export interface SearchInputProps
  extends Omit<React.ComponentProps<"input">, "onChange" | "value"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Fires only after typing settles. Wire your query to this, not onValueChange. */
  onDebouncedChange?: (value: string) => void;
  delay?: number;
}

/**
 * Search field with a clear button and a debounced callback.
 *
 * Two values on purpose: `value` updates on every keystroke so the field stays
 * responsive, while `onDebouncedChange` fires once typing settles so the query
 * doesn't run per character. Debouncing the input itself would make it feel
 * laggy - the delay belongs on the request, not the text.
 */
function SearchInput({
  value, onValueChange, onDebouncedChange, delay = 300,
  className, placeholder = "Search…", ...props
}: SearchInputProps) {
  const debounced = useDebounce(value, delay);

  // The callback is held in a ref so that a caller passing a fresh closure on
  // every render does not re-fire the debounced effect. Assigned in an effect
  // rather than during render: a render-phase ref write is not safe under
  // concurrent rendering, where a render can be thrown away or replayed
  // (react-hooks/refs). This effect has no dependency array so it runs after
  // every commit, and it is declared FIRST so the ref is current before the
  // effect below reads it.
  const onDebouncedRef = React.useRef(onDebouncedChange);
  React.useEffect(() => {
    onDebouncedRef.current = onDebouncedChange;
  });

  React.useEffect(() => {
    onDebouncedRef.current?.(debounced);
  }, [debounced]);

  return (
    <div className={cn("relative flex w-full items-center", className)}>
      <Search className="text-subtle-foreground pointer-events-none absolute left-3 size-4" />
      <Input
        type="search"
        role="searchbox"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        // Escape clears - expected in any table filter, and cheap to support.
        onKeyDown={(e) => { if (e.key === "Escape" && value) { e.preventDefault(); onValueChange(""); } }}
        className={cn("pl-9", value && "pr-9", "[&::-webkit-search-cancel-button]:hidden")}
        {...props}
      />
      {value && (
        <button
          type="button"
          onClick={() => onValueChange("")}
          aria-label="Clear search"
          className={cn(
            "text-subtle-foreground hover:text-foreground hover:bg-muted",
            "absolute right-2 grid size-6 place-items-center rounded-[5px] transition-colors",
            "focus-visible:ring-[3px] focus-visible:ring-ring/25 focus-visible:outline-none",
          )}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export { SearchInput };
