import { useEffect } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import type { BrandTokens, Locale, Theme } from '@qr/shared';
import { useLoad } from './lib/hooks';
import { I18nProvider, useI18n } from './lib/i18n';
import { applyBrand } from './lib/theme';
import { ErrorBox } from './components/ui';
import { Customer } from './customer/Customer';
import { DeviceScreen, Pair } from './device/Device';
import { Admin } from './admin/Admin';
import { Platform } from './platform/Platform';

export interface BusinessCtx {
  kind: 'business';
  business: { slug: string; name: string; theme: Theme; defaultLocale: Locale; enabledLocales: Locale[]; currency: string; brand: BrandTokens };
  location: { slug: string; name: string; qrEnabled: boolean; kioskEnabled: boolean; prepMinutes: number } | null;
}
type Ctx = BusinessCtx | { kind: 'platform' };

export function App() {
  const { data: ctx, error } = useLoad<Ctx>('/api/context');
  useEffect(() => {
    if (ctx?.kind === 'business') { applyBrand(ctx.business.brand, ctx.business.theme); document.title = ctx.business.name; }
    if (ctx?.kind === 'platform') applyBrand(undefined, 'light');
  }, [ctx]);
  if (error) return <I18nProvider><div className="cust-center"><ErrorBox error={error} /></div></I18nProvider>;
  if (!ctx) return null;
  if (ctx.kind === 'platform') {
    const base = location.hostname.replace(/^admin\./, '');
    return <I18nProvider storageKey="locale:admin"><BrowserRouter><Platform baseDomain={base} /></BrowserRouter></I18nProvider>;
  }
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/admin/*" element={<I18nProvider storageKey="locale:admin"><Admin ctx={ctx} /></I18nProvider>} />
        <Route path="/device" element={<I18nProvider initial={ctx.business.defaultLocale}><Pair /></I18nProvider>} />
        <Route path="/kitchen" element={<DeviceScreen kind="kitchen" />} />
        <Route path="/board" element={<DeviceScreen kind="board" />} />
        <Route path="/kiosk" element={<DeviceScreen kind="kiosk" />} />
        <Route path="*" element={<CustomerRoot ctx={ctx} />} />
      </Routes>
    </BrowserRouter>
  );
}

function CustomerRoot({ ctx }: { ctx: BusinessCtx }) {
  return (
    <I18nProvider initial={ctx.business.defaultLocale} storageKey={`locale:${ctx.business.slug}`}>
      <LocaleGuard locales={ctx.business.enabledLocales} />
      <Customer ctx={ctx} />
    </I18nProvider>
  );
}

/** Ако запомненият език е изключен от бизнеса — връща езика по подразбиране. */
function LocaleGuard({ locales }: { locales: Locale[] }) {
  const { locale, setLocale } = useI18n();
  useEffect(() => { if (!locales.includes(locale)) setLocale(locales[0] ?? 'bg'); }, [locale, locales, setLocale]);
  return null;
}
