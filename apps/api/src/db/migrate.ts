import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

/** Пуска нови .sql файлове по ред на името, всеки в отделна транзакция. */
export async function migrate(connectionString: string, log: (m: string) => void = () => {}): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    // Само един процес мигрира наведнъж.
    await client.query('SELECT pg_advisory_lock(727274)');
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(`${MIGRATIONS_DIR}/${file}`, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Миграция ${file} се провали: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`приложена ${file}`);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { env } = await import('../config');
  const applied = await migrate(env.migrationDatabaseUrl, console.log);
  console.log(applied.length ? `Готово: ${applied.length} миграции.` : 'Няма нови миграции.');
}
