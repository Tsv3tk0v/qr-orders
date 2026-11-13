import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { totpCode, totpStep } from '../src/auth/crypto';
import { insertUser } from '../src/auth/service';
import { createPool, withScope, type Db } from '../src/db/pool';
import { buildApp } from '../src/http/app';
import { insertBusiness, insertLocation } from '../src/tenancy/repo';
import { BASE, TEST_DB_URL } from './env';

export const uniq = () => randomUUID().slice(0, 8);
export const PASSWORD = 'много-тайна-парола';
export const ADMIN_HOST = `admin.${BASE}`;

export async function makeApp(): Promise<{ app: FastifyInstance; db: Db }> {
  const db = createPool(TEST_DB_URL);
  const app = await buildApp({ db, baseDomain: BASE, secretsKey: randomBytes(32), secureCookies: false,
    qrSecret: 'test-qr-secret', contactKey: 'test-contact-key', setupCode: 'TEST-SETUP', rateLimitScale: 1000 });
  return { app, db };
}

export async function seedBusiness(db: Db, role: 'owner' | 'manager' | 'staff' = 'owner') {
  const slug = `t-${uniq()}`;
  return withScope(db, { platform: true }, async (tx) => {
    const business = await insertBusiness(tx, { slug, name: `Тест ${slug}` }, BASE);
    await insertLocation(tx, business.id, { slug: 'main', name: 'Основен' }, BASE);
    const email = `${role}@${slug}.bg`;
    const user = await insertUser(tx, business.id, { email, role, password: PASSWORD });
    return { business, host: `${slug}.${BASE}`, email, user };
  });
}

export async function seedPlatformAdmin(db: Db) {
  const email = `root-${uniq()}@platform.bg`;
  await withScope(db, { platform: true }, (tx) =>
    insertUser(tx, null, { email, role: 'platform_admin', password: PASSWORD }));
  return email;
}

/** Клиент с бисквитки, който праща правилния Host и Origin. */
export class Client {
  jar = new Map<string, string>();
  get cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  set cookie(v: string) {
    this.jar.clear();
    for (const part of v.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k) this.jar.set(k, rest.join('='));
    }
  }
  constructor(private app: FastifyInstance, public host: string) {}

  async req(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown,
    headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method, url, payload: body as object | Buffer | undefined,
      headers: { host: this.host, origin: `https://${this.host}`, cookie: this.cookie, ...headers },
    });
    for (const c of res.cookies) this.jar.set(c.name, c.value);
    for (const [k, v] of [...this.jar]) if (!v) this.jar.delete(k);
    return res;
  }
  get(url: string) { return this.req('GET', url); }
  post(url: string, body: unknown = {}) { return this.req('POST', url, body); }
  patch(url: string, body: unknown) { return this.req('PATCH', url, body); }
  put(url: string, body: unknown) { return this.req('PUT', url, body); }
  del(url: string) { return this.req('DELETE', url); }
  upload(url: string, content: Buffer, type = 'text/csv') {
    return this.req('POST', url, content, { 'content-type': type });
  }

  /** Пълен вход с първоначална настройка на 2FA. Връща тайната. */
  async loginAndEnroll(email: string, password = PASSWORD): Promise<string> {
    const l = await this.post('/api/auth/login', { email, password });
    expect(l.json()).toEqual({ stage: 'enroll_2fa' });
    const e = await this.post('/api/auth/2fa/enroll');
    expect(e.statusCode).toBe(200);
    const { secret } = e.json();
    const v = await this.post('/api/auth/2fa', { code: totpCode(secret, totpStep()) });
    expect(v.json()).toEqual({ stage: 'active' });
    return secret;
  }
}

/** Бизнес с влязъл потребител (по подразбиране собственик). */
export async function loggedIn(app: FastifyInstance, db: Db, role: 'owner' | 'manager' | 'staff' = 'owner') {
  const seeded = await seedBusiness(db, role);
  const client = new Client(app, seeded.host);
  await client.loginAndEnroll(seeded.email);
  return { ...seeded, client };
}
