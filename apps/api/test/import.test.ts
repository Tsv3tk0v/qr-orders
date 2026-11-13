import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../src/db/pool';
import { parseCsv } from '../src/menu/import/parse';
import { ensureBusinessFolders, processSftpFolders } from '../src/menu/import/sftp';
import { loggedIn, makeApp, type Client } from './helpers';

let app: FastifyInstance;
let db: Db;
beforeAll(async () => ({ app, db } = await makeApp()));
afterAll(async () => { await app.close(); await db.end(); });

const M = '/api/admin/menu';
const cp1251 = (s: string) => {
  // Минимален кодер за кирилица → Windows-1251 (за тестов файл „от касата“).
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 128) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (ch === '„') out.push(0x84);
    else if (ch === '“') out.push(0x93);
    else throw new Error(`няма в теста: ${ch}`);
  }
  return Buffer.from(out);
};

const FILE1 = [
  'код;наименование;цена;група артикули за меню;наличност',
  '004512;Еклер с ванилия;2,40;пасти;24',
  '004518;Паста „Гараш“;3,20;пасти;12',
  '004601;Капучино;2,60;кафе;',
].join('\r\n');

const upload = (c: Client, name: string, body: Buffer | string, type = 'text/csv') =>
  c.upload(`${M}/import?filename=${encodeURIComponent(name)}`, Buffer.isBuffer(body) ? body : Buffer.from(body), type);

describe('CSV', () => {
  it('кавички, разделител и празни редове', () => {
    const p = parseCsv('a,b,c\n1,"x, ""y""",3\n\n"многоредов\nтекст",2,\n');
    expect(p.headers).toEqual(['a', 'b', 'c']);
    expect(p.rows).toEqual([['1', 'x, "y"', '3'], ['многоредов\nтекст', '2', '']]);
  });
});

