import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withScope, type Tx } from '../../db/pool';
import { AuthError, audit } from '../../auth/service';
import { createDevice, listDevices, newPairingCode, revokeDevice } from '../../devices/repo';
import { requireAuth } from '../app';

const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } };

/** Устройства, история на поръчките, черен списък, отчети, правила за неявявания. */
export async function opsRoutes(app: FastifyInstance) {
  const { db } = app.deps;
  app.addHook('onRequest', async (req) => {
    if (req.tenant.kind !== 'business') throw new AuthError('not_found', 404);
  });
  const bid = (req: FastifyRequest) => (req.realm as { businessId: string }).businessId;
  const run = <T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>) => withScope(db, { businessId: bid(req) }, fn);
  const log = (tx: Tx, req: FastifyRequest, action: string, targetType: string, targetId?: string, data = {}) =>
    audit(tx, bid(req), { action, actorId: req.session!.user.id, targetType, targetId, data, ip: req.ip });

  // --- Устройства ---
  const manage = { preHandler: requireAuth('settings.manage') };
  app.get('/devices', manage, (req) => run(req, listDevices));
  app.post<{ Body: { locationId: string; kind: 'kitchen' | 'board' | 'kiosk'; name: string } }>('/devices', {
    ...manage, schema: { body: { type: 'object', required: ['locationId', 'kind', 'name'], additionalProperties: false,
      properties: { locationId: uuid, kind: { type: 'string', enum: ['kitchen', 'board', 'kiosk'] },
        name: { type: 'string', minLength: 1, maxLength: 60 } } } },
  }, async (req, reply) => reply.code(201).send(await run(req, async (tx) => {
    const r = await createDevice(tx, bid(req), req.body);
    await log(tx, req, 'device.created', 'device', r.device.id, { kind: req.body.kind });
    return r;
  })));
  app.post<{ Params: { id: string } }>('/devices/:id/pairing-code', { ...manage, schema: { params: idParams } },
    (req) => run(req, async (tx) => {
      const r = await newPairingCode(tx, bid(req), req.params.id).catch(() => { throw new AuthError('not_found', 404); });
      await log(tx, req, 'device.pairing_code', 'device', req.params.id);
      return r;
    }));
  app.post<{ Params: { id: string } }>('/devices/:id/revoke', { ...manage, schema: { params: idParams } },
    (req) => run(req, async (tx) => {
      if (!(await revokeDevice(tx, req.params.id))) throw new AuthError('not_found', 404);
      await log(tx, req, 'device.revoked', 'device', req.params.id);
      return { ok: true };
    }));

  // --- Поръчки (история) ---
  app.get<{ Querystring: { day?: string; locationId?: string } }>('/orders', {
    preHandler: requireAuth('orders.handle'),
    schema: { querystring: { type: 'object', properties: {
      day: { type: 'string', format: 'date' }, locationId: uuid } } },
  }, (req) => run(req, async (tx) => (await tx.query(
    `SELECT o.id, o.location_id AS "locationId", o.number, o.public_code AS "publicCode", o.channel, o.status,
       o.total_cents AS "totalCents", o.created_at AS "createdAt", o.ready_at AS "readyAt", o.closed_at AS "closedAt",
       o.customer_hash IS NOT NULL AS "canBlock",
       (SELECT coalesce(sum(qty), 0)::int FROM order_items WHERE order_id = o.id) AS "itemCount"
     FROM orders o
     WHERE ($1::date IS NULL OR o.business_day = $1) AND ($2::uuid IS NULL OR o.location_id = $2)
     ORDER BY o.created_at DESC LIMIT 500`, [req.query.day ?? null, req.query.locationId ?? null])).rows));

  // --- Черен списък (само HMAC, без лични данни) ---
  app.get('/blacklist', { preHandler: requireAuth('orders.handle') }, (req) => run(req, async (tx) => (await tx.query(
    `SELECT encode(customer_hash, 'hex') AS id, no_shows AS "noShows", orders, last_no_show_at AS "lastNoShowAt",
       blocked_until AS "blockedUntil", block_reason AS reason
     FROM customer_marks WHERE blocked_until > now() ORDER BY blocked_until DESC`)).rows));
  app.delete<{ Params: { id: string } }>('/blacklist/:id', { preHandler: requireAuth('orders.handle'),
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: '^[0-9a-f]{64}$' } } } } },
  (req) => run(req, async (tx) => {
    await tx.query(`UPDATE customer_marks SET blocked_until = NULL, block_reason = NULL, no_shows = 0
                    WHERE customer_hash = decode($1, 'hex')`, [req.params.id]);
    await log(tx, req, 'blacklist.removed', 'customer', req.params.id.slice(0, 12));
    return { ok: true };
  }));
  /** Ръчно блокиране на клиента от конкретна поръчка. */
  app.post<{ Params: { id: string } }>('/orders/:id/block', { preHandler: requireAuth('orders.handle'),
    schema: { params: idParams } }, (req) => run(req, async (tx) => {
    const r = await tx.query(
      `INSERT INTO customer_marks AS m (business_id, customer_hash, blocked_until, block_reason)
       SELECT o.business_id, o.customer_hash, now() + make_interval(days => b.block_days), 'manual'
       FROM orders o JOIN businesses b ON b.id = o.business_id WHERE o.id = $1 AND o.customer_hash IS NOT NULL
       ON CONFLICT (business_id, customer_hash) DO UPDATE SET blocked_until = excluded.blocked_until,
         block_reason = 'manual'`, [req.params.id]);
    if (!r.rowCount) throw new AuthError('not_found', 404);
    await log(tx, req, 'blacklist.added', 'order', req.params.id);
    return { ok: true };
  }));

  // --- Отчети (само от поръчките в системата) ---
  app.get<{ Querystring: { from: string; to: string; locationId?: string } }>('/reports/summary', {
    preHandler: requireAuth('reports.read'),
    schema: { querystring: { type: 'object', required: ['from', 'to'], properties: {
      from: { type: 'string', format: 'date' }, to: { type: 'string', format: 'date' }, locationId: uuid } } },
  }, (req) => run(req, (tx) => reportSummary(tx, req.query.from, req.query.to, req.query.locationId ?? null)));

  // --- Правила на бизнеса ---
  app.patch<{ Body: { noshowBlockThreshold?: number; blockDays?: number; dailyEmail?: boolean; dailyEmailHour?: number } }>(
    '/business', { preHandler: requireAuth('settings.manage'), schema: { body: { type: 'object',
      additionalProperties: false, minProperties: 1, properties: {
        noshowBlockThreshold: { type: 'integer', minimum: 1, maximum: 20 },
        blockDays: { type: 'integer', minimum: 1, maximum: 365 },
        dailyEmail: { type: 'boolean' }, dailyEmailHour: { type: 'integer', minimum: 0, maximum: 23 } } } } },
    (req) => run(req, async (tx) => {
      const b = req.body;
      const { rows } = await tx.query(
        `UPDATE businesses SET noshow_block_threshold = coalesce($2, noshow_block_threshold),
           block_days = coalesce($3, block_days), daily_email = coalesce($4, daily_email),
           daily_email_hour = coalesce($5, daily_email_hour)
         WHERE id = $1 RETURNING noshow_block_threshold AS "noshowBlockThreshold", block_days AS "blockDays",
           daily_email AS "dailyEmail", daily_email_hour AS "dailyEmailHour"`,
        [bid(req), b.noshowBlockThreshold ?? null, b.blockDays ?? null, b.dailyEmail ?? null, b.dailyEmailHour ?? null]);
      await log(tx, req, 'settings.business_updated', 'business', bid(req), b);
      return rows[0];
    }));
  app.get('/business', { preHandler: requireAuth('settings.manage') }, (req) => run(req, async (tx) => (await tx.query(
    `SELECT noshow_block_threshold AS "noshowBlockThreshold", block_days AS "blockDays",
       daily_email AS "dailyEmail", daily_email_hour AS "dailyEmailHour" FROM businesses WHERE id = $1`,
    [bid(req)])).rows[0]));
}

