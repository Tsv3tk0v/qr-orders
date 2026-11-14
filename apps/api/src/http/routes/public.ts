import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LOCALES, ORDER_LIMITS, SESSION_MINUTES, type Locale } from '@qr/shared';
import { withScope } from '../../db/pool';
import { AuthError } from '../../auth/service';
import { verifyQrToken } from '../../orders/qr';
import * as orders from '../../orders/repo';
import { locationChannel, openStream, orderChannel, publish } from '../../orders/events';
import { RateLimiter } from '../ratelimit';

export const lineSchema = {
  type: 'array', minItems: 1, maxItems: ORDER_LIMITS.maxLines,
  items: { type: 'object', required: ['itemId', 'qty'], additionalProperties: false, properties: {
    itemId: { type: 'string', format: 'uuid' },
    qty: { type: 'integer', minimum: 1, maximum: ORDER_LIMITS.maxQty },
    removed: { type: 'array', maxItems: 30, items: { type: 'string', format: 'uuid' } },
    addons: { type: 'array', maxItems: 30, items: { type: 'object', required: ['componentId'],
      additionalProperties: false, properties: {
        componentId: { type: 'string', format: 'uuid' }, qty: { type: 'integer', minimum: 1, maximum: 10 } } } },
    note: { type: 'string', maxLength: ORDER_LIMITS.noteLength },
  } },
};

const CS = 'cs';   // клиентска сесия (20 мин)
const CID = 'cid'; // браузър — за неявявания и черен списък (само като HMAC)

/** Клиентът: сесия от QR, поръчка, статус на живо. Без вход. */
export async function publicRoutes(app: FastifyInstance) {
  const { db, qrSecret, contactKey, secureCookies } = app.deps;
  const sessionLimiter = new RateLimiter(30, 10 * 60_000, app.deps.rateLimitScale);
  const orderLimiter = new RateLimiter(10, 10 * 60_000, app.deps.rateLimitScale);

  const tenant = (req: FastifyRequest) => {
    const t = req.tenant;
    if (t.kind !== 'business') throw new AuthError('not_found', 404);
    return t;
  };
  const bid = (req: FastifyRequest) => tenant(req).business.id;
  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: secureCookies };

  const customerId = (req: FastifyRequest, reply: FastifyReply) => {
    let cid = req.cookies[CID];
    if (!cid || !/^[A-Za-z0-9_-]{20,64}$/.test(cid)) {
      cid = randomBytes(18).toString('base64url');
      reply.setCookie(CID, cid, { ...cookieOpts, maxAge: 60 * 60 * 24 * 30 });
    }
    return orders.customerHash(contactKey, bid(req), cid);
  };

  const session = async (req: FastifyRequest) => {
    const token = req.cookies[CS];
    if (!token) return null;
    return withScope(db, { businessId: bid(req) }, (tx) => orders.getCustomerSession(tx, token));
  };

  /** Сканиран QR → нова сесия за 20 минути. */
  app.post<{ Body: { qrToken: string } }>('/session', { schema: { body: {
    type: 'object', required: ['qrToken'], properties: { qrToken: { type: 'string', maxLength: 64 } } } } },
  async (req, reply) => {
    const t = tenant(req);
    if (!t.location) throw new AuthError('location_required', 400);
    if (!sessionLimiter.allow(req.ip)) throw new AuthError('rate_limited', 429);
    if (!verifyQrToken(qrSecret, t.location.id, req.body.qrToken)) throw new AuthError('qr_expired', 410);
    if (!t.location.qrEnabled) throw new AuthError('qr_disabled', 409);
    const hash = customerId(req, reply);
    const s = await withScope(db, { businessId: t.business.id }, (tx) =>
      orders.createCustomerSession(tx, t.business.id, t.location!.id, hash));
    reply.setCookie(CS, s.token, { ...cookieOpts, maxAge: SESSION_MINUTES * 60 });
    return { expiresAt: s.expiresAt };
  });

  app.get('/session', async (req) => {
    const s = await session(req);
    if (!s) return { active: false };
    const order = await withScope(db, { businessId: bid(req) }, (tx) => orders.sessionActiveOrder(tx, s.id));
    return { active: true, expiresAt: s.expiresAt, order: order && { publicCode: order.publicCode, status: order.status } };
  });

  app.post<{ Body: { lines: orders.LineInput[]; note?: string; locale?: Locale } }>('/orders', { schema: { body: {
    type: 'object', required: ['lines'], additionalProperties: false, properties: {
      lines: lineSchema, note: { type: 'string', maxLength: 200 },
      locale: { type: 'string', enum: [...LOCALES] } } } } },
  async (req, reply) => {
    const s = await session(req);
    if (!s) throw new AuthError('session_expired', 401);
    if (!orderLimiter.allow(req.ip)) throw new AuthError('rate_limited', 429);
    const order = await withScope(db, { businessId: bid(req) }, (tx) => orders.createOrder(tx, {
      businessId: bid(req), locationId: s.locationId, channel: 'qr', lines: req.body.lines,
      locale: req.body.locale ?? 'bg', note: req.body.note, sessionId: s.id, customerHash: s.customerHash,
    }));
    publish(locationChannel(order.locationId));
    return reply.code(201).send(order);
  });

  app.post('/orders/cancel', async (req) => {
    const s = await session(req);
    if (!s) throw new AuthError('session_expired', 401);
    const order = await withScope(db, { businessId: bid(req) }, (tx) => orders.cancelByCustomer(tx, s.id));
    publish(locationChannel(order.locationId));
    publish(orderChannel(order.id));
    return order;
  });

  const publicView = async (req: FastifyRequest, code: string) =>
    withScope(db, { businessId: bid(req) }, async (tx) => {
      const o = await orders.findOrderByCode(tx, code);
      if (!o) throw new AuthError('not_found', 404);
      const l = (await tx.query<{ name: string; prep: number }>(
        `SELECT name, prep_minutes_estimate AS prep FROM locations WHERE id = $1`, [o.locationId])).rows[0]!;
      // Колко поръчки са преди тази → приблизително време.
      const ahead = (await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders WHERE location_id = $1 AND status IN ('pending', 'accepted')
         AND created_at < $2`, [o.locationId, o.createdAt])).rows[0]!.n;
      return { ...o, id: undefined, locationName: l.name, estimateMinutes: l.prep + ahead * 2 };
    });

  app.get<{ Params: { code: string } }>('/orders/:code', { schema: { params: { type: 'object',
    properties: { code: { type: 'string', pattern: '^[A-Za-z0-9]{4}-[A-Za-z0-9]{3}$' } } } } },
  (req) => publicView(req, req.params.code));

  app.get<{ Params: { code: string } }>('/orders/:code/stream', { schema: { params: { type: 'object',
    properties: { code: { type: 'string', pattern: '^[A-Za-z0-9]{4}-[A-Za-z0-9]{3}$' } } } } },
  async (req, reply) => {
    const first = await withScope(db, { businessId: bid(req) }, (tx) => orders.findOrderByCode(tx, req.params.code));
    if (!first) throw new AuthError('not_found', 404);
    openStream(req, reply, [orderChannel(first.id)], () => publicView(req, req.params.code));
  });
}