describe('импорт', () => {
  it('първи импорт: нови артикули чакат одобрение, новите групи са скрити филтри', async () => {
    const { client: c } = await loggedIn(app, db);
    const run = (await upload(c, 'artikuli_2026-11-12.csv', cp1251(FILE1))).json();
    expect(run).toMatchObject({ status: 'success', source: 'upload', rowsTotal: 3, created: 3, errorCount: 0 });
    expect(run.preview).toContain('004518;Паста „Гараш“');

    const cats = (await c.get(`${M}/categories`)).json();
    expect(cats.map((x: { importKey: string }) => x.importKey).sort()).toEqual(['кафе', 'пасти']);
    expect(cats.every((x: { visible: boolean; createdByImport: boolean }) => !x.visible && x.createdByImport)).toBe(true);
    expect((await c.get(`${M}/items?approval=pending`)).json()).toHaveLength(3);
    expect((await c.get('/api/menu')).json().items).toHaveLength(0);

    const ids = (await c.get(`${M}/items`)).json().map((i: { id: string }) => i.id);
    expect((await c.post(`${M}/items/approve`, { ids })).json()).toEqual({ approved: 3 });
    const pasti = cats.find((x: { importKey: string }) => x.importKey === 'пасти');
    await c.patch(`${M}/categories/${pasti.id}`, { visible: true });
    const pub = (await c.get('/api/menu')).json();
    expect(pub.items).toHaveLength(3);
    expect(pub.categories).toHaveLength(1);
  });

  it('повторен импорт: само име, цена и основна група; ръчните неща остават', async () => {
    const { client: c } = await loggedIn(app, db);
    await upload(c, 'a.csv', FILE1);
    const eclair = (await c.get(`${M}/items?q=004512`)).json()[0];
    const tortes = (await c.post(`${M}/categories`, { name: { bg: 'Торти' } })).json();
    await c.patch(`${M}/items/${eclair.id}`, {
      name: { bg: 'Еклер с ванилия', en: 'Vanilla eclair' }, description: { bg: 'Ръчно описание' },
      allergens: ['milk'], extraCategoryIds: [tortes.id],
    });

    const file2 = [
      'Код,Наименование,Цена,Група артикули за меню',
      '004512,Еклер ванилия,2.50,Сладки',  // ново име, цена и група
      '004518,Паста „Гараш“,3.20,пасти',    // без промяна
    ].join('\n');                           // 004601 липсва
    const run = (await upload(c, 'b.csv', file2)).json();
    expect(run).toMatchObject({ status: 'success', created: 0, updated: 1, unchanged: 1, hidden: 0 });

    const after = (await c.get(`${M}/items/${eclair.id}`)).json();
    expect(after).toMatchObject({ name: { bg: 'Еклер ванилия', en: 'Vanilla eclair' }, priceCents: 250,
      description: { bg: 'Ръчно описание' }, allergens: ['milk'] });
    const sources = after.categories.map((x: { source: string }) => x.source).sort();
    expect(sources).toEqual(['import', 'manual']); // ново „сладки“ + ръчно „Торти“
    const cappuccino = (await c.get(`${M}/items?q=004601`)).json()[0];
    expect(cappuccino.missingFromImportAt).not.toBeNull();
    expect(cappuccino.visible).toBe(true); // настройката е „не се пипа“
  });

  it('липсващите се скриват по настройка и се връщат, когато пак ги има', async () => {
    const { client: c } = await loggedIn(app, db);
    await c.put(`${M}/import/settings`, { missingItems: 'hide', autoApproveNew: true });
    await upload(c, 'a.csv', FILE1);
    const r = (await upload(c, 'b.csv', FILE1.split('\r\n').slice(0, 3).join('\n'))).json();
    expect(r.hidden).toBe(1);
    const cap = () => c.get(`${M}/items?q=004601`).then((x) => x.json()[0]);
    expect((await cap()).visible).toBe(false);
    expect((await cap()).approval).toBe('approved');
    await upload(c, 'c.csv', FILE1);
    expect(await cap()).toMatchObject({ visible: true, missingFromImportAt: null });
  });

  it('спира при много грешки и не променя нищо', async () => {
    const { client: c } = await loggedIn(app, db);
    const bad = 'код;наименование;цена\n12A45;Грешен;1\n004512;Добър;2\n004513;;3\n';
    const r = (await upload(c, 'bad.csv', bad)).json();
    expect(r).toMatchObject({ status: 'aborted', errorCount: 2, created: 0 });
    expect(r.errors).toEqual([{ row: 2, code: 'bad_code', value: '12A45' }, { row: 4, code: 'missing_name', value: '004513' }]);
    expect((await c.get(`${M}/items`)).json()).toHaveLength(0);

    await c.put(`${M}/import/settings`, { maxErrorRatio: 0.7 });
    const r2 = (await upload(c, 'bad.csv', bad)).json();
    expect(r2).toMatchObject({ status: 'with_errors', created: 1, errorCount: 2 });

    expect((await upload(c, 'x.csv', 'име;цена\nа;1')).json()).toMatchObject({ status: 'failed',
      errors: [{ code: 'missing_column', value: 'code' }] });
    expect((await upload(c, 'x.pdf', 'нещо')).json().errors[0].code).toBe('unsupported_format');
    const runs = (await c.get(`${M}/import/runs`)).json();
    expect(runs.map((x: { status: string }) => x.status)).toEqual(['failed', 'failed', 'with_errors', 'aborted']);
  });

  it('XLSX: числовите кодове си връщат водещите нули; собствени имена на колони', async () => {
    const { client: c } = await loggedIn(app, db);
    await c.put(`${M}/import/settings`, { columnMap: { 'Артикул №': 'code', 'Продукт': 'name', 'Ед. цена': 'price' } });
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Лист1');
    ws.addRow(['Артикул №', 'Продукт', 'Ед. цена']);
    ws.addRow([4512, 'Еклер', 2.4]);
    ws.addRow(['004530', 'Паста „Шварцвалд“', '3,50']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const r = (await upload(c, 'menu.xlsx', buf,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).json();
    expect(r).toMatchObject({ status: 'success', created: 2 });
    const codes = (await c.get(`${M}/items`)).json().map((i: { code: string; priceCents: number }) => [i.code, i.priceCents]);
    expect(codes).toEqual([['004512', 240], ['004530', 350]]);
  });

  it('персоналът не може да импортира', async () => {
    const { client: c } = await loggedIn(app, db, 'staff');
    expect((await upload(c, 'a.csv', FILE1)).statusCode).toBe(403);
  });
});

describe('SFTP папки', () => {
  it('импортира, мести в history/ или errors/ с отчет; пресни файлове чакат', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qr-sftp-'));
    const { client: c, business } = await loggedIn(app, db);
    await c.put(`${M}/import/settings`, { sftpEnabled: true });
    const dir = join(root, business.slug);
    const now = Date.now();
    const old = new Date(now - 120_000);

    await ensureBusinessFolders(root, business.slug);
    await writeFile(join(dir, 'import', 'artikuli.csv'), cp1251(FILE1));
    await writeFile(join(dir, 'import', 'bad.csv'), 'код;наименование;цена\nxx;А;1\n');
    await writeFile(join(dir, 'import', 'fresh.csv'), FILE1);
    await utimes(join(dir, 'import', 'artikuli.csv'), old, old);
    await utimes(join(dir, 'import', 'bad.csv'), old, old);

    const results = await processSftpFolders(db, root, now);
    const mine = results.filter((r) => r.slug === business.slug);
    expect(mine.map((r) => [r.filename, r.run.status]).sort()).toEqual([['artikuli.csv', 'success'], ['bad.csv', 'aborted']]);
    expect(await readdir(join(dir, 'import'))).toEqual(['fresh.csv']);
    expect((await readdir(join(dir, 'history'))).some((f) => f.endsWith('_artikuli.csv'))).toBe(true);
    const errs = await readdir(join(dir, 'errors'));
    const report = errs.find((f) => f.endsWith('bad.csv.report.txt'))!;
    expect(await readFile(join(dir, 'errors', report), 'utf8')).toContain('ред 2: кодът не е 6 цифри („xx“)');
    expect((await c.get(`${M}/import/runs`)).json()[0].source).toBe('sftp');
  });
});
