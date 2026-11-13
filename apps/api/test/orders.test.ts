import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { withScope, type Db } from '../src/db/pool';
import { qrToken, verifyQrToken } from '../src/orders/qr';
import { toCp866 } from '../src/print/escpos';
import { dailyEmails, purge, sweep } from '../src/jobs';
import { ADMIN_HOST, Client, loggedIn, makeApp } from './helpers';
import { BASE } from './env';

let app: FastifyInstance;
let db: Db;
beforeAll(async () => ({ app, db } = await makeApp()));
afterAll(async () => { await app.close(); await db.end(); });

const SECRET = 'test-qr-secret';
const M = '/api/admin/menu';

/** Бизнес с меню, кухня, табло и киоск. */
async function shop() {
  const owner = await loggedIn(app, db);
  const c = owner.client;
  const settings = (await c.get('/api/admin/settings')).json();
  const loc = settings.locations[0];
  await c.patch(`/api/admin/settings/locations/${loc.id}`, { kioskEnabled: true });
  const meat = (await c.post(`${M}/components`, { name: { bg: 'Месо' } })).json();
  const onion = (await c.post(`${M}/components`, { name: { bg: 'Лук' }, removable: true })).json();
  const extra = (await c.post(`${M}/components`, { name: { bg: 'Доп. месо' }, addonPriceCents: 300 })).json();
  const doner = (await c.post(`${M}/items`, { name: { bg: 'Дюнер' }, priceCents: 950 })).json();
  await c.put(`${M}/items/${doner.id}/components`, { base: [meat.id, onion.id],
    addons: [{ componentId: extra.id, maxQty: 2 }], maxAddons: 3 });
  const ayran = (await c.post(`${M}/items`, { name: { bg: 'Айрян' }, priceCents: 180 })).json();

  const pair = async (kind: string) => {
    const r = (await c.post('/api/admin/devices', { locationId: loc.id, kind, name: kind })).json();
    const d = new Client(app, owner.host);
    const p = await d.post('/api/device/pair', { code: r.pairingCode });
    expect(p.statusCode).toBe(200);
    return { client: d, id: r.device.id as string };
  };
  return { ...owner, loc, doner, ayran, meat, onion, extra,
    kitchen: await pair('kitchen'), board: await pair('board'), kiosk: await pair('kiosk') };
}

async function customer(host: string, locationId: string) {
  const cl = new Client(app, host);
  const r = await cl.post('/api/session', { qrToken: qrToken(SECRET, locationId) });
  expect(r.statusCode).toBe(200);
  return cl;
}

describe('въртящ се QR', () => {
  it('важат текущият и предишният прозорец, само за своя обект', () => {
    const t = 1_700_000_000_000;
    const tok = qrToken(SECRET, 'loc-a', t);
    expect(verifyQrToken(SECRET, 'loc-a', tok, t)).toBe(true);
    expect(verifyQrToken(SECRET, 'loc-a', tok, t + 30_000)).toBe(true);
    expect(verifyQrToken(SECRET, 'loc-a', tok, t + 60_000)).toBe(false);
    expect(verifyQrToken(SECRET, 'loc-b', tok, t)).toBe(false);
    expect(verifyQrToken('друга-тайна', 'loc-a', tok, t)).toBe(false);
    expect(verifyQrToken(SECRET, 'loc-a', 'боклук', t)).toBe(false);
  });
});

