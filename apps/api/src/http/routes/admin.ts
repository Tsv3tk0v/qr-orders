import type { FastifyInstance } from 'fastify';
import { BUSINESS_ROLES, type Role } from '@qr/shared';
import { withScope } from '../../db/pool';
import { AuthError, audit, insertUser, listAudit, listUsers, updateUser } from '../../auth/service';
import { meta, requireAuth } from '../app';

/** Админ панел на бизнеса. Работи само на поддомейна на бизнеса. */
export async function adminRoutes(app: FastifyInstance) {
  const { db } = app.deps;

  app.addHook('onRequest', async (req) => {
    if (req.tenant.kind !== 'business') throw new AuthError('not_found', 404);
  });
  const bid = (req: { realm: { kind: string; businessId?: string } }) => req.realm.businessId!;

  app.get('/users', { preHandler: requireAuth('users.manage') }, async (req) =>
    withScope(db, { businessId: bid(req) }, (tx) => listUsers(tx, bid(req))));

  app.post<{ Body: { email: string; name?: string; role: Role; password: string } }>('/users', {
    preHandler: requireAuth('users.manage'),
    schema: { body: { type: 'object', required: ['email', 'role', 'password'], additionalProperties: false,
      properties: {
        email: { type: 'string', maxLength: 254 }, name: { type: 'string', maxLength: 100 },
        role: { type: 'string', enum: [...BUSINESS_ROLES] }, password: { type: 'string', maxLength: 200 },
      } } },
  }, async (req, reply) => {
    const user = await withScope(db, { businessId: bid(req) }, async (tx) => {
      const u = await insertUser(tx, bid(req), req.body);
      await audit(tx, bid(req), { action: 'user.created', actorId: req.session!.user.id,
        targetType: 'user', targetId: u.id, data: { email: u.email, role: u.role }, ip: req.ip });
      return u;
    });
    return reply.code(201).send(user);
  });

  app.patch<{ Params: { id: string }; Body: { role?: Role; active?: boolean; reset2fa?: boolean; password?: string } }>('/users/:id', {
    preHandler: requireAuth('users.manage'),
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
        role: { type: 'string', enum: [...BUSINESS_ROLES] }, active: { type: 'boolean' }, reset2fa: { type: 'boolean' },
        password: { type: 'string', maxLength: 200 },
      } },
    },
  }, async (req) => withScope(db, { businessId: bid(req) }, (tx) =>
    updateUser(tx, bid(req), req.session!.user.id, req.params.id, req.body, meta(req))));

  app.get<{ Querystring: { limit?: number; before?: string } }>('/audit', {
    preHandler: requireAuth('audit.read'),
    schema: { querystring: { type: 'object', properties: {
      limit: { type: 'integer', minimum: 1, maximum: 500 }, before: { type: 'string', pattern: '^[0-9]+$' },
    } } },
  }, async (req) => withScope(db, { businessId: bid(req) }, (tx) =>
    listAudit(tx, bid(req), req.query.limit, req.query.before)));
}
