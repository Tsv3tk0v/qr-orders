import type { Locale } from './tenancy';

/** Текст на двата езика; български е задължителен. */
export type I18nText = Partial<Record<Locale, string>>;

/** Текстът на избрания език; ако липсва — на български. */
export function pickText(t: I18nText, locale: Locale): string {
  return (t[locale]?.trim() || t.bg || '').trim();
}

/** Езиците, за които липсва превод (за „EN липсва“ в админа). */
export function missingLocales(texts: I18nText[], locales: readonly Locale[]): Locale[] {
  return locales.filter((l) => texts.some((t) => !t[l]?.trim()));
}

/** 14-те алергена по Регламент (ЕС) 1169/2011. Надписите са в преводите на интерфейса. */
export const ALLERGENS = [
  'gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soybeans', 'milk',
  'nuts', 'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs',
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const CURRENCY = 'EUR';

/** „2,40“, „2.40“, „2“ → 240. Невалидно → null. */
export function parsePriceCents(input: string | number): number | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
  }
  const s = input.trim().replace(/\s|€/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

export function formatPrice(cents: number, locale: Locale = 'bg'): string {
  const value = (cents / 100).toFixed(2);
  return locale === 'bg' ? `${value.replace('.', ',')} €` : `€${value}`;
}

/** Код на артикул: 6 цифри като текст. Число от Excel губи водещите нули — връщаме ги. */
export function normalizeItemCode(input: string | number): string | null {
  const s = typeof input === 'number'
    ? (Number.isInteger(input) && input >= 0 ? String(input).padStart(6, '0') : '')
    : input.trim();
  return /^\d{6}$/.test(s) ? s : null;
}

// --- Марка и теми ----------------------------------------------------------------

export const FONTS = ['Manrope', 'Inter', 'Merriweather'] as const;
export type Font = (typeof FONTS)[number];

/** Токените на марката. Всички компоненти четат цветовете оттук. */
export interface BrandTokens {
  primary: string;          // основен (тъмни бутони, избран филтър)
  accent: string;           // маркиращ (бутон „+“, количка)
  onAccent: string;         // текст върху маркиращия цвят
  menuBackground: string;
  boardBackground: string;
  text: string;
  cooking: string;          // „Готвят се“
  ready: string;            // „Готови“
  font: Font;
  logoDarkUrl?: string;     // лого за тъмен фон
  logoLightUrl?: string;    // лого за светъл фон
  menuHeroUrl?: string;
  boardBackgroundUrl?: string;
  statusBackgroundUrl?: string;
}

export const DEFAULT_BRAND: BrandTokens = {
  primary: '#141414',
  accent: '#F2A93B',
  onAccent: '#141414',
  menuBackground: '#FFFFFF',
  boardBackground: '#0B0B0B',
  text: '#1E1E1E',
  cooking: '#C4281F',
  ready: '#13803F',
  font: 'Manrope',
};

export const MIN_CONTRAST = 4.5;
const WHITE = '#FFFFFF';
const HEX = /^#[0-9a-fA-F]{6}$/;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Контраст по WCAG 2.1, напр. 4.5 за 4,5:1. */
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 10) / 10;
}

/** Двойки, които се проверяват: [токен, фон/текст, срещу какво]. */
const CONTRAST_PAIRS: [keyof BrandTokens, (t: BrandTokens) => string][] = [
  ['primary', () => WHITE],
  ['accent', (t) => t.onAccent],
  ['menuBackground', (t) => t.text],
  ['boardBackground', () => WHITE],
  ['cooking', () => WHITE],
  ['ready', () => WHITE],
];

export interface BrandIssue { token: string; code: 'invalid_color' | 'low_contrast' | 'invalid_font' | 'invalid_url'; ratio?: number }

/** Проверява токените; под 4,5:1 записът се отказва (мокъп „Външен вид“). */
export function validateBrand(t: BrandTokens): BrandIssue[] {
  const issues: BrandIssue[] = [];
  const colors = ['primary', 'accent', 'onAccent', 'menuBackground', 'boardBackground', 'text', 'cooking', 'ready'] as const;
  for (const c of colors) if (!HEX.test(t[c] ?? '')) issues.push({ token: c, code: 'invalid_color' });
  if (!FONTS.includes(t.font)) issues.push({ token: 'font', code: 'invalid_font' });
  for (const k of ['logoDarkUrl', 'logoLightUrl', 'menuHeroUrl', 'boardBackgroundUrl', 'statusBackgroundUrl'] as const) {
    const v = t[k];
    if (v !== undefined && !/^(https:\/\/|\/)[^\s"'<>]*$/.test(v)) issues.push({ token: k, code: 'invalid_url' });
  }
  if (issues.some((i) => i.code === 'invalid_color')) return issues;
  for (const [token, other] of CONTRAST_PAIRS) {
    const ratio = contrastRatio(t[token] as string, other(t));
    if (ratio < MIN_CONTRAST) issues.push({ token, code: 'low_contrast', ratio });
  }
  return issues;
}
