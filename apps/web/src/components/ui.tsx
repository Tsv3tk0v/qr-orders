import { useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { LOCALES, type Locale } from '@qr/shared';
import { useI18n } from '../lib/i18n';
import { api } from '../lib/api';

type BtnKind = 'primary' | 'accent' | 'ghost' | 'danger' | 'success';
export function Button({ kind = 'primary', big, className = '', ...p }:
  ButtonHTMLAttributes<HTMLButtonElement> & { kind?: BtnKind; big?: boolean }) {
  return <button {...p} className={`btn btn-${kind}${big ? ' btn-big' : ''} ${className}`} />;
}

export function Toggle({ checked, onChange, label, disabled }:
  { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`toggle${disabled ? ' is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label && <span className="toggle-label">{label}</span>}
    </label>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={`input ${p.className ?? ''}`} />;
}

/** Цена в евро: показва €, пази центове. */
export function PriceInput({ cents, onChange }: { cents: number | null; onChange: (c: number | null) => void }) {
  const [v, setV] = useState(cents === null ? '' : (cents / 100).toFixed(2));
  useEffect(() => { setV(cents === null ? '' : (cents / 100).toFixed(2)); }, [cents]);
  return (
    <span className="price-input">
      <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Number(v.replace(',', '.'));
          onChange(v.trim() === '' ? null : Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : cents);
        }} />
      <span>€</span>
    </span>
  );
}

export function QrCode({ value, size = 220, dark = '#000', light = '#fff' }:
  { value: string; size?: number; dark?: string; light?: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    QRCode.toString(value, { type: 'svg', margin: 1, color: { dark, light }, errorCorrectionLevel: 'M' })
      .then(setSvg).catch(() => setSvg(''));
  }, [value, dark, light]);
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function LangSwitch({ locales = LOCALES as readonly Locale[] }: { locales?: readonly Locale[] }) {
  const { locale, setLocale } = useI18n();
  if (locales.length < 2) return null;
  return (
    <div className="seg seg-sm" role="group">
      {locales.map((l) => (
        <button key={l} className={l === locale ? 'is-on' : ''} onClick={() => setLocale(l)}>{l === 'bg' ? 'БГ' : 'EN'}</button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }:
  { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'is-on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  const { err } = useI18n();
  if (!error) return null;
  return <div className="alert alert-error" role="alert">{err(error)}</div>;
}

export function Notice({ children, kind = 'info' }: { children: ReactNode; kind?: 'info' | 'ok' | 'warn' }) {
  return <div className={`alert alert-${kind}`}>{children}</div>;
}

export function Sheet({ onClose, children, wide }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className={`sheet${wide ? ' sheet-wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <button className="sheet-close" onClick={onClose} aria-label="×">×</button>
        {children}
      </div>
    </div>
  );
}

export function Stepper({ value, onChange, min = 0, max = 20 }:
  { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <span className="stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} aria-label="−">−</button>
      <span>{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} aria-label="+">+</button>
    </span>
  );
}

export function Logo({ url, name, size = 36 }: { url?: string; name: string; size?: number }) {
  return url
    ? <img className="logo" src={url} alt={name} style={{ width: size, height: size }} />
    : <span className="logo logo-letter" style={{ width: size, height: size, fontSize: size * 0.5 }}>{name.trim()[0] ?? '•'}</span>;
}

/** Мястото за снимка: ако няма снимка — кръг с първата буква. */
export function ItemImage({ url, name, size = 72 }: { url: string | null; name: string; size?: number }) {
  return url
    ? <img className="item-img" src={url} alt="" style={{ width: size, height: size }} loading="lazy" />
    : <span className="item-img item-img-empty" style={{ width: size, height: size, fontSize: size * 0.4 }}>{name.trim()[0]}</span>;
}

export function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 10_000); return () => clearInterval(t); }, []);
  return <span className="clock">{now.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })}</span>;
}

export function LiveDot({ online }: { online: boolean }) {
  const { t } = useI18n();
  return <span className={`live ${online ? 'is-on' : ''}`}><i />{online ? t('common.online') : t('common.offline')}</span>;
}

/** Качване на снимка от компютъра/телефона (PNG, JPEG, WebP до 2 MB) → адрес /media/… */
export function ImageUpload({ value, onChange }: { value: string; onChange: (url: string) => void }) {
  const { t, err } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="image-upload">
      {value && <img src={value} alt="" />}
      <label className="btn btn-ghost btn-sm">
        {busy ? t('common.loading') : `📷 ${t('common.upload')}`}
        <input type="file" accept="image/png,image/jpeg,image/webp" hidden disabled={busy} onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          setBusy(true); setError('');
          try { onChange((await api.uploadImage(f)).url); } catch (x) { setError(err(x)); } finally { setBusy(false); e.target.value = ''; }
        }} />
      </label>
      {value && <button type="button" className="link-btn" onClick={() => onChange('')}>{t('common.delete')}</button>}
      {error && <span className="danger small">{error}</span>}
    </div>
  );
}
