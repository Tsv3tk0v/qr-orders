import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { totpCode, totpStep } from '../src/auth/crypto';
import { withScope, type Db } from '../src/db/pool';
import { BASE } from './env';
import { ADMIN_HOST, Client, makeApp, PASSWORD, seedBusiness, seedPlatformAdmin, uniq } from './helpers';

let app: FastifyInstance;
let db: Db;

beforeAll(async () => ({ app, db } = await makeApp()));
afterAll(async () => { await app.close(); await db.end(); });

describe('хост и контекст', () => {
  it('контекст на бизнеса, непознат хост, health', async () => {
    const { host, business } = await seedBusiness(db);
    const ctx = await new Client(app, host).get('/api/context');
    expect(ctx.json()).toMatchObject({ kind: 'business',
      business: { slug: business.slug, theme: 'light', defaultLocale: 'bg' }, location: { slug: 'main' } });
    expect((await new Client(app, `nobody.${BASE}`).get('/api/context')).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/health' })).json()).toEqual({ ok: true });
  });

  it('отказва заявки без Origin или от чужд Origin', async () => {
    const { host, email } = await seedBusiness(db);
    const c = new Client(app, host);
    const body = { email, password: PASSWORD };
    expect((await c.req('POST', '/api/auth/login', body, { origin: '' })).statusCode).toBe(403);
    expect((await c.req('POST', '/api/auth/login', body, { origin: 'https://evil.com' })).statusCode).toBe(403);
  });
});

describe('вход и 2FA', () => {
  it('без 2FA няма достъп; грешен код се отказва; след 2FA има', async () => {
    const { host, email } = await seedBusiness(db);
    const c = new Client(app, host);
    expect((await c.post('/api/auth/login', { email, password: 'грешна-парола' })).statusCode).toBe(401);
    expect((await c.post('/api/auth/login', { email: email.toUpperCase(), password: PASSWORD })).json())
      .toEqual({ stage: 'enroll_2fa' });

    const blocked = await c.get('/api/admin/users');
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error).toBe('second_factor_required');
    // Без започната настройка кодът няма към какво да се провери.
    expect((await c.post('/api/auth/2fa', { code: '123456' })).json().error).toBe('enrollment_not_started');

    const { secret, otpauthUrl } = (await c.post('/api/auth/2fa/enroll')).json();
    expect(otpauthUrl).toContain(`secret=${secret}`);
    const wrong = (Number(totpCode(secret, totpStep())) + 1) % 1_000_000;
    expect((await c.post('/api/auth/2fa', { code: String(wrong).padStart(6, '0') })).statusCode).toBe(401);
    const pendingCookie = c.cookie;
    expect((await c.post('/api/auth/2fa', { code: totpCode(secret, totpStep()) })).json()).toEqual({ stage: 'active' });
    expect(c.cookie).not.toBe(pendingCookie); // нова бисквитка след входа

    const me = (await c.get('/api/auth/me')).json();
    expect(me).toMatchObject({ stage: 'active', user: { email, role: 'owner' } });
    expect(me.permissions).toContain('users.manage');
    expect((await c.get('/api/admin/users')).statusCode).toBe(200);

    // Втори вход: иска код, а използваният вече не важи.
    const c2 = new Client(app, host);
    expect((await c2.post('/api/auth/login', { email, password: PASSWORD })).json()).toEqual({ stage: 'verify_2fa' });
    expect((await c2.post('/api/auth/2fa/enroll')).statusCode).toBe(409); // не може да смени тайната
    expect((await c2.post('/api/auth/2fa', { code: totpCode(secret, totpStep()) })).statusCode).toBe(401);
    expect((await c2.post('/api/auth/2fa', { code: totpCode(secret, totpStep() + 1) })).json())
      .toEqual({ stage: 'active' });

    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
    expect((await c2.get('/api/auth/me')).statusCode).toBe(200);
  });

  it('бисквитката на един бизнес не важи на друг', async () => {
    const a = await seedBusiness(db);
    const b = await seedBusiness(db);
    const ca = new Client(app, a.host);
    await ca.loginAndEnroll(a.email);
    const cb = new Client(app, b.host);
    cb.cookie = ca.cookie;
    expect((await cb.get('/api/auth/me')).statusCode).toBe(401);
    // Собственикът на бизнес не влиза в админа на платформата.
    const cp = new Client(app, ADMIN_HOST);
    expect((await cp.post('/api/auth/login', { email: a.email, password: PASSWORD })).statusCode).toBe(401);
  });

  it('заключва след 5 грешни опита', async () => {
    const { host, email } = await seedBusiness(db);
    const c = new Client(app, host);
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { email, password: 'грешна-парола' });
    const r = await c.post('/api/auth/login', { email, password: PASSWORD });
    expect(r.statusCode).toBe(423);
    expect(r.json().error).toBe('locked');
  });

  it('смяна на парола изхвърля другите сесии', async () => {
    const { host, email } = await seedBusiness(db);
    const c1 = new Client(app, host);
    const secret = await c1.loginAndEnroll(email);
    const c2 = new Client(app, host);
    await c2.post('/api/auth/login', { email, password: PASSWORD });
    await c2.post('/api/auth/2fa', { code: totpCode(secret, totpStep() + 1) });
    expect((await c1.post('/api/auth/password', { current: PASSWORD, next: 'къса' })).statusCode).toBe(400);
    expect((await c1.post('/api/auth/password', { current: 'грешна', next: 'нова-дълга-парола' })).statusCode).toBe(401);
    expect((await c1.post('/api/auth/password', { current: PASSWORD, next: 'нова-дълга-парола' })).statusCode).toBe(200);
    expect((await c1.get('/api/auth/me')).statusCode).toBe(200);
    expect((await c2.get('/api/auth/me')).statusCode).toBe(401);
  });
});

