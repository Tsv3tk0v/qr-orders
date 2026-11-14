export const ORDER_STATUSES = ['pending', 'accepted', 'ready', 'collected', 'rejected', 'no_show', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const ACTIVE_STATUSES: readonly OrderStatus[] = ['pending', 'accepted', 'ready'];

export type OrderChannel = 'qr' | 'kiosk';

/** Действия на кухнята и до какъв статус водят (от кои статуси са позволени). */
export const KITCHEN_ACTIONS = {
  accept: { from: ['pending'], to: 'accepted' },
  reject: { from: ['pending'], to: 'rejected' },
  ready: { from: ['accepted'], to: 'ready' },
  back: { from: ['accepted', 'ready'], to: null },   // връща една стъпка назад
  collected: { from: ['ready'], to: 'collected' },
  no_show: { from: ['ready'], to: 'no_show' },
} as const satisfies Record<string, { from: readonly OrderStatus[]; to: OrderStatus | null }>;
export type KitchenAction = keyof typeof KITCHEN_ACTIONS;

export function nextStatus(action: KitchenAction, current: OrderStatus): OrderStatus | null {
  const a = KITCHEN_ACTIONS[action];
  if (!(a.from as readonly OrderStatus[]).includes(current)) return null;
  if (a.to) return a.to;
  return current === 'ready' ? 'accepted' : 'pending';
}

/** QR (реш. 3): ново кодче на всеки 30 с; важат текущото и предишното. */
export const QR_PERIOD_SECONDS = 30;
export const SESSION_MINUTES = 20;

/** Код за следене: без лесни за бъркане знаци (0/O, 1/I/L). */
export const PUBLIC_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function formatPublicCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/** Лимити за една поръчка. */
export const ORDER_LIMITS = { maxLines: 30, maxQty: 20, noteLength: 120 };

export type DeviceKind = 'kitchen' | 'board' | 'kiosk';
