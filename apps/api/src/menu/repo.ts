import { ALLERGENS, LOCALES, type I18nText, type Locale } from '@qr/shared';
import type { Tx } from '../db/pool';
import { ValidationError } from '../tenancy/repo';

// --- Типове --------------------------------------------------------------------

export interface Category {
  id: string;
  name: I18nText;
  importKey: string | null;
  visible: boolean;
  position: number;
  createdByImport: boolean;
  itemCount: number;
}

export interface ItemComponentRef { componentId: string; kind: 'base' | 'addon'; maxQty: number; position: number }

export interface Item {
  id: string;
  code: string | null;
  name: I18nText;
  description: I18nText;
  priceCents: number;
  imageUrl: string | null;
  visible: boolean;
  approval: 'pending' | 'approved';
  badgeHit: boolean;
  prepMinutes: number | null;
  allergens: string[];
  primaryCategoryId: string | null;
  maxAddons: number | null;
  missingFromImportAt: Date | null;
  categories: { categoryId: string; source: 'import' | 'manual'; position: number }[];
  components: ItemComponentRef[];
}

export interface Component {
  id: string;
  name: I18nText;
  addonPriceCents: number | null;
  removable: boolean;
}

// --- Проверки ------------------------------------------------------------------

function i18n(v: I18nText | undefined, field: string, required: boolean): I18nText {
  const out: I18nText = {};
  for (const l of LOCALES) {
    const s = v?.[l]?.trim();
    if (s) out[l] = s;
  }
  if (required && !out.bg) throw new ValidationError(`${field}: липсва текст на български`);
  return out;
}

function allergens(list: string[] | undefined): string[] {
  const set = [...new Set(list ?? [])];
  const bad = set.filter((a) => !(ALLERGENS as readonly string[]).includes(a));
  if (bad.length) throw new ValidationError(`Непознати алергени: ${bad.join(', ')}`);
  return set;
}

// --- Категории (филтри) --------------------------------------------------------

const CATEGORY_COLS = `c.id, c.name, c.import_key AS "importKey", c.visible, c.position,
  c.created_by_import AS "createdByImport"`;

export async function listCategories(tx: Tx): Promise<Category[]> {
  const { rows } = await tx.query<Category>(
    `SELECT ${CATEGORY_COLS}, count(ic.item_id)::int AS "itemCount"
     FROM menu_categories c LEFT JOIN menu_item_categories ic ON ic.category_id = c.id
     GROUP BY c.id ORDER BY c.position, c.created_at`);
  return rows;
}

export interface CategoryInput { name?: I18nText; importKey?: string | null; visible?: boolean }

const importKeyOf = (s: string | null | undefined) => {
  const k = s?.trim().toLowerCase().replace(/\s+/g, ' ');
  return k ? k : null;
};

export async function createCategory(tx: Tx, businessId: string, input: CategoryInput): Promise<Category> {
  const { rows } = await tx.query<Category>(
    `INSERT INTO menu_categories AS c (business_id, name, import_key, visible, position)
     VALUES ($1, $2, $3, $4, coalesce((SELECT max(position) + 1 FROM menu_categories), 0))
     RETURNING ${CATEGORY_COLS}, 0 AS "itemCount"`,
    [businessId, i18n(input.name, 'Име', true), importKeyOf(input.importKey), input.visible ?? true]);
  return rows[0]!;
}

export async function updateCategory(tx: Tx, id: string, input: CategoryInput): Promise<Category> {
  const { rows } = await tx.query<Category>(
    `UPDATE menu_categories c SET
       name = coalesce($2, name),
       import_key = CASE WHEN $3 THEN $4 ELSE import_key END,
       visible = coalesce($5, visible),
       created_by_import = false
     WHERE id = $1 RETURNING ${CATEGORY_COLS},
       (SELECT count(*)::int FROM menu_item_categories WHERE category_id = c.id) AS "itemCount"`,
    [id, input.name ? i18n(input.name, 'Име', true) : null,
      input.importKey !== undefined, importKeyOf(input.importKey), input.visible ?? null]);
  if (!rows[0]) throw new NotFound();
  return rows[0];
}

