import { createHmac, randomInt } from 'node:crypto';
import {
  ACTIVE_STATUSES, formatPublicCode, nextStatus, ORDER_LIMITS, PUBLIC_CODE_ALPHABET, SESSION_MINUTES,
  type I18nText, type KitchenAction, type Locale, type OrderChannel, type OrderStatus,
} from '@qr/shared';
import type { Tx } from '../db/pool';
import { newToken, sha256 } from '../auth/crypto';
import { ValidationError } from '../tenancy/repo';

export class OrderError extends Error {
  constructor(public code: string, public status = 409) { super(code); }
}

/** HMAC с таен ключ (реш. 7) — не обикновен хеш, за да не може да се обърне по речник. */
export function customerHash(key: string, businessId: string, value: string): Buffer {
  return createHmac('sha256', key).update(`${businessId}:cid:${value}`).digest();
}

// --- Клиентска сесия ---------------------------------------------------------

export async function createCustomerSession(
  tx: Tx, businessId: string, locationId: string, custHash: Buffer | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const { rows } = await tx.query<{ expiresAt: Date }>(
    `INSERT INTO customer_sessions (business_id, location_id, token_hash, customer_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5)) RETURNING expires_at AS "expiresAt"`,
    [businessId, locationId, sha256(token), custHash, SESSION_MINUTES]);
  return { token, expiresAt: rows[0]!.expiresAt };
}

export interface CustomerSession { id: string; locationId: string; customerHash: Buffer | null; expiresAt: Date }

export async function getCustomerSession(tx: Tx, token: string): Promise<CustomerSession | null> {
  const { rows } = await tx.query<CustomerSession>(
    `SELECT id, location_id AS "locationId", customer_hash AS "customerHash", expires_at AS "expiresAt"
     FROM customer_sessions WHERE token_hash = $1 AND expires_at > now()`, [sha256(token)]);
  return rows[0] ?? null;
}

// --- Черен списък и неявявания -----------------------------------------------

export async function isBlocked(tx: Tx, hash: Buffer | null): Promise<boolean> {
  if (!hash) return false;
  const { rows } = await tx.query(
    `SELECT 1 FROM customer_marks WHERE customer_hash = $1 AND blocked_until > now()`, [hash]);
  return rows.length > 0;
}

async function markOrder(tx: Tx, businessId: string, hash: Buffer) {
  await tx.query(
    `INSERT INTO customer_marks (business_id, customer_hash, orders, last_order_at) VALUES ($1, $2, 1, now())
     ON CONFLICT (business_id, customer_hash) DO UPDATE SET orders = customer_marks.orders + 1, last_order_at = now()`,
    [businessId, hash]);
}

/** Неявяване: брои се; при достигнат праг за 30 дни → черен списък за block_days. */
async function markNoShow(tx: Tx, businessId: string, hash: Buffer) {
  await tx.query(
    `INSERT INTO customer_marks AS m (business_id, customer_hash, no_shows, last_no_show_at)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (business_id, customer_hash) DO UPDATE SET
       no_shows = CASE WHEN m.last_no_show_at < now() - interval '30 days' THEN 1 ELSE m.no_shows + 1 END,
       last_no_show_at = now()`, [businessId, hash]);
  await tx.query(
    `UPDATE customer_marks m SET blocked_until = now() + make_interval(days => b.block_days), block_reason = 'no_shows'
     FROM businesses b
     WHERE b.id = m.business_id AND m.customer_hash = $1 AND m.no_shows >= b.noshow_block_threshold
       AND (m.blocked_until IS NULL OR m.blocked_until < now())`, [hash]);
}

// --- Редове на поръчката ----------------------------------------------------

export interface LineInput {
  itemId: string;
  qty: number;
  removed?: string[];
  addons?: { componentId: string; qty?: number }[];
  note?: string;
}

interface MenuItemRow {
  id: string; code: string | null; name: I18nText; priceCents: number; maxAddons: number | null;
  base: { id: string; name: I18nText; removable: boolean }[];
  addons: { id: string; name: I18nText; priceCents: number; maxQty: number }[];
}

interface Line {
  itemId: string; code: string | null; name: I18nText; qty: number; unitCents: number;
  removed: { id: string; name: I18nText }[];
  addons: { id: string; name: I18nText; priceCents: number; qty: number }[];
  note: string | null; lineCents: number;
}

