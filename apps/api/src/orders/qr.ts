import { createHmac, timingSafeEqual } from 'node:crypto';
import { QR_PERIOD_SECONDS } from '@qr/shared';

/** Номер на 30-секундния прозорец. */
export const qrWindow = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / QR_PERIOD_SECONDS);

function sign(secret: string, locationId: string, window: number): string {
  return createHmac('sha256', secret).update(`qr:${locationId}:${window}`).digest('base64url').slice(0, 16);
}

/** Токенът в QR: „<прозорец>.<подпис>“. Подписът е обвързан с обекта. */
export function qrToken(secret: string, locationId: string, nowMs = Date.now()): string {
  const w = qrWindow(nowMs);
  return `${w}.${sign(secret, locationId, w)}`;
}

/** Важат текущият и предишният прозорец (реш. 3). */
export function verifyQrToken(secret: string, locationId: string, token: string, nowMs = Date.now()): boolean {
  const m = /^(\d{1,12})\.([A-Za-z0-9_-]{16})$/.exec(token);
  if (!m) return false;
  const w = Number(m[1]);
  const now = qrWindow(nowMs);
  if (w !== now && w !== now - 1) return false;
  return timingSafeEqual(Buffer.from(sign(secret, locationId, w)), Buffer.from(m[2]!));
}

/** Секунди до смяната на кода (за брояча на таблото). */
export function qrSecondsLeft(nowMs = Date.now()): number {
  return QR_PERIOD_SECONDS - Math.floor((nowMs / 1000) % QR_PERIOD_SECONDS);
}
