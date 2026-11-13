import { useEffect, useMemo, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { I18nText, Locale } from '@qr/shared';
import { api } from '../lib/api';
import { useCart, type Cart } from '../lib/cart';
import { useLoad, useNow, useStream } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { logoFor } from '../lib/theme';
import { Button, ErrorBox, ItemImage, LangSwitch, Logo, Notice, Sheet, Stepper } from '../components/ui';
import type { BusinessCtx } from '../App';

// --- Типове на менюто (както ги връща /api/menu) ---------------------------------
export interface MenuItem {
  id: string; name: I18nText; description: I18nText; priceCents: number; imageUrl: string | null;
  badgeHit: boolean; prepMinutes: number | null; allergens: string[]; maxAddons: number | null;
  base: { id: string; name: I18nText; removable: boolean }[];
  addons: { id: string; name: I18nText; priceCents: number; maxQty: number }[];
}
export interface PublicMenu {
  locales: Locale[]; defaultLocale: Locale; currency: string;
  categories: { id: string; name: I18nText; itemIds: string[] }[];
  items: MenuItem[];
}

export function lineTotal(item: MenuItem, qty: number, addons: { componentId: string; qty: number }[]) {
  const extra = addons.reduce((s, a) => s + (item.addons.find((x) => x.id === a.componentId)?.priceCents ?? 0) * a.qty, 0);
  return (item.priceCents + extra) * qty;
}

export function cartTotal(cart: Cart, byId: Map<string, MenuItem>) {
  return cart.lines.reduce((s, l) => { const i = byId.get(l.itemId); return i ? s + lineTotal(i, l.qty, l.addons) : s; }, 0);
}

export function Customer({ ctx }: { ctx: BusinessCtx }) {
  const cart = useCart(`cart:${ctx.business.slug}`);
  return (
    <div className="cust">
      <Routes>
        <Route path="/q/:token" element={<QrEntry />} />
        <Route path="/o/:code" element={<Status ctx={ctx} />} />
        <Route path="/cart" element={<CartScreen ctx={ctx} cart={cart} />} />
        <Route path="*" element={<MenuScreen ctx={ctx} cart={cart} />} />
      </Routes>
    </div>
  );
}

/** Сканиран QR: отваря сесия и връща към менюто. */
function QrEntry() {
  const { token } = useParams();
  const nav = useNavigate();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.post('/api/session', { qrToken: token }).then(() => nav('/', { replace: true })).catch(setError);
  }, [token, nav]);
  const { t } = useI18n();
  return <div className="cust-center">{error ? <ErrorBox error={error} /> : <p>{t('common.loading')}</p>}</div>;
}

interface SessionInfo { active: boolean; expiresAt?: string; order?: { publicCode: string; status: string } | null }

