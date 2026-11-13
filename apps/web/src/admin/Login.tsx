import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { Button, ErrorBox, Field, Input, LangSwitch, QrCode } from '../components/ui';

export interface Me {
  stage: 'enroll_2fa' | 'verify_2fa' | 'active';
  user: { id: string; email: string; name: string; role: string };
  permissions: string[];
}

/** Вход: парола → (настройка на) 2FA. Показва децата само при завършен вход. */
export function AuthGate({ children }: { children: (me: Me, reload: () => void) => ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const load = () => api.get<Me>('/api/auth/me').then(setMe).catch(() => setMe(null));
  useEffect(() => { void load(); }, []);
  if (me === undefined) return null;
  if (!me || me.stage !== 'active') return <Login me={me} onDone={load} />;
  return <>{children(me, load)}</>;
}

function Login({ me, onDone }: { me: Me | null; onDone: () => void }) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'password' | 'enroll_2fa' | 'verify_2fa'>(me?.stage === 'enroll_2fa' || me?.stage === 'verify_2fa' ? me.stage : 'password');
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (stage === 'enroll_2fa' && !enroll) api.post<{ secret: string; otpauthUrl: string }>('/api/auth/2fa/enroll').then(setEnroll).catch(setError);
  }, [stage, enroll]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.code === 'unauthenticated') setStage('password');
    } finally { setBusy(false); }
  };
  const submitPassword = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
    const r = await api.post<{ stage: 'enroll_2fa' | 'verify_2fa' }>('/api/auth/login', { email, password });
    setStage(r.stage);
  }); };
  const submitCode = (e: React.FormEvent) => { e.preventDefault(); void run(async () => {
    await api.post('/api/auth/2fa', { code });
    onDone();
  }); };

  return (
    <div className="auth-page">
      <div className="auth-top"><LangSwitch /></div>
      {stage === 'password' ? (
        <form className="auth-card" onSubmit={submitPassword}>
          <h1>{t('auth.title')}</h1>
          <Field label={t('auth.email')}><Input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label={t('auth.password')}><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <ErrorBox error={error} />
          <Button big disabled={busy}>{t('auth.login')}</Button>
        </form>
      ) : (
        <form className="auth-card" onSubmit={submitCode}>
          <h1>{stage === 'enroll_2fa' ? t('auth.enrollTitle') : t('auth.verifyTitle')}</h1>
          <p className="muted">{stage === 'enroll_2fa' ? t('auth.enrollHint') : t('auth.verifyHint')}</p>
          {stage === 'enroll_2fa' && enroll && (
            <div className="center">
              <QrCode value={enroll.otpauthUrl} size={200} />
              <p className="muted small">{t('auth.manualKey')}: <code className="mono">{enroll.secret.match(/.{1,4}/g)?.join(' ')}</code></p>
            </div>
          )}
          <Field label={t('auth.code')}>
            <Input className="code-input" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <ErrorBox error={error} />
          <Button big disabled={busy || code.length !== 6}>{t('auth.confirm')}</Button>
        </form>
      )}
    </div>
  );
}
