import type { FastifyInstance, FastifyRequest } from 'fastify';
import { DEFAULT_BRAND, KITCHEN_ACTIONS, LOCALES, type KitchenAction, type Locale } from '@qr/shared';
import { withScope } from '../../db/pool';
import { AuthError } from '../../auth/service';
import { deviceByToken, pairDevice, type Device } from '../../devices/repo';
import * as orders from '../../orders/repo';
import { locationChannel, openStream, orderChannel, publish } from '../../orders/events';
import { qrSecondsLeft, qrToken } from '../../orders/qr';
import { buildTicket } from '../../print/escpos';
import { RateLimiter } from '../ratelimit';
import { lineSchema } from './public';

const DT = 'dt'; // токен на устройството

declare module 'fastify' {
  interface FastifyRequest { device: Device | null }
}

/** Кухня, табло и киоск в обекта. Удостоверяват се със сдвоено устройство. */
export async function deviceRoutes(app: FastifyInstance) {
  const { db, qrSecret, secureCookies } = app.deps;
  const pairLimiter = new RateLimiter(10, 10 * 60_000, app.deps.rateLimitScale);
  app.decorateRequest('device', null);

  const tenant = (req: FastifyRequest) => {
    const t = req.tenant;
    if (t.kind !== 'business') throw new AuthError('not_found', 404);
    return t;
  };
  const bid = (req: FastifyRequest) => tenant(req).business.id;
  const origin = (req: FastifyRequest) => `${secureCookies ? 'https' : 'http'}://${req.headers.host}`;

  const requireDevice = (...kinds: Device['kind'][]) => async (req: FastifyRequest) => {
    const token = req.cookies[DT];
    const d = token ? await withScope(db, { businessId: bid(req) }, (tx) => deviceByToken(tx, token)) : null;
    if (!d) throw new AuthError('device_unpaired', 401);
    const hostLoc = tenant(req).location;
    if (hostLoc && hostLoc.id !== d.locationId) throw new AuthError('wrong_location', 403);
    if (kinds.length && !kinds.includes(d.kind)) throw new AuthError('forbidden', 403);
    req.device = d;
  };

  app.post<{ Body: { code: string } }>('/pair', { schema: { body: { type: 'object', required: ['code'],
    properties: { code: { type: 'string', pattern: '^[0-9]{6}$' } } } } }, async (req, reply) => {
    if (!pairLimiter.allow(req.ip)) throw new AuthError('rate_limited', 429);
    const r = await withScope(db, { businessId: bid(req) }, (tx) =>
      pairDevice(tx, bid(req), req.body.code, tenant(req).location?.id ?? null));
    if (!r) throw new AuthError('invalid_code', 401);
    reply.setCookie(DT, r.token, { path: '/', httpOnly: true, sameSite: 'lax', secure: secureCookies,
      maxAge: 60 * 60 * 24 * 365 * 5 });
    return r.device;
  });

  /** Всичко, което екранът трябва да знае: вид, обект, марка. */
  app.get('/me', { preHandler: requireDevice() }, (req) => withScope(db, { businessId: bid(req) }, async (tx) => {
    const l = (await tx.query(
      `SELECT l.id, l.slug, l.name, l.qr_enabled AS "qrEnabled", l.kiosk_enabled AS "kioskEnabled",
         l.printer_host AS "printerHost", l.printer_port AS "printerPort", l.ticket_qr AS "ticketQr"
       FROM locations l WHERE l.id = $1`, [req.device!.locationId])).rows[0];
    const b = tenant(req).business;
    return { device: req.device, location: l,
      business: { name: b.name, theme: b.theme, defaultLocale: b.defaultLocale, enabledLocales: b.enabledLocales,
        brand: { ...DEFAULT_BRAND, ...b.brand } } };
  }));

  app.get('/stream', { preHandler: requireDevice() }, async (req, reply) => {
    const d = req.device!;
    const snap = d.kind === 'kitchen'
      ? () => withScope(db, { businessId: bid(req) }, (tx) => orders.kitchenSnapshot(tx, d.locationId))
      : () => withScope(db, { businessId: bid(req) }, (tx) => orders.boardSnapshot(tx, d.locationId));
    openStream(req, reply, [locationChannel(d.locationId)], snap);
  });

  /** Текущият QR адрес за таблото; сменя се на 30 с. */
  app.get('/qr', { preHandler: requireDevice('board', 'kiosk') }, async (req) =>
    ({ url: `${origin(req)}/q/${qrToken(qrSecret, req.device!.locationId)}`, secondsLeft: qrSecondsLeft() }));

  app.post<{ Params: { id: string; action: KitchenAction } }>('/orders/:id/:action', {
    preHandler: requireDevice('kitchen'),
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' },
      action: { type: 'string', enum: Object.keys(KITCHEN_ACTIONS) } } } },
  }, async (req) => {
    const d = req.device!;
    const o = await withScope(db, { businessId: bid(req) }, (tx) =>
      orders.applyKitchenAction(tx, bid(req), d.locationId, req.params.id, req.params.action));
    publish(locationChannel(d.locationId));
    publish(orderChannel(o.id));
    return o;
  });

  const ticketFor = (req: FastifyRequest, o: orders.OrderView) => withScope(db, { businessId: bid(req) }, async (tx) => {
    const l = (await tx.query<{ name: string; ticketQr: boolean; printerHost: string | null; printerPort: number;
      codepage: number }>(
      `SELECT name, ticket_qr AS "ticketQr", printer_host AS "printerHost", printer_port AS "printerPort",
         printer_codepage AS codepage FROM locations WHERE id = $1`, [o.locationId])).rows[0]!;
    const bg = o.locale === 'bg';
    const bytes = buildTicket({
      businessName: tenant(req).business.name, locationName: l.name, number: o.number, createdAt: new Date(o.createdAt),
      locale: o.locale, items: o.items, totalCents: o.totalCents,
      statusUrl: l.ticketQr ? `${origin(req)}/o/${o.publicCode}` : undefined,
      scanText: bg ? 'Сканирайте, за да следите поръчката си' : 'Scan to follow your order',
      footer: bg ? 'Това не е фискален бон.' : 'This is not a fiscal receipt.',
    }, l.codepage);
    return { escposBase64: bytes.toString('base64'),
      printer: l.printerHost ? { host: l.printerHost, port: l.printerPort } : null };
  });

  /** Киоск: поръчка без QR, приема се автоматично по настройка (реш. 5) + бележка. */
  app.post<{ Body: { lines: orders.LineInput[]; locale?: Locale } }>('/kiosk/orders', {
    preHandler: requireDevice('kiosk'),
    schema: { body: { type: 'object', required: ['lines'], additionalProperties: false, properties: {
      lines: lineSchema, locale: { type: 'string', enum: [...LOCALES] } } } },
  }, async (req, reply) => {
    const d = req.device!;
    const o = await withScope(db, { businessId: bid(req) }, (tx) => orders.createOrder(tx, {
      businessId: bid(req), locationId: d.locationId, channel: 'kiosk', lines: req.body.lines,
      locale: req.body.locale ?? 'bg', deviceId: d.id,
    }));
    publish(locationChannel(d.locationId));
    return reply.code(201).send({ order: o, ticket: await ticketFor(req, o) });
  });

  /** Повторен печат от кухнята или киоска. */
  app.get<{ Params: { id: string } }>('/orders/:id/ticket', { preHandler: requireDevice('kiosk', 'kitchen'),
    schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } } } },
  async (req) => {
    const o = await withScope(db, { businessId: bid(req) }, (tx) => orders.getOrder(tx, req.params.id));
    if (o.locationId !== req.device!.locationId) throw new AuthError('not_found', 404);
    return ticketFor(req, o);
  });
}