describe('поръчка от телефона', () => {
  it('сесия, поръчка, кухня, статус и номерация', async () => {
    const s = await shop();
    const bad = new Client(app, s.host);
    expect((await bad.post('/api/session', { qrToken: '1.AAAAAAAAAAAAAAAA' })).statusCode).toBe(410);
    expect((await bad.post('/api/orders', { lines: [{ itemId: s.ayran.id, qty: 1 }] })).statusCode).toBe(401);

    const cust = await customer(s.host, s.loc.id);
    // Цената от клиента се игнорира; смята се от менюто.
    const ok = await cust.post('/api/orders', { locale: 'bg', lines: [
      { itemId: s.doner.id, qty: 2, removed: [s.onion.id], addons: [{ componentId: s.extra.id, qty: 2 }], note: 'добре изпечен' },
      { itemId: s.ayran.id, qty: 1, priceCents: 1 } as object,
    ] });
    expect(ok.statusCode).toBe(201);
    const order = ok.json();
    expect(order).toMatchObject({ number: 1, status: 'pending', channel: 'qr', totalCents: (950 + 600) * 2 + 180 });
    expect(order.publicCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{3}$/);

    // Една активна поръчка на сесия.
    expect((await cust.post('/api/orders', { lines: [{ itemId: s.ayran.id, qty: 1 }] })).json().error)
      .toBe('active_order_exists');
    expect((await cust.get('/api/session')).json().order).toMatchObject({ status: 'pending' });

    // Невалидни поръчки.
    const c2 = await customer(s.host, s.loc.id);
    expect((await c2.post('/api/orders', { lines: [{ itemId: s.doner.id, qty: 1, removed: [s.meat.id] }] })).json().error)
      .toBe('bad_removal');
    expect((await c2.post('/api/orders', { lines: [{ itemId: s.doner.id, qty: 1,
      addons: [{ componentId: s.extra.id, qty: 3 }] }] })).json().error).toBe('bad_addon');

    // Кухнята приема → готова → взета.
    const k = s.kitchen.client;
    expect((await k.post(`/api/device/orders/${order.id}/ready`)).json().error).toBe('bad_transition');
    expect((await k.post(`/api/device/orders/${order.id}/accept`)).json().status).toBe('accepted');
    const pub = (await new Client(app, s.host).get(`/api/orders/${order.publicCode}`)).json();
    expect(pub).toMatchObject({ number: 1, status: 'accepted', locationName: 'Основен' });
    expect(pub.id).toBeUndefined();
    expect((await k.post(`/api/device/orders/${order.id}/ready`)).json().status).toBe('ready');
    expect((await k.post(`/api/device/orders/${order.id}/back`)).json().status).toBe('accepted');
    await k.post(`/api/device/orders/${order.id}/ready`);
    expect((await k.post(`/api/device/orders/${order.id}/collected`)).json().status).toBe('collected');

    // Следващата поръчка в същата сесия е разрешена и получава № 2.
    const second = (await cust.post('/api/orders', { lines: [{ itemId: s.ayran.id, qty: 1 }] })).json();
    expect(second.number).toBe(2);
    // Клиентът отказва, докато не е приета.
    expect((await cust.post('/api/orders/cancel')).json().status).toBe('cancelled');

    // Устройствата не могат да вършат чужда работа.
    expect((await s.board.client.post(`/api/device/orders/${order.id}/accept`)).statusCode).toBe(403);
    expect((await cust.post(`/api/device/orders/${order.id}/accept`)).statusCode).toBe(401);
  });

  it('номерът не се повтаря, докато е активен; след 999 → 1', async () => {
    const s = await shop();
    const first = (await (await customer(s.host, s.loc.id)).post('/api/orders',
      { lines: [{ itemId: s.ayran.id, qty: 1 }] })).json();
    expect(first.number).toBe(1);
    await withScope(db, { businessId: s.business.id }, (tx) =>
      tx.query('UPDATE order_counters SET last_number = 999 WHERE location_id = $1', [s.loc.id]));
    const next = (await (await customer(s.host, s.loc.id)).post('/api/orders',
      { lines: [{ itemId: s.ayran.id, qty: 1 }] })).json();
    expect(next.number).toBe(2); // 1 още е активен
  });

  it('неявявания водят до черен списък; админът може да го махне', async () => {
    const s = await shop();
    const cust = await customer(s.host, s.loc.id);
    for (let i = 0; i < 2; i++) {
      const o = (await cust.post('/api/orders', { lines: [{ itemId: s.ayran.id, qty: 1 }] })).json();
      await s.kitchen.client.post(`/api/device/orders/${o.id}/accept`);
      await s.kitchen.client.post(`/api/device/orders/${o.id}/ready`);
      expect((await s.kitchen.client.post(`/api/device/orders/${o.id}/no_show`)).json().status).toBe('no_show');
    }
    // Същият браузър (бисквитката cid) е блокиран и в нова сесия.
    const again = await cust.post('/api/session', { qrToken: qrToken(SECRET, s.loc.id) });
    expect(again.statusCode).toBe(200);
    const blocked = await cust.post('/api/orders', { lines: [{ itemId: s.ayran.id, qty: 1 }] });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('blocked');
    // Друг клиент не е засегнат.
    expect((await (await customer(s.host, s.loc.id)).post('/api/orders',
      { lines: [{ itemId: s.ayran.id, qty: 1 }] })).statusCode).toBe(201);

    const list = (await s.client.get('/api/admin/blacklist')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ noShows: 2, reason: 'no_shows' });
    expect(list[0].id).toMatch(/^[0-9a-f]{64}$/);
    await s.client.del(`/api/admin/blacklist/${list[0].id}`);
    expect((await cust.post('/api/orders', { lines: [{ itemId: s.ayran.id, qty: 1 }] })).statusCode).toBe(201);
  });
});