function MenuScreen({ ctx, cart }: { ctx: BusinessCtx; cart: Cart }) {
  const { t, text, price } = useI18n();
  const { data: menu, error } = useLoad<PublicMenu>('/api/menu');
  const { data: session } = useLoad<SessionInfo>('/api/session');
  const [filter, setFilter] = useState<string>('all');
  const [open, setOpen] = useState<MenuItem | null>(null);
  const now = useNow(1000);
  const byId = useMemo(() => new Map(menu?.items.map((i) => [i.id, i]) ?? []), [menu]);

  if (error) return <div className="cust-center"><ErrorBox error={error} /></div>;
  if (!menu) return <div className="cust-center">{t('common.loading')}</div>;

  const left = session?.expiresAt ? Math.max(0, new Date(session.expiresAt).getTime() - now.getTime()) : 0;
  const canOrder = Boolean(session?.active && left > 0);
  const mmss = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
  const hit = menu.items.find((i) => i.badgeHit);
  const sections = filter === 'all' ? menu.categories : menu.categories.filter((c) => c.id === filter);
  const inCategory = new Set(menu.categories.flatMap((c) => c.itemIds));
  const loose = filter === 'all' ? menu.items.filter((i) => !inCategory.has(i.id)) : [];
  const count = cart.lines.reduce((s, l) => s + l.qty, 0);
  const prep = ctx.location?.prepMinutes ?? 10;

  return (
    <>
      <header className="cust-head">
        <div className="row-between">
          <Logo url={logoFor(ctx.business.brand, false)} name={ctx.business.name} />
          <LangSwitch locales={menu.locales} />
        </div>
        <h1>{ctx.business.name}</h1>
        <p className="muted">{t('cust.pickup')} · {t('cust.readyIn', { min: `${prep}–${prep + 4}` })}</p>
        {session?.order && ['pending', 'accepted', 'ready'].includes(session.order.status) && (
          <Link className="pill-banner is-accent" to={`/o/${session.order.publicCode}`}>
            {t('cust.yourNumber')} → {t(`status.${session.order.status}` as 'status.pending')}
          </Link>
        )}
        {canOrder
          ? <div className="pill-banner"><i className="dot-green" />{t('cust.scanned')}<span className="muted">{t('cust.left', { time: mmss })}</span></div>
          : <div className="pill-banner is-muted">{session?.active === false && session.expiresAt === undefined
            ? t('cust.scanToOrder') : t('cust.sessionExpired')}</div>}
      </header>

      <nav className="chips" aria-label={t('cust.menu')}>
        <button className={filter === 'all' ? 'is-on' : ''} onClick={() => setFilter('all')}>{t('common.all')}</button>
        {menu.categories.map((c) => (
          <button key={c.id} className={filter === c.id ? 'is-on' : ''} onClick={() => setFilter(c.id)}>{text(c.name)}</button>
        ))}
      </nav>

      {hit && filter === 'all' && (
        <button className="hero" onClick={() => setOpen(hit)}>
          <div>
            <span className="hero-kicker">{t('cust.hit')}</span>
            <h2>{text(hit.name)}</h2>
            <span className="muted">{price(hit.priceCents)}</span>
          </div>
          <ItemImage url={hit.imageUrl} name={text(hit.name)} size={130} />
          <span className="plus plus-dark">+</span>
        </button>
      )}

      {sections.map((c) => (
        <section key={c.id} className="menu-section">
          <h3>{text(c.name)}</h3>
          {c.itemIds.map((id) => byId.get(id)).filter(Boolean).map((i) => <ItemRow key={i!.id} item={i!} onOpen={setOpen} />)}
        </section>
      ))}
      {loose.length > 0 && (
        <section className="menu-section">
          {menu.categories.length > 0 && <h3>{t('menu.noCategory')}</h3>}
          {loose.map((i) => <ItemRow key={i.id} item={i} onOpen={setOpen} />)}
        </section>
      )}

      {count > 0 && (
        <Link to="/cart" className="cart-bar">
          <span className="cart-count">{count}</span>
          <span>{t('cust.cart')}</span>
          <strong>{price(cartTotal(cart, byId))}</strong>
        </Link>
      )}
      {open && <ItemSheet item={open} onClose={() => setOpen(null)} onAdd={(l) => { cart.add(l); setOpen(null); }} />}
    </>
  );
}

function ItemRow({ item, onOpen }: { item: MenuItem; onOpen: (i: MenuItem) => void }) {
  const { text, price } = useI18n();
  return (
    <button className="item-row" onClick={() => onOpen(item)}>
      <ItemImage url={item.imageUrl} name={text(item.name)} />
      <span className="item-row-body">
        <strong>{text(item.name)}</strong>
        <span className="muted clamp">{text(item.description)}</span>
        <b>{price(item.priceCents)}</b>
      </span>
      <span className="plus">+</span>
    </button>
  );
}

