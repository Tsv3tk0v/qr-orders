import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../src/db/pool';
import { loggedIn, makeApp } from './helpers';

let app: FastifyInstance;
let db: Db;
beforeAll(async () => ({ app, db } = await makeApp()));
afterAll(async () => { await app.close(); await db.end(); });

describe('меню', () => {
  it('категории, компоненти, артикул и менюто за клиента', async () => {
    const { client: c } = await loggedIn(app, db);
    const M = '/api/admin/menu';
    const doner = (await c.post(`${M}/categories`, { name: { bg: 'Дюнери', en: 'Doners' } })).json();
    const burgers = (await c.post(`${M}/categories`, { name: { bg: 'Бургери' } })).json();
    const hidden = (await c.post(`${M}/categories`, { name: { bg: 'Скрити' }, visible: false })).json();
    expect([doner.position, burgers.position]).toEqual([0, 1]);

    const comp = async (bg: string, extra: object) => (await c.post(`${M}/components`, { name: { bg }, ...extra })).json();
    const meat = await comp('Месо', {});
    const onion = await comp('Лук', { removable: true });
    const extraMeat = await comp('Допълнително месо', { addonPriceCents: 300 });
    const sauce = await comp('Лют сос', { addonPriceCents: 50 });

    const res = await c.post(`${M}/items`, {
      name: { bg: 'ХасаН мега Дюнер', en: 'HasaN Mega Doner' }, description: { bg: 'Хрупкав хляб' },
      priceCents: 950, badgeHit: true, prepMinutes: 8, allergens: ['gluten', 'milk', 'mustard'],
      primaryCategoryId: doner.id, extraCategoryIds: [burgers.id, hidden.id],
    });
    expect(res.statusCode).toBe(201);
    const item = res.json();
    expect(item.categories).toHaveLength(3);

    const withComps = await c.put(`${M}/items/${item.id}/components`, {
      base: [meat.id, onion.id], addons: [{ componentId: extraMeat.id, maxQty: 2 }, { componentId: sauce.id }], maxAddons: 5,
    });
    expect(withComps.json()).toMatchObject({ maxAddons: 5 });
    // Компонент без цена не може да е добавка.
    expect((await c.put(`${M}/items/${item.id}/components`, { base: [], addons: [{ componentId: onion.id }] }))
      .statusCode).toBe(400);

    await c.post(`${M}/items`, { name: { bg: 'Скрит' }, priceCents: 100, visible: false, primaryCategoryId: doner.id });

    const pub = (await c.get('/api/menu')).json();
    expect(pub).toMatchObject({ locales: ['bg', 'en'], defaultLocale: 'bg', currency: 'EUR' });
    expect(pub.items).toHaveLength(1);
    expect(pub.items[0]).toMatchObject({
      name: { bg: 'ХасаН мега Дюнер', en: 'HasaN Mega Doner' }, priceCents: 950, badgeHit: true,
      base: [{ name: { bg: 'Месо' }, removable: false }, { name: { bg: 'Лук' }, removable: true }],
      addons: [{ name: { bg: 'Допълнително месо' }, priceCents: 300, maxQty: 2 }, { priceCents: 50, maxQty: 1 }],
    });
    expect(pub.categories.map((x: { id: string }) => x.id)).toEqual([doner.id, burgers.id]);

    // Подредба на филтрите.
    await c.put(`${M}/categories/order`, { ids: [burgers.id, doner.id] });
    expect((await c.get('/api/menu')).json().categories[0].id).toBe(burgers.id);

    // Ако компонентът спре да е добавка, изчезва от добавките на артикулите.
    await c.patch(`${M}/components/${sauce.id}`, { addonPriceCents: null });
    expect((await c.get('/api/menu')).json().items[0].addons).toHaveLength(1);

    // Изтриване на категория маха само връзката.
    expect((await c.del(`${M}/categories/${burgers.id}`)).statusCode).toBe(204);
    expect((await c.get(`${M}/items/${item.id}`)).json().categories).toHaveLength(2);
  });

  it('проверки и права', async () => {
    const { client: c } = await loggedIn(app, db);
    const other = await loggedIn(app, db);
    const M = '/api/admin/menu';
    expect((await c.post(`${M}/items`, { name: { en: 'Only EN' }, priceCents: 100 })).statusCode).toBe(400);
    expect((await c.post(`${M}/items`, { name: { bg: 'X' }, priceCents: -1 })).statusCode).toBe(400);
    expect((await c.post(`${M}/items`, { name: { bg: 'X' }, priceCents: 1, allergens: ['plutonium'] })).statusCode).toBe(400);
    expect((await c.post(`${M}/items`, { name: { bg: 'X' }, priceCents: 1, code: '12A45' })).statusCode).toBe(400);
    expect((await c.post(`${M}/items`, { name: { bg: 'X' }, priceCents: 1, imageUrl: 'javascript:x' })).statusCode).toBe(400);
    // Категория на друг бизнес.
    const foreign = (await other.client.post(`${M}/categories`, { name: { bg: 'Чужда' } })).json();
    const r = await c.post(`${M}/items`, { name: { bg: 'X' }, priceCents: 1, primaryCategoryId: foreign.id });
    expect(r.statusCode).toBe(400);
    expect((await c.patch(`${M}/categories/${foreign.id}`, { visible: false })).statusCode).toBe(404);
    // Повтарящ се код.
    await c.post(`${M}/items`, { name: { bg: 'А' }, priceCents: 1, code: '000001' });
    expect((await c.post(`${M}/items`, { name: { bg: 'Б' }, priceCents: 1, code: '000001' })).statusCode).toBe(409);

    const staff = await loggedIn(app, db, 'staff');
    expect((await staff.client.get(`${M}/items`)).statusCode).toBe(403);
    const manager = await loggedIn(app, db, 'manager');
    expect((await manager.client.post(`${M}/categories`, { name: { bg: 'М' } })).statusCode).toBe(201);
  });

  it('търсене и чакащи одобрение', async () => {
    const { client: c } = await loggedIn(app, db);
    const M = '/api/admin/menu';
    await c.post(`${M}/items`, { name: { bg: 'Еклер с ванилия', en: 'Vanilla eclair' }, priceCents: 240, code: '004512' });
    await c.post(`${M}/items`, { name: { bg: 'Тирамису' }, priceCents: 450 });
    expect((await c.get(`${M}/items?q=еклер`)).json()).toHaveLength(1);
    expect((await c.get(`${M}/items?q=vanilla`)).json()).toHaveLength(1);
    expect((await c.get(`${M}/items?q=0045`)).json()).toHaveLength(1);
    expect((await c.get(`${M}/items?approval=pending`)).json()).toHaveLength(0);
  });
});

