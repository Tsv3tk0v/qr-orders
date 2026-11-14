import { PGlite, types } from '@electric-sql/pglite';
import type pg from 'pg';

/**
 * Вграден PostgreSQL (PGlite = истинският PostgreSQL като WebAssembly) за работа без отделен
 * сървър с база — напр. вътре в Android таблет. Адрес: `pglite:///път/до/папка?user=qr_app`
 * (без път — в паметта). Изглежда като `pg.Pool`, за да не се променя останалият код.
 * Има една връзка, затова транзакциите вървят една след друга (опашка).
 */

interface Instance { db: PGlite; refs: number; queue: Promise<void>; ready: Promise<void> }
const instances = new Map<string, Instance>();

export const isPgliteUrl = (url: string) => url.startsWith('pglite:');

const OWNERS = new Set(['qr', 'postgres', '']);

function hexToBuffer(v: string): Buffer {
  return v.startsWith('\\x') ? Buffer.from(v.slice(2), 'hex') : Buffer.from(v, 'binary');
}

function open(dataDir: string): Instance {
  let inst = instances.get(dataDir);
  if (!inst) {
    const db = new PGlite(dataDir || undefined, {
      // Същите типове като драйвера pg: int8/numeric като текст, bytea като Buffer.
      parsers: {
        [types.INT8]: (v: string) => v,
        [types.NUMERIC]: (v: string) => v,
        [types.BYTEA]: (v: string) => hexToBuffer(v),
      },
    });
    const ready = db.exec(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qr') THEN CREATE ROLE qr; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'qr_app') THEN CREATE ROLE qr_app NOBYPASSRLS; END IF;
      END $$;`).then(() => undefined);
    inst = { db, refs: 0, queue: Promise.resolve(), ready };
    instances.set(dataDir, inst);
  }
  inst.refs++;
  return inst;
}

type Params = unknown[] | undefined;

function toPgParams(params: Params): unknown[] {
  // pg приема обекти за json; PGlite иска текст за параметри с неизвестен тип.
  return (params ?? []).map((p) =>
    p !== null && typeof p === 'object' && !Buffer.isBuffer(p) && !(p instanceof Date) && !Array.isArray(p)
      ? JSON.stringify(p) : p);
}

async function run(db: PGlite, text: string, params: Params) {
  if (!params || params.length === 0) {
    const results = await db.exec(text);
    const last = results[results.length - 1] ?? { rows: [], affectedRows: 0 };
    return { rows: last.rows, rowCount: Math.max(last.affectedRows ?? 0, last.rows.length) };
  }
  const r = await db.query(text, toPgParams(params));
  return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
}

class LiteClient {
  private released = false;
  constructor(private inst: Instance, private role: string, private unlock: () => void) {}
  query(textOrConfig: string | { text: string; values?: unknown[] }, values?: unknown[]) {
    const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
    return run(this.inst.db, text, typeof textOrConfig === 'string' ? values : textOrConfig.values);
  }
  release() {
    if (this.released) return;
    this.released = true;
    this.unlock();
  }
  get roleName() { return this.role; }
}

export class LitePool {
  private inst: Instance;
  private role: string;
  private ended = false;
  options = { max: 1 };

  constructor(url: string) {
    const u = new URL(url);
    this.inst = open(decodeURIComponent(u.pathname === '/' ? '' : u.pathname));
    this.role = u.searchParams.get('user') ?? u.username ?? '';
  }

  /** Взима единствената връзка; следващият чака release(). */
  async connect(): Promise<LiteClient> {
    await this.inst.ready;
    let unlock!: () => void;
    const prev = this.inst.queue;
    this.inst.queue = new Promise<void>((r) => { unlock = r; });
    await prev;
    const setRole = OWNERS.has(this.role) ? 'RESET ROLE' : `SET ROLE ${this.role.replace(/[^a-z_]/g, '')}`;
    await this.inst.db.exec(`${setRole}; RESET app.business_id; RESET app.scope;`);
    return new LiteClient(this.inst, this.role, unlock);
  }

  async query(text: string, params?: unknown[]) {
    const c = await this.connect();
    try { return await c.query(text, params); } finally { c.release(); }
  }

  async end() {
    if (this.ended) return;
    this.ended = true;
    this.inst.refs--;
    if (this.inst.refs <= 0) {
      for (const [k, v] of instances) if (v === this.inst) instances.delete(k);
      await this.inst.queue;
      await this.inst.db.close();
    }
  }

  on() { return this; }
}

/** Пул за pglite: адреси, видян от останалия код като pg.Pool. */
export function createLitePool(url: string): pg.Pool {
  return new LitePool(url) as unknown as pg.Pool;
}
