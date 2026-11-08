import { useEffect, useState } from "react";

/**
 * Debounce a rapidly-changing value.
 *
 *   const search = useDebounce(query, 300);
 *   useEffect(() => { fetchResults(search); }, [search]);
 *
 * Debounces the VALUE rather than wrapping the callback, so it composes with
 * effects and query hooks without needing a stable function reference.
 */
export function useDebounce<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
