import pg from 'pg';
import { createLitePool, isPgliteUrl } from './pglite';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

/** Контекст на заявката: един бизнес или (рядко) цялата платформа. */
export type Scope = { businessId: string } | { platform: true } | { anonymous: true };

export function createPool(connectionString: string): Db {
  if (isPgliteUrl(connectionString)) return createLitePool(connectionString);
  return new pg.Pool({ connectionString, max: 10 });
}

/**
 * Всяка работа с данни минава оттук: транзакция + контекст за RLS.
 * Контекстът е `SET LOCAL` и изчезва с края на транзакцията,
 * така че връзката се връща в пула чиста.
 */
export async function withScope<T>(db: Db, scope: Scope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if ('businessId' in scope) {
      await client.query("SELECT set_config('app.business_id', $1, true)", [scope.businessId]);
    } else if ('platform' in scope) {
      await client.query("SELECT set_config('app.scope', 'platform', true)");
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
