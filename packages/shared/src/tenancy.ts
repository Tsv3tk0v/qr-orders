export const LOCALES = ['bg', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const THEMES = ['light', 'classic'] as const;
export type Theme = (typeof THEMES)[number];

/** Във версия 1 няма плащане (реш. 1); стойностите се разширяват във версия 2. */
export const PAYMENT_MODES = ['none'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;

/** Кратко име за поддомейн: малки латински букви, цифри и тире, до 32 знака. */
export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !slug.includes('--');
}

/** Поддомейнът трябва да е едно ниво, за да го покрива wildcard сертификатът (реш. 19). */
export function businessHostname(businessSlug: string, baseDomain: string): string {
  return `${businessSlug}.${normalizeHostname(baseDomain)}`;
}

/** Обектът е на поддомейн „<бизнес>--<обект>“, пак едно ниво. */
export function locationHostname(businessSlug: string, locationSlug: string, baseDomain: string): string {
  return `${businessSlug}--${locationSlug}.${normalizeHostname(baseDomain)}`;
}

/** Махa порт и крайна точка, малки букви. */
export function normalizeHostname(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h; // IPv6 — не се ползва за бизнеси
  const colon = h.indexOf(':');
  if (colon >= 0) h = h.slice(0, colon);
  return h.replace(/\.$/, '');
}

/** Поддомейни, заети от платформата; не могат да са бизнеси. */
export const RESERVED_SLUGS: readonly string[] = ['admin', 'api', 'www', 'app', 'static', 'mail'];

/** Хостът на админ панела на платформата. */
export function platformHostname(baseDomain: string): string {
  return `admin.${normalizeHostname(baseDomain)}`;
}