describe('роли и потребители', () => {
  it('собственикът управлява потребители; персоналът няма достъп', async () => {
    const { host, email } = await seedBusiness(db);
    const owner = new Client(app, host);
    await owner.loginAndEnroll(email);

    const staffEmail = `staff-${uniq()}@x.bg`;
    const created = await owner.post('/api/admin/users', { email: staffEmail, role: 'staff', password: PASSWORD });
    expect(created.statusCode).toBe(201);
    const staffId = created.json().id;
    expect((await owner.post('/api/admin/users', { email: staffEmail, role: 'staff', password: PASSWORD })).statusCode)
      .toBe(409);
    expect((await owner.post('/api/admin/users', { email: 'x@y.bg', role: 'platform_admin', password: PASSWORD }))
      .statusCode).toBe(400);

    const staff = new Client(app, host);
    await staff.loginAndEnroll(staffEmail);
    expect((await staff.get('/api/admin/users')).statusCode).toBe(403);
    expect((await staff.get('/api/admin/audit')).statusCode).toBe(403);

    // Собственикът не може да промени себе си.
    const me = (await owner.get('/api/auth/me')).json();
    expect((await owner.patch(`/api/admin/users/${me.user.id}`, { active: false })).statusCode).toBe(409);

    // Повишаване на роля изхвърля сесиите на потребителя.
    const upd = await owner.patch(`/api/admin/users/${staffId}`, { role: 'manager' });
    expect(upd.json()).toMatchObject({ role: 'manager' });
    expect((await staff.get('/api/auth/me')).statusCode).toBe(401);

    // Нулиране на 2FA: при следващ вход трябва да настрои наново.
    await owner.patch(`/api/admin/users/${staffId}`, { reset2fa: true });
    expect((await staff.post('/api/auth/login', { email: staffEmail, password: PASSWORD })).json())
      .toEqual({ stage: 'enroll_2fa' });

    // Деактивиран потребител не може да влезе.
    await owner.patch(`/api/admin/users/${staffId}`, { active: false });
    expect((await staff.post('/api/auth/login', { email: staffEmail, password: PASSWORD })).statusCode).toBe(401);
  });

  it('потребител от друг бизнес не може да бъде променен', async () => {
    const a = await seedBusiness(db);
    const b = await seedBusiness(db);
    const ca = new Client(app, a.host);
    await ca.loginAndEnroll(a.email);
    expect((await ca.patch(`/api/admin/users/${b.user.id}`, { active: false })).statusCode).toBe(404);
  });
});

