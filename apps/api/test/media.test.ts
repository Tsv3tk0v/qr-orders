import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/pool';
import { Client, loggedIn, makeApp } from './helpers';

let app: FastifyInstance;
let db: Db;
beforeAll(async () => ({ app, db } = await makeApp()));
afterAll(async () => { await app.close(); await db.end(); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);

describe('снимки', () => {
  it('качване, показване, проверка на типа, само в своя бизнес', async () => {
    const { client: c, host } = await loggedIn(app, db);
    const r = await c.upload('/api/admin/media', PNG, 'image/png');
    expect(r.statusCode).toBe(201);
    const { url } = r.json();
    expect(url).toMatch(/^\/media\/[0-9a-f-]{36}$/);

    const pub = await new Client(app, host).get(url);
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('image/png');
    expect(pub.rawPayload.equals(PNG)).toBe(true);

    // SVG/HTML под маската на PNG не минава.
    expect((await c.upload('/api/admin/media', Buffer.from('<svg onload=alert(1)>'), 'image/png')).json().error).toBe('unsupported_image');
    expect((await c.upload('/api/admin/media', Buffer.alloc(3 * 1024 * 1024, 0xff), 'image/jpeg')).statusCode).toBe(413);

    // Друг бизнес не вижда снимката.
    const other = await loggedIn(app, db);
    expect((await new Client(app, other.host).get(url)).statusCode).toBe(404);
    // Персоналът не качва.
    const staff = await loggedIn(app, db, 'staff');
    expect((await staff.client.upload('/api/admin/media', PNG, 'image/png')).statusCode).toBe(403);
    // Адресът се приема като снимка на артикул.
    expect((await c.post('/api/admin/menu/items', { name: { bg: 'X' }, priceCents: 1, imageUrl: url })).statusCode).toBe(201);
  });
});
