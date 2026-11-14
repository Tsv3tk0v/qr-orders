import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createPool, type Db } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { buildApp } from '../src/http/app';
import { Client, PASSWORD } from './helpers';

// Офлайн режим върху вградения PostgreSQL (PGlite) в паметта — както би работил без сървър с база.
let app: FastifyInstance;
let db: Db;
beforeAll(async () => {
  db = createPool('pglite:///?user=qr_app');      // отваря базата в паметта
  await migrate('pglite:///?user=qr');            // същата база, като собственик
  app = await buildApp({ db, baseDomain: 'local.invalid', secretsKey: randomBytes(32), secureCookies: false,
    qrSecret: 'q', contactKey: 'c', setupCode: 'LOCAL-1234', localMode: true, rateLimitScale: 1000 });
});
afterAll(async () => { await app.close(); await db.end(); });

describe('офлайн режим (без домейн)', () => {
  it('настройка на IP адрес → бизнес с киоск → поръчка от киоска', async () => {
    const ip = new Client(app, '192.168.1.20');
    expect((await ip.get('/api/context')).json()).toEqual({ kind: 'platform', localMode: true });
    expect((await ip.get('/api/setup/status')).json()).toEqual({ needsSetup: true, localMode: true });
    expect((await ip.post('/api/setup', { code: 'local-1234', email: 'boss@shop.bg', password: PASSWORD })).statusCode).toBe(400);
    const r = await ip.post('/api/setup', { code: 'local-1234', email: 'boss@shop.bg', password: PASSWORD, businessName: 'Дюнер Двор' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ role: 'owner' });
    expect((await ip.post('/api/setup', { code: 'LOCAL-1234', email: 'x@y.bg', password: PASSWORD, businessName: 'X' })).statusCode).toBe(404);

    // Всеки адрес (IP или име на компютъра) води към бизнеса.
    const ctx = (await new Client(app, '10.0.0.5:8080').get('/api/context')).json();
    expect(ctx).toMatchObject({ kind: 'business', business: { name: 'Дюнер Двор' }, location: { kioskEnabled: true, qrEnabled: false } });

    const owner = new Client(app, '192.168.1.20');
    await owner.loginAndEnroll('boss@shop.bg');
    const item = (await owner.post('/api/admin/menu/items', { name: { bg: 'Айрян' }, priceCents: 180 })).json();
    const loc = (await owner.get('/api/admin/settings')).json().locations[0];
    expect(loc.ticketQr).toBe(false);
    const pair = (await owner.post('/api/admin/devices', { locationId: loc.id, kind: 'kiosk', name: 'Киоск' })).json();

    const kiosk = new Client(app, '192.168.1.20');
    expect((await kiosk.post('/api/device/pair', { code: pair.pairingCode })).statusCode).toBe(200);
    const o = await kiosk.post('/api/device/kiosk/orders', { lines: [{ itemId: item.id, qty: 2 }] });
    expect(o.statusCode).toBe(201);
    expect(o.json().order).toMatchObject({ number: 1, status: 'accepted', totalCents: 360 });
  });
});
