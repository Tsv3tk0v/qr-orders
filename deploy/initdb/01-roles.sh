#!/bin/sh
# Създава ролите при първото стартиране на базата (виж db/roles.sql).
set -e
psql -v ON_ERROR_STOP=1 --username postgres --dbname qr <<SQL
CREATE ROLE qr LOGIN PASSWORD '${QR_OWNER_PASSWORD}';
CREATE ROLE qr_app LOGIN PASSWORD '${QR_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
ALTER DATABASE qr OWNER TO qr;
ALTER SCHEMA public OWNER TO qr;
SQL
