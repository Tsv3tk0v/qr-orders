-- Изпълнява се веднъж от администратор на PostgreSQL (не от миграциите).
-- qr      — собственик на таблиците, пуска миграциите.
-- qr_app  — ролята, с която работи приложението. Не е собственик и няма BYPASSRLS.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qr') THEN
    CREATE ROLE qr LOGIN PASSWORD 'qr';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qr_app') THEN
    CREATE ROLE qr_app LOGIN PASSWORD 'qr_app' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
-- В продукция паролите се сменят: ALTER ROLE qr_app PASSWORD '...';
