import { createPool } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { TEST_MIGRATION_DB_URL } from './env';

/** Тестовата база се създава наново: празна схема + всички миграции. */
export default async function setup() {
  const pool = createPool(TEST_MIGRATION_DB_URL);
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await pool.end();
  await migrate(TEST_MIGRATION_DB_URL);
}
