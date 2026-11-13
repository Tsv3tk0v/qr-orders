import { useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import type { BrandTokens, I18nText, Locale } from '@qr/shared';
import { api, ApiError } from '../lib/api';
import { beep, useIdle, useLoad, useNow, useStream, safeStorage } from '../lib/hooks';
import { I18nProvider, useI18n } from '../lib/i18n';
import { applyBrand, logoFor } from '../lib/theme';
import { useCart } from '../lib/cart';
import { Button, Clock, ErrorBox, Input, ItemImage, LangSwitch, LiveDot, Logo, QrCode, Stepper } from '../components/ui';
import { cartTotal, ItemSheet, lineTotal, type MenuItem, type PublicMenu } from '../customer/Customer';

interface DeviceMe {
  device: { id: string; kind: 'kitchen' | 'board' | 'kiosk'; name: string };
  location: { id: string; name: string; qrEnabled: boolean; kioskEnabled: boolean; printerHost: string | null; printerPort: number };
  business: { name: string; theme: 'light' | 'classic'; defaultLocale: Locale; enabledLocales: Locale[]; brand: BrandTokens };
}

declare global {
  interface Window {
    /** Мост от Android обвивката (печат по LAN). */
    QRBridge?: { printEscPos(host: string, port: number, base64: string): boolean };
  }
}

/** Общо за кухня, табло и киоск: зарежда устройството; ако не е свързано → /device. */
export function DeviceScreen({ kind }: { kind: DeviceMe['device']['kind'] }) {
  const { data, error } = useLoad<DeviceMe>('/api/device/me');
  useEffect(() => { if (data) applyBrand(data.business.brand, data.business.theme); }, [data]);
  if (error instanceof ApiError && error.status === 401) return <Navigate to="/device" replace />;
  if (error) return <div className="cust-center"><ErrorBox error={error} /></div>;
  if (!data) return null;
  if (data.device.kind !== kind) return <Navigate to={`/${data.device.kind}`} replace />;
  return (
    <I18nProvider initial={data.business.defaultLocale} storageKey={`locale:${kind}`}>
      {kind === 'kitchen' && <Kitchen me={data} />}
      {kind === 'board' && <Board me={data} />}
      {kind === 'kiosk' && <Kiosk me={data} />}
    </I18nProvider>
  );
}

export function Pair() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  // Вече свързано устройство (напр. след рестарт на таблета) отива направо на екрана си.
  useEffect(() => {
    api.get<DeviceMe>('/api/device/me').then((d) => nav(`/${d.device.kind}`, { replace: true })).catch(() => {});
  }, [nav]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const d = await api.post<{ kind: string }>('/api/device/pair', { code });
      nav(`/${d.kind}`, { replace: true });
    } catch (err) { setError(err); }
  };
  return (
    <form className="auth-card" onSubmit={submit}>
      <h1>{t('device.pairTitle')}</h1>
      <p className="muted">{t('device.pairHint')}</p>
      <Input className="code-input" inputMode="numeric" autoFocus maxLength={6} value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="000000" />
      <ErrorBox error={error} />
      <Button big disabled={code.length !== 6}>{t('device.pair')}</Button>
    </form>
  );
}

// --- Кухня ---------------------------------------------------------------------

interface KOrder {
  id: string; number: number; status: 'pending' | 'accepted' | 'ready'; channel: 'qr' | 'kiosk'; note: string | null;
  createdAt: string; acceptedAt: string | null; readyAt: string | null;
  items: { qty: number; name: I18nText; note: string | null; removed: { name: I18nText }[]; addons: { name: I18nText; qty: number }[] }[];
}

