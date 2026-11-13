import { useState } from 'react';
import { contrastRatio, DEFAULT_BRAND, FONTS, MIN_CONTRAST, validateBrand, type BrandTokens, type Locale, type Theme } from '@qr/shared';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useI18n, type TKey } from '../lib/i18n';
import { applyBrand } from '../lib/theme';
import { Button, ErrorBox, Field, Input, Notice, Segmented, Toggle } from '../components/ui';
import type { BusinessCtx } from '../App';

interface LocationRow {
  id: string; slug: string; name: string; status: 'active' | 'inactive'; hostname: string | null;
  qrEnabled: boolean; kioskEnabled: boolean; qrAutoAccept: boolean; kioskAutoAccept: boolean;
  printerHost: string | null; printerPort: number; printerCodepage: number; ticketQr: boolean; prepMinutesEstimate: number;
}
interface Settings {
  theme: Theme; brand: BrandTokens; defaultLocale: Locale; enabledLocales: Locale[]; currency: string; locations: LocationRow[];
}

const COLOR_FIELDS: { key: keyof BrandTokens; label: TKey; against: (b: BrandTokens) => string }[] = [
  { key: 'primary', label: 'look.primary', against: () => '#FFFFFF' },
  { key: 'accent', label: 'look.accent', against: (b) => b.onAccent },
  { key: 'onAccent', label: 'look.onAccent', against: (b) => b.accent },
  { key: 'menuBackground', label: 'look.menuBackground', against: (b) => b.text },
  { key: 'boardBackground', label: 'look.boardBackground', against: () => '#FFFFFF' },
  { key: 'text', label: 'look.text', against: (b) => b.menuBackground },
];
const STATUS_FIELDS: typeof COLOR_FIELDS = [
  { key: 'cooking', label: 'look.cooking', against: () => '#FFFFFF' },
  { key: 'ready', label: 'look.ready', against: () => '#FFFFFF' },
];

export function Appearance({ ctx }: { ctx: BusinessCtx }) {
  const { t } = useI18n();
  const { data } = useLoad<Settings>('/api/admin/settings');
  const { data: versions, reload } = useLoad<{ id: string; publishedBy: string | null; createdAt: string; theme: Theme }[]>('/api/admin/settings/appearance/versions');
  if (!data) return null;
  return <AppearanceForm initial={data} versions={versions ?? []} onPublished={reload} businessName={ctx.business.name} />;
}

