-- Етапи 4 и 7: устройства, клиентски сесии, поръчки, номерация, неявявания, черен списък.

-- Настройки на обекта за печат и на бизнеса за неявявания --------------------
ALTER TABLE locations
  ADD COLUMN verification_mode text NOT NULL DEFAULT 'light' CHECK (verification_mode IN ('light')),
  ADD COLUMN printer_host text CHECK (printer_host ~ '^[a-zA-Z0-9.:-]+$'),
  ADD COLUMN printer_port int NOT NULL DEFAULT 9100 CHECK (printer_port BETWEEN 1 AND 65535),
  ADD COLUMN printer_codepage smallint NOT NULL DEFAULT 17 CHECK (printer_codepage BETWEEN 0 AND 255),
  ADD COLUMN ticket_qr boolean NOT NULL DEFAULT true,
  ADD COLUMN prep_minutes_estimate smallint NOT NULL DEFAULT 10 CHECK (prep_minutes_estimate BETWEEN 1 AND 180);

ALTER TABLE businesses
  -- Толкова неявявания за 30 дни → черен списък.
  ADD COLUMN noshow_block_threshold smallint NOT NULL DEFAULT 2 CHECK (noshow_block_threshold BETWEEN 1 AND 20),
  ADD COLUMN block_days smallint NOT NULL DEFAULT 30 CHECK (block_days BETWEEN 1 AND 365),
  -- Дневен имейл до собствениците.
  ADD COLUMN daily_email boolean NOT NULL DEFAULT true,
  ADD COLUMN daily_email_hour smallint NOT NULL DEFAULT 22 CHECK (daily_email_hour BETWEEN 0 AND 23);

-- Устройства: кухня, табло, киоск (реш. 11). Сдвояват се с код, могат да се отнемат.
CREATE TABLE devices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id        uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('kitchen', 'board', 'kiosk')),
  name               text NOT NULL CHECK (length(btrim(name)) > 0),
  token_hash         bytea UNIQUE,
  pairing_code_hash  bytea,
  pairing_expires_at timestamptz,
  paired_at          timestamptz,
  last_seen_at       timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES locations (business_id, id) ON DELETE CASCADE
);

-- Клиентска сесия след сканиране на QR (реш. 3): 20 мин, една активна поръчка.
CREATE TABLE customer_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  customer_hash bytea,               -- HMAC на бисквитката на браузъра
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES locations (business_id, id) ON DELETE CASCADE
);

-- Брояч на номерата (реш. 6): по обект и работен ден (ден започва в order_reset_hour).
CREATE TABLE order_counters (
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id  uuid NOT NULL,
  business_day date NOT NULL,
  last_number  int NOT NULL DEFAULT 0,
  PRIMARY KEY (location_id, business_day),
  FOREIGN KEY (business_id, location_id) REFERENCES locations (business_id, id) ON DELETE CASCADE
);

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  location_id   uuid NOT NULL,
  session_id    uuid REFERENCES customer_sessions(id) ON DELETE SET NULL,
  device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,
  number        int NOT NULL CHECK (number BETWEEN 1 AND 999),
  business_day  date NOT NULL,
  public_code   text NOT NULL,       -- „код за следене“, напр. K7M2-9QX
  channel       text NOT NULL CHECK (channel IN ('qr', 'kiosk')),
  status        text NOT NULL CHECK (status IN
                  ('pending', 'accepted', 'ready', 'collected', 'rejected', 'no_show', 'cancelled')),
  payment_mode  text NOT NULL DEFAULT 'none' CHECK (payment_mode IN ('none')),
  locale        text NOT NULL DEFAULT 'bg' CHECK (locale IN ('bg', 'en')),
  total_cents   int NOT NULL CHECK (total_cents >= 0),
  note          text CHECK (length(note) <= 200),
  customer_hash bytea,               -- изтрива се след 30 дни (реш. 7)
  created_at    timestamptz NOT NULL DEFAULT now(),
  accepted_at   timestamptz,
  ready_at      timestamptz,
  closed_at     timestamptz,
  UNIQUE (business_id, public_code),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, location_id) REFERENCES locations (business_id, id) ON DELETE CASCADE
);
CREATE INDEX orders_active_idx ON orders (location_id, status) WHERE status IN ('pending', 'accepted', 'ready');
CREATE INDEX orders_location_day_idx ON orders (location_id, business_day);
CREATE INDEX orders_session_idx ON orders (session_id) WHERE session_id IS NOT NULL;

-- Редове: снимка на името и цените в момента на поръчката.
CREATE TABLE order_items (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id   uuid NOT NULL,
  order_id      uuid NOT NULL,
  item_id       uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  code          text,
  name          jsonb NOT NULL,
  qty           smallint NOT NULL CHECK (qty BETWEEN 1 AND 50),
  unit_cents    int NOT NULL CHECK (unit_cents >= 0),
  removed       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id, name}]
  addons        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id, name, priceCents, qty}]
  note          text CHECK (length(note) <= 120),
  line_cents    int NOT NULL CHECK (line_cents >= 0),
  FOREIGN KEY (business_id, order_id) REFERENCES orders (business_id, id) ON DELETE CASCADE
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

-- Неявявания и черен списък (реш. 4, 7): по HMAC, без лични данни.
CREATE TABLE customer_marks (
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_hash   bytea NOT NULL,
  orders          int NOT NULL DEFAULT 0,
  no_shows        int NOT NULL DEFAULT 0,
  last_order_at   timestamptz,
  last_no_show_at timestamptz,
  blocked_until   timestamptz,
  block_reason    text CHECK (block_reason IN ('no_shows', 'manual')),
  PRIMARY KEY (business_id, customer_hash)
);

-- Изпратени дневни имейли (за да не се пращат два пъти).
CREATE TABLE daily_reports (
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day         date NOT NULL,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, day)
);

-- Следващ свободен номер: 1–999, след 999 отново 1, без номер, който още е активен.
CREATE FUNCTION next_order_number(p_business uuid, p_location uuid, p_day date) RETURNS int
  LANGUAGE plpgsql AS
$$
DECLARE
  n int;
  tries int := 0;
BEGIN
  INSERT INTO order_counters (business_id, location_id, business_day) VALUES (p_business, p_location, p_day)
    ON CONFLICT DO NOTHING;
  SELECT last_number INTO n FROM order_counters
    WHERE location_id = p_location AND business_day = p_day FOR UPDATE;
  LOOP
    n := n % 999 + 1;
    tries := tries + 1;
    IF tries > 999 THEN RAISE EXCEPTION 'no_free_order_number'; END IF;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM orders WHERE location_id = p_location AND number = n
                          AND status IN ('pending', 'accepted', 'ready'));
  END LOOP;
  UPDATE order_counters SET last_number = n WHERE location_id = p_location AND business_day = p_day;
  RETURN n;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['devices', 'customer_sessions', 'order_counters', 'orders', 'order_items',
                           'customer_marks', 'daily_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant ON %I
      USING (app_is_platform() OR business_id = app_business_id())
      WITH CHECK (app_is_platform() OR business_id = app_business_id())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO qr_app', t);
  END LOOP;
END $$;