function Kitchen({ me }: { me: DeviceMe }) {
  const { t, text, err } = useI18n();
  const { data, online } = useStream<{ orders: KOrder[] }>('/api/device/stream');
  const [tab, setTab] = useState<'all' | 'pending' | 'accepted' | 'ready'>('all');
  const store = safeStorage('local');
  const [sound, setSound] = useState(store.get('kitchen-sound') !== 'off');
  const [error, setError] = useState<string | null>(null);
  const now = useNow(15_000);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.orders.filter((o) => o.status === 'pending' || o.channel === 'kiosk').map((o) => o.id));
    if (seen.current && sound && [...ids].some((id) => !seen.current!.has(id))) beep();
    seen.current = ids;
  }, [data, sound]);

  const act = async (o: KOrder, action: string) => {
    if (action === 'reject' && !confirm(t('kitchen.confirmReject', { n: o.number }))) return;
    if (action === 'no_show' && !confirm(t('kitchen.confirmNoShow', { n: o.number }))) return;
    try { setError(null); await api.post(`/api/device/orders/${o.id}/${action}`); } catch (e) { setError(err(e)); }
  };
  const orders = data?.orders ?? [];
  const count = (s: string) => orders.filter((o) => o.status === s).length;
  const cards = orders.filter((o) => o.status !== 'ready' && (tab === 'all' || o.status === tab));
  const ready = orders.filter((o) => o.status === 'ready');
  const mins = (iso: string | null) => (iso ? Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000)) : 0);
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="kitchen">
      <header className="k-head">
        <strong className="k-title">{t('kitchen.title')}</strong>
        {(['all', 'pending', 'accepted', 'ready'] as const).map((s) => (
          <button key={s} className={`k-tab${tab === s ? ' is-on' : ''}`} onClick={() => setTab(s)}>
            {s === 'all' ? t('common.all') : s === 'pending' ? t('kitchen.new') : s === 'accepted' ? t('kitchen.cooking') : t('kitchen.ready')}
            <b className={`k-badge k-${s}`}>{s === 'all' ? orders.length : count(s)}</b>
          </button>
        ))}
        <span className="grow" />
        <LiveDot online={online} />
        <button className="k-icon" title={t('kitchen.sound')} onClick={() => { setSound(!sound); store.set('kitchen-sound', sound ? 'off' : 'on'); }}>
          {sound ? '🔊' : '🔇'}
        </button>
        <LangSwitch locales={me.business.enabledLocales} />
        <Clock />
      </header>
      {error && <div className="k-error">{error}</div>}
      <main className="k-grid">
        {(tab === 'ready' ? ready : cards).map((o) => {
          const hasMods = o.items.some((i) => i.addons.length || i.removed.length || i.note) || Boolean(o.note);
          return (
            <article key={o.id} className={`k-card k-${o.status}`}>
              <div className="k-card-head">
                <span className="k-num"><small>№</small>{o.number}</span>
                <span className="k-meta">
                  <b>{o.channel === 'kiosk' ? `${t('kitchen.kiosk')} · ` : ''}{o.status === 'pending' ? t('kitchen.statusNew')
                    : o.status === 'accepted' ? t('kitchen.statusCooking') : t('kitchen.ready')}</b>
                  <span>{o.status === 'pending' ? `${hhmm(o.createdAt)} · ${t('kitchen.ago', { min: mins(o.createdAt) })}`
                    : o.acceptedAt ? `${t('kitchen.acceptedAt', { time: hhmm(o.acceptedAt) })} · ${mins(o.acceptedAt)}′` : ''}</span>
                </span>
              </div>
              {hasMods && <div className="k-warn">⚠ {t('kitchen.hasAddons')}</div>}
              <div className="k-items">
                {o.items.map((i, k) => {
                  const mod = i.addons.length || i.removed.length || i.note;
                  return (
                    <div key={k} className={`k-item${mod ? ' is-mod' : ''}`}>
                      <div className="k-item-name"><b className={`k-qty${i.qty > 1 ? ' is-multi' : ''}`}>{i.qty}×</b>{text(i.name)}</div>
                      {i.addons.map((a, j) => <div key={`a${j}`} className="k-mod k-add"><i>+</i>{a.qty > 1 ? `${a.qty}× ` : ''}{text(a.name)}</div>)}
                      {i.removed.map((r, j) => <div key={`r${j}`} className="k-mod k-no"><i>−</i>{t('kitchen.legendNo')} {text(r.name)}</div>)}
                      {i.note && <div className="k-mod k-note">✎ {i.note}</div>}
                      {!mod && <div className="k-std">{t('kitchen.standard')}</div>}
                    </div>
                  );
                })}
                {o.note && <div className="k-mod k-note">✎ {o.note}</div>}
              </div>
              <div className="k-actions">
                {o.status === 'pending' && <><button className="k-btn k-btn-reject" onClick={() => act(o, 'reject')}>{t('kitchen.reject')}</button>
                  <button className="k-btn k-btn-accept" onClick={() => act(o, 'accept')}>{t('kitchen.accept')} ›</button></>}
                {o.status === 'accepted' && <><button className="k-btn k-btn-back" onClick={() => act(o, 'back')}>‹ {t('kitchen.back')}</button>
                  <button className="k-btn k-btn-ready" onClick={() => act(o, 'ready')}>{t('kitchen.readyBtn')} ✓</button></>}
                {o.status === 'ready' && <><button className="k-btn k-btn-back" onClick={() => act(o, 'back')}>‹ {t('kitchen.back')}</button>
                  <button className="k-btn k-btn-ready" onClick={() => act(o, 'collected')}>{t('kitchen.collected')}</button></>}
              </div>
            </article>
          );
        })}
        {data && (tab === 'ready' ? ready : cards).length === 0 && <p className="k-empty">{t('kitchen.empty')}</p>}
      </main>
      <footer className="k-foot">
        <b>{t('kitchen.readyRow')}</b>
        {ready.map((o) => {
          const late = mins(o.readyAt) >= 5;
          return (
            <span key={o.id} className={`k-ready${late ? ' is-late' : ''}`}>
              № {o.number}{late && <small>{t('kitchen.waiting', { min: mins(o.readyAt) })}</small>}
              <button onClick={() => act(o, 'collected')}>{t('kitchen.collected')}</button>
              {late && <button className="is-danger" onClick={() => act(o, 'no_show')}>{t('kitchen.noShow')}</button>}
            </span>
          );
        })}
        <span className="grow" />
        <span className="k-legend"><i className="k-add">+</i>{t('kitchen.legendAdd')} <i className="k-no">−</i>{t('kitchen.legendNo')} <i className="k-note">✎</i>{t('kitchen.legendNote')}</span>
      </footer>
    </div>
  );
}

