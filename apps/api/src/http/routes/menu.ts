import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ALLERGENS } from '@qr/shared';
import { withScope, type Tx } from '../../db/pool';
import { AuthError, audit } from '../../auth/service';
import * as menu from '../../menu/repo';
import {
  getImportSettings, IMPORT_FIELDS, listImportRuns, runImport, saveImportSettings, type ImportSettings,
} from '../../menu/import/apply';
import { MAX_IMPORT_BYTES } from '../../menu/import/parse';
import { requireAuth } from '../app';

// --- Схеми ---------------------------------------------------------------------
const i18n = (max: number) => ({
  type: 'object', additionalProperties: false,
  properties: { bg: { type: 'string', maxLength: max }, en: { type: 'string', maxLength: max } },
});
const uuid = { type: 'string', format: 'uuid' };
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } };
const uuidList = { type: 'array', items: uuid, maxItems: 1000, uniqueItems: true };
/** Масив от типове, не anyOf: иначе Fastify приводи null към 0 или "". */
const nullable = <S extends { type: string }>(s: S) => ({ ...s, type: [s.type, 'null'] });
const url = { type: 'string', maxLength: 500, pattern: '^(https://|/)[^\\s"\'<>]*$' };

const categoryBody = { type: 'object', additionalProperties: false, properties: {
  name: i18n(80), importKey: nullable({ type: 'string', maxLength: 80 }), visible: { type: 'boolean' },
} };

const itemBody = { type: 'object', additionalProperties: false, properties: {
  code: nullable({ type: 'string', pattern: '^[0-9]{6}$' }),
  name: i18n(200), description: i18n(1000),
  priceCents: { type: 'integer', minimum: 0, maximum: 10_000_000 },
  imageUrl: nullable(url), visible: { type: 'boolean' }, badgeHit: { type: 'boolean' },
  prepMinutes: nullable({ type: 'integer', minimum: 0, maximum: 240 }),
  allergens: { type: 'array', items: { type: 'string', enum: [...ALLERGENS] }, uniqueItems: true },
  primaryCategoryId: nullable(uuid), extraCategoryIds: uuidList,
  maxAddons: nullable({ type: 'integer', minimum: 0, maximum: 50 }),
} };

