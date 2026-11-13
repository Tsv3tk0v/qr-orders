import { env } from './config';
import { parseKey } from './auth/crypto';
import { createPool } from './db/pool';
import { buildApp } from './http/app';

const app = await buildApp({
  db: createPool(env.databaseUrl),
  baseDomain: env.baseDomain,
  secretsKey: parseKey(env.secretsKey),
  secureCookies: process.env.INSECURE_COOKIES !== '1',
  trustProxy: process.env.TRUST_PROXY !== '0',
  logger: true,
});
await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
