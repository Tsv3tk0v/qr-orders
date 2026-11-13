import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Липсва променлива на средата ${name} (виж .env.example)`);
  return v;
}

export const env = {
  get databaseUrl() { return required('DATABASE_URL'); },
  get migrationDatabaseUrl() { return required('MIGRATION_DATABASE_URL'); },
  get baseDomain() { return required('BASE_DOMAIN'); },
  get secretsKey() { return required('SECRETS_KEY'); },
};
