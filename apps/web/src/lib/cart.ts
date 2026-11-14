import { useEffect, useState } from 'react';
import { safeStorage } from './hooks';

export interface CartLine {
  key: string;
  itemId: string;
  qty: number;
  removed: string[];
  addons: { componentId: string; qty: number }[];
  note?: string;
}

/** Количката живее в sessionStorage — оцелява при презареждане, изчезва със затварянето. */
export function useCart(storageKey: string, persist = true) {
  const store = safeStorage('session');
  const [lines, setLines] = useState<CartLine[]>(() => {
    if (!persist) return [];
    try { return JSON.parse(store.get(storageKey) ?? '[]'); } catch { return []; }
  });
  useEffect(() => { if (persist) store.set(storageKey, JSON.stringify(lines)); }, [lines, storageKey, persist]); // eslint-disable-line
  return {
    lines,
    add: (l: Omit<CartLine, 'key'>) => setLines((ls) => {
      const key = JSON.stringify([l.itemId, [...l.removed].sort(), l.addons, l.note ?? '']);
      const found = ls.find((x) => x.key === key);
      return found ? ls.map((x) => (x.key === key ? { ...x, qty: Math.min(20, x.qty + l.qty) } : x)) : [...ls, { ...l, key }];
    }),
    setQty: (key: string, qty: number) =>
      setLines((ls) => (qty <= 0 ? ls.filter((x) => x.key !== key) : ls.map((x) => (x.key === key ? { ...x, qty: Math.min(20, qty) } : x)))),
    clear: () => setLines([]),
    toApi: () => lines.map(({ itemId, qty, removed, addons, note }) => ({ itemId, qty, removed, addons, ...(note ? { note } : {}) })),
  };
}
export type Cart = ReturnType<typeof useCart>;