/** Цените и правилата идват от менюто в базата, никога от клиента. */
export async function buildLines(tx: Tx, input: LineInput[]): Promise<Line[]> {
  if (!input.length) throw new OrderError('empty_order', 400);
  if (input.length > ORDER_LIMITS.maxLines) throw new OrderError('too_many_lines', 400);
  const ids = [...new Set(input.map((l) => l.itemId))];
  const { rows } = await tx.query<MenuItemRow>(
    `SELECT i.id, i.code, i.name, i.price_cents AS "priceCents", i.max_addons AS "maxAddons",
       coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'removable', c.removable))
         FROM menu_item_components mc JOIN menu_components c ON c.id = mc.component_id
         WHERE mc.item_id = i.id AND mc.kind = 'base'), '[]') AS base,
       coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
           'priceCents', c.addon_price_cents, 'maxQty', mc.max_qty))
         FROM menu_item_components mc JOIN menu_components c ON c.id = mc.component_id
         WHERE mc.item_id = i.id AND mc.kind = 'addon' AND c.addon_price_cents IS NOT NULL), '[]') AS addons
     FROM menu_items i WHERE i.id = ANY($1::uuid[]) AND i.visible AND i.approval = 'approved'`, [ids]);
  const byId = new Map(rows.map((r) => [r.id, r]));

  return input.map((l) => {
    const item = byId.get(l.itemId);
    if (!item) throw new OrderError('item_unavailable', 409);
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > ORDER_LIMITS.maxQty) throw new OrderError('bad_qty', 400);
    const removed = [...new Set(l.removed ?? [])].map((id) => {
      const b = item.base.find((x) => x.id === id && x.removable);
      if (!b) throw new OrderError('bad_removal', 400);
      return { id: b.id, name: b.name };
    });
    const seen = new Set<string>();
    const addons = (l.addons ?? []).map((a) => {
      const def = item.addons.find((x) => x.id === a.componentId);
      const qty = a.qty ?? 1;
      if (!def || seen.has(def.id) || !Number.isInteger(qty) || qty < 1 || qty > def.maxQty) {
        throw new OrderError('bad_addon', 400);
      }
      seen.add(def.id);
      return { id: def.id, name: def.name, priceCents: def.priceCents, qty };
    });
    const addonCount = addons.reduce((s, a) => s + a.qty, 0);
    if (item.maxAddons !== null && addonCount > item.maxAddons) throw new OrderError('too_many_addons', 400);
    const unitCents = item.priceCents + addons.reduce((s, a) => s + a.priceCents * a.qty, 0);
    const note = l.note?.trim().slice(0, ORDER_LIMITS.noteLength) || null;
    return { itemId: item.id, code: item.code, name: item.name, qty: l.qty, unitCents, removed, addons, note,
      lineCents: unitCents * l.qty };
  });
}

// --- Създаване ----------------------------------------------------------------

export interface LocationRules {
  id: string; status: string; qrEnabled: boolean; kioskEnabled: boolean;
  qrAutoAccept: boolean; kioskAutoAccept: boolean; timezone: string; orderResetHour: number;
}

export async function getLocationRules(tx: Tx, locationId: string): Promise<LocationRules> {
  const { rows } = await tx.query<LocationRules>(
    `SELECT id, status, qr_enabled AS "qrEnabled", kiosk_enabled AS "kioskEnabled", qr_auto_accept AS "qrAutoAccept",
       kiosk_auto_accept AS "kioskAutoAccept", timezone, order_reset_hour AS "orderResetHour"
     FROM locations WHERE id = $1`, [locationId]);
  if (!rows[0]) throw new OrderError('location_not_found', 404);
  return rows[0];
}

export interface NewOrder {
  businessId: string;
  locationId: string;
  channel: OrderChannel;
  lines: LineInput[];
  locale: Locale;
  note?: string;
  sessionId?: string;
  deviceId?: string;
  customerHash?: Buffer | null;
}

function randomCode(): string {
  let s = '';
  for (let i = 0; i < 7; i++) s += PUBLIC_CODE_ALPHABET[randomInt(PUBLIC_CODE_ALPHABET.length)];
  return formatPublicCode(s);
}