/** Продукт: добавки, „без“, бележка, количество. Ползва се и в киоска. */
export function ItemSheet({ item, onClose, onAdd, allowNote = true }: {
  item: MenuItem; onClose: () => void; allowNote?: boolean;
  onAdd: (l: { itemId: string; qty: number; removed: string[]; addons: { componentId: string; qty: number }[]; note?: string }) => void;
}) {
  const { t, text, price } = useI18n();
  const [qty, setQty] = useState(1);
  const [addons, setAddons] = useState<Record<string, number>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const chosen = Object.entries(addons).filter(([, q]) => q > 0).map(([componentId, q]) => ({ componentId, qty: q }));
  const used = chosen.reduce((s, a) => s + a.qty, 0);
  const limit = item.maxAddons ?? Infinity;
  const removable = item.base.filter((b) => b.removable);

  return (
    <Sheet onClose={onClose}>
      <div className="sheet-hero"><ItemImage url={item.imageUrl} name={text(item.name)} size={200} /></div>
      <div className="sheet-body">
        <h2>{text(item.name)}</h2>
        <p className="price-lg">{price(item.priceCents)}</p>
        {text(item.description) && <p className="muted">{text(item.description)}</p>}
        {item.allergens.length > 0 && (
          <p className="muted small">ⓘ {t('cust.allergens')}: {item.allergens.map((a) => t(`allergen.${a}` as 'allergen.milk').toLowerCase()).join(', ')}</p>
        )}
        {item.addons.length > 0 && (
          <div className="opt-group">
            <div className="opt-head"><span>{t('cust.addons')}</span>
              <span className="muted">{item.maxAddons ? t('cust.upTo', { n: item.maxAddons }) : t('common.optional')}</span></div>
            {item.addons.map((a) => {
              const q = addons[a.id] ?? 0;
              const full = used >= limit && q === 0;
              return (
                <div key={a.id} className={`opt-row${full ? ' is-disabled' : ''}`}>
                  {a.maxQty > 1 ? (
                    <Stepper value={q} max={Math.min(a.maxQty, q + (limit - used))} onChange={(v) => setAddons({ ...addons, [a.id]: v })} />
                  ) : (
                    <input type="checkbox" className="check" checked={q > 0} disabled={full}
                      onChange={(e) => setAddons({ ...addons, [a.id]: e.target.checked ? 1 : 0 })} />
                  )}
                  <span className="grow">{text(a.name)}</span>
                  <span className="muted">+{price(a.priceCents)}</span>
                </div>
              );
            })}
          </div>
        )}
        {removable.length > 0 && (
          <div className="opt-group">
            <div className="opt-head"><span>{t('cust.without')}</span><span className="muted">{t('cust.removeFrom')}</span></div>
            <div className="chips chips-wrap">
              {removable.map((b) => {
                const on = removed.includes(b.id);
                return (
                  <button key={b.id} className={on ? 'is-on' : ''}
                    onClick={() => setRemoved(on ? removed.filter((x) => x !== b.id) : [...removed, b.id])}>
                    {on ? '✓ ' : ''}{t('cust.noWord')} {text(b.name).toLowerCase()}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {allowNote && (showNote
          ? <textarea className="input" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('cust.noteKitchen')} />
          : <button className="link-btn" onClick={() => setShowNote(true)}>+ {t('cust.noteKitchen')}</button>)}
      </div>
      <div className="sheet-foot">
        <Stepper value={qty} min={1} onChange={setQty} />
        <Button big className="grow" onClick={() => onAdd({ itemId: item.id, qty, removed, addons: chosen, note: note.trim() || undefined })}>
          <span>{t('cust.add')}</span><span>{price(lineTotal(item, qty, chosen))}</span>
        </Button>
      </div>
    </Sheet>
  );
}

function CartScreen({ ctx, cart }: { ctx: BusinessCtx; cart: Cart }) {
  const { t, text, price, locale } = useI18n();
  const nav = useNavigate();
  const { data: menu } = useLoad<PublicMenu>('/api/menu');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const byId = useMemo(() => new Map(menu?.items.map((i) => [i.id, i]) ?? []), [menu]);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      const o = await api.post<{ publicCode: string }>('/api/orders', { lines: cart.toApi(), locale });
      cart.clear();
      nav(`/o/${o.publicCode}`, { replace: true });
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  void ctx;
  return (
    <div className="cust-page">
      <Link to="/" className="back-link">‹ {t('cust.menu')}</Link>
      <h1>{t('cust.cart')}</h1>
      {cart.lines.length === 0 && <p className="muted">{t('cust.emptyCart')}</p>}
      {cart.lines.map((l) => {
        const item = byId.get(l.itemId);
        if (!item) return null;
        return (
          <div key={l.key} className="cart-line">
            <Stepper value={l.qty} onChange={(q) => cart.setQty(l.key, q)} />
            <div className="grow">
              <strong>{text(item.name)}</strong>
              {l.addons.length > 0 && <div className="muted small">+ {l.addons.map((a) =>
                `${a.qty > 1 ? `${a.qty}× ` : ''}${text(item.addons.find((x) => x.id === a.componentId)?.name ?? {})}`).join(', +')}</div>}
              {l.removed.length > 0 && <div className="muted small">{t('cust.noWord')} {l.removed.map((r) =>
                text(item.base.find((b) => b.id === r)?.name ?? {}).toLowerCase()).join(', ')}</div>}
              {l.note && <div className="muted small">✎ {l.note}</div>}
            </div>
            <strong>{price(lineTotal(item, l.qty, l.addons))}</strong>
          </div>
        );
      })}
      {cart.lines.length > 0 && (
        <>
          <div className="cart-total"><span>{t('common.total')}</span><strong>{price(cartTotal(cart, byId))}</strong></div>
          <Notice>🔔 {t('cust.followHint')}</Notice>
          <ErrorBox error={error} />
          <div className="sticky-foot">
            <Button big className="grow" disabled={busy} onClick={send}>
              <span>{t('cust.send')}</span><span>{price(cartTotal(cart, byId))}</span>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

interface OrderPublic {
  number: number; publicCode: string; status: string; totalCents: number; createdAt: string; readyAt: string | null;
  estimateMinutes: number; locationName: string;
  items: { qty: number; name: I18nText; removed: { name: I18nText }[]; addons: { name: I18nText; qty: number }[] }[];
}

function Status({ ctx }: { ctx: BusinessCtx }) {
  const { code } = useParams();
  const { t, text, price } = useI18n();
  const { data: o, online } = useStream<OrderPublic>(`/api/orders/${code}/stream`);
  const [gotIt, setGotIt] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notified, setNotified] = useState(false);

  // Вибрация и известие в браузъра, когато стане готова (без web push — той е Фаза 2).
  useEffect(() => {
    if (o?.status === 'ready' && !notified) {
      setNotified(true);
      navigator.vibrate?.([200, 100, 200]);
      if ('Notification' in window && Notification.permission === 'granted') {
        try { new Notification(ctx.business.name, { body: `№ ${o.number} — ${t('cust.readyTitle')}` }); } catch { /* */ }
      }
    }
  }, [o?.status, notified, o?.number, ctx.business.name, t]);
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  }, []);

  if (!o) return <div className="cust-center">{t('common.loading')}</div>;
  const items = o.items.reduce((s, i) => s + i.qty, 0);

  if (o.status === 'ready' || o.status === 'collected') {
    return (
      <div className="cust-page status-ready">
        <div className="big-check">✓</div>
        <div className="ready-number"><small>№</small>{o.number}</div>
        <h2>{gotIt || o.status === 'collected' ? t('cust.thanks') : t('cust.readyTitle')}</h2>
        <p className="muted">{t('cust.readyHint')}</p>
        <div className="card list">
          {o.readyAt && <div className="row-between"><span>{t('cust.preparedAt')}</span>
            <span>{new Date(o.readyAt).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })}</span></div>}
          <div className="row-between"><span>{t('cust.trackCode')}</span><span className="mono">{o.publicCode}</span></div>
        </div>
        {!gotIt && o.status === 'ready' && <div className="sticky-foot"><Button big className="grow" onClick={() => setGotIt(true)}>{t('cust.gotIt')}</Button></div>}
        {(gotIt || o.status === 'collected') && <Link className="btn btn-ghost" to="/">{t('cust.newOrder')}</Link>}
      </div>
    );
  }

  const steps = ['pending', 'accepted', 'cooking', 'ready'] as const;
  const at = o.status === 'pending' ? 0 : o.status === 'accepted' ? 2 : -1;
  const closed = ['rejected', 'cancelled', 'no_show'].includes(o.status);
  return (
    <div className="cust-page status">
      <header className="row-between">
        <span className="row"><Logo url={logoFor(ctx.business.brand, false)} name={ctx.business.name} size={28} /><strong>{ctx.business.name}</strong></span>
        <span className={`live ${online ? 'is-on' : ''}`}><i />{t('common.live')}</span>
      </header>
      <p className="muted center">{t('cust.yourNumber')}</p>
      <div className="huge-number">{o.number}</div>
      <div className="center"><span className={`status-pill s-${o.status}`}>● {t(`status.${o.status}` as 'status.pending')}</span></div>
      {!closed && <p className="muted center">{t('cust.estimate', { min: o.estimateMinutes })}</p>}
      {closed && <Notice kind="warn">{t('cust.rejectedHint')}</Notice>}
      {!closed && (
        <div className="progress">
          {steps.map((s, i) => <div key={s} className={`progress-step${i < at ? ' is-done' : i === at ? ' is-now' : ''}`}>
            <i /><span>{t(`cust.step.${s}`)}</span></div>)}
        </div>
      )}
      <div className="card list">
        <div className="row-between"><span>{t('cust.items', { n: items })}</span><span>{price(o.totalCents)}</span></div>
        {o.items.map((i, k) => <div key={k} className="muted small">{i.qty}× {text(i.name)}</div>)}
        <div className="row-between"><span>{t('cust.trackCode')}</span><span className="mono">{o.publicCode}</span></div>
      </div>
      {o.status === 'pending' && (
        <>
          <ErrorBox error={error} />
          <button className="link-btn danger" onClick={() => api.post('/api/orders/cancel').catch(setError)}>{t('cust.cancelOrder')}</button>
        </>
      )}
      <p className="muted center small">🖥 {t('cust.screenHint')}</p>
    </div>
  );
}
