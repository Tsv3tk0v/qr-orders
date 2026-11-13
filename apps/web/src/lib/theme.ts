import { DEFAULT_BRAND, type BrandTokens, type Theme } from '@qr/shared';

/** Токените на марката → CSS променливи. Компонентите ползват само променливите. */
export function applyBrand(brand: Partial<BrandTokens> | undefined, theme: Theme = 'light') {
  const b = { ...DEFAULT_BRAND, ...brand };
  const r = document.documentElement;
  const set = (k: string, v: string) => r.style.setProperty(k, v);
  set('--primary', b.primary);
  set('--accent', b.accent);
  set('--on-accent', b.onAccent);
  set('--menu-bg', theme === 'light' ? '#FFFFFF' : b.menuBackground);
  set('--board-bg', b.boardBackground);
  set('--text', b.text);
  set('--cooking', b.cooking);
  set('--ready', b.ready);
  set('--font', `'${b.font}', system-ui, -apple-system, 'Segoe UI', sans-serif`);
  r.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#FFFFFF' : b.menuBackground);
}

export function logoFor(brand: Partial<BrandTokens> | undefined, dark: boolean) {
  return dark ? brand?.logoDarkUrl ?? brand?.logoLightUrl : brand?.logoLightUrl ?? brand?.logoDarkUrl;
}