export async function deleteCategory(tx: Tx, id: string): Promise<void> {
  const r = await tx.query('DELETE FROM menu_categories WHERE id = $1', [id]);
  if (!r.rowCount) throw new NotFound();
}

/** Подредба: позицията е индексът в масива. */
export async function reorderCategories(tx: Tx, ids: string[]): Promise<void> {
  await tx.query(
    `UPDATE menu_categories c SET position = o.pos
     FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, pos) WHERE c.id = o.id`, [ids]);
}

export async function reorderItemsInCategory(tx: Tx, categoryId: string, itemIds: string[]): Promise<void> {
  await tx.query(
    `UPDATE menu_item_categories ic SET position = o.pos
     FROM unnest($2::uuid[]) WITH ORDINALITY AS o(id, pos)
     WHERE ic.category_id = $1 AND ic.item_id = o.id`, [categoryId, itemIds]);
}

// --- Артикули ------------------------------------------------------------------

export class NotFound extends Error { constructor() { super('not_found'); } }

const ITEM_COLS = `i.id, i.code, i.name, i.description, i.price_cents AS "priceCents", i.image_url AS "imageUrl",
  i.visible, i.approval, i.badge_hit AS "badgeHit", i.prep_minutes AS "prepMinutes", i.allergens,
  i.primary_category_id AS "primaryCategoryId", i.max_addons AS "maxAddons",
  i.missing_from_import_at AS "missingFromImportAt",
  coalesce((SELECT jsonb_agg(jsonb_build_object('categoryId', ic.category_id, 'source', ic.source,
              'position', ic.position) ORDER BY ic.source, ic.category_id)
            FROM menu_item_categories ic WHERE ic.item_id = i.id), '[]') AS categories,
  coalesce((SELECT jsonb_agg(jsonb_build_object('componentId', mc.component_id, 'kind', mc.kind,
              'maxQty', mc.max_qty, 'position', mc.position) ORDER BY mc.kind, mc.position)
            FROM menu_item_components mc WHERE mc.item_id = i.id), '[]') AS components`;

export interface ItemFilter { categoryId?: string; approval?: 'pending' | 'approved'; q?: string }

export async function listItems(tx: Tx, f: ItemFilter = {}): Promise<Item[]> {
  const { rows } = await tx.query<Item>(
    `SELECT ${ITEM_COLS} FROM menu_items i
     LEFT JOIN menu_item_categories fc ON fc.item_id = i.id AND fc.category_id = $1
     WHERE ($1::uuid IS NULL OR fc.item_id IS NOT NULL)
       AND ($2::text IS NULL OR i.approval = $2)
       AND ($3::text IS NULL OR i.code LIKE $3 || '%'
            OR i.name->>'bg' ILIKE '%' || $3 || '%' OR i.name->>'en' ILIKE '%' || $3 || '%')
     ORDER BY fc.position NULLS LAST, i.name->>'bg'`,
    [f.categoryId ?? null, f.approval ?? null, f.q?.trim() || null]);
  return rows;
}

export async function getItem(tx: Tx, id: string): Promise<Item> {
  const { rows } = await tx.query<Item>(`SELECT ${ITEM_COLS} FROM menu_items i WHERE i.id = $1`, [id]);
  if (!rows[0]) throw new NotFound();
  return rows[0];
}

export interface ItemInput {
  code?: string | null;
  name?: I18nText;
  description?: I18nText;
  priceCents?: number;
  imageUrl?: string | null;
  visible?: boolean;
  badgeHit?: boolean;
  prepMinutes?: number | null;
  allergens?: string[];
  primaryCategoryId?: string | null;
  /** Ръчни филтри освен основната група. */
  extraCategoryIds?: string[];
  maxAddons?: number | null;
}