describe('киоск, табло, устройства', () => {
  it('киоск поръчката се приема сама и има бележка', async () => {
    const s = await shop();
    const r = await s.kiosk.client.post('/api/device/kiosk/orders', { locale: 'bg',
      lines: [{ itemId: s.doner.id, qty: 1, removed: [s.onion.id] }] });
    expect(r.statusCode).toBe(201);
    const { order, ticket } = r.json();
    expect(order).toMatchObject({ status: 'accepted', channel: 'kiosk', number: 1 });
    const bytes = Buffer.from(ticket.escposBase64, 'base64');
    expect(bytes.includes(Buffer.from(toCp866('Това не е фискален бон.')))).toBe(true);
    expect(bytes.includes(Buffer.from(`/o/${order.publicCode}`))).toBe(true);
    expect(bytes.includes(Buffer.from(toCp866('- без Лук')))).toBe(true);

    const reprint = await s.kitchen.client.get(`/api/device/orders/${order.id}/ticket`);
    expect(reprint.statusCode).toBe(200);
    // Само киоскът поръчва от името на обекта.
    expect((await s.kitchen.client.post('/api/device/kiosk/orders', { lines: [{ itemId: s.ayran.id, qty: 1 }] }))
      .statusCode).toBe(403);
  });

  it('таблото получава QR адрес; отнето устройство спира да работи', async () => {
    const s = await shop();
    const qr = (await s.board.client.get('/api/device/qr')).json();
    expect(qr.url).toMatch(new RegExp(`^http://${s.host}/q/\\d+\\.[A-Za-z0-9_-]{16}$`));
    expect(qr.secondsLeft).toBeGreaterThan(0);
    const token = qr.url.split('/q/')[1];
    expect((await new Client(app, s.host).post('/api/session', { qrToken: token })).statusCode).toBe(200);

    const me = (await s.board.client.get('/api/device/me')).json();
    expect(me).toMatchObject({ device: { kind: 'board' }, location: { id: s.loc.id } });
    await s.client.post(`/api/admin/devices/${s.board.id}/revoke`);
    expect((await s.board.client.get('/api/device/me')).statusCode).toBe(401);
    expect((await new Client(app, s.host).post('/api/device/pair', { code: '000000' })).statusCode).toBe(401);
  });

  it('живи обновления: снимък при свързване и при промяна', async () => {
    const s = await shop();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const events: { cooking: number[]; ready: number[] }[] = [];
    const req = request({ host: '127.0.0.1', port, path: '/api/device/stream',
      headers: { host: s.host, cookie: s.board.client.cookie } });
    const done = new Promise<void>((resolve) => {
      req.on('response', (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        expect(res.headers['x-accel-buffering']).toBe('no');
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          for (const m of buf.matchAll(/event: snapshot\ndata: (.*)\n\n/g)) events.push(JSON.parse(m[1]!));
          buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
          if (events.length >= 2) { req.destroy(); resolve(); }
        });
      });
    });
    req.end();
    await new Promise((r) => setTimeout(r, 100));
    await s.kiosk.client.post('/api/device/kiosk/orders', { lines: [{ itemId: s.ayran.id, qty: 1 }] });
    await done;
    expect(events[0]).toEqual({ cooking: [], ready: [] });
    expect(events[1]).toEqual({ cooking: [1], ready: [] });
  });
});