describe('външен вид и обекти', () => {
  it('публикува марка с проверка на контраста и пази версии', async () => {
    const { client: c } = await loggedIn(app, db);
    const S = '/api/admin/settings';
    const base = { theme: 'classic', defaultLocale: 'bg', enabledLocales: ['bg', 'en'] };
    const bad = await c.put(`${S}/appearance`, { ...base, brand: { accent: '#FFD000', onAccent: '#FFFFFF' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: 'invalid_brand', issues: [{ token: 'accent', code: 'low_contrast' }] });

    const brand = { primary: '#141414', accent: '#D7191C', onAccent: '#FFFFFF', menuBackground: '#F6F3EF',
      boardBackground: '#0B0B0B', text: '#1E1E1E', font: 'Merriweather', logoDarkUrl: '/media/logo-dark.png' };
    const ok = await c.put(`${S}/appearance`, { ...base, brand });
    expect(ok.statusCode).toBe(200);
    const ctx = (await c.get('/api/context')).json();
    expect(ctx.business).toMatchObject({ theme: 'classic', brand: { ...brand, cooking: '#C4281F' } });
    expect((await c.get(`${S}/appearance/versions`)).json()).toHaveLength(1);

    // Само български: английските текстове не стигат до клиента.
    expect((await c.put(`${S}/appearance`, { ...base, brand, enabledLocales: ['en'] })).statusCode).toBe(400);
    await c.put(`${S}/appearance`, { ...base, brand, enabledLocales: ['bg'] });
    await c.post('/api/admin/menu/items', { name: { bg: 'Кафе', en: 'Coffee' }, priceCents: 260 });
    const pub = (await c.get('/api/menu')).json();
    expect(pub.locales).toEqual(['bg']);
    expect(pub.items[0].name).toEqual({ bg: 'Кафе' });
  });

  it('обект: QR и киоск не могат да са изключени едновременно', async () => {
    const { client: c } = await loggedIn(app, db);
    const loc = (await c.get('/api/admin/settings')).json().locations[0];
    expect((await c.patch(`/api/admin/settings/locations/${loc.id}`, { qrEnabled: false })).statusCode).toBe(400);
    const r = await c.patch(`/api/admin/settings/locations/${loc.id}`, { qrEnabled: false, kioskEnabled: true });
    expect(r.json()).toMatchObject({ qrEnabled: false, kioskEnabled: true, kioskAutoAccept: true });
    const staff = await loggedIn(app, db, 'staff');
    expect((await staff.client.get('/api/admin/settings')).statusCode).toBe(403);
  });
});