export async function createItem(tx: Tx, businessId: string, input: ItemInput): Promise<Item> {
  if (input.priceCents === undefined) throw new ValidationError('Липсва цена');
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO menu_items (business_id, code, name, description, price_cents, image_url, visible,
       badge_hit, prep_minutes, allergens, max_addons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [businessId, input.code ?? null, i18n(input.name, 'Име', true), i18n(input.description, 'Описание', false),
      input.priceCents, input.imageUrl ?? null, input.visible ?? true, input.badgeHit ?? false,
      input.prepMinutes ?? null, allergens(input.allergens), input.maxAddons ?? null]);
  const id = rows[0]!.id;
  if (input.primaryCategoryId) await setPrimaryCategory(tx, businessId, id, input.primaryCategoryId);
  if (input.extraCategoryIds) await setManualCategories(tx, businessId, id, input.extraCategoryIds);
  return getItem(tx, id);
}

export async function updateItem(tx: Tx, businessId: string, id: string, input: ItemInput): Promise<Item> {
  const has = (k: keyof ItemInput) => input[k] !== undefined;
  const r = await tx.query(
    `UPDATE menu_items SET
       code = CASE WHEN $2 THEN $3 ELSE code END,
       name = coalesce($4, name),
       description = coalesce($5, description),
       price_cents = coalesce($6, price_cents),
       image_url = CASE WHEN $7 THEN $8 ELSE image_url END,
       visible = coalesce($9, visible),
       badge_hit = coalesce($10, badge_hit),
       prep_minutes = CASE WHEN $11 THEN $12 ELSE prep_minutes END,
       allergens = coalesce($13, allergens),
       max_addons = CASE WHEN $14 THEN $15 ELSE max_addons END
     WHERE id = $1`,
    [id, has('code'), input.code ?? null,
      input.name ? i18n(input.name, 'Име', true) : null,
      input.description ? i18n(input.description, 'Описание', false) : null,
      input.priceCents ?? null, has('imageUrl'), input.imageUrl ?? null, input.visible ?? null,
      input.badgeHit ?? null, has('prepMinutes'), input.prepMinutes ?? null,
      input.allergens ? allergens(input.allergens) : null, has('maxAddons'), input.maxAddons ?? null]);
  if (!r.rowCount) throw new NotFound();
  if (has('primaryCategoryId')) await setPrimaryCategory(tx, businessId, id, input.primaryCategoryId ?? null);
  if (input.extraCategoryIds) await setManualCategories(tx, businessId, id, input.extraCategoryIds);
  return getItem(tx, id);
}

export async function deleteItem(tx: Tx, id: string): Promise<void> {
  const r = await tx.query('DELETE FROM menu_items WHERE id = $1', [id]);
  if (!r.rowCount) throw new NotFound();
}

export async function approveItems(tx: Tx, ids: string[]): Promise<number> {
  const r = await tx.query(
    `UPDATE menu_items SET approval = 'approved' WHERE id = ANY($1::uuid[]) AND approval = 'pending'`, [ids]);
  return r.rowCount ?? 0;
}

/** Основната група (от импорта или зададена ръчно). Ръчните филтри не се пипат. */
export async function setPrimaryCategory(tx: Tx, businessId: string, itemId: string, categoryId: string | null) {
  await tx.query('UPDATE menu_items SET primary_category_id = $2 WHERE id = $1', [itemId, categoryId]);
  await tx.query(`DELETE FROM menu_item_categories WHERE item_id = $1 AND source = 'import'
                  AND category_id IS DISTINCT FROM $2`, [itemId, categoryId]);
  if (categoryId) {
    await tx.query(
      `INSERT INTO menu_item_categories (business_id, item_id, category_id, source, position)
       VALUES ($1, $2, $3, 'import',
         coalesce((SELECT max(position) + 1 FROM menu_item_categories WHERE category_id = $3), 0))
       ON CONFLICT (item_id, category_id) DO NOTHING`, [businessId, itemId, categoryId]);
  }
}

