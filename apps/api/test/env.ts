import '../src/config';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://qr_app:qr_app@localhost:5432/qr_test';
export const TEST_MIGRATION_DB_URL =
  process.env.TEST_MIGRATION_DATABASE_URL ?? 'postgres://qr:qr@localhost:5432/qr_test';
export const BASE = 'example.test';