export async function reportSummary(tx: Tx, from: string, to: string, locationId: string | null) {
  const days = (await tx.query(
    `SELECT business_day::text AS day, count(*)::int AS orders,
       count(*) FILTER (WHERE status = 'collected')::int AS collected,
       count(*) FILTER (WHERE status = 'no_show')::int AS "noShows",
       count(*) FILTER (WHERE status IN ('rejected', 'cancelled'))::int AS cancelled,
       coalesce(sum(total_cents) FILTER (WHERE status = 'collected'), 0)::int AS "revenueCents",
       round(avg(extract(epoch FROM ready_at - accepted_at) / 60) FILTER (WHERE ready_at IS NOT NULL))::int
         AS "avgPrepMinutes",
       count(*) FILTER (WHERE channel = 'kiosk')::int AS kiosk
     FROM orders WHERE business_day BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR location_id = $3)
     GROUP BY business_day ORDER BY business_day`, [from, to, locationId])).rows;
  const topItems = (await tx.query(
    `SELECT oi.name, sum(oi.qty)::int AS qty, sum(oi.line_cents)::int AS "revenueCents"
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.business_day BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR o.location_id = $3) AND o.status = 'collected'
     GROUP BY oi.name ORDER BY qty DESC LIMIT 10`, [from, to, locationId])).rows;
  return { days, topItems };
}
