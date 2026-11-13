import type { FastifyInstance } from 'fastify';
import { LOCALES, THEMES, type Locale, type Theme } from '@qr/shared';
import { withScope } from '../../db/pool';
import { AuthError, audit, insertUser, listAudit } from '../../auth/service';
import { insertBusiness, insertLocation } from '../../tenancy/repo';
import { requireAuth } from '../app';

interface NewBusinessBody {
  slug: string; name: string; defaultLocale?: Locale; theme?: Theme;
  owner: { email: string; name?: string; password: string };
  location?: { slug: string; name: string; qrEnabled?: boolean; kioskEnabled?: boolean };
}

/** Админ на платформата: само на admin.<домейн>. */
export async function platformRoutes(app: FastifyInstance) {
  const { db, baseDomain } = app.deps;

  app.addHook('onRequest', async (req) => {
    if (req.tenant.kind !== 'platform') throw new AuthError('not_found', 404);
  });

  app.get('/businesses', { preHandler: requireAuth() }, async () =>
    withScope(db, { platform: true }, async (tx) =>
      (await tx.query(`SELECT id, slug, name, status, theme, created_at AS "createdAt"
                       FROM businesses ORDER BY name`)).rows));

  /** Нов бизнес със собственик и (по избор) първи обект — в една транзакция. */
  app.post<{ Body: NewBusinessBody }>('/businesses', {
    preHandler: requireAuth(),
    schema: { body: { type: 'object', required: ['slug', 'name', 'owner'], additionalProperties: false, properties: {
      slug: { type: 'string', maxLength: 32 }, name: { type: 'string', minLength: 1, maxLength: 120 },
      defaultLocale: { type: 'string', enum: [...LOCALES] }, theme: { type: 'string', enum: [...THEMES] },
      owner: { type: 'object', required: ['email', 'password'], additionalProperties: false, properties: {
        email: { type: 'string', maxLength: 254 }, name: { type: 'string', maxLength: 100 },
        password: { type: 'string', maxLength: 200 } } },
      location: { type: 'object', required: ['slug', 'name'], additionalProperties: false, properties: {
        slug: { type: 'string', maxLength: 32 }, name: { type: 'string', minLength: 1, maxLength: 120 },
        qrEnabled: { type: 'boolean' }, kioskEnabled: { type: 'boolean' } } },
    } } },
  }, async (req, reply) => {
    const actorId = req.session!.user.id;
    const result = await withScope(db, { platform: true }, async (tx) => {
      const { owner, location, ...biz } = req.body;
      const business = await insertBusiness(tx, biz, baseDomain);
      const user = await insertUser(tx, business.id, { ...owner, role: 'owner' });
      const loc = location ? await insertLocation(tx, business.id, location, baseDomain) : null;
      await audit(tx, null, { action: 'business.created', actorId, targetType: 'business',
        targetId: business.id, data: { slug: business.slug }, ip: req.ip });
      // В журнала на самия бизнес, без автор (авторът е от платформата).
      await audit(tx, business.id, { action: 'business.created', data: { by: 'platform' }, ip: req.ip });
      return { business, owner: user, location: loc };
    });
    return reply.code(201).send(result);
  });

  app.get('/audit', { preHandler: requireAuth() }, async () =>
    withScope(db, { platform: true }, (tx) => listAudit(tx, null)));
}
