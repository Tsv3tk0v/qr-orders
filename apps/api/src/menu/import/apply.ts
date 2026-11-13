import { normalizeItemCode, parsePriceCents } from '@qr/shared';
import type { Tx } from '../../db/pool';
import { audit } from '../../auth/service';
import { setPrimaryCategory } from '../repo';
import { parseImportFile, ParseError, type Cell, type Encoding } from './parse';

/** Полетата, които импортът познава. Само name, price и group променят артикул (реш. 20). */
export const IMPORT_FIELDS = ['code', 'name', 'price', 'group', 'stock'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Стандартни заглавия на колони (малки букви). */
const DEFAULT_ALIASES: Record<string, ImportField> = {
  'код': 'code', 'code': 'code', 'sku': 'code',
  'наименование': 'name', 'име': 'name', 'name': 'name',
  'цена': 'price', 'price': 'price',
  'група артикули за меню': 'group', 'група': 'group', 'group': 'group', 'category': 'group',
  // Начална наличност — ползва се във Фаза 2; сега колоната се приема и пропуска.
  'наличност': 'stock', 'stock': 'stock',
};

export interface ImportSettings {
  autoApproveNew: boolean;
  missingItems: 'keep' | 'hide';
  maxErrorRatio: number;
  sftpEnabled: boolean;
  encoding: Encoding;
  notifyOnError: boolean;
  columnMap: Record<string, ImportField>;
}

export const DEFAULT_IMPORT_SETTINGS: ImportSettings = {
  autoApproveNew: false, missingItems: 'keep', maxErrorRatio: 0.2, sftpEnabled: false,
  encoding: 'auto', notifyOnError: true, columnMap: {},
};

export async function getImportSettings(tx: Tx): Promise<ImportSettings> {
  const { rows } = await tx.query<ImportSettings>(
    `SELECT auto_approve_new AS "autoApproveNew", missing_items AS "missingItems",
       max_error_ratio::float AS "maxErrorRatio", sftp_enabled AS "sftpEnabled", encoding,
       notify_on_error AS "notifyOnError", column_map AS "columnMap" FROM import_settings`);
  return rows[0] ?? DEFAULT_IMPORT_SETTINGS;
}

export async function saveImportSettings(tx: Tx, businessId: string, s: Partial<ImportSettings>): Promise<ImportSettings> {
  const next = { ...(await getImportSettings(tx)), ...s };
  for (const [k, v] of Object.entries(next.columnMap)) {
    if (!(IMPORT_FIELDS as readonly string[]).includes(v) || !k.trim()) throw new ImportSettingsError();
  }
  await tx.query(
    `INSERT INTO import_settings (business_id, auto_approve_new, missing_items, max_error_ratio, sftp_enabled,
       encoding, notify_on_error, column_map)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (business_id) DO UPDATE SET auto_approve_new = $2, missing_items = $3, max_error_ratio = $4,
       sftp_enabled = $5, encoding = $6, notify_on_error = $7, column_map = $8, updated_at = now()`,
    [businessId, next.autoApproveNew, next.missingItems, next.maxErrorRatio, next.sftpEnabled,
      next.encoding, next.notifyOnError, normalizeMap(next.columnMap)]);
  return getImportSettings(tx);
}

export class ImportSettingsError extends Error { constructor() { super('invalid_column_map'); } }

const normHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, ' ');
const normalizeMap = (m: Record<string, ImportField>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [normHeader(k), v]));

export interface RowError { row: number; code: string; value?: string }

export interface ImportRun {
  id: string;
  source: 'upload' | 'sftp';
  filename: string;
  status: 'success' | 'with_errors' | 'aborted' | 'failed';
  rowsTotal: number;
  created: number;
  updated: number;
  unchanged: number;
  hidden: number;
  errorCount: number;
  errors: RowError[];
  preview: string;
  createdAt: Date;
}

const RUN_COLS = `id, source, filename, status, rows_total AS "rowsTotal", created, updated, unchanged, hidden,
  error_count AS "errorCount", errors, preview, created_at AS "createdAt"`;

