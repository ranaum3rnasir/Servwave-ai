import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, resolving Tailwind conflicts.
 *
 * clsx handles conditionals; twMerge ensures the LAST conflicting utility wins,
 * so a consumer can override a component's defaults:
 *
 *   <Button className="h-12" />   ->  the h-12 beats the variant's h-10
 *
 * Without twMerge both classes land in the DOM and the winner depends on
 * stylesheet order, which is why plain string concatenation breaks overrides.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
