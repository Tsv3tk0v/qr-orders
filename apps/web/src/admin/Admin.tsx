import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { I18nText } from '@qr/shared';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useI18n, type TKey } from '../lib/i18n';
import { logoFor } from '../lib/theme';
import { Button, ErrorBox, Field, Input, LangSwitch, Logo, Notice, Toggle } from '../components/ui';
import { AuthGate, type Me } from './Login';
import { Components, Filters, Import, MenuPage } from './MenuAdmin';
import { Appearance, Locations } from './SettingsAdmin';
import type { BusinessCtx } from '../App';

const NAV: { to: string; key: TKey; icon: string; perm: string }[] = [
  { to: '', key: 'nav.dashboard', icon: '📊', perm: 'orders.handle' },
  { to: 'orders', key: 'nav.orders', icon: '🧾', perm: 'orders.handle' },
  { to: 'menu', key: 'nav.menu', icon: '🍽', perm: 'menu.manage' },
  { to: 'filters', key: 'nav.filters', icon: '🏷', perm: 'menu.manage' },
  { to: 'components', key: 'nav.components', icon: '➕', perm: 'menu.manage' },
  { to: 'import', key: 'nav.import', icon: '📥', perm: 'menu.manage' },
  { to: 'appearance', key: 'nav.appearance', icon: '🎨', perm: 'settings.manage' },
  { to: 'locations', key: 'nav.locations', icon: '📺', perm: 'settings.manage' },
  { to: 'users', key: 'nav.users', icon: '👥', perm: 'users.manage' },
  { to: 'blacklist', key: 'nav.blacklist', icon: '⛔', perm: 'orders.handle' },
  { to: 'security', key: 'nav.security', icon: '🛡', perm: 'orders.handle' },
  { to: 'reports', key: 'nav.reports', icon: '📈', perm: 'reports.read' },
];

export function Admin({ ctx }: { ctx: BusinessCtx }) {
  return <AuthGate>{(me) => <Layout ctx={ctx} me={me} />}</AuthGate>;
}

