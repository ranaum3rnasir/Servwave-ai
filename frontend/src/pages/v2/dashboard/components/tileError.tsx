import { LoadError } from '../../_shared/loadError';

/**
 * A tile that has no answer: the read failed, or the server could not build this tile. One plain line naming the tile
 * and a Retry, in the app's own load-error state, so a failure is never drawn as a figure of zero.
 */
export function TileError({ title, onRetry, retrying }: { title: string; onRetry: () => void; retrying: boolean }) {
  return <LoadError title={`Couldn't load ${title}.`} onRetry={onRetry} retrying={retrying} className="py-6" />;
}