describe('журнал', () => {
  it('записва действията и показва само своя бизнес', async () => {
    const a = await seedBusiness(db);
    const b = await seedBusiness(db);
    const ca = new Client(app, a.host);
    await ca.post('/api/auth/login', { email: a.email, password: 'грешна-парола' });
    await ca.loginAndEnroll(a.email);
    await ca.post('/api/admin/users', { email: `m-${uniq()}@x.bg`, role: 'manager', password: PASSWORD });
    await new Client(app, b.host).post('/api/auth/login', { email: b.email, password: 'грешна-парола' });

    const log = (await ca.get('/api/admin/audit')).json() as { action: string; actorEmail: string; ip: string }[];
    expect(log.map((e) => e.action)).toEqual(['user.created', 'auth.login', 'auth.2fa_enabled', 'auth.failed']);
    expect(log[0]!.actorEmail).toBe(a.email);
    expect(log[0]!.ip).toBeTruthy();
  });

  it('приложението не може да променя или трие журнала', async () => {
    const a = await seedBusiness(db);
    await expect(withScope(db, { businessId: a.business.id }, (tx) => tx.query('DELETE FROM audit_log')))
      .rejects.toThrow(/permission denied/);
    await expect(withScope(db, { businessId: a.business.id }, (tx) => tx.query("UPDATE audit_log SET action = 'x'")))
      .rejects.toThrow(/permission denied/);
  });
});

describe('платформа', () => {
  it('админ на платформата създава бизнес със собственик и обект', async () => {
    const rootEmail = await seedPlatformAdmin(db);
    const p = new Client(app, ADMIN_HOST);
    await p.loginAndEnroll(rootEmail);

    const slug = `new-${uniq()}`;
    const res = await p.post('/api/platform/businesses', {
      slug, name: 'Сладкарница Ф', theme: 'classic',
      owner: { email: `owner@${slug}.bg`, password: PASSWORD },
      location: { slug: 'center', name: 'Център', kioskEnabled: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ business: { slug, theme: 'classic' }, owner: { role: 'owner' },
      location: { slug: 'center', kioskEnabled: true } });

    // Запазено име и невалидни данни: нищо не се създава наполовина.
    const bad = await p.post('/api/platform/businesses', { slug: 'admin', name: 'X',
      owner: { email: 'a@b.bg', password: PASSWORD } });
    expect(bad.statusCode).toBe(400);
    const half = `half-${uniq()}`;
    expect((await p.post('/api/platform/businesses', { slug: half, name: 'X',
      owner: { email: 'a@b.bg', password: 'къса' } })).statusCode).toBe(400);
    expect((await new Client(app, `${half}.${BASE}`).get('/api/context')).statusCode).toBe(404);

    // Новият собственик влиза на своя поддомейн.
    const owner = new Client(app, `${slug}--center.${BASE}`);
    await owner.loginAndEnroll(`owner@${slug}.bg`);
    expect((await owner.get('/api/context')).json().location.slug).toBe('center');

    // Пътищата са разделени по хост.
    expect((await owner.get('/api/platform/businesses')).statusCode).toBe(404);
    expect((await p.get('/api/admin/users')).statusCode).toBe(404);
    expect((await p.get('/api/platform/audit')).json()[0].action).toBe('business.created');
  });
});
