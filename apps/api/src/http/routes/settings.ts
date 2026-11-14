import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  DEFAULT_BRAND, FONTS, LOCALES, THEMES, validateBrand, type BrandTokens, type Locale, type Theme,
} from '@qr/shared';
import { withScope } from '../../db/pool';
import { AuthError, audit } from '../../auth/service';
import { ValidationError } from '../../tenancy/repo';
import { requireAuth } from '../app';

const COLOR = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const URL_S = { type: 'string', maxLength: 500 };

interface AppearanceBody {
  theme: Theme;
  brand: Partial<BrandTokens>;
  defaultLocale: Locale;
  enabledLocales: Locale[];
}

interface LocationPatch {
  name?: string; status?: 'active' | 'inactive'; qrEnabled?: boolean; kioskEnabled?: boolean;
  qrAutoAccept?: boolean; kioskAutoAccept?: boolean; printerHost?: string | null; printerPort?: number;
  printerCodepage?: number; ticketQr?: boolean; prepMinutesEstimate?: number;
}

const LOC_COLS = `l.id, l.slug, l.name, l.status, l.qr_enabled AS "qrEnabled", l.kiosk_enabled AS "kioskEnabled",
  l.qr_auto_accept AS "qrAutoAccept", l.kiosk_auto_accept AS "kioskAutoAccept", l.payment_mode AS "paymentMode",
  l.printer_host AS "printerHost", l.printer_port AS "printerPort", l.printer_codepage AS "printerCodepage",
  l.ticket_qr AS "ticketQr", l.prep_minutes_estimate AS "prepMinutesEstimate"`;

export class BrandError extends Error {
  constructor(public issues: ReturnType<typeof validateBrand>) { super('invalid_brand'); }
}