// --- Табло -----------------------------------------------------------------------

function Board({ me }: { me: DeviceMe }) {
  const { t } = useI18n();
  const { data, online } = useStream<{ cooking: number[]; ready: number[] }>('/api/device/stream');
  const [qr, setQr] = useState<{ url: string; secondsLeft: number; at: number } | null>(null);
  const now = useNow(500);

  useEffect(() => {
    if (!me.location.qrEnabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const load = () => api.get<{ url: string; secondsLeft: number }>('/api/device/qr')
      .then((q) => { setQr({ ...q, at: Date.now() }); timer = setTimeout(load, q.secondsLeft * 1000 + 300); })
      .catch(() => { timer = setTimeout(load, 5000); });
    load();
    return () => clearTimeout(timer);
  }, [me.location.qrEnabled]);

  const left = qr ? Math.max(0, qr.secondsLeft - Math.floor((now.getTime() - qr.at) / 1000)) : 0;
  const cooking = (data?.cooking ?? []).slice(0, 8);
  const ready = (data?.ready ?? []).slice(0, 8);
  return (
    <div className="board" style={me.business.brand.boardBackgroundUrl ? { backgroundImage: `url(${me.business.brand.boardBackgroundUrl})` } : undefined}>
      <header className="b-head">
        <span className="row"><Logo url={logoFor(me.business.brand, true)} name={me.business.name} size={40} /><strong>{me.business.name}</strong></span>
        <span className="row"><span className={`live ${online ? 'is-on' : ''}`}><i />{t('common.live')}</span><Clock /></span>
      </header>
      <main className="b-cols">
        <section className="b-col b-cooking">
          <h2><span className="b-ico">⏱</span>{t('board.cooking')}<small>{t('board.cookingSub')}</small></h2>
          <div className="b-list">{cooking.map((n) => <div key={n} className="b-num">{n}</div>)}</div>
        </section>
        <section className="b-col b-ready">
          <h2><span className="b-ico">✓</span>{t('board.ready')}<small>{t('board.readySub')}</small></h2>
          <div className="b-list">
            {ready.map((n, i) => <div key={n} className={`b-num${i === 0 ? ' is-new' : ''}`}>{n}{i === 0 && <span className="b-take">{t('board.take')}</span>}</div>)}
            {ready.length === 0 && <div className="b-num is-empty">—</div>}
          </div>
        </section>
      </main>
      {me.location.qrEnabled && qr && (
        <footer className="b-qr">
          <div className="b-qr-code"><QrCode value={qr.url} size={150} /></div>
          <div className="grow">
            <h3>{t('board.orderPhone')}</h3>
            <p>{t('board.orderPhoneSub')}</p>
            <p className="b-steps"><span>① {t('board.step1')}</span><span>② {t('board.step2')}</span><span>③ {t('board.step3')}</span></p>
          </div>
          <div className="b-timer">
            <small>{t('board.codeChanges')}</small>
            <b>0:{String(left).padStart(2, '0')}</b>
            <span className="b-bar"><i style={{ width: `${(left / 30) * 100}%` }} /></span>
            <small>{t('board.onlyHere')}</small>
          </div>
        </footer>
      )}
    </div>
  );
}

// --- Киоск -----------------------------------------------------------------------

function Kiosk({ me }: { me: DeviceMe }) {
  const { t, text, price, locale, setLocale } = useI18n();
  const { data: menu, error: menuErr, reload } = useLoad<PublicMenu>('/api/menu');
  const cart = useCart('kiosk', false);
  const [step, setStep] = useState<'start' | 'menu' | 'cart' | 'done'>('start');
  const [cat, setCat] = useState<string | null>(null);
  const [open, setOpen] = useState<MenuItem | null>(null);
  const [done, setDone] = useState<{ number: number; createdAt: string; printed: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(12);
  const [offline, setOffline] = useState(!navigator.onLine);
  const byId = useMemo(() => new Map(menu?.items.map((i) => [i.id, i]) ?? []), [menu]);

  const restart = () => { cart.clear(); setStep('start'); setOpen(null); setDone(null); setError(null); setLocale(me.business.defaultLocale); reload(); };
  useIdle(90_000, restart, step === 'menu' || step === 'cart');
  useEffect(() => {
    const on = () => setOffline(false); const off = () => setOffline(true);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    if (step !== 'done') return;
    setCountdown(12);
    const iv = setInterval(() => setCountdown((c) => { if (c <= 1) { restart(); return 12; } return c - 1; }), 1000);
    return () => clearInterval(iv);
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  const categories = menu?.categories ?? [];
  const current = cat ?? categories[0]?.id ?? null;
  const shown = current ? (categories.find((c) => c.id === current)?.itemIds ?? []).map((id) => byId.get(id)).filter(Boolean) as MenuItem[]
    : menu?.items ?? [];
  const count = cart.lines.reduce((s, l) => s + l.qty, 0);

  const order = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ order: { number: number; createdAt: string }; ticket: { escposBase64: string; printer: { host: string; port: number } | null } }>(
        '/api/device/kiosk/orders', { lines: cart.toApi(), locale });
      let printed = false;
      if (r.ticket.printer && window.QRBridge) {
        try { printed = window.QRBridge.printEscPos(r.ticket.printer.host, r.ticket.printer.port, r.ticket.escposBase64); } catch { printed = false; }
      }
      if (!printed && !window.QRBridge) { setTimeout(() => window.print(), 300); printed = true; }
      setDone({ number: r.order.number, createdAt: r.order.createdAt, printed });
      cart.clear();
      setStep('done');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  if (offline || menuErr) {
    return <div className="kiosk kiosk-start"><h1>{t('kiosk.offline')}</h1></div>;
  }
  if (step === 'start') {
    return (
      <div className="kiosk kiosk-start" onClick={() => setStep('menu')}>
        <Logo url={logoFor(me.business.brand, false)} name={me.business.name} size={72} />
        <p className="muted">{me.business.name}</p>
        <h1>{t('kiosk.orderHere')}</h1>
        <p className="muted">{t('kiosk.subtitle')}</p>
        <div className="kiosk-hero">{menu?.items.find((i) => i.badgeHit)?.imageUrl && <img src={menu.items.find((i) => i.badgeHit)!.imageUrl!} alt="" />}</div>
        <Button big>{t('kiosk.tap')} ›</Button>
        <div className="row" onClick={(e) => e.stopPropagation()}><LangSwitch locales={me.business.enabledLocales} /></div>
        <p className="muted small">{t('kiosk.footer')}</p>
      </div>
    );
  }
  const head = (
    <header className="kiosk-head">
      <span className="row"><Logo url={logoFor(me.business.brand, false)} name={me.business.name} size={32} /><strong>{me.business.name}</strong></span>
      <span className="row"><LangSwitch locales={me.business.enabledLocales} /><button className="btn btn-ghost btn-sm" onClick={restart}>↻ {t('kiosk.restart')}</button></span>
    </header>
  );
  if (step === 'done' && done) {
    return (
      <div className="kiosk kiosk-done">
        <div className="big-check dark">✓</div>
        <h1>{done.printed ? t('kiosk.takeTicket') : t('kiosk.printFailed')}</h1>
        <p className="muted">{t('kiosk.sentToKitchen')}</p>
        <p className="muted small upper">{t('cust.yourNumber')}</p>
        <div className="huge-number">{done.number}</div>
        <p className="muted small">{me.business.name} · {new Date(done.createdAt).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })}</p>
        <div className="alert alert-info">🖥 {t('kiosk.watchScreen')}</div>
        <Button big onClick={restart}>{t('common.done')}</Button>
        <p className="muted small">{t('kiosk.newIn', { s: countdown })}</p>
        <div className="print-only ticket">
          <h2>{me.business.name}</h2><p>{me.location.name}</p><hr /><p>{t('cust.yourNumber')}</p>
          <div className="ticket-num">{done.number}</div><hr /><p>{t('kiosk.notFiscal')}</p>
        </div>
      </div>
    );
  }
  if (step === 'cart') {
    return (
      <div className="kiosk">
        {head}
        <main className="kiosk-cart">
          <h1>{t('kiosk.yourOrder')}</h1>
          {cart.lines.map((l) => {
            const item = byId.get(l.itemId);
            if (!item) return null;
            return (
              <div key={l.key} className="cart-line">
                <ItemImage url={item.imageUrl} name={text(item.name)} size={64} />
                <div className="grow">
                  <strong>{text(item.name)}</strong>
                  {l.addons.length > 0 && <div className="muted small">+ {l.addons.map((a) => text(item.addons.find((x) => x.id === a.componentId)?.name ?? {})).join(', + ')}</div>}
                  {l.removed.length > 0 && <div className="muted small">{t('cust.noWord')} {l.removed.map((r) => text(item.base.find((b) => b.id === r)?.name ?? {}).toLowerCase()).join(', ')}</div>}
                </div>
                <div className="col-end"><strong>{price(lineTotal(item, l.qty, l.addons))}</strong><Stepper value={l.qty} onChange={(q) => cart.setQty(l.key, q)} /></div>
              </div>
            );
          })}
          <div className="cart-total"><span>{t('common.total')}</span><strong>{price(cartTotal(cart, byId))}</strong></div>
          <div className="alert alert-info">🖨 {t('kiosk.printHint')}</div>
          <ErrorBox error={error} />
        </main>
        <footer className="kiosk-foot">
          <Button kind="ghost" big onClick={() => setStep('menu')}>‹ {t('cust.menu')}</Button>
          <Button big className="grow" disabled={busy || count === 0} onClick={order}>
            <span>{t('kiosk.order')}</span><span>{price(cartTotal(cart, byId))}</span>
          </Button>
        </footer>
      </div>
    );
  }
  return (
    <div className="kiosk">
      {head}
      <div className="kiosk-body">
        <nav className="kiosk-rail">
          {categories.map((c) => <button key={c.id} className={c.id === current ? 'is-on' : ''} onClick={() => setCat(c.id)}>{text(c.name)}</button>)}
        </nav>
        <main className="kiosk-main">
          <h1>{current ? text(categories.find((c) => c.id === current)!.name) : t('cust.menu')}</h1>
          <p className="muted small">{t('kiosk.addonsAfter')}</p>
          <div className="kiosk-grid">
            {shown.map((i) => (
              <button key={i.id} className="kiosk-card" onClick={() => setOpen(i)}>
                {i.badgeHit && <span className="badge-hit">{t('kiosk.hit')}</span>}
                <ItemImage url={i.imageUrl} name={text(i.name)} size={140} />
                <strong>{text(i.name)}</strong>
                <span>{price(i.priceCents)}</span>
                <span className="plus plus-dark">+</span>
              </button>
            ))}
          </div>
        </main>
      </div>
      {count > 0 && (
        <footer className="kiosk-foot">
          <div className="kiosk-summary" onClick={() => setStep('cart')}>
            <div><strong>{t('kiosk.yourOrder')}</strong><small>{t('kiosk.items', { n: count })} · {price(cartTotal(cart, byId))}</small></div>
            <span className="btn btn-light">{t('kiosk.toOrder')} ›</span>
          </div>
        </footer>
      )}
      {open && <ItemSheet item={open} allowNote={false} onClose={() => setOpen(null)} onAdd={(l) => { cart.add(l); setOpen(null); }} />}
    </div>
  );
}