function Layout({ ctx, me }: { ctx: BusinessCtx; me: Me }) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const can = (p: string) => me.permissions.includes(p);
  const logout = async () => { await api.post('/api/auth/logout'); location.reload(); };
  return (
    <div className="admin">
      <aside className={`admin-side${menuOpen ? ' is-open' : ''}`}>
        <div className="admin-brand">
          <Logo url={logoFor(ctx.business.brand, true)} name={ctx.business.name} size={40} />
          <div><strong>{ctx.business.name}</strong><small>{t('nav.business')}</small></div>
        </div>
        <nav onClick={() => setMenuOpen(false)}>
          {NAV.filter((n) => can(n.perm)).map((n) => (
            <NavLink key={n.to} to={`/admin/${n.to}`} end={n.to === ''}>{n.icon} {t(n.key)}</NavLink>
          ))}
        </nav>
        <div className="admin-user">
          <span className="avatar">{me.user.email[0]?.toUpperCase()}</span>
          <div className="grow"><strong>{me.user.name || me.user.email}</strong><small>{t(`users.role.${me.user.role}` as TKey)}</small></div>
        </div>
        <div className="row"><LangSwitch /><button className="btn btn-ghost btn-sm" onClick={logout}>{t('nav.logout')}</button></div>
      </aside>
      <button className="admin-burger" onClick={() => setMenuOpen(!menuOpen)} aria-label="menu">☰</button>
      <main className="admin-main">
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="orders" element={<Orders />} />
          <Route path="menu" element={<MenuPage />} />
          <Route path="filters" element={<Filters />} />
          <Route path="components" element={<Components />} />
          <Route path="import" element={<Import />} />
          <Route path="appearance" element={<Appearance ctx={ctx} />} />
          <Route path="locations" element={<Locations />} />
          <Route path="users" element={<Users me={me} />} />
          <Route path="blacklist" element={<Blacklist />} />
          <Route path="security" element={<Security />} />
          <Route path="reports" element={<Reports />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Sofia' });
const fmtTime = (iso: string) => new Date(iso).toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

interface Summary {
  days: { day: string; orders: number; collected: number; noShows: number; cancelled: number; revenueCents: number; avgPrepMinutes: number | null; kiosk: number }[];
  topItems: { name: I18nText; qty: number; revenueCents: number }[];
}

function Dashboard() {
  const { t, price } = useI18n();
  const d = today();
  const { data } = useLoad<Summary>(`/api/admin/reports/summary?from=${d}&to=${d}`);
  const { data: pending } = useLoad<unknown[]>('/api/admin/menu/items?approval=pending');
  const day = data?.days[0];
  return (
    <div className="page">
      <h1>{t('dash.today')}</h1>
      <div className="stats">
        <Stat label={t('dash.orders')} value={day?.orders ?? 0} />
        <Stat label={t('dash.collected')} value={day?.collected ?? 0} />
        <Stat label={t('dash.noShows')} value={day?.noShows ?? 0} />
        <Stat label={t('dash.revenue')} value={price(day?.revenueCents ?? 0)} />
        <Stat label={t('dash.avgPrep')} value={day?.avgPrepMinutes ? `${day.avgPrepMinutes} ${t('common.minutes')}` : '—'} />
      </div>
      {(pending?.length ?? 0) > 0 && <Notice kind="warn">{t('dash.pending')}: {pending!.length} — <NavLink to="/admin/menu">{t('nav.menu')}</NavLink></Notice>}
      <div className="card">
        <h2>{t('dash.start')}</h2>
        <ol className="steps-list">
          <li><NavLink to="/admin/menu">{t('dash.step1')}</NavLink></li>
          <li><NavLink to="/admin/locations">{t('dash.step2')}</NavLink></li>
          <li>{t('dash.step3')}</li>
          <li>{t('dash.step4')}</li>
        </ol>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div className="stat"><small>{label}</small><b>{value}</b></div>;
}

interface OrderRow { id: string; number: number; publicCode: string; channel: string; status: string; totalCents: number; createdAt: string; itemCount: number; canBlock: boolean }

function Orders() {
  const { t, price } = useI18n();
  const [day, setDay] = useState(today());
  const { data, reload } = useLoad<OrderRow[]>(`/api/admin/orders?day=${day}`);
  const [msg, setMsg] = useState('');
  const block = async (id: string) => {
    if (!confirm(t('common.confirmDelete'))) return;
    await api.post(`/api/admin/orders/${id}/block`); setMsg(t('orders.blocked')); reload();
  };
  return (
    <div className="page">
      <div className="page-head"><h1>{t('orders.title')}</h1>
        <Field label={t('orders.day')}><Input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field></div>
      {msg && <Notice kind="ok">{msg}</Notice>}
      <table className="table">
        <thead><tr><th>{t('orders.number')}</th><th>{t('orders.time')}</th><th>{t('orders.channel')}</th><th>{t('orders.status')}</th><th>{t('cust.items', { n: '' })}</th><th>{t('orders.total')}</th><th /></tr></thead>
        <tbody>
          {data?.map((o) => (
            <tr key={o.id}>
              <td><b>{o.number}</b> <small className="mono muted">{o.publicCode}</small></td>
              <td>{fmtTime(o.createdAt)}</td>
              <td>{o.channel === 'kiosk' ? t('device.kind.kiosk') : 'QR'}</td>
              <td><span className={`status-pill s-${o.status}`}>{t(`status.${o.status}` as TKey)}</span></td>
              <td>{o.itemCount}</td>
              <td>{price(o.totalCents)}</td>
              <td>{o.canBlock && <button className="link-btn danger" onClick={() => block(o.id)}>{t('orders.block')}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Blacklist() {
  const { t } = useI18n();
  const { data, reload } = useLoad<{ id: string; noShows: number; blockedUntil: string; reason: string }[]>('/api/admin/blacklist');
  const { data: rules, reload: reloadRules } = useLoad<{ noshowBlockThreshold: number; blockDays: number }>('/api/admin/business');
  const [error, setError] = useState<unknown>(null);
  const save = (patch: object) => api.patch('/api/admin/business', patch).then(reloadRules).catch(setError);
  return (
    <div className="page">
      <h1>{t('bl.title')}</h1>
      <Notice>{t('bl.hint')}</Notice>
      {rules && (
        <div className="card form-grid">
          <h2>{t('bl.rules')}</h2>
          <Field label={t('bl.threshold')}><Input type="number" min={1} max={20} defaultValue={rules.noshowBlockThreshold}
            onBlur={(e) => save({ noshowBlockThreshold: Number(e.target.value) })} /></Field>
          <Field label={t('bl.days')}><Input type="number" min={1} max={365} defaultValue={rules.blockDays}
            onBlur={(e) => save({ blockDays: Number(e.target.value) })} /></Field>
          <ErrorBox error={error} />
        </div>
      )}
      {data?.length === 0 && <p className="muted">{t('bl.empty')}</p>}
      {(data?.length ?? 0) > 0 && (
        <table className="table">
          <thead><tr><th>ID</th><th>{t('bl.noShows')}</th><th>{t('bl.reason')}</th><th>{t('bl.until')}</th><th /></tr></thead>
          <tbody>{data!.map((b) => (
            <tr key={b.id}><td className="mono">{b.id.slice(0, 10)}…</td><td>{b.noShows}</td>
              <td>{t(`bl.reason.${b.reason}` as TKey)}</td><td>{fmtTime(b.blockedUntil)}</td>
              <td><button className="link-btn" onClick={() => api.del(`/api/admin/blacklist/${b.id}`).then(reload)}>{t('bl.unblock')}</button></td></tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

function Reports() {
  const { t, text, price } = useI18n();
  const [from, setFrom] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 6); return d.toLocaleDateString('en-CA'); });
  const [to, setTo] = useState(today());
  const { data } = useLoad<Summary>(`/api/admin/reports/summary?from=${from}&to=${to}`);
  const { data: rules, reload } = useLoad<{ dailyEmail: boolean; dailyEmailHour: number }>('/api/admin/business');
  const save = (patch: object) => api.patch('/api/admin/business', patch).then(reload);
  return (
    <div className="page">
      <div className="page-head"><h1>{t('rep.title')}</h1>
        <div className="row">
          <Field label={t('rep.from')}><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label={t('rep.to')}><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div></div>
      {rules && (
        <div className="card row">
          <Toggle checked={rules.dailyEmail} onChange={(v) => save({ dailyEmail: v })} label={t('rep.dailyEmail')} />
          <Field label={t('rep.hour')}><Input type="number" min={0} max={23} defaultValue={rules.dailyEmailHour}
            onBlur={(e) => save({ dailyEmailHour: Number(e.target.value) })} /></Field>
        </div>
      )}
      {data && data.days.length === 0 && <p className="muted">{t('rep.empty')}</p>}
      {data && data.days.length > 0 && (
        <>
          <table className="table">
            <thead><tr><th>{t('rep.day')}</th><th>{t('dash.orders')}</th><th>{t('rep.kiosk')}</th><th>{t('dash.collected')}</th>
              <th>{t('dash.noShows')}</th><th>{t('rep.cancelled')}</th><th>{t('dash.revenue')}</th><th>{t('dash.avgPrep')}</th></tr></thead>
            <tbody>{data.days.map((d) => (
              <tr key={d.day}><td>{d.day}</td><td>{d.orders}</td><td>{d.kiosk}</td><td>{d.collected}</td><td>{d.noShows}</td>
                <td>{d.cancelled}</td><td>{price(d.revenueCents)}</td><td>{d.avgPrepMinutes ?? '—'}</td></tr>
            ))}</tbody>
          </table>
          <h2>{t('rep.top')}</h2>
          <table className="table">
            <thead><tr><th>{t('comp.name')}</th><th>{t('rep.qty')}</th><th>{t('dash.revenue')}</th></tr></thead>
            <tbody>{data.topItems.map((i, k) => <tr key={k}><td>{text(i.name)}</td><td>{i.qty}</td><td>{price(i.revenueCents)}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </div>
  );
}

interface UserRow { id: string; email: string; name: string; role: string; active: boolean; totpEnabled: boolean }

function Users({ me }: { me: Me }) {
  const { t } = useI18n();
  const { data, reload } = useLoad<UserRow[]>('/api/admin/users');
  const [form, setForm] = useState({ email: '', name: '', role: 'staff', password: '' });
  const [error, setError] = useState<unknown>(null);
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.post('/api/admin/users', form); setForm({ email: '', name: '', role: 'staff', password: '' }); reload(); } catch (err) { setError(err); }
  };
  const patch = (id: string, body: object) => api.patch(`/api/admin/users/${id}`, body).then(reload).catch(setError);
  return (
    <div className="page">
      <h1>{t('users.title')}</h1>
      <table className="table">
        <thead><tr><th>{t('auth.email')}</th><th>{t('users.role')}</th><th>{t('users.twofa')}</th><th>{t('users.active')}</th><th /></tr></thead>
        <tbody>{data?.map((u) => (
          <tr key={u.id} className={u.active ? '' : 'is-dim'}>
            <td>{u.email}<br /><small className="muted">{u.name}</small></td>
            <td>{u.id === me.user.id ? t(`users.role.${u.role}` as TKey) : (
              <select className="input" value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })}>
                {['owner', 'manager', 'staff'].map((r) => <option key={r} value={r}>{t(`users.role.${r}` as TKey)}</option>)}
              </select>)}</td>
            <td>{u.totpEnabled ? '✓' : '—'}</td>
            <td>{u.active ? '✓' : '—'}</td>
            <td>{u.id !== me.user.id && <span className="row">
              <button className="link-btn" onClick={() => patch(u.id, { reset2fa: true })}>{t('users.reset2fa')}</button>
              <button className="link-btn" onClick={() => {
                const pw = prompt(t('users.tempPassword'));
                if (pw) api.patch(`/api/admin/users/${u.id}`, { password: pw }).then(() => { alert(t('users.passwordSet')); reload(); }).catch(setError);
              }}>{t('users.newPassword')}</button>
              <button className="link-btn" onClick={() => patch(u.id, { active: !u.active })}>{u.active ? t('users.deactivate') : t('users.activate')}</button>
            </span>}</td>
          </tr>
        ))}</tbody>
      </table>
      <form className="card form-grid" onSubmit={create}>
        <h2>{t('users.new')}</h2>
        <Field label={t('auth.email')}><Input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        <Field label={t('users.name')}><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label={t('users.role')}>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {['owner', 'manager', 'staff'].map((r) => <option key={r} value={r}>{t(`users.role.${r}` as TKey)}</option>)}
          </select></Field>
        <Field label={t('users.tempPassword')}><Input type="text" minLength={10} required value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <ErrorBox error={error} />
        <Button>{t('common.add')}</Button>
      </form>
    </div>
  );
}

function Security() {
  const { t } = useI18n();
  const { data: log, error: logErr } = useLoad<{ id: string; action: string; actorEmail: string | null; ip: string | null; createdAt: string; targetType: string | null }[]>('/api/admin/audit');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  const change = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setOk(false);
    try { await api.post('/api/auth/password', pw); setOk(true); setPw({ current: '', next: '' }); } catch (err) { setError(err); }
  };
  return (
    <div className="page">
      <h1>{t('sec.title')}</h1>
      <form className="card form-grid" onSubmit={change}>
        <h2>{t('auth.changePassword')}</h2>
        <Field label={t('auth.current')}><Input type="password" required value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
        <Field label={t('auth.new')}><Input type="password" minLength={10} required value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
        <ErrorBox error={error} />
        {ok && <Notice kind="ok">{t('common.saved')}</Notice>}
        <Button>{t('common.save')}</Button>
      </form>
      {!logErr && (
        <>
          <h2>{t('sec.audit')}</h2>
          <table className="table">
            <thead><tr><th>{t('sec.when')}</th><th>{t('sec.who')}</th><th>{t('sec.action')}</th><th>{t('sec.ip')}</th></tr></thead>
            <tbody>{log?.map((l) => <tr key={l.id}><td>{fmtTime(l.createdAt)}</td><td>{l.actorEmail ?? '—'}</td>
              <td className="mono small">{l.action}</td><td className="mono small">{l.ip ?? ''}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </div>
  );
}
