-- Етап 3: меню, филтри (категории), компоненти (добавки и „без“), марка, импорт.
-- Текстовете са jsonb {"bg": "...", "en": "..."}; български е задължителен.
-- Менюто е общо за бизнеса (всички обекти). Наличности и „изчерпано“ — Фаза 2.

CREATE FUNCTION is_i18n(v jsonb, required boolean) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS
$$ SELECT jsonb_typeof(v) = 'object'
     AND (v - 'bg' - 'en') = '{}'::jsonb
     AND (NOT v ? 'bg' OR jsonb_typeof(v->'bg') = 'string')
     AND (NOT v ? 'en' OR jsonb_typeof(v->'en') = 'string')
     AND (NOT required OR length(btrim(coalesce(v->>'bg', ''))) > 0) $$;

-- Настройки на бизнеса за езици и марка ---------------------------------------
ALTER TABLE businesses
  ADD COLUMN enabled_locales text[] NOT NULL DEFAULT ARRAY['bg', 'en'],
  ADD COLUMN currency text NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR')),
  ADD CONSTRAINT businesses_locales_chk
    CHECK (enabled_locales <@ ARRAY['bg', 'en'] AND default_locale = ANY (enabled_locales));

-- Версии на марката: всяко „Публикувай“ пази снимка (за „История на версиите“).
CREATE TABLE brand_versions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  theme        text NOT NULL,
  brand        jsonb NOT NULL,
  published_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX brand_versions_business_idx ON brand_versions (business_id, id DESC);

-- Категории = филтрите, които клиентът вижда ----------------------------------
CREATE TABLE menu_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name         jsonb NOT NULL CHECK (is_i18n(name, true)),
  -- „група артикули за меню“ от импорта (малки букви, без излишни интервали)
  import_key   text CHECK (import_key = lower(btrim(import_key)) AND import_key <> ''),
  visible      boolean NOT NULL DEFAULT true,
  position     int NOT NULL DEFAULT 0,
  created_by_import boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, import_key),
  UNIQUE (business_id, id)
);
CREATE TRIGGER menu_categories_touch BEFORE UPDATE ON menu_categories
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Артикули --------------------------------------------------------------------
CREATE TABLE menu_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- Ключ за импорта: 6 цифри като текст (водещите нули се пазят).
  code          text CHECK (code ~ '^[0-9]{6}$'),
  name          jsonb NOT NULL CHECK (is_i18n(name, true)),
  description   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (is_i18n(description, false)),
  price_cents   int NOT NULL CHECK (price_cents >= 0 AND price_cents <= 10000000),
  image_url     text,
  visible       boolean NOT NULL DEFAULT true,
  -- Нови артикули от импорта чакат одобрение (реш. 12, 20).
  approval      text NOT NULL DEFAULT 'approved' CHECK (approval IN ('pending', 'approved')),
  badge_hit     boolean NOT NULL DEFAULT false,
  prep_minutes  smallint CHECK (prep_minutes BETWEEN 0 AND 240),
  allergens     text[] NOT NULL DEFAULT '{}',
  -- Основната група от импорта; ръчните членства са в menu_item_categories.
  primary_category_id uuid,
  max_addons    smallint CHECK (max_addons BETWEEN 0 AND 50),
  missing_from_import_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, code),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, primary_category_id)
    REFERENCES menu_categories (business_id, id) ON DELETE SET NULL (primary_category_id)
);
CREATE TRIGGER menu_items_touch BEFORE UPDATE ON menu_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Артикул във филтър (основна група от импорта или ръчно добавен) -------------
CREATE TABLE menu_item_categories (
  business_id  uuid NOT NULL,
  item_id      uuid NOT NULL,
  category_id  uuid NOT NULL,
  source       text NOT NULL CHECK (source IN ('import', 'manual')),
  position     int NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, category_id),
  FOREIGN KEY (business_id, item_id) REFERENCES menu_items (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, category_id) REFERENCES menu_categories (business_id, id) ON DELETE CASCADE
);
CREATE INDEX menu_item_categories_cat_idx ON menu_item_categories (category_id, position);

-- Библиотека с компоненти: добавка (с цена) и/или „без“ (може да се махне) ------
CREATE TABLE menu_components (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          jsonb NOT NULL CHECK (is_i18n(name, true)),
  -- NULL = не е добавка
  addon_price_cents int CHECK (addon_price_cents >= 0 AND addon_price_cents <= 1000000),
  removable     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE TRIGGER menu_components_touch BEFORE UPDATE ON menu_components
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Компонент в артикул: съставка ('base') или допустима добавка ('addon') -------
CREATE TABLE menu_item_components (
  business_id   uuid NOT NULL,
  item_id       uuid NOT NULL,
  component_id  uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('base', 'addon')),
  max_qty       smallint NOT NULL DEFAULT 1 CHECK (max_qty BETWEEN 1 AND 10),
  position      int NOT NULL DEFAULT 0,
  PRIMARY KEY (item_id, component_id, kind),
  FOREIGN KEY (business_id, item_id) REFERENCES menu_items (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, component_id) REFERENCES menu_components (business_id, id) ON DELETE CASCADE
);

-- Импорт ------------------------------------------------------------------------
CREATE TABLE import_settings (
  business_id      uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  auto_approve_new boolean NOT NULL DEFAULT false,
  -- Какво става с артикул, който липсва във файла.
  missing_items    text NOT NULL DEFAULT 'keep' CHECK (missing_items IN ('keep', 'hide')),
  -- Спира целия импорт, ако грешните редове са над този дял.
  max_error_ratio  numeric(4,3) NOT NULL DEFAULT 0.2 CHECK (max_error_ratio BETWEEN 0 AND 1),
  sftp_enabled     boolean NOT NULL DEFAULT false,
  encoding         text NOT NULL DEFAULT 'auto' CHECK (encoding IN ('auto', 'utf-8', 'windows-1251')),
  notify_on_error  boolean NOT NULL DEFAULT true,
  -- Заглавие на колона във файла → поле. Празно = стандартните имена.
  column_map       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(column_map) = 'object'),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE import_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source       text NOT NULL CHECK (source IN ('upload', 'sftp')),
  filename     text NOT NULL,
  status       text NOT NULL CHECK (status IN ('success', 'with_errors', 'aborted', 'failed')),
  rows_total   int NOT NULL DEFAULT 0,
  created      int NOT NULL DEFAULT 0,
  updated      int NOT NULL DEFAULT 0,
  unchanged    int NOT NULL DEFAULT 0,
  hidden       int NOT NULL DEFAULT 0,
  error_count  int NOT NULL DEFAULT 0,
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb,
  preview      text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_runs_business_idx ON import_runs (business_id, created_at DESC);

-- RLS --------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['brand_versions', 'menu_categories', 'menu_items', 'menu_item_categories',
                           'menu_components', 'menu_item_components', 'import_settings', 'import_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I
      USING (app_is_platform() OR business_id = app_business_id())
      WITH CHECK (app_is_platform() OR business_id = app_business_id())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO qr_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON brand_versions, import_runs FROM qr_app;
