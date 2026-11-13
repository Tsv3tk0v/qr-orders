import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { can, normalizeHostname, permissionsOf, platformHostname, type Permission } from '@qr/shared';
import type { Db } from '../db/pool';
import { AuthError, getSession, type Meta, type Realm, type SessionUser } from '../auth/service';
import { resolveHost, ValidationError, type Business, type Location } from '../tenancy/repo';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { platformRoutes } from './routes/platform';

export interface AppDeps {
  db: Db;
  baseDomain: string;
  secretsKey: Buffer;
  /** false само за локална разработка по http. */
  secureCookies: boolean;
  /** Брой проксита пред приложението (за истинския IP). */
  trustProxy?: boolean;
  logger?: boolean;
}

/** Контекстът на заявката, определен от хоста. */
export type Tenant =
  | { kind: 'platform' }
  | { kind: 'business'; business: Business; location: Location | null };

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
    realm: Realm;
    session: SessionUser | null;
  }
  interface FastifyInstance {
    deps: AppDeps;
  }
}

export const SESSION_COOKIE = 'sid';

export function meta(req: FastifyRequest): Meta {
  return { ip: req.ip, userAgent: req.headers['user-agent'] };
}

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string) {
  // Без domain: бисквитката важи само за този поддомейн.
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: app.deps.secureCookies,
  });
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** preHandler: изисква завършен вход (с 2FA) и, по избор, право. */
export function requireAuth(permission?: Permission) {
  return async (req: FastifyRequest) => {
    const s = req.session;
    if (!s) throw new AuthError('unauthenticated', 401);
    if (s.stage !== 'active') throw new AuthError('second_factor_required', 401);
    if (permission && !can(s.user.role, permission)) throw new AuthError('forbidden', 403);
  };
}

/** preHandler: сесия, която още чака 2FA. */
export async function requirePendingSession(req: FastifyRequest) {
  if (!req.session) throw new AuthError('unauthenticated', 401);
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: deps.trustProxy ?? false });
  app.decorate('deps', deps);
  app.decorateRequest('tenant', null as never);
  app.decorateRequest('realm', null as never);
  app.decorateRequest('session', null);
  await app.register(cookie);

  const adminHost = platformHostname(deps.baseDomain);

  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/api/health') return;
    const host = normalizeHostname(req.headers.host ?? '');

    // Защита от CSRF: заявките, които променят, трябва да идват от същия хост.
    if (UNSAFE.has(req.method)) {
      const origin = req.headers.origin;
      let originHost = '';
      try { originHost = origin ? new URL(origin).host : ''; } catch { /* невалиден */ }
      if (!originHost || normalizeHostname(originHost) !== host) {
        return reply.code(403).send({ error: 'bad_origin' });
      }
    }

    if (host === adminHost) {
      req.tenant = { kind: 'platform' };
      req.realm = { kind: 'platform' };
    } else {
      const resolved = await resolveHost(deps.db, host);
      if (!resolved) return reply.code(404).send({ error: 'unknown_host' });
      req.tenant = { kind: 'business', ...resolved };
      req.realm = { kind: 'business', businessId: resolved.business.id };
    }

    const token = req.cookies[SESSION_COOKIE];
    req.session = token ? await getSession(deps.db, req.realm, token) : null;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof ValidationError) return reply.code(400).send({ error: 'validation', message: err.message });
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: 'validation', message: (err as Error).message });
    }
    if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'conflict' });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  /** Публичен контекст за интерфейса: марка, тема, езици, обект. */
  app.get('/api/context', async (req) => {
    const t = req.tenant;
    if (t.kind === 'platform') return { kind: 'platform' };
    const { business: b, location: l } = t;
    return {
      kind: 'business',
      business: { slug: b.slug, name: b.name, theme: b.theme, defaultLocale: b.defaultLocale, brand: b.brand },
      location: l && { slug: l.slug, name: l.name, qrEnabled: l.qrEnabled, kioskEnabled: l.kioskEnabled },
    };
  });

  app.get('/api/auth/me', async (req) => {
    const s = req.session;
    if (!s) throw new AuthError('unauthenticated', 401);
    return {
      stage: s.stage,
      user: { id: s.user.id, email: s.user.email, name: s.user.name, role: s.user.role },
      permissions: s.stage === 'active' ? permissionsOf(s.user.role) : [],
    };
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(platformRoutes, { prefix: '/api/platform' });
  return app;
}
