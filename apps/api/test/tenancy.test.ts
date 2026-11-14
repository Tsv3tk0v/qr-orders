import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool, withScope, type Db } from '../src/db/pool';
import { migrate } from '../src/db/migrate';
import { createBusiness, createLocation, resolveHost, ValidationError } from '../src/tenancy/repo';
import { BASE, TEST_DB_URL, TEST_MIGRATION_DB_URL } from './env';

let db: Db;
const uniq = () => randomUUID().slice(0, 8);

beforeAll(() => { db = createPool(TEST_DB_URL); });
afterAll(async () => { await db.end(); });

describe('миграции', () => {
  it('повторното пускане не прави нищо', async () => {
    expect(await migrate(TEST_MIGRATION_DB_URL)).toEqual([]);
  });

  it('приложението не е собственик и не може да изключи RLS', async () => {
    await expect(withScope(db, { anonymous: true }, (tx) =>
      tx.query('ALTER TABLE locations DISABLE ROW LEVEL SECURITY'))).rejects.toThrow(/owner/);
  });
});

describe('бизнеси, обекти, поддомейни', () => {
  it('създава бизнес с поддомейн; един обект се избира сам', async () => {
    const slug = `hasan-${uniq()}`;
    const b = await createBusiness(db, { slug, name: 'ХасаН мега Дюнер' }, BASE);
    expect(b).toMatchObject({ slug, theme: 'light', defaultLocale: 'bg', status: 'active' });

    const noLoc = await resolveHost(db, `${slug}.${BASE}`);
    expect(noLoc?.business.id).toBe(b.id);
    expect(noLoc?.location).toBeNull();

    const l = await createLocation(db, b.id, { slug: 'center', name: 'Център' }, BASE);
    expect(l).toMatchObject({ qrEnabled: true, kioskEnabled: false, kioskAutoAccept: true,
      qrAutoAccept: false, paymentMode: 'none', orderResetHour: 4, timezone: 'Europe/Sofia' });

    const viaBiz = await resolveHost(db, `${slug.toUpperCase()}.${BASE}:443`);
    expect(viaBiz?.location?.id).toBe(l.id);
  });

  it('хост на обект води до обекта; при няколко обекта бизнес хостът не избира', async () => {
    const slug = `cafe-${uniq()}`;
    const b = await createBusiness(db, { slug, name: 'Сладкарница Ф', theme: 'classic',
      brand: { primary: '#c8102e', background: '#000000' } }, BASE);
    const l1 = await createLocation(db, b.id, { slug: 'mall', name: 'Мол', kioskEnabled: true }, BASE);
    await createLocation(db, b.id, { slug: 'park', name: 'Парк' }, BASE);

    const r = await resolveHost(db, `${slug}--mall.${BASE}`);
    expect(r?.location?.id).toBe(l1.id);
    expect(r?.business.brand).toEqual({ primary: '#c8102e', background: '#000000' });
    expect((await resolveHost(db, `${slug}.${BASE}`))?.location).toBeNull();
  });

  it('непознат хост, спрян бизнес и неактивен обект не се откриват', async () => {
    expect(await resolveHost(db, `nobody.${BASE}`)).toBeNull();

    const slug = `stop-${uniq()}`;
    const b = await createBusiness(db, { slug, name: 'Спрян' }, BASE);
    const l = await createLocation(db, b.id, { slug: 'x', name: 'X' }, BASE);
    await withScope(db, { businessId: b.id }, (tx) =>
      tx.query("UPDATE locations SET status = 'inactive' WHERE id = $1", [l.id]));
    expect(await resolveHost(db, `${slug}--x.${BASE}`)).toBeNull();
    await withScope(db, { platform: true }, (tx) =>
      tx.query("UPDATE businesses SET status = 'suspended' WHERE id = $1", [b.id]));
    expect(await resolveHost(db, `${slug}.${BASE}`)).toBeNull();
  });

  it('проверки на данните', async () => {
    await expect(createBusiness(db, { slug: 'Bad_Slug', name: 'x' }, BASE)).rejects.toBeInstanceOf(ValidationError);
    const slug = `dup-${uniq()}`;
    const b = await createBusiness(db, { slug, name: 'Дубликат' }, BASE);
    await expect(createBusiness(db, { slug, name: 'Пак' }, BASE)).rejects.toThrow(/unique/);
    // QR и киоск не могат да са изключени едновременно.
    await expect(createLocation(db, b.id, { slug: 'none', name: 'Нищо', qrEnabled: false }, BASE))
      .rejects.toThrow(/check/);
    // Само киоск е позволено (QR изключен изцяло).
    const k = await createLocation(db, b.id, { slug: 'kiosk', name: 'Киоск', qrEnabled: false, kioskEnabled: true }, BASE);
    expect(k.qrEnabled).toBe(false);
  });
});

describe('RLS', () => {
  it('бизнесът вижда и променя само своите редове', async () => {
    const a = await createBusiness(db, { slug: `a-${uniq()}`, name: 'А' }, BASE);
    const b = await createBusiness(db, { slug: `b-${uniq()}`, name: 'Б' }, BASE);
    await createLocation(db, a.id, { slug: 'one', name: 'А1' }, BASE);
    const lb = await createLocation(db, b.id, { slug: 'one', name: 'Б1' }, BASE);

    await withScope(db, { businessId: a.id }, async (tx) => {
      const biz = await tx.query('SELECT id FROM businesses');
      expect(biz.rows.map((r) => r.id)).toEqual([a.id]);
      const locs = await tx.query('SELECT business_id FROM locations');
      expect(locs.rows.every((r) => r.business_id === a.id)).toBe(true);
      expect(locs.rowCount).toBe(1);
      // Чуждият ред е невидим и за промяна.
      const upd = await tx.query("UPDATE locations SET name = 'хак' WHERE id = $1", [lb.id]);
      expect(upd.rowCount).toBe(0);
    });

    // Вмъкване с чужд business_id се отказва от RLS.
    await expect(withScope(db, { businessId: a.id }, (tx) =>
      tx.query("INSERT INTO locations (business_id, slug, name) VALUES ($1, 'evil', 'Зло')", [b.id])))
      .rejects.toThrow(/row-level security/);

    // Домейн към чужд бизнес също.
    await expect(withScope(db, { businessId: a.id }, (tx) =>
      tx.query("INSERT INTO domains (business_id, hostname) VALUES ($1, 'evil.example.test')", [b.id])))
      .rejects.toThrow(/row-level security/);
  });

  it('без контекст не се вижда нищо освен хостовете', async () => {
    await withScope(db, { anonymous: true }, async (tx) => {
      expect((await tx.query('SELECT 1 FROM businesses')).rowCount).toBe(0);
      expect((await tx.query('SELECT 1 FROM locations')).rowCount).toBe(0);
      expect((await tx.query('SELECT 1 FROM domains')).rowCount).toBeGreaterThan(0);
      expect((await tx.query('DELETE FROM domains')).rowCount).toBe(0);
    });
  });

  it('контекстът не изтича към следващата транзакция на същата връзка', async () => {
    const single = createPool(TEST_DB_URL);
    single.options.max = 1;
    const a = await createBusiness(db, { slug: `leak-${uniq()}`, name: 'Теч' }, BASE);
    await withScope(single, { businessId: a.id }, async () => {});
    const n = await withScope(single, { anonymous: true }, (tx) => tx.query('SELECT 1 FROM businesses'));
    expect(n.rowCount).toBe(0);
    await single.end();
  });
});
