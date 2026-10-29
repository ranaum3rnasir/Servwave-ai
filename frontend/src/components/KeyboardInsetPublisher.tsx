import { useKeyboardInset } from '@/hooks/useKeyboardInset';

/**
 * Mounts the app-level keyboard hook (mobile slice 54) and renders nothing. App loads it lazily, so
 * the measurement code is a chunk of its own instead of weight in the staff app's entry bundle. The
 * CSS variables it publishes all have safe defaults in index.css, so the first frames before it
 * arrives render exactly as a closed keyboard does.
 */
export default function KeyboardInsetPublisher(): null {
  useKeyboardInset();
  return null;
}
