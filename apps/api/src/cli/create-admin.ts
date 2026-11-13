// Първи администратор на платформата: pnpm --filter @qr/api create-admin имейл@домейн
// Паролата се генерира и се показва веднъж. При първи вход се настройва 2FA.
import { randomBytes } from 'node:crypto';
import { env } from '../config';
import { createPool, withScope } from '../db/pool';
import { audit, insertUser } from '../auth/service';

const email = process.argv[2];
if (!email) {
  console.error('Употреба: create-admin <имейл>');
  process.exit(1);
}
const password = randomBytes(12).toString('base64url');
const db = createPool(env.databaseUrl);
const user = await withScope(db, { platform: true }, async (tx) => {
  const u = await insertUser(tx, null, { email, role: 'platform_admin', password });
  await audit(tx, null, { action: 'user.created', targetType: 'user', targetId: u.id, data: { via: 'cli' } });
  return u;
});
await db.end();
console.log(`Създаден: ${user.email}\nВременна парола: ${password}\nСмени я след първия вход.`);