export async function listImportRuns(tx: Tx, limit = 20): Promise<ImportRun[]> {
  const { rows } = await tx.query<ImportRun>(
    `SELECT ${RUN_COLS} FROM import_runs ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows;
}

interface ValidRow { line: number; code: string; name: string; priceCents: number; group: string | null }

const text = (c: Cell | undefined) => (c === null || c === undefined ? '' : String(c).trim());

/** Заглавие на колона → индекс за всяко поле. */
function mapColumns(headers: string[], custom: Record<string, ImportField>) {
  const idx: Partial<Record<ImportField, number>> = {};
  headers.forEach((h, i) => {
    const field = custom[normHeader(h)] ?? DEFAULT_ALIASES[normHeader(h)];
    if (field && idx[field] === undefined) idx[field] = i;
  });
  return idx;
}

export interface ImportInput {
  businessId: string;
  source: 'upload' | 'sftp';
  filename: string;
  content: Buffer;
  actorId?: string | null;
  ip?: string;
}

/**
 * Импорт в отворена транзакция с контекста на бизнеса.
 * Ключ е 6-цифреният код. Променят се само име (български), цена и основна група.
 * Нови артикули чакат одобрение, освен ако настройката не казва друго.
 * Ако грешните редове са над прага, нищо не се променя (статус „aborted“).
 */
export async function runImport(tx: Tx, input: ImportInput): Promise<ImportRun> {
  const settings = await getImportSettings(tx);
  const base = { rowsTotal: 0, created: 0, updated: 0, unchanged: 0, hidden: 0 };
  let preview = '';
  const errors: RowError[] = [];

  const finish = async (status: ImportRun['status'], counts = base) => {
    const { rows } = await tx.query<ImportRun>(
      `INSERT INTO import_runs (business_id, source, filename, status, rows_total, created, updated, unchanged,
         hidden, error_count, errors, preview, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING ${RUN_COLS}`,
      [input.businessId, input.source, input.filename.slice(0, 255), status, counts.rowsTotal, counts.created,
        counts.updated, counts.unchanged, counts.hidden, errors.length, JSON.stringify(errors.slice(0, 200)),
        preview.slice(0, 2000), input.actorId ?? null]);
    const run = rows[0]!;
    await audit(tx, input.businessId, {
      action: 'menu.imported', actorId: input.actorId, targetType: 'import_run', targetId: run.id, ip: input.ip,
      data: { source: input.source, filename: run.filename, status, ...counts, errors: errors.length },
    });
    return run;
  };

  let parsed;
  try {
    parsed = await parseImportFile(input.content, input.filename, settings.encoding);
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    errors.push({ row: 0, code: err.message });
    return finish('failed');
  }
  preview = parsed.preview;

  const col = mapColumns(parsed.headers, settings.columnMap);
  const missingCols = (['code', 'name', 'price'] as const).filter((f) => col[f] === undefined);
  if (missingCols.length) {
    for (const f of missingCols) errors.push({ row: 1, code: 'missing_column', value: f });
    return finish('failed');
  }

  // 1. Проверка на редовете.
  const valid: ValidRow[] = [];
  const seen = new Set<string>();
  parsed.rows.forEach((r, i) => {
    const line = i + 2; // ред 1 е заглавието
    const rawCode = r[col.code!];
    const code = rawCode === null || rawCode === undefined ? null : normalizeItemCode(rawCode);
    const name = text(r[col.name!]);
    const rawPrice = r[col.price!];
    const priceCents = rawPrice === null || rawPrice === undefined ? null : parsePriceCents(rawPrice);
    if (!code) return errors.push({ row: line, code: 'bad_code', value: text(rawCode) });
    if (seen.has(code)) return errors.push({ row: line, code: 'duplicate_code', value: code });
    if (!name) return errors.push({ row: line, code: 'missing_name', value: code });
    if (priceCents === null) return errors.push({ row: line, code: 'bad_price', value: text(rawPrice) });
    seen.add(code);
    valid.push({ line, code, name: name.slice(0, 200), priceCents,
      group: col.group === undefined ? null : text(r[col.group]) || null });
  });
  const counts = { ...base, rowsTotal: parsed.rows.length };
  if (counts.rowsTotal === 0) {
    errors.push({ row: 0, code: 'no_rows' });
    return finish('failed', counts);
  }
  if (errors.length / counts.rowsTotal > settings.maxErrorRatio) return finish('aborted', counts);

  // 2. Групи → филтри. Нова група създава скрит филтър „НОВ“.
  const cats = new Map((await tx.query<{ id: string; importKey: string }>(
    `SELECT id, import_key AS "importKey" FROM menu_categories WHERE import_key IS NOT NULL`)).rows
    .map((c) => [c.importKey, c.id]));
  const categoryFor = async (group: string | null): Promise<string | null> => {
    if (!group) return null;
    const key = group.toLowerCase().replace(/\s+/g, ' ');
    let id = cats.get(key);
    if (!id) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO menu_categories (business_id, name, import_key, visible, created_by_import, position)
         VALUES ($1, $2, $3, false, true, coalesce((SELECT max(position) + 1 FROM menu_categories), 0))
         RETURNING id`, [input.businessId, { bg: group.replace(/\s+/g, ' ') }, key]);
      id = rows[0]!.id;
      cats.set(key, id);
    }
    return id;
  };

  // 3. Артикули.
  const existing = new Map((await tx.query<{
    id: string; code: string; nameBg: string; priceCents: number; primaryCategoryId: string | null;
    missing: boolean; visible: boolean;
  }>(`SELECT id, code, name->>'bg' AS "nameBg", price_cents AS "priceCents",
        primary_category_id AS "primaryCategoryId", missing_from_import_at IS NOT NULL AS missing, visible
      FROM menu_items WHERE code IS NOT NULL`)).rows.map((r) => [r.code, r]));

  for (const row of valid) {
    const categoryId = await categoryFor(row.group);
    const item = existing.get(row.code);
    if (!item) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO menu_items (business_id, code, name, price_cents, approval)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.businessId, row.code, { bg: row.name }, row.priceCents,
          settings.autoApproveNew ? 'approved' : 'pending']);
      if (categoryId) await setPrimaryCategory(tx, input.businessId, rows[0]!.id, categoryId);
      counts.created++;
      continue;
    }
    // Ако беше скрит, защото липсваше във файла, се връща.
    const unhide = item.missing && settings.missingItems === 'hide' && !item.visible;
    const changed = item.nameBg !== row.name || item.priceCents !== row.priceCents
      || (col.group !== undefined && item.primaryCategoryId !== categoryId);
    if (changed || item.missing) {
      await tx.query(
        `UPDATE menu_items SET name = jsonb_set(name, '{bg}', to_jsonb($2::text)), price_cents = $3,
           missing_from_import_at = NULL, visible = visible OR $4 WHERE id = $1`,
        [item.id, row.name, row.priceCents, unhide]);
      if (col.group !== undefined && item.primaryCategoryId !== categoryId) {
        await setPrimaryCategory(tx, input.businessId, item.id, categoryId);
      }
    }
    if (changed) counts.updated++;
    else counts.unchanged++;
  }

  // 4. Артикули с код, които ги няма във файла. Отбелязват се веднъж; ако админът
  //    после ги покаже ръчно, следващият импорт не ги скрива отново.
  const codes = valid.map((r) => r.code);
  const missing = await tx.query(
    `UPDATE menu_items SET missing_from_import_at = coalesce(missing_from_import_at, now()),
       visible = CASE WHEN $2 THEN false ELSE visible END
     WHERE code IS NOT NULL AND NOT (code = ANY($1::text[])) AND missing_from_import_at IS NULL`,
    [codes, settings.missingItems === 'hide']);
  if (settings.missingItems === 'hide') counts.hidden = missing.rowCount ?? 0;

  return finish(errors.length ? 'with_errors' : 'success', counts);
}