function AppearanceForm({ initial, versions, onPublished, businessName }:
  { initial: Settings; versions: { id: string; publishedBy: string | null; createdAt: string }[]; onPublished: () => void; businessName: string }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>(initial.theme);
  const [brand, setBrand] = useState<BrandTokens>({ ...DEFAULT_BRAND, ...initial.brand });
  const [locales, setLocales] = useState<Locale[]>(initial.enabledLocales);
  const [defLocale, setDefLocale] = useState<Locale>(initial.defaultLocale);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  const issues = validateBrand(brand);

  const publish = async () => {
    setError(null); setOk(false);
    try {
      const clean = Object.fromEntries(Object.entries(brand).filter(([, v]) => v !== '' && v !== undefined));
      await api.put('/api/admin/settings/appearance', { theme, brand: clean, enabledLocales: locales, defaultLocale: defLocale });
      setOk(true); onPublished(); applyBrand(brand, theme);
    } catch (e) { setError(e); }
  };
  const colorRow = (f: (typeof COLOR_FIELDS)[number]) => {
    const value = brand[f.key] as string;
    const valid = /^#[0-9a-fA-F]{6}$/.test(value);
    const ratio = valid ? contrastRatio(value, f.against(brand)) : 0;
    return (
      <div key={f.key} className="color-row">
        <input type="color" value={valid ? value : '#000000'} onChange={(e) => setBrand({ ...brand, [f.key]: e.target.value.toUpperCase() })} />
        <span className="grow">{t(f.label)}</span>
        {valid && <span className={`tag ${ratio >= MIN_CONTRAST ? 'tag-success' : 'tag-failed'}`}>{ratio.toFixed(1).replace('.', ',')}:1 {ratio >= MIN_CONTRAST ? '✓' : '✗'}</span>}
        <Input className="input-hex mono" value={value} onChange={(e) => setBrand({ ...brand, [f.key]: e.target.value })} />
      </div>
    );
  };

  return (
    <div className="page page-wide">
      <div className="page-head"><h1>{t('look.title')}</h1>
        <Button kind="accent" disabled={issues.length > 0} onClick={publish}>{t('look.publish')}</Button></div>
      <ErrorBox error={error} />
      {ok && <Notice kind="ok">{t('common.saved')}</Notice>}
      <div className="three-col-wide">
        <div>
          <div className="card form-grid">
            <h2>{t('look.theme')}</h2>
            <Segmented value={theme} onChange={setTheme} options={[{ value: 'light', label: t('look.theme.light') }, { value: 'classic', label: t('look.theme.classic') }]} />
            <h2>🖼 {t('look.logos')}</h2>
            <Field label={t('look.logoDark')}><Input value={brand.logoDarkUrl ?? ''} placeholder="https://…" onChange={(e) => setBrand({ ...brand, logoDarkUrl: e.target.value || undefined })} /></Field>
            <Field label={t('look.logoLight')}><Input value={brand.logoLightUrl ?? ''} placeholder="https://…" onChange={(e) => setBrand({ ...brand, logoLightUrl: e.target.value || undefined })} /></Field>
          </div>
          <div className="card form-grid">
            <h2>🌐 {t('look.languages')}</h2>
            <Toggle checked disabled onChange={() => {}} label={t('look.bgDefault')} />
            <Toggle checked={locales.includes('en')} onChange={(v) => { setLocales(v ? ['bg', 'en'] : ['bg']); if (!v) setDefLocale('bg'); }} label={t('look.en')} />
            <Field label={t('look.defaultLocale')}>
              <Segmented value={defLocale} onChange={setDefLocale} options={locales.map((l) => ({ value: l, label: l === 'bg' ? t('look.bgDefault') : t('look.en') }))} />
            </Field>
            <p className="muted small">{t('look.currency')}: € EUR</p>
          </div>
        </div>
        <div>
          <div className="card">
            <h2>🎨 {t('look.colors')}</h2>
            {COLOR_FIELDS.map(colorRow)}
            <p className="muted small">{t('look.contrastHint')}</p>
          </div>
          <div className="card">
            <h2>🚦 {t('look.statusColors')}</h2>
            {STATUS_FIELDS.map(colorRow)}
          </div>
          <div className="card">
            <h2>🔤 {t('look.font')}</h2>
            <Segmented value={brand.font} onChange={(font) => setBrand({ ...brand, font })} options={FONTS.map((f) => ({ value: f, label: <span style={{ fontFamily: f }}>{f}</span> }))} />
          </div>
        </div>
        <div>
          <div className="card">
            <h2>👁 {t('look.preview')}</h2>
            <Preview brand={brand} theme={theme} name={businessName} />
          </div>
          {versions.length > 0 && (
            <div className="card">
              <h2>{t('look.versions')}</h2>
              {versions.slice(0, 8).map((v) => <div key={v.id} className="row-between small"><span>{new Date(v.createdAt).toLocaleString('bg-BG')}</span><span className="muted">{v.publishedBy}</span></div>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Preview({ brand, theme, name }: { brand: BrandTokens; theme: Theme; name: string }) {
  const { t } = useI18n();
  const bg = theme === 'light' ? '#FFFFFF' : brand.menuBackground;
  return (
    <div className="preview">
      <div className="preview-phone" style={{ background: bg, color: brand.text, fontFamily: brand.font }}>
        <strong>{name}</strong>
        <div className="row"><span className="chip" style={{ background: brand.primary, color: '#fff' }}>{t('common.all')}</span><span className="chip">…</span></div>
        <div className="preview-item"><span>{t('cust.menu')}</span><span className="plus" style={{ background: brand.accent, color: brand.onAccent }}>+</span></div>
        <div className="preview-cart" style={{ background: brand.primary }}><span>{t('cust.cart')}</span><span style={{ background: brand.accent, color: brand.onAccent }}>5,60 €</span></div>
      </div>
      <div className="preview-board" style={{ background: brand.boardBackground }}>
        <div style={{ background: brand.cooking }}><small>{t('board.cooking')}</small><b>49</b><b>48</b></div>
        <div style={{ background: brand.ready }}><small>{t('board.ready')}</small><b>45</b><b>44</b></div>
      </div>
    </div>
  );
}

interface DeviceRow { id: string; locationId: string; kind: 'kitchen' | 'board' | 'kiosk'; name: string; pairedAt: string | null; lastSeenAt: string | null; revokedAt: string | null }

export function Locations() {
  const { t } = useI18n();
  const { data, reload } = useLoad<Settings>('/api/admin/settings');
  const { data: devices, reload: reloadDevices } = useLoad<DeviceRow[]>('/api/admin/devices');
  const [error, setError] = useState<unknown>(null);
  const [code, setCode] = useState<{ deviceId: string; code: string } | null>(null);
  const patch = (id: string, body: object) => api.patch(`/api/admin/settings/locations/${id}`, body).then(reload).catch(setError);
  const addDevice = async (locationId: string, kind: string) => {
    try {
      const r = await api.post<{ device: DeviceRow; pairingCode: string }>('/api/admin/devices', { locationId, kind, name: t(`device.kind.${kind}` as TKey) });
      setCode({ deviceId: r.device.id, code: r.pairingCode }); reloadDevices();
    } catch (e) { setError(e); }
  };
  const newCode = async (id: string) => {
    const r = await api.post<{ pairingCode: string }>(`/api/admin/devices/${id}/pairing-code`);
    setCode({ deviceId: id, code: r.pairingCode }); reloadDevices();
  };
  const scheme = location.protocol;
  return (
    <div className="page">
      <h1>{t('loc.title')}</h1>
      <ErrorBox error={error} />
      {data?.locations.map((l) => {
        const base = l.hostname ? `${scheme}//${l.hostname}${location.port ? `:${location.port}` : ''}` : location.origin;
        return (
          <div key={l.id} className="card form-grid">
            <div className="row-between"><h2>📍 {l.name}</h2><Toggle checked={l.status === 'active'} onChange={(v) => patch(l.id, { status: v ? 'active' : 'inactive' })} label={t('loc.active')} /></div>
            <p className="muted small">{t('loc.address')}: <a href={base} target="_blank" rel="noreferrer" className="mono">{base}</a></p>
            <div className="two-col">
              <div className="form-grid">
                <Toggle checked={l.qrEnabled} onChange={(v) => patch(l.id, { qrEnabled: v })} label={t('loc.qr')} />
                <Toggle checked={l.qrAutoAccept} disabled={!l.qrEnabled} onChange={(v) => patch(l.id, { qrAutoAccept: v })} label={t('loc.qrAuto')} />
                <Toggle checked={l.kioskEnabled} onChange={(v) => patch(l.id, { kioskEnabled: v })} label={t('loc.kiosk')} />
                <Toggle checked={l.kioskAutoAccept} disabled={!l.kioskEnabled} onChange={(v) => patch(l.id, { kioskAutoAccept: v })} label={t('loc.kioskAuto')} />
                <Toggle checked={l.ticketQr} onChange={(v) => patch(l.id, { ticketQr: v })} label={t('loc.ticketQr')} />
              </div>
              <div className="form-grid">
                <Field label={t('loc.printer')}><Input defaultValue={l.printerHost ?? ''} placeholder="192.168.1.50"
                  onBlur={(e) => patch(l.id, { printerHost: e.target.value.trim() || null })} /></Field>
                <div className="two-col">
                  <Field label={t('loc.printerPort')}><Input type="number" defaultValue={l.printerPort} onBlur={(e) => patch(l.id, { printerPort: Number(e.target.value) })} /></Field>
                  <Field label={t('loc.codepage')}><Input type="number" defaultValue={l.printerCodepage} onBlur={(e) => patch(l.id, { printerCodepage: Number(e.target.value) })} /></Field>
                </div>
                <Field label={t('loc.prep')}><Input type="number" min={1} max={180} defaultValue={l.prepMinutesEstimate}
                  onBlur={(e) => patch(l.id, { prepMinutesEstimate: Number(e.target.value) })} /></Field>
              </div>
            </div>
            <h3>{t('loc.devices')}</h3>
            <table className="table">
              <tbody>{devices?.filter((d) => d.locationId === l.id).map((d) => (
                <tr key={d.id} className={d.revokedAt ? 'is-dim' : ''}>
                  <td>{d.kind === 'kitchen' ? '🍳' : d.kind === 'board' ? '📺' : '🖥'} {d.name}</td>
                  <td className="small muted">{d.revokedAt ? t('loc.revoked') : d.lastSeenAt ? `${t('loc.lastSeen')} ${new Date(d.lastSeenAt).toLocaleString('bg-BG')}` : t('loc.never')}</td>
                  <td>{code?.deviceId === d.id && <span className="pair-code mono">{code.code}</span>}</td>
                  <td className="row">
                    <button className="link-btn" onClick={() => newCode(d.id)}>{t('loc.newCode')}</button>
                    {!d.revokedAt && <button className="link-btn danger" onClick={() => api.post(`/api/admin/devices/${d.id}/revoke`).then(reloadDevices)}>{t('loc.revoke')}</button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
            {code && devices?.some((d) => d.id === code.deviceId && d.locationId === l.id) && (
              <Notice kind="ok">{t('loc.pairingCode')}: <b className="mono pair-code">{code.code}</b> — {t('loc.pairingHint', { url: `${base}/device` })}</Notice>
            )}
            <div className="row">
              {(['kitchen', 'board', 'kiosk'] as const).map((k) => (
                <Button key={k} kind="ghost" onClick={() => addDevice(l.id, k)}>+ {t(`device.kind.${k}`)}</Button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
