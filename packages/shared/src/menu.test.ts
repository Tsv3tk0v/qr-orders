import { describe, expect, it } from 'vitest';
import {
  contrastRatio, DEFAULT_BRAND, formatPrice, missingLocales, normalizeItemCode, parsePriceCents, pickText, validateBrand,
} from './menu';

describe('цени и кодове', () => {
  it('цена', () => {
    expect(parsePriceCents('2,40')).toBe(240);
    expect(parsePriceCents('3.2')).toBe(320);
    expect(parsePriceCents(' 12 € ')).toBe(1200);
    expect(parsePriceCents(9.5)).toBe(950);
    for (const bad of ['', 'abc', '-1', '1,234', '1.2.3']) expect(parsePriceCents(bad)).toBeNull();
    expect(formatPrice(950)).toBe('9,50 €');
    expect(formatPrice(950, 'en')).toBe('€9.50');
  });
  it('код', () => {
    expect(normalizeItemCode('004512')).toBe('004512');
    expect(normalizeItemCode(4512)).toBe('004512');
    for (const bad of ['12A45', '1234567', '45', 4.5]) expect(normalizeItemCode(bad)).toBeNull();
  });
});

describe('текстове', () => {
  it('избор на език и липсващ превод', () => {
    expect(pickText({ bg: 'Дюнер', en: 'Doner' }, 'en')).toBe('Doner');
    expect(pickText({ bg: 'Дюнер', en: ' ' }, 'en')).toBe('Дюнер');
    expect(missingLocales([{ bg: 'а', en: 'a' }, { bg: 'б' }], ['bg', 'en'])).toEqual(['en']);
  });
});

describe('марка', () => {
  it('контраст като в мокъпа', () => {
    expect(contrastRatio('#141414', '#FFFFFF')).toBe(18.4);
    expect(contrastRatio('#C4281F', '#FFFFFF')).toBe(5.7);
    expect(contrastRatio('#13803F', '#FFFFFF')).toBe(5);
  });
  it('стандартната марка е валидна; бледите цветове се отказват', () => {
    expect(validateBrand(DEFAULT_BRAND)).toEqual([]);
    const cafe = { ...DEFAULT_BRAND, accent: '#D7191C', onAccent: '#FFFFFF', menuBackground: '#F6F3EF' };
    expect(validateBrand(cafe)).toEqual([]);
    const pale = validateBrand({ ...DEFAULT_BRAND, accent: '#FFD000', text: 'red' });
    expect(pale).toEqual([{ token: 'text', code: 'invalid_color' }]);
    expect(validateBrand({ ...DEFAULT_BRAND, accent: '#FFD000', onAccent: '#FFFFFF' })).toEqual([
      { token: 'accent', code: 'low_contrast', ratio: 1.5 },
    ]);
    expect(validateBrand({ ...DEFAULT_BRAND, logoDarkUrl: 'javascript:alert(1)' })[0]?.code).toBe('invalid_url');
  });
});
