// Администратор на платформата: създава нов или дава нов достъп на съществуващ
// (нова парола + нулиран двуфакторен вход). На сървъра:  qr reset-admin имейл@домейн
// Паролата се генерира и се показва веднъж. При вход се настройва 2FA наново.
import { randomBytes } from 'node:crypto';
import { env } from '../config';
import { createPool, withScope } from '../db/pool';
import { audit, resetAccess } from '../auth/service';

const email = process.argv[2];
if (!email) {
  console.error('Употреба: create-admin <имейл>');
  process.exit(1);
}
const password = randomBytes(12).toString('base64url');
const db = createPool(env.databaseUrl);
const user = await withScope(db, { platform: true }, async (tx) => {
  const u = await resetAccess(tx, null, email, password, 'platform_admin');
  await audit(tx, null, { action: 'user.access_reset', targetType: 'user', targetId: u.id, data: { via: 'cli' } });
  return u;
});
await db.end();
console.log(`Готово: ${user.email}\nВременна парола: ${password}\nПри вход настройте двуфакторния вход и сменете паролата.`);
