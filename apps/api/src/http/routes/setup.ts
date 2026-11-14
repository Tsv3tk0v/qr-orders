import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withScope } from '../../db/pool';
import { AuthError, audit, insertUser } from '../../auth/service';
import { insertBusiness, insertLocation } from '../../tenancy/repo';
import { RateLimiter } from '../ratelimit';

/**
 * Първоначална настройка (само на admin.<домейн>, само докато няма админ на платформата).
 * Кодът за настройка се генерира от инсталатора и се показва на екрана му.
 */
export async function setupRoutes(app: FastifyInstance) {
  const { db, setupCode, localMode, baseDomain } = app.deps;
  const limiter = new RateLimiter(10, 10 * 60_000, app.deps.rateLimitScale);
  app.addHook('onRequest', async (req) => {
    if (req.tenant.kind !== 'platform') throw new AuthError('not_found', 404);
  });
  const hasAdmin = () => withScope(db, { platform: true }, async (tx) =>
    (await tx.query(`SELECT 1 FROM users WHERE business_id IS NULL LIMIT 1`)).rows.length > 0);

  const hasBusiness = () => withScope(db, { platform: true }, async (tx) =>
    (await tx.query(`SELECT 1 FROM businesses LIMIT 1`)).rows.length > 0);

  app.get('/status', async () => ({
    needsSetup: Boolean(setupCode) && !(localMode ? await hasBusiness() : await hasAdmin()),
    localMode: Boolean(localMode),
  }));

  app.post<{ Body: { code: string; email: string; password: string; name?: string; businessName?: string } }>('/', { schema: { body: {
    type: 'object', required: ['code', 'email', 'password'], additionalProperties: false, properties: {
      code: { type: 'string', maxLength: 64 }, email: { type: 'string', maxLength: 254 },
      password: { type: 'string', maxLength: 200 }, name: { type: 'string', maxLength: 100 },
      businessName: { type: 'string', minLength: 1, maxLength: 120 } } } } },
  async (req, reply) => {
    if (!limiter.allow(req.ip)) throw new AuthError('rate_limited', 429);
    const given = Buffer.from(req.body.code.trim().toUpperCase());
    const expected = Buffer.from((setupCode ?? '').toUpperCase());
    if (!setupCode || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AuthError('invalid_setup_code', 401);
    }
    if (localMode) {
      // Офлайн режим: бизнес + обект с киоск + собственик наведнъж; без админ на платформата.
      if (!req.body.businessName?.trim()) throw new AuthError('validation', 400);
      const owner = await withScope(db, { platform: true }, async (tx) => {
        await tx.query('LOCK TABLE businesses IN SHARE ROW EXCLUSIVE MODE');
        if ((await tx.query(`SELECT 1 FROM businesses LIMIT 1`)).rows.length) throw new AuthError('already_set_up', 409);
        const b = await insertBusiness(tx, { slug: 'local', name: req.body.businessName!.trim() }, baseDomain);
        const l = await insertLocation(tx, b.id, { slug: 'main', name: req.body.businessName!.trim(), qrEnabled: false, kioskEnabled: true }, baseDomain);
        // Бележката няма QR: адресът на статуса работи само в WiFi мрежата на обекта.
        await tx.query('UPDATE locations SET ticket_qr = false WHERE id = $1', [l.id]);
        const u = await insertUser(tx, b.id, { email: req.body.email, name: req.body.name, role: 'owner', password: req.body.password });
        await audit(tx, b.id, { action: 'setup.completed', actorId: u.id, data: { mode: 'local' }, ip: req.ip });
        return u;
      });
      return reply.code(201).send(owner);
    }
    const user = await withScope(db, { platform: true }, async (tx) => {
      await tx.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
      if ((await tx.query(`SELECT 1 FROM users WHERE business_id IS NULL LIMIT 1`)).rows.length) {
        throw new AuthError('already_set_up', 409);
      }
      const u = await insertUser(tx, null, { email: req.body.email, name: req.body.name, role: 'platform_admin',
        password: req.body.password });
      await audit(tx, null, { action: 'setup.completed', actorId: u.id, ip: req.ip });
      return u;
    });
    return reply.code(201).send(user);
  });
}
