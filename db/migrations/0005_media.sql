-- Снимки на артикулите и лога, качени от админ панела. Пазят се в базата,
-- за да влизат в нощния архив и да не зависят от външни адреси.
CREATE TABLE media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  bytes        bytea NOT NULL,
  size         int NOT NULL CHECK (size > 0 AND size <= 2097152),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_business_idx ON media (business_id);
ALTER TABLE media ENABLE ROW LEVEL SECURITY;
ALTER TABLE media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON media
  USING (app_is_platform() OR business_id = app_business_id())
  WITH CHECK (app_is_platform() OR business_id = app_business_id());
GRANT SELECT, INSERT, DELETE ON media TO qr_app;
