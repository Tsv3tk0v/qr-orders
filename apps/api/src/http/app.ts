import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { can, DEFAULT_BRAND, normalizeHostname, permissionsOf, platformHostname, type Permission } from '@qr/shared';
import type { Db } from '../db/pool';
import { AuthError, getSession, type Meta, type Realm, type SessionUser } from '../auth/service';
import { resolveHost, ValidationError, type Business, type Location } from '../tenancy/repo';
import { authRoutes } from './routes/auth';
import { adminRoutes } from './routes/admin';
import { platformRoutes } from './routes/platform';
import { menuRoutes } from './routes/menu';
import { BrandError, settingsRoutes } from './routes/settings';
import { NotFound, publicMenu } from '../menu/repo';
import { ImportSettingsError } from '../menu/import/apply';
import { withScope } from '../db/pool';
import { publicRoutes } from './routes/public';
import { deviceRoutes } from './routes/device';
import { opsRoutes } from './routes/ops';
import { setupRoutes } from './routes/setup';
import { OrderError } from '../orders/repo';

export interface AppDeps {
  db: Db;
  baseDomain: string;
  secretsKey: Buffer;
  /** Подпис на въртящия се QR. */
  qrSecret: string;
  /** Ключ за HMAC на клиентите (черен списък). */
  contactKey: string;
  /** Код за първоначална настройка; празен = настройката е изключена. */
  setupCode?: string;
  /** Множител на лимитите за заявки (тестовете идват от един IP). */
  rateLimitScale?: number;
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
    if (req.url === '/api/health' || req.url.startsWith('/api/internal/') || req.url.startsWith('/assets/')) return;
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
    if (err instanceof OrderError) return reply.code(err.status).send({ error: err.code });
    if (err instanceof NotFound) return reply.code(404).send({ error: 'not_found' });
    if (err instanceof BrandError) return reply.code(400).send({ error: 'invalid_brand', issues: err.issues });
    if (err instanceof ImportSettingsError) return reply.code(400).send({ error: err.message });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return reply.code(409).send({ error: 'conflict' });
    // Нарушено правило в базата (напр. QR и киоск изключени) или връзка към чужд/липсващ ред.
    if (pgCode === '23514') return reply.code(400).send({ error: 'validation' });
    if (pgCode === '23503') return reply.code(400).send({ error: 'invalid_reference' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (err as { code?: string }).code ?? 'bad_request' });
    }
    req.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  /** Caddy пита тук, преди да издаде сертификат за поддомейн (on-demand TLS). */
  app.get<{ Querystring: { domain?: string } }>('/api/internal/tls-check', async (req, reply) => {
    const domain = normalizeHostname(req.query.domain ?? '');
    if (domain === adminHost || domain === normalizeHostname(deps.baseDomain)) return { ok: true };
    const found = await withScope(deps.db, { anonymous: true }, (tx) =>
      tx.query('SELECT 1 FROM domains WHERE hostname = $1', [domain]));
    return found.rows.length ? { ok: true } : reply.code(404).send({ ok: false });
  });

  /** Публичен контекст за интерфейса: марка, тема, езици, обект. */
  app.get('/api/context', async (req) => {
    const t = req.tenant;
    if (t.kind === 'platform') return { kind: 'platform' };
    const { business: b, location: l } = t;
    return {
      kind: 'business',
      business: { slug: b.slug, name: b.name, theme: b.theme, defaultLocale: b.defaultLocale,
        enabledLocales: b.enabledLocales, currency: b.currency, brand: { ...DEFAULT_BRAND, ...b.brand } },
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

  /** Менюто за клиента: видими и одобрени артикули на двата езика. */
  app.get('/api/menu', async (req) => {
    const t = req.tenant;
    if (t.kind !== 'business') throw new AuthError('not_found', 404);
    return withScope(deps.db, { businessId: t.business.id }, publicMenu);
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(publicRoutes, { prefix: '/api' });
  await app.register(deviceRoutes, { prefix: '/api/device' });
  await app.register(opsRoutes, { prefix: '/api/admin' });
  await app.register(setupRoutes, { prefix: '/api/setup' });
  await app.register(menuRoutes, { prefix: '/api/admin/menu' });
  await app.register(settingsRoutes, { prefix: '/api/admin/settings' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(platformRoutes, { prefix: '/api/platform' });
  return app;
}