/** Ръчно добавените филтри; остават при следващ импорт. */
export async function setManualCategories(tx: Tx, businessId: string, itemId: string, categoryIds: string[]) {
  await tx.query(`DELETE FROM menu_item_categories WHERE item_id = $1 AND source = 'manual'
                  AND NOT (category_id = ANY($2::uuid[]))`, [itemId, categoryIds]);
  await tx.query(
    `INSERT INTO menu_item_categories (business_id, item_id, category_id, source, position)
     SELECT $1::uuid, $2::uuid, c, 'manual',
       coalesce((SELECT max(position) + 1 FROM menu_item_categories WHERE category_id = c), 0)
     FROM unnest($3::uuid[]) AS c
     ON CONFLICT (item_id, category_id) DO NOTHING`, [businessId, itemId, categoryIds]);
}

export interface ItemComponentsInput {
  base: string[];
  addons: { componentId: string; maxQty?: number }[];
  maxAddons?: number | null;
}

/** Състав и допустими добавки на артикул. Само компоненти от библиотеката с правилния вид. */
export async function setItemComponents(tx: Tx, businessId: string, itemId: string, input: ItemComponentsInput) {
  const addonIds = input.addons.map((a) => a.componentId);
  if (addonIds.length) {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM menu_components WHERE id = ANY($1::uuid[]) AND addon_price_cents IS NULL`, [addonIds]);
    if (rows.length) throw new ValidationError('Компонентът не е добавка в библиотеката');
  }
  await tx.query('DELETE FROM menu_item_components WHERE item_id = $1', [itemId]);
  await tx.query(
    `INSERT INTO menu_item_components (business_id, item_id, component_id, kind, max_qty, position)
     SELECT $1::uuid, $2::uuid, b.id, 'base', 1, b.pos FROM unnest($3::uuid[]) WITH ORDINALITY AS b(id, pos)
     UNION ALL
     SELECT $1::uuid, $2::uuid, a.id, 'addon', a.qty, a.pos FROM unnest($4::uuid[], $5::int[]) WITH ORDINALITY AS a(id, qty, pos)`,
    [businessId, itemId, input.base, addonIds, input.addons.map((a) => a.maxQty ?? 1)]);
  if (input.maxAddons !== undefined) {
    await tx.query('UPDATE menu_items SET max_addons = $2 WHERE id = $1', [itemId, input.maxAddons]);
  }
  return getItem(tx, itemId);
}

// --- Компоненти ----------------------------------------------------------------

const COMPONENT_COLS = `id, name, addon_price_cents AS "addonPriceCents", removable`;

export async function listComponents(tx: Tx): Promise<Component[]> {
  const { rows } = await tx.query<Component>(`SELECT ${COMPONENT_COLS} FROM menu_components ORDER BY name->>'bg'`);
  return rows;
}

export interface ComponentInput { name?: I18nText; addonPriceCents?: number | null; removable?: boolean }

export async function createComponent(tx: Tx, businessId: string, input: ComponentInput): Promise<Component> {
  const { rows } = await tx.query<Component>(
    `INSERT INTO menu_components (business_id, name, addon_price_cents, removable)
     VALUES ($1, $2, $3, $4) RETURNING ${COMPONENT_COLS}`,
    [businessId, i18n(input.name, 'Име', true), input.addonPriceCents ?? null, input.removable ?? false]);
  return rows[0]!;
}

export async function updateComponent(tx: Tx, id: string, input: ComponentInput): Promise<Component> {
  if (input.addonPriceCents === null) {
    // Ако вече не е добавка, маха се от допустимите добавки на артикулите.
    await tx.query(`DELETE FROM menu_item_components WHERE component_id = $1 AND kind = 'addon'`, [id]);
  }
  const { rows } = await tx.query<Component>(
    `UPDATE menu_components SET name = coalesce($2, name),
       addon_price_cents = CASE WHEN $3 THEN $4 ELSE addon_price_cents END,
       removable = coalesce($5, removable)
     WHERE id = $1 RETURNING ${COMPONENT_COLS}`,
    [id, input.name ? i18n(input.name, 'Име', true) : null, input.addonPriceCents !== undefined,
      input.addonPriceCents ?? null, input.removable ?? null]);
  if (!rows[0]) throw new NotFound();
  return rows[0];
}

export async function deleteComponent(tx: Tx, id: string): Promise<void> {
  const r = await tx.query('DELETE FROM menu_components WHERE id = $1', [id]);
  if (!r.rowCount) throw new NotFound();
}

// --- Менюто, както го вижда клиентът -------------------------------------------

export interface PublicMenu {
  locales: Locale[];
  defaultLocale: Locale;
  currency: string;
  categories: { id: string; name: I18nText; itemIds: string[] }[];
  items: {
    id: string; name: I18nText; description: I18nText; priceCents: number; imageUrl: string | null;
    badgeHit: boolean; prepMinutes: number | null; allergens: string[]; maxAddons: number | null;
    base: { id: string; name: I18nText; removable: boolean }[];
    addons: { id: string; name: I18nText; priceCents: number; maxQty: number }[];
  }[];
}

/** Само видими и одобрени артикули; само видими филтри. Преводите са само на включените езици. */
export async function publicMenu(tx: Tx): Promise<PublicMenu> {
  const biz = await tx.query<{ locales: Locale[]; defaultLocale: Locale; currency: string }>(
    `SELECT enabled_locales AS locales, default_locale AS "defaultLocale", currency FROM businesses`);
  const { locales, defaultLocale, currency } = biz.rows[0]!;
  const strip = (t: I18nText): I18nText =>
    Object.fromEntries(Object.entries(t).filter(([l]) => locales.includes(l as Locale)));

  const items = await tx.query<PublicMenu['items'][number]>(
    `SELECT i.id, i.name, i.description, i.price_cents AS "priceCents", i.image_url AS "imageUrl",
       i.badge_hit AS "badgeHit", i.prep_minutes AS "prepMinutes", i.allergens, i.max_addons AS "maxAddons",
       coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'removable', c.removable)
                   ORDER BY mc.position)
                 FROM menu_item_components mc JOIN menu_components c ON c.id = mc.component_id
                 WHERE mc.item_id = i.id AND mc.kind = 'base'), '[]') AS base,
       coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name,
                   'priceCents', c.addon_price_cents, 'maxQty', mc.max_qty) ORDER BY mc.position)
                 FROM menu_item_components mc JOIN menu_components c ON c.id = mc.component_id
                 WHERE mc.item_id = i.id AND mc.kind = 'addon' AND c.addon_price_cents IS NOT NULL), '[]') AS addons
     FROM menu_items i WHERE i.visible AND i.approval = 'approved' ORDER BY i.name->>'bg'`);

  const cats = await tx.query<{ id: string; name: I18nText; itemIds: string[] }>(
    `SELECT c.id, c.name,
       coalesce(array_agg(ic.item_id ORDER BY ic.position, ic.item_id)
         FILTER (WHERE i.id IS NOT NULL), '{}') AS "itemIds"
     FROM menu_categories c
     LEFT JOIN menu_item_categories ic ON ic.category_id = c.id
     LEFT JOIN menu_items i ON i.id = ic.item_id AND i.visible AND i.approval = 'approved'
     WHERE c.visible GROUP BY c.id ORDER BY c.position, c.created_at`);

  return {
    locales, defaultLocale, currency,
    categories: cats.rows.filter((c) => c.itemIds.length).map((c) => ({ ...c, name: strip(c.name) })),
    items: items.rows.map((i) => ({
      ...i, name: strip(i.name), description: strip(i.description),
      base: i.base.map((b) => ({ ...b, name: strip(b.name) })),
      addons: i.addons.map((a) => ({ ...a, name: strip(a.name) })),
    })),
  };
}
