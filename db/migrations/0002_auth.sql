-- Етап 2: потребители, роли, сесии, 2FA, журнал.
-- business_id NULL означава ниво платформа (администратори на платформата).
-- Такива редове се виждат само в контекст 'platform'.

CREATE TABLE users (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid REFERENCES businesses(id) ON DELETE CASCADE,
  email             text NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  name              text NOT NULL DEFAULT '',
  -- Платформа: 'platform_admin'. Бизнес: 'owner', 'manager', 'staff'.
  role              text NOT NULL,
  CHECK ((business_id IS NULL AND role = 'platform_admin')
      OR (business_id IS NOT NULL AND role IN ('owner', 'manager', 'staff'))),
  password_hash     text NOT NULL,
  -- Тайната за TOTP е криптирана (AES-256-GCM) с ключ от .env.
  totp_secret_enc   text,
  totp_enabled      boolean NOT NULL DEFAULT false,
  totp_last_step    bigint,          -- защита от повторно ползване на код
  failed_logins     int NOT NULL DEFAULT 0,
  locked_until      timestamptz,
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (business_id, email),
  UNIQUE (business_id, id)
);
CREATE TRIGGER users_touch BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid REFERENCES businesses(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,   -- sha256 на бисквитката; самата бисквитка не се пази
  -- 'enroll_2fa' → трябва да настрои 2FA; 'verify_2fa' → трябва да въведе код; 'active'
  stage         text NOT NULL CHECK (stage IN ('enroll_2fa', 'verify_2fa', 'active')),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ip            inet,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id  uuid REFERENCES businesses(id) ON DELETE CASCADE,
  actor_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  target_type  text,
  target_id    text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_business_time_idx ON audit_log (business_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'sessions', 'audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I
      USING (app_is_platform() OR (business_id IS NOT NULL AND business_id = app_business_id()))
      WITH CHECK (app_is_platform() OR (business_id IS NOT NULL AND business_id = app_business_id()))$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON users, sessions TO qr_app;
-- Журналът само се добавя, никога не се променя или трие от приложението.
GRANT SELECT, INSERT ON audit_log TO qr_app;