describe('фонови задачи', () => {
  it('затваря забравени поръчки, праща дневен имейл веднъж, чисти старите следи', async () => {
    const s = await shop();
    const o = (await s.kiosk.client.post('/api/device/kiosk/orders', { lines: [{ itemId: s.ayran.id, qty: 2 }] })).json().order;
    await s.kitchen.client.post(`/api/device/orders/${o.id}/ready`);
    await withScope(db, { businessId: s.business.id }, (tx) =>
      tx.query(`UPDATE orders SET ready_at = now() - interval '2 hours' WHERE id = $1`, [o.id]));
    await sweep(db);
    expect((await s.client.get('/api/admin/orders')).json()[0].status).toBe('collected');

    await s.client.patch('/api/admin/business', { dailyEmailHour: 0 });
    const sent: { to: string[]; subject: string; text: string }[] = [];
    const mailer = { send: async (to: string[], subject: string, text: string) => { sent.push({ to, subject, text }); } };
    await dailyEmails(db, mailer);
    const mine = sent.filter((m) => m.to.includes(s.email));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain('Поръчки: 1');
    expect(mine[0]!.text).toContain('2 × Айрян');
    await dailyEmails(db, mailer);
    expect(sent.filter((m) => m.to.includes(s.email))).toHaveLength(1);

    const sum = (await s.client.get(`/api/admin/reports/summary?from=2000-01-01&to=2100-01-01`)).json();
    expect(sum.days[0]).toMatchObject({ orders: 1, collected: 1, revenueCents: 360 });

    await withScope(db, { businessId: s.business.id }, (tx) =>
      tx.query(`UPDATE orders SET created_at = now() - interval '40 days', customer_hash = '\\x01'`));
    await purge(db);
    const left = await withScope(db, { businessId: s.business.id }, (tx) =>
      tx.query('SELECT 1 FROM orders WHERE customer_hash IS NOT NULL'));
    expect(left.rowCount).toBe(0);
  });
});

describe('инсталация', () => {
  it('първоначална настройка и проверка за сертификат', async () => {
    const p = new Client(app, ADMIN_HOST);
    expect((await p.post('/api/setup', { code: 'ГРЕШЕН', email: 'a@b.bg', password: 'дълга-парола-1' })).statusCode)
      .toBe(401);
    const first = await p.post('/api/setup', { code: 'test-setup', email: `boss-${Date.now()}@b.bg`, password: 'дълга-парола-1' });
    expect([201, 409]).toContain(first.statusCode); // 409, ако друг тест вече е създал админ
    expect((await p.post('/api/setup', { code: 'TEST-SETUP', email: 'x@b.bg', password: 'дълга-парола-1' })).statusCode)
      .toBe(409);
    expect((await p.get('/api/setup/status')).json()).toEqual({ needsSetup: false });
    // Настройката не е достъпна на поддомейн на бизнес.
    const { host } = await loggedIn(app, db);
    expect((await new Client(app, host).get('/api/setup/status')).statusCode).toBe(404);

    const tls = (d: string) => app.inject({ url: `/api/internal/tls-check?domain=${d}`, headers: { host: 'app:3000' } });
    expect((await tls(host)).statusCode).toBe(200);
    expect((await tls(`admin.${BASE}`)).statusCode).toBe(200);
    expect((await tls(`nobody.${BASE}`)).statusCode).toBe(404);
  });
});