export async function createOrder(tx: Tx, o: NewOrder): Promise<OrderView> {
  const loc = await getLocationRules(tx, o.locationId);
  if (loc.status !== 'active') throw new OrderError('location_closed');
  if (o.channel === 'qr' && !loc.qrEnabled) throw new OrderError('qr_disabled');
  if (o.channel === 'kiosk' && !loc.kioskEnabled) throw new OrderError('kiosk_disabled');
  if (await isBlocked(tx, o.customerHash ?? null)) throw new OrderError('blocked', 403);

  if (o.sessionId) {
    // Една активна поръчка на сесия (реш. 3). Заключваме сесията срещу двоен клик.
    await tx.query('SELECT 1 FROM customer_sessions WHERE id = $1 FOR UPDATE', [o.sessionId]);
    const active = await tx.query(`SELECT 1 FROM orders WHERE session_id = $1 AND status = ANY($2)`,
      [o.sessionId, ACTIVE_STATUSES]);
    if (active.rows.length) throw new OrderError('active_order_exists');
  }

  const lines = await buildLines(tx, o.lines);
  const total = lines.reduce((s, l) => s + l.lineCents, 0);
  const autoAccept = o.channel === 'kiosk' ? loc.kioskAutoAccept : loc.qrAutoAccept;
  const day = await tx.query<{ day: string }>(
    `SELECT ((now() AT TIME ZONE $1) - make_interval(hours => $2))::date::text AS day`,
    [loc.timezone, loc.orderResetHour]);
  const businessDay = day.rows[0]!.day;
  const num = await tx.query<{ n: number }>('SELECT next_order_number($1, $2, $3) AS n',
    [o.businessId, o.locationId, businessDay]);

  let orderId = '';
  for (let attempt = 0; ; attempt++) {
    try {
      await tx.query('SAVEPOINT code');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO orders (business_id, location_id, session_id, device_id, number, business_day, public_code,
           channel, status, locale, total_cents, note, customer_hash, accepted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CASE WHEN $14 THEN now() END)
         RETURNING id`,
        [o.businessId, o.locationId, o.sessionId ?? null, o.deviceId ?? null, num.rows[0]!.n, businessDay,
          randomCode(), o.channel, autoAccept ? 'accepted' : 'pending', o.locale,
          total, o.note?.trim().slice(0, 200) || null, o.customerHash ?? null, autoAccept]);
      orderId = rows[0]!.id;
      break;
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT code');
      if ((err as { code?: string }).code !== '23505' || attempt > 5) throw err;
    }
  }
  for (const l of lines) {
    await tx.query(
      `INSERT INTO order_items (business_id, order_id, item_id, code, name, qty, unit_cents, removed, addons, note, line_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [o.businessId, orderId, l.itemId, l.code, l.name, l.qty, l.unitCents, JSON.stringify(l.removed),
        JSON.stringify(l.addons), l.note, l.lineCents]);
  }
  if (o.customerHash) await markOrder(tx, o.businessId, o.customerHash);
  return getOrder(tx, orderId);
}

// --- Преглед ------------------------------------------------------------------

export interface OrderView {
  id: string; locationId: string; number: number; publicCode: string; channel: OrderChannel; status: OrderStatus;
  locale: Locale; totalCents: number; note: string | null; createdAt: Date; acceptedAt: Date | null;
  readyAt: Date | null; closedAt: Date | null;
  items: { qty: number; name: I18nText; unitCents: number; lineCents: number; note: string | null;
    removed: { name: I18nText }[]; addons: { name: I18nText; qty: number; priceCents: number }[] }[];
}

const ORDER_COLS = `o.id, o.location_id AS "locationId", o.number, o.public_code AS "publicCode", o.channel, o.status,
  o.locale, o.total_cents AS "totalCents", o.note, o.created_at AS "createdAt", o.accepted_at AS "acceptedAt",
  o.ready_at AS "readyAt", o.closed_at AS "closedAt",
  coalesce((SELECT jsonb_agg(jsonb_build_object('qty', oi.qty, 'name', oi.name, 'unitCents', oi.unit_cents,
      'lineCents', oi.line_cents, 'note', oi.note, 'removed', oi.removed, 'addons', oi.addons) ORDER BY oi.id)
    FROM order_items oi WHERE oi.order_id = o.id), '[]') AS items`;

export async function getOrder(tx: Tx, id: string): Promise<OrderView> {
  const { rows } = await tx.query<OrderView>(`SELECT ${ORDER_COLS} FROM orders o WHERE o.id = $1`, [id]);
  if (!rows[0]) throw new OrderError('not_found', 404);
  return rows[0];
}

export async function findOrderByCode(tx: Tx, code: string): Promise<OrderView | null> {
  const { rows } = await tx.query<OrderView>(
    `SELECT ${ORDER_COLS} FROM orders o WHERE o.public_code = $1`, [code.trim().toUpperCase()]);
  return rows[0] ?? null;
}

export async function sessionActiveOrder(tx: Tx, sessionId: string): Promise<OrderView | null> {
  const { rows } = await tx.query<OrderView>(
    `SELECT ${ORDER_COLS} FROM orders o WHERE o.session_id = $1 ORDER BY o.created_at DESC LIMIT 1`, [sessionId]);
  return rows[0] ?? null;
}

/** Кухня: активните + последните приключени за реда „Готови“ отдолу. */
export async function kitchenSnapshot(tx: Tx, locationId: string) {
  const active = await tx.query<OrderView>(
    `SELECT ${ORDER_COLS} FROM orders o WHERE o.location_id = $1 AND o.status = ANY($2)
     ORDER BY o.created_at`, [locationId, ACTIVE_STATUSES]);
  return { orders: active.rows, now: new Date() };
}

/** Табло: само номера. „Готвят се“ = приети; „Готови“ = най-новите отгоре. */
export async function boardSnapshot(tx: Tx, locationId: string) {
  const { rows } = await tx.query<{ number: number; status: OrderStatus }>(
    `SELECT number, status FROM orders WHERE location_id = $1 AND status IN ('accepted', 'ready')
     ORDER BY CASE WHEN status = 'ready' THEN ready_at END DESC NULLS LAST, accepted_at DESC`, [locationId]);
  return {
    cooking: rows.filter((r) => r.status === 'accepted').map((r) => r.number),
    ready: rows.filter((r) => r.status === 'ready').map((r) => r.number),
  };
}

// --- Промени --------------------------------------------------------------------

export async function applyKitchenAction(
  tx: Tx, businessId: string, locationId: string, orderId: string, action: KitchenAction,
): Promise<OrderView> {
  const { rows } = await tx.query<{ status: OrderStatus; customerHash: Buffer | null }>(
    `SELECT status, customer_hash AS "customerHash" FROM orders WHERE id = $1 AND location_id = $2 FOR UPDATE`,
    [orderId, locationId]);
  const cur = rows[0];
  if (!cur) throw new OrderError('not_found', 404);
  const next = nextStatus(action, cur.status);
  if (!next) throw new OrderError('bad_transition');
  await tx.query(
    `UPDATE orders SET status = $2,
       accepted_at = CASE WHEN $2 = 'accepted' THEN coalesce(accepted_at, now()) WHEN $2 = 'pending' THEN NULL
                     ELSE accepted_at END,
       ready_at = CASE WHEN $2 = 'ready' THEN now() WHEN $2 IN ('accepted', 'pending') THEN NULL ELSE ready_at END,
       closed_at = CASE WHEN $2 IN ('collected', 'rejected', 'no_show', 'cancelled') THEN now() ELSE NULL END
     WHERE id = $1`, [orderId, next]);
  if (next === 'no_show' && cur.customerHash) await markNoShow(tx, businessId, cur.customerHash);
  return getOrder(tx, orderId);
}

/** Клиентът може да откаже, докато поръчката още не е приета. */
export async function cancelByCustomer(tx: Tx, sessionId: string): Promise<OrderView> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE orders SET status = 'cancelled', closed_at = now()
     WHERE session_id = $1 AND status = 'pending' RETURNING id`, [sessionId]);
  if (!rows[0]) throw new OrderError('cannot_cancel');
  return getOrder(tx, rows[0].id);
}

export function assertLines(lines: unknown): asserts lines is LineInput[] {
  if (!Array.isArray(lines)) throw new ValidationError('lines');
}
