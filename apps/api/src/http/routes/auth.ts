import type { FastifyInstance } from 'fastify';
import {
  changePassword, completeSecondFactor, login, logout, startEnrollment,
} from '../../auth/service';
import { clearSessionCookie, meta, requireAuth, requirePendingSession, setSessionCookie } from '../app';

const str = (max: number) => ({ type: 'string', minLength: 1, maxLength: max });

export async function authRoutes(app: FastifyInstance) {
  const { db, secretsKey } = app.deps;

  app.post<{ Body: { email: string; password: string } }>('/login', {
    schema: { body: { type: 'object', required: ['email', 'password'], additionalProperties: false,
      properties: { email: str(254), password: str(200) } } },
  }, async (req, reply) => {
    const r = await login(db, req.realm, req.body.email, req.body.password, meta(req));
    setSessionCookie(app, reply, r.token);
    return { stage: r.stage };
  });

  /** Начало на настройката на 2FA: тайна и otpauth адрес за QR кода. */
  app.post('/2fa/enroll', { preHandler: requirePendingSession }, async (req) =>
    startEnrollment(db, req.realm, req.session!, secretsKey));

  /** Код от приложението: завършва настройката или входа. */
  app.post<{ Body: { code: string } }>('/2fa', {
    preHandler: requirePendingSession,
    schema: { body: { type: 'object', required: ['code'], additionalProperties: false,
      properties: { code: str(10) } } },
  }, async (req, reply) => {
    const r = await completeSecondFactor(db, req.realm, req.session!, req.body.code, secretsKey, meta(req));
    setSessionCookie(app, reply, r.token);
    return { stage: r.stage };
  });

  app.post<{ Body: { current: string; next: string } }>('/password', {
    preHandler: requireAuth(),
    schema: { body: { type: 'object', required: ['current', 'next'], additionalProperties: false,
      properties: { current: str(200), next: str(200) } } },
  }, async (req) => {
    await changePassword(db, req.realm, req.session!, req.body.current, req.body.next, meta(req));
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    if (req.session) await logout(db, req.realm, req.session, meta(req));
    clearSessionCookie(reply);
    return { ok: true };
  });
}