/** Външен вид (тема, цветове, лого, шрифт, езици) и обекти. Право: settings.manage. */
export async function settingsRoutes(app: FastifyInstance) {
  const { db } = app.deps;
  app.addHook('onRequest', async (req) => {
    if (req.tenant.kind !== 'business') throw new AuthError('not_found', 404);
  });
  app.addHook('preHandler', requireAuth('settings.manage'));
  const bid = (req: FastifyRequest) => (req.realm as { businessId: string }).businessId;

  app.get('/', (req) => withScope(db, { businessId: bid(req) }, async (tx) => {
    const b = (await tx.query(
      `SELECT theme, brand, default_locale AS "defaultLocale", enabled_locales AS "enabledLocales", currency
       FROM businesses WHERE id = $1`, [bid(req)])).rows[0];
    const locations = (await tx.query(
      `SELECT ${LOC_COLS},
         (SELECT d.hostname FROM domains d WHERE d.location_id = l.id ORDER BY d.created_at LIMIT 1) AS hostname
       FROM locations l ORDER BY l.name`)).rows;
    return { ...b, brand: { ...DEFAULT_BRAND, ...b.brand }, locations };
  }));

  /** „Публикувай“: проверява контраста и пази версия. */
  app.put<{ Body: AppearanceBody }>('/appearance', { schema: { body: {
    type: 'object', required: ['theme', 'brand', 'defaultLocale', 'enabledLocales'], additionalProperties: false,
    properties: {
      theme: { type: 'string', enum: [...THEMES] },
      defaultLocale: { type: 'string', enum: [...LOCALES] },
      enabledLocales: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...LOCALES] } },
      brand: { type: 'object', additionalProperties: false, properties: {
        primary: COLOR, accent: COLOR, onAccent: COLOR, menuBackground: COLOR, boardBackground: COLOR,
        text: COLOR, cooking: COLOR, ready: COLOR, font: { type: 'string', enum: [...FONTS] },
        logoDarkUrl: URL_S, logoLightUrl: URL_S, menuHeroUrl: URL_S, boardBackgroundUrl: URL_S,
        statusBackgroundUrl: URL_S,
      } },
    } } } }, async (req) => {
    const { theme, defaultLocale, enabledLocales } = req.body;
    if (!enabledLocales.includes(defaultLocale)) throw new ValidationError('Езикът по подразбиране трябва да е включен');
    const brand: BrandTokens = { ...DEFAULT_BRAND, ...req.body.brand };
    const issues = validateBrand(brand);
    if (issues.length) throw new BrandError(issues);
    return withScope(db, { businessId: bid(req) }, async (tx) => {
      await tx.query(
        `UPDATE businesses SET theme = $2, brand = $3, default_locale = $4, enabled_locales = $5 WHERE id = $1`,
        [bid(req), theme, brand, defaultLocale, enabledLocales]);
      const v = await tx.query<{ id: string }>(
        `INSERT INTO brand_versions (business_id, theme, brand, published_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [bid(req), theme, brand, req.session!.user.id]);
      await audit(tx, bid(req), { action: 'settings.appearance_published', actorId: req.session!.user.id,
        targetType: 'brand_version', targetId: v.rows[0]!.id, ip: req.ip });
      return { theme, brand, defaultLocale, enabledLocales, version: v.rows[0]!.id };
    });
  });

  app.get('/appearance/versions', (req) => withScope(db, { businessId: bid(req) }, async (tx) =>
    (await tx.query(
      `SELECT v.id, v.theme, v.brand, u.email AS "publishedBy", v.created_at AS "createdAt"
       FROM brand_versions v LEFT JOIN users u ON u.id = v.published_by ORDER BY v.id DESC LIMIT 50`)).rows));

  app.patch<{ Params: { id: string }; Body: LocationPatch }>('/locations/:id', { schema: {
    params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
    body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      name: { type: 'string', minLength: 1, maxLength: 120 }, status: { type: 'string', enum: ['active', 'inactive'] },
      qrEnabled: { type: 'boolean' }, kioskEnabled: { type: 'boolean' },
      qrAutoAccept: { type: 'boolean' }, kioskAutoAccept: { type: 'boolean' },
      printerHost: { type: ['string', 'null'], maxLength: 100, pattern: '^[a-zA-Z0-9.:-]*$' },
      printerPort: { type: 'integer', minimum: 1, maximum: 65535 },
      printerCodepage: { type: 'integer', minimum: 0, maximum: 255 }, ticketQr: { type: 'boolean' },
      prepMinutesEstimate: { type: 'integer', minimum: 1, maximum: 180 },
    } } } }, (req) => withScope(db, { businessId: bid(req) }, async (tx) => {
    const b = req.body;
    const { rows } = await tx.query(
      `UPDATE locations l SET name = coalesce($2, name), status = coalesce($3, status),
         qr_enabled = coalesce($4, qr_enabled), kiosk_enabled = coalesce($5, kiosk_enabled),
         qr_auto_accept = coalesce($6, qr_auto_accept), kiosk_auto_accept = coalesce($7, kiosk_auto_accept),
         printer_host = CASE WHEN $8 THEN nullif($9, '') ELSE printer_host END,
         printer_port = coalesce($10, printer_port), printer_codepage = coalesce($11, printer_codepage),
         ticket_qr = coalesce($12, ticket_qr), prep_minutes_estimate = coalesce($13, prep_minutes_estimate)
       WHERE id = $1 RETURNING ${LOC_COLS}`,
      [req.params.id, b.name ?? null, b.status ?? null, b.qrEnabled ?? null, b.kioskEnabled ?? null,
        b.qrAutoAccept ?? null, b.kioskAutoAccept ?? null, b.printerHost !== undefined, b.printerHost ?? null,
        b.printerPort ?? null, b.printerCodepage ?? null, b.ticketQr ?? null, b.prepMinutesEstimate ?? null]);
    if (!rows[0]) throw new AuthError('not_found', 404);
    await audit(tx, bid(req), { action: 'settings.location_updated', actorId: req.session!.user.id,
      targetType: 'location', targetId: req.params.id, data: { ...b }, ip: req.ip });
    return rows[0];
  }));
}
