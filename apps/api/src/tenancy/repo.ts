import {
  businessHostname, isValidSlug, locationHostname, normalizeHostname,
  type Locale, type PaymentMode, type Theme,
} from '@qr/shared';
import { withScope, type Db, type Tx } from '../db/pool';

export interface Business {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  defaultLocale: Locale;
  theme: Theme;
  brand: Record<string, unknown>;
}

export interface Location {
  id: string;
  businessId: string;
  slug: string;
  name: string;
  status: 'active' | 'inactive';
  timezone: string;
  qrEnabled: boolean;
  kioskEnabled: boolean;
  qrAutoAccept: boolean;
  kioskAutoAccept: boolean;
  paymentMode: PaymentMode;
  orderResetHour: number;
}

const BUSINESS_COLS = `id, slug, name, status, default_locale AS "defaultLocale", theme, brand`;
const LOCATION_COLS = `id, business_id AS "businessId", slug, name, status, timezone,
  qr_enabled AS "qrEnabled", kiosk_enabled AS "kioskEnabled",
  qr_auto_accept AS "qrAutoAccept", kiosk_auto_accept AS "kioskAutoAccept",
  payment_mode AS "paymentMode", order_reset_hour AS "orderResetHour"`;

export class ValidationError extends Error {}

function assertSlug(slug: string) {
  if (!isValidSlug(slug)) throw new ValidationError(`Невалидно кратко име: „${slug}“`);
}

export interface NewBusiness {
  slug: string;
  name: string;
  defaultLocale?: Locale;
  theme?: Theme;
  brand?: Record<string, unknown>;
}

/** Само на ниво платформа. Създава бизнеса и поддомейна му. */
export async function createBusiness(db: Db, input: NewBusiness, baseDomain: string): Promise<Business> {
  assertSlug(input.slug);
  return withScope(db, { platform: true }, async (tx) => {
    const { rows } = await tx.query<Business>(
      `INSERT INTO businesses (slug, name, default_locale, theme, brand)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${BUSINESS_COLS}`,
      [input.slug, input.name, input.defaultLocale ?? 'bg', input.theme ?? 'light', input.brand ?? {}],
    );
    const business = rows[0]!;
    await tx.query('INSERT INTO domains (business_id, hostname) VALUES ($1, $2)', [
      business.id, businessHostname(business.slug, baseDomain),
    ]);
    return business;
  });
}

export interface NewLocation {
  slug: string;
  name: string;
  timezone?: string;
  qrEnabled?: boolean;
  kioskEnabled?: boolean;
}

/** В контекста на бизнеса. Създава обекта и неговия поддомейн. */
export async function createLocation(
  db: Db, businessId: string, input: NewLocation, baseDomain: string,
): Promise<Location> {
  assertSlug(input.slug);
  return withScope(db, { businessId }, async (tx) => {
    const biz = await tx.query<{ slug: string }>('SELECT slug FROM businesses WHERE id = $1', [businessId]);
    if (!biz.rows[0]) throw new ValidationError('Бизнесът не е намерен');
    const { rows } = await tx.query<Location>(
      `INSERT INTO locations (business_id, slug, name, timezone, qr_enabled, kiosk_enabled)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${LOCATION_COLS}`,
      [businessId, input.slug, input.name, input.timezone ?? 'Europe/Sofia',
        input.qrEnabled ?? true, input.kioskEnabled ?? false],
    );
    const location = rows[0]!;
    await tx.query('INSERT INTO domains (business_id, location_id, hostname) VALUES ($1, $2, $3)', [
      businessId, location.id, locationHostname(biz.rows[0].slug, location.slug, baseDomain),
    ]);
    return location;
  });
}

export async function listLocations(tx: Tx): Promise<Location[]> {
  const { rows } = await tx.query<Location>(`SELECT ${LOCATION_COLS} FROM locations ORDER BY name`);
  return rows;
}

export interface ResolvedHost {
  business: Business;
  /** Обектът, ако хостът е на обект или бизнесът има само един активен обект. */
  location: Location | null;
}

/**
 * Хост → бизнес и обект. Връща null за непознат хост, спрян бизнес
 * или неактивен обект — за външния свят те не съществуват.
 */
export async function resolveHost(db: Db, host: string): Promise<ResolvedHost | null> {
  const hostname = normalizeHostname(host);
  const found = await withScope(db, { anonymous: true }, (tx) =>
    tx.query<{ businessId: string; locationId: string | null }>(
      'SELECT business_id AS "businessId", location_id AS "locationId" FROM domains WHERE hostname = $1',
      [hostname],
    ));
  const domain = found.rows[0];
  if (!domain) return null;

  return withScope(db, { businessId: domain.businessId }, async (tx) => {
    const b = await tx.query<Business>(`SELECT ${BUSINESS_COLS} FROM businesses WHERE id = $1`, [domain.businessId]);
    const business = b.rows[0];
    if (!business || business.status !== 'active') return null;

    if (domain.locationId) {
      const l = await tx.query<Location>(
        `SELECT ${LOCATION_COLS} FROM locations WHERE id = $1 AND status = 'active'`, [domain.locationId]);
      return l.rows[0] ? { business, location: l.rows[0] } : null;
    }
    const active = (await listLocations(tx)).filter((l) => l.status === 'active');
    return { business, location: active.length === 1 ? active[0]! : null };
  });
}
