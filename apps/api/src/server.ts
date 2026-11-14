import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { env } from './config';
import { parseKey } from './auth/crypto';
import { createPool } from './db/pool';
import { migrate } from './db/migrate';
import { buildApp } from './http/app';
import { createMailer } from './mail';
import { startJobs } from './jobs';

// 1. Миграции при всеки старт (безопасно е — пускат се само новите).
if (process.env.MIGRATION_DATABASE_URL) {
  await migrate(env.migrationDatabaseUrl, (m) => console.log(`[миграции] ${m}`));
}

const db = createPool(env.databaseUrl);
const secure = process.env.INSECURE_COOKIES !== '1';
const app = await buildApp({
  db,
  baseDomain: env.baseDomain,
  secretsKey: parseKey(env.secretsKey),
  qrSecret: env.qrSecret,
  contactKey: env.contactKey,
  setupCode: process.env.SETUP_CODE,
  localMode: process.env.LOCAL_MODE === '1',
  secureCookies: secure,
  trustProxy: process.env.TRUST_PROXY !== '0',
  logger: true,
});

// 2. Уеб екраните (React) от същия процес; всички пътища без /api връщат index.html.
const webDist = process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false,
    setHeaders: (res, path) => {
      res.setHeader('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    } });
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
    return reply.type('text/html').header('Cache-Control', 'no-cache').sendFile('index.html');
  });
}

// 3. Фонови задачи.
const mailer = createMailer(process.env.SMTP_URL || undefined, process.env.MAIL_FROM ?? 'noreply@localhost',
  (m) => app.log.info(m));
const [fromH, toH] = (process.env.IMPORT_HOURS ?? '06-22').split('-').map(Number) as [number, number];
startJobs(db, mailer, { importRoot: process.env.IMPORT_ROOT || undefined,
  importIntervalMin: Number(process.env.IMPORT_INTERVAL_MIN ?? 15), importHours: [fromH, toH] },
(m, e) => app.log.error({ err: e }, m));

await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