const componentBody = { type: 'object', additionalProperties: false, properties: {
  name: i18n(80), addonPriceCents: nullable({ type: 'integer', minimum: 0, maximum: 1_000_000 }),
  removable: { type: 'boolean' },
} };

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Меню, филтри, компоненти, импорт. Право: menu.manage. */
export async function menuRoutes(app: FastifyInstance) {
  const { db } = app.deps;
  app.addHook('onRequest', async (req) => {
    if (req.tenant.kind !== 'business') throw new AuthError('not_found', 404);
  });
  app.addHook('preHandler', requireAuth('menu.manage'));

  // Файлът за импорт идва като тяло на заявката (CSV или XLSX).
  app.addContentTypeParser(['text/csv', 'application/octet-stream', XLSX_TYPE],
    { parseAs: 'buffer', bodyLimit: MAX_IMPORT_BYTES }, (_req, body, done) => done(null, body));

  const bid = (req: FastifyRequest) => (req.realm as { businessId: string }).businessId;
  /** Транзакция в контекста на бизнеса + запис в журнала. */
  const write = <T>(req: FastifyRequest, action: string, fn: (tx: Tx) => Promise<T>, target?: (r: T) => string) =>
    withScope(db, { businessId: bid(req) }, async (tx) => {
      const result = await fn(tx);
      await audit(tx, bid(req), { action, actorId: req.session!.user.id, ip: req.ip,
        targetType: action.split('.')[1], targetId: target?.(result) ?? (req.params as { id?: string }).id });
      return result;
    });
  const read = <T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>) => withScope(db, { businessId: bid(req) }, fn);

  // Категории (филтри)
  app.get('/categories', (req) => read(req, menu.listCategories));
  app.post<{ Body: menu.CategoryInput }>('/categories', { schema: { body: { ...categoryBody, required: ['name'] } } },
    async (req, reply) => reply.code(201).send(
      await write(req, 'menu.category_created', (tx) => menu.createCategory(tx, bid(req), req.body), (c) => c.id)));
  app.patch<{ Params: { id: string }; Body: menu.CategoryInput }>('/categories/:id',
    { schema: { params: idParams, body: { ...categoryBody, minProperties: 1 } } },
    (req) => write(req, 'menu.category_updated', (tx) => menu.updateCategory(tx, req.params.id, req.body)));
  app.delete<{ Params: { id: string } }>('/categories/:id', { schema: { params: idParams } },
    async (req, reply) => {
      await write(req, 'menu.category_deleted', (tx) => menu.deleteCategory(tx, req.params.id));
      return reply.code(204).send();
    });
  app.put<{ Body: { ids: string[] } }>('/categories/order',
    { schema: { body: { type: 'object', required: ['ids'], properties: { ids: uuidList } } } },
    async (req) => {
      await write(req, 'menu.categories_reordered', (tx) => menu.reorderCategories(tx, req.body.ids));
      return { ok: true };
    });
  app.put<{ Params: { id: string }; Body: { ids: string[] } }>('/categories/:id/items/order',
    { schema: { params: idParams, body: { type: 'object', required: ['ids'], properties: { ids: uuidList } } } },
    async (req) => {
      await write(req, 'menu.items_reordered', (tx) => menu.reorderItemsInCategory(tx, req.params.id, req.body.ids));
      return { ok: true };
    });

  // Артикули
  app.get<{ Querystring: menu.ItemFilter }>('/items', { schema: { querystring: { type: 'object', properties: {
    categoryId: uuid, approval: { type: 'string', enum: ['pending', 'approved'] }, q: { type: 'string', maxLength: 100 },
  } } } }, (req) => read(req, (tx) => menu.listItems(tx, req.query)));
  app.get<{ Params: { id: string } }>('/items/:id', { schema: { params: idParams } },
    (req) => read(req, (tx) => menu.getItem(tx, req.params.id)));
  app.post<{ Body: menu.ItemInput }>('/items', { schema: { body: { ...itemBody, required: ['name', 'priceCents'] } } },
    async (req, reply) => reply.code(201).send(
      await write(req, 'menu.item_created', (tx) => menu.createItem(tx, bid(req), req.body), (i) => i.id)));
  app.patch<{ Params: { id: string }; Body: menu.ItemInput }>('/items/:id',
    { schema: { params: idParams, body: { ...itemBody, minProperties: 1 } } },
    (req) => write(req, 'menu.item_updated', (tx) => menu.updateItem(tx, bid(req), req.params.id, req.body)));
  app.delete<{ Params: { id: string } }>('/items/:id', { schema: { params: idParams } }, async (req, reply) => {
    await write(req, 'menu.item_deleted', (tx) => menu.deleteItem(tx, req.params.id));
    return reply.code(204).send();
  });
  app.post<{ Body: { ids: string[] } }>('/items/approve',
    { schema: { body: { type: 'object', required: ['ids'], properties: { ids: uuidList } } } },
    async (req) => ({ approved: await write(req, 'menu.items_approved', (tx) => menu.approveItems(tx, req.body.ids)) }));
  app.put<{ Params: { id: string }; Body: menu.ItemComponentsInput }>('/items/:id/components', { schema: {
    params: idParams,
    body: { type: 'object', required: ['base', 'addons'], additionalProperties: false, properties: {
      base: uuidList,
      addons: { type: 'array', maxItems: 100, items: { type: 'object', required: ['componentId'],
        additionalProperties: false, properties: { componentId: uuid, maxQty: { type: 'integer', minimum: 1, maximum: 10 } } } },
      maxAddons: nullable({ type: 'integer', minimum: 0, maximum: 50 }),
    } },
  } }, (req) => write(req, 'menu.item_components_updated',
    (tx) => menu.setItemComponents(tx, bid(req), req.params.id, req.body)));

  // Компоненти (добавки и „без“)
  app.get('/components', (req) => read(req, menu.listComponents));
  app.post<{ Body: menu.ComponentInput }>('/components', { schema: { body: { ...componentBody, required: ['name'] } } },
    async (req, reply) => reply.code(201).send(
      await write(req, 'menu.component_created', (tx) => menu.createComponent(tx, bid(req), req.body), (c) => c.id)));
  app.patch<{ Params: { id: string }; Body: menu.ComponentInput }>('/components/:id',
    { schema: { params: idParams, body: { ...componentBody, minProperties: 1 } } },
    (req) => write(req, 'menu.component_updated', (tx) => menu.updateComponent(tx, req.params.id, req.body)));
  app.delete<{ Params: { id: string } }>('/components/:id', { schema: { params: idParams } }, async (req, reply) => {
    await write(req, 'menu.component_deleted', (tx) => menu.deleteComponent(tx, req.params.id));
    return reply.code(204).send();
  });

  // Импорт
  app.post<{ Querystring: { filename: string }; Body: Buffer }>('/import', {
    schema: { querystring: { type: 'object', required: ['filename'], properties: {
      filename: { type: 'string', minLength: 1, maxLength: 255 } } } },
  }, async (req) => {
    if (!Buffer.isBuffer(req.body)) throw new AuthError('unsupported_media_type', 415);
    return withScope(db, { businessId: bid(req) }, (tx) => runImport(tx, {
      businessId: bid(req), source: 'upload', filename: req.query.filename, content: req.body,
      actorId: req.session!.user.id, ip: req.ip,
    }));
  });
  app.get('/import/runs', (req) => read(req, (tx) => listImportRuns(tx)));
  app.get('/import/settings', (req) => read(req, getImportSettings));
  app.put<{ Body: Partial<ImportSettings> }>('/import/settings', { schema: { body: {
    type: 'object', additionalProperties: false, minProperties: 1, properties: {
      autoApproveNew: { type: 'boolean' }, missingItems: { type: 'string', enum: ['keep', 'hide'] },
      maxErrorRatio: { type: 'number', minimum: 0, maximum: 1 }, sftpEnabled: { type: 'boolean' },
      encoding: { type: 'string', enum: ['auto', 'utf-8', 'windows-1251'] }, notifyOnError: { type: 'boolean' },
      columnMap: { type: 'object', maxProperties: 20,
        additionalProperties: { type: 'string', enum: [...IMPORT_FIELDS] } },
    } } } },
  (req) => write(req, 'menu.import_settings_updated', (tx) => saveImportSettings(tx, bid(req), req.body)));
}
