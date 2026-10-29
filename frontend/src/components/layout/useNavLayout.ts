import { useCallback, useState } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import {
  loadLayout, saveLayout, reorder, addKey, removeKey, resetLayout,
} from './nav-layout';

export interface NavLayoutApi {
  keys: string[];
  move: (from: number, to: number) => void;
  add: (key: string) => void;
  remove: (key: string) => void;
  reset: () => void;
}

export function useNavLayout(): NavLayoutApi {
  const userId = useAuthStore((s) => s.user?.id) ?? 'anon';
  const [keys, setKeys] = useState<string[]>(() => loadLayout(userId));

  const persist = useCallback(
    (next: string[]) => {
      setKeys(next);
      saveLayout(userId, next);
    },
    [userId]
  );

  return {
    keys,
    move: (from, to) => persist(reorder(keys, from, to)),
    add: (key) => persist(addKey(keys, key)),
    remove: (key) => persist(removeKey(keys, key)),
    reset: () => setKeys(resetLayout(userId)),
  };
}
