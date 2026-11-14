import { useState } from 'react';
import { api } from '../lib/api';
import { useLoad } from '../lib/hooks';
import { useI18n } from '../lib/i18n';
import { Button, ErrorBox, Field, Input, LangSwitch, Notice, Toggle } from '../components/ui';
import { AuthGate } from '../admin/Login';

export function Platform({ baseDomain }: { baseDomain: string }) {
  const { data: status } = useLoad<{ needsSetup: boolean }>('/api/setup/status');
  const [setupDone, setSetupDone] = useState(false);
  if (!status) return null;
  if (status.needsSetup && !setupDone) return <Setup onDone={() => setSetupDone(true)} />;
  return <AuthGate>{() => <Businesses baseDomain={baseDomain} />}</AuthGate>;
}

function Setup({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ code: '', email: '', password: '', name: '' });
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try { await api.post('/api/setup', f); onDone(); } catch (err) { setError(err); }
  };
  return (
    <div className="auth-page">
      <div className="auth-top"><LangSwitch /></div>
      <form className="auth-card" onSubmit={submit}>
        <h1>{t('setup.title')}</h1>
        <p className="muted">{t('setup.hint')}</p>
        <Field label={t('setup.code')}><Input className="mono" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label={t('users.name')}><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('auth.email')}><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t('auth.new')}><Input type="password" minLength={10} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <ErrorBox error={error} />
        <Button big>{t('setup.create')}</Button>
      </form>
    </div>
  );
}

interface Biz { id: string; slug: string; name: string; status: string; createdAt: string }

function Businesses({ baseDomain }: { baseDomain: string }) {
  const { t } = useI18n();
  const { data, reload } = useLoad<Biz[]>('/api/platform/businesses');
  const [f, setF] = useState({ slug: '', name: '', ownerEmail: '', ownerPassword: '', locSlug: 'center', locName: '', kiosk: false });
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<string | null>(null);
  const port = location.port ? `:${location.port}` : '';
  const url = (slug: string) => `${location.protocol}//${slug}.${baseDomain}${port}/admin`;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    try {
      await api.post('/api/platform/businesses', {
        slug: f.slug, name: f.name, owner: { email: f.ownerEmail, password: f.ownerPassword },
        location: { slug: f.locSlug, name: f.locName || f.name, kioskEnabled: f.kiosk },
      });
      setCreated(url(f.slug)); reload();
    } catch (err) { setError(err); }
  };
  const logout = async () => { await api.post('/api/auth/logout'); location.reload(); };
  return (
    <div className="page platform">
      <div className="page-head"><h1>{t('plat.businesses')}</h1><div className="row"><LangSwitch /><Button kind="ghost" onClick={logout}>{t('nav.logout')}</Button></div></div>
      <table className="table">
        <tbody>{data?.map((b) => (
          <tr key={b.id}><td><strong>{b.name}</strong><br /><small className="mono muted">{b.slug}.{baseDomain}</small></td>
            <td>{b.status}</td>
            <td className="row"><a className="btn btn-ghost btn-sm" href={url(b.slug)} target="_blank" rel="noreferrer">{t('plat.open')} ↗</a>
              <button className="link-btn" onClick={async () => {
                const email = prompt(t('plat.owner')); if (!email) return;
                const password = prompt(t('plat.ownerPass')); if (!password) return;
                try { await api.post(`/api/platform/businesses/${b.id}/owner`, { email, password }); alert(t('plat.ownerResetDone')); }
                catch (e) { setError(e); }
              }}>{t('plat.ownerReset')}</button></td></tr>
        ))}</tbody>
      </table>
      {created && <Notice kind="ok">{t('plat.created')} <a href={created} target="_blank" rel="noreferrer" className="mono">{created}</a></Notice>}
      <form className="card form-grid" onSubmit={submit}>
        <h2>{t('plat.new')}</h2>
        <Field label={t('plat.name')}><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={t('plat.slug')} hint={f.slug ? `${f.slug}.${baseDomain}` : undefined}>
          <Input required pattern="[a-z0-9]([a-z0-9\-]{0,30}[a-z0-9])?" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} /></Field>
        <Field label={t('plat.owner')}><Input type="email" required value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} /></Field>
        <Field label={t('plat.ownerPass')}><Input minLength={10} required value={f.ownerPassword} onChange={(e) => setF({ ...f, ownerPassword: e.target.value })} /></Field>
        <h3>{t('plat.location')}</h3>
        <Field label={t('plat.locName')}><Input value={f.locName} placeholder={f.name} onChange={(e) => setF({ ...f, locName: e.target.value })} /></Field>
        <Field label={t('plat.locSlug')}><Input required value={f.locSlug} onChange={(e) => setF({ ...f, locSlug: e.target.value.toLowerCase() })} /></Field>
        <Toggle checked={f.kiosk} onChange={(kiosk) => setF({ ...f, kiosk })} label={t('loc.kiosk')} />
        <ErrorBox error={error} />
        <Button kind="accent">{t('common.add')}</Button>
      </form>
    </div>
  );
}
