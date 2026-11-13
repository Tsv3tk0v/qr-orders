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
  const app = await buildApp({ db, baseDomain: BASE, secretsKey: randomBytes(32), secureCookies: false });
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
  cookie = '';
  constructor(private app: FastifyInstance, public host: string) {}

  async req(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method, url, payload: body as object | undefined,
      headers: { host: this.host, origin: `https://${this.host}`, cookie: this.cookie, ...headers },
    });
    const set = res.cookies.find((c) => c.name === 'sid');
    if (set) this.cookie = set.value ? `sid=${set.value}` : '';
    return res;
  }
  get(url: string) { return this.req('GET', url); }
  post(url: string, body: unknown = {}) { return this.req('POST', url, body); }
  patch(url: string, body: unknown) { return this.req('PATCH', url, body); }

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
