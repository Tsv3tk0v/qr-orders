import pg from 'pg';
import { migrate } from '../src/db/migrate';
import { TEST_MIGRATION_DB_URL } from './env';

/** Тестовата база се създава наново: празна схема + всички миграции. */
export default async function setup() {
  const client = new pg.Client({ connectionString: TEST_MIGRATION_DB_URL });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();
  await migrate(TEST_MIGRATION_DB_URL);
}
