-- Етап 1: бизнеси, обекти, поддомейни, RLS.
-- Всеки ред носи business_id. Приложението задава контекста в транзакцията:
--   SELECT set_config('app.business_id', '<uuid>', true);
-- Действия на ниво платформа (създаване на бизнес) ползват:
--   SELECT set_config('app.scope', 'platform', true);
-- RLS е втори предпазител срещу грешки в кода, не замества проверките в API.

GRANT USAGE ON SCHEMA public TO qr_app;

CREATE FUNCTION app_business_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('app.business_id', true), '')::uuid $$;

CREATE FUNCTION app_is_platform() RETURNS boolean
  LANGUAGE sql STABLE AS
$$ SELECT coalesce(current_setting('app.scope', true), '') = 'platform' $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- Бизнес -----------------------------------------------------------------
CREATE TABLE businesses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug           text NOT NULL UNIQUE
                 CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$' AND position('--' in slug) = 0),
  name           text NOT NULL CHECK (length(btrim(name)) > 0),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  default_locale text NOT NULL DEFAULT 'bg' CHECK (default_locale IN ('bg', 'en')),
  theme          text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'classic')),
  -- Токени на марката: цветове, лого, шрифт. Интерфейсът чете оттук, не от кода.
  brand          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(brand) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER businesses_touch BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Обект ------------------------------------------------------------------
CREATE TABLE locations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  slug               text NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$' AND position('--' in slug) = 0),
  name               text NOT NULL CHECK (length(btrim(name)) > 0),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  timezone           text NOT NULL DEFAULT 'Europe/Sofia',
  -- Начин на поръчка (реш. 2): QR, киоск или двата; поне един е включен.
  qr_enabled         boolean NOT NULL DEFAULT true,
  kiosk_enabled      boolean NOT NULL DEFAULT false,
  CHECK (qr_enabled OR kiosk_enabled),
  -- QR поръчките се приемат ръчно (реш. 4), киоск — автоматично (реш. 5).
  qr_auto_accept     boolean NOT NULL DEFAULT false,
  kiosk_auto_accept  boolean NOT NULL DEFAULT true,
  -- Режим на плащане (реш. 1): във версия 1 само 'none'.
  payment_mode       text NOT NULL DEFAULT 'none' CHECK (payment_mode IN ('none')),
  -- Номерация (реш. 6): нулиране всеки ден в този час местно време.
  order_reset_hour   smallint NOT NULL DEFAULT 4 CHECK (order_reset_hour BETWEEN 0 AND 23),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, slug),
  UNIQUE (business_id, id)
);
CREATE TRIGGER locations_touch BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Домейни: хост → бизнес (и по избор обект) ------------------------------
CREATE TABLE domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id uuid,
  hostname    text NOT NULL UNIQUE
              CHECK (hostname = lower(hostname) AND hostname ~ '^[a-z0-9.-]+$'),
  kind        text NOT NULL DEFAULT 'subdomain' CHECK (kind IN ('subdomain', 'custom')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES locations (business_id, id) ON DELETE CASCADE
);
CREATE INDEX domains_business_idx ON domains (business_id);

-- RLS ----------------------------------------------------------------------
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE businesses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON businesses
  USING (app_is_platform() OR id = app_business_id())
  WITH CHECK (app_is_platform() OR id = app_business_id());

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON locations
  USING (app_is_platform() OR business_id = app_business_id())
  WITH CHECK (app_is_platform() OR business_id = app_business_id());

-- Хостовете са публични (DNS), затова четенето е отворено — така се открива
-- бизнесът по входящата заявка, преди да има контекст. Писането е по бизнес.
ALTER TABLE domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE domains FORCE ROW LEVEL SECURITY;
CREATE POLICY lookup ON domains FOR SELECT USING (true);
CREATE POLICY tenant_write ON domains FOR ALL
  USING (app_is_platform() OR business_id = app_business_id())
  WITH CHECK (app_is_platform() OR business_id = app_business_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON businesses, locations, domains TO qr_app;
