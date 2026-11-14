import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withScope, type Db } from '../../db/pool';
import { runImport, type ImportRun } from './apply';

/**
 * SFTP импорт (реш. 12, 20). Сървърът (напр. OpenSSH с chroot) дава на всеки бизнес
 * папка <root>/<slug>/ с подпапки import/, history/ и errors/. Тук само обхождаме:
 * файл от import/ се импортира и се мести в history/ (успех) или errors/ (с отчет).
 */
export const SFTP_DIRS = ['import', 'history', 'errors'] as const;

/** Файл, променян в последните секунди, може още да се качва — пропуска се. */
const SETTLE_MS = 30_000;

export interface FolderResult { slug: string; filename: string; run: ImportRun }

export async function ensureBusinessFolders(root: string, slug: string): Promise<void> {
  for (const d of SFTP_DIRS) await mkdir(join(root, slug, d), { recursive: true });
}

export async function processSftpFolders(db: Db, root: string, now = Date.now()): Promise<FolderResult[]> {
  const businesses = await withScope(db, { platform: true }, async (tx) =>
    (await tx.query<{ id: string; slug: string }>(
      `SELECT b.id, b.slug FROM businesses b JOIN import_settings s ON s.business_id = b.id
       WHERE s.sftp_enabled AND b.status = 'active' ORDER BY b.slug`)).rows);

  const results: FolderResult[] = [];
  for (const b of businesses) {
    const dir = join(root, b.slug);
    // Папките се създават от „qr sftp-add“ (с права за chroot); без тях бизнесът се пропуска.
    if (!(await stat(join(dir, 'import')).catch(() => null))?.isDirectory()) continue;
    const files = [];
    for (const name of await readdir(join(dir, 'import'))) {
      if (!/\.(csv|xlsx)$/i.test(name) || name.startsWith('.')) continue;
      const st = await stat(join(dir, 'import', name));
      if (st.isFile() && now - st.mtimeMs >= SETTLE_MS) files.push({ name, mtime: st.mtimeMs });
    }
    files.sort((a, b) => a.mtime - b.mtime);

    for (const f of files) {
      const src = join(dir, 'import', f.name);
      const content = await readFile(src);
      const run = await withScope(db, { businessId: b.id }, (tx) =>
        runImport(tx, { businessId: b.id, source: 'sftp', filename: f.name, content }));
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      const ok = run.status === 'success' || run.status === 'with_errors';
      const target = join(dir, ok ? 'history' : 'errors', `${stamp}_${f.name}`);
      await rename(src, target);
      if (run.errors.length) {
        await writeFile(`${join(dir, 'errors', `${stamp}_${f.name}`)}.report.txt`, errorReport(run), 'utf8');
      }
      results.push({ slug: b.slug, filename: f.name, run });
    }
  }
  return results;
}

/** Отчет за грешките на български — четат го хора, не програми. */
export function errorReport(run: ImportRun): string {
  const labels: Record<string, string> = {
    bad_code: 'кодът не е 6 цифри', duplicate_code: 'кодът се повтаря', missing_name: 'липсва наименование',
    bad_price: 'невалидна цена', missing_column: 'липсва колона', no_rows: 'файлът няма редове',
    empty_file: 'празен файл', bad_xlsx: 'повреден XLSX', unsupported_format: 'непознат формат',
    bad_encoding: 'грешно кодиране', too_many_rows: 'твърде много редове', file_too_large: 'файлът е твърде голям',
  };
  const head = `Импорт ${run.filename}: ${run.status}. Редове: ${run.rowsTotal}, нови: ${run.created}, `
    + `обновени: ${run.updated}, грешки: ${run.errorCount}.`;
  const lines = run.errors.map((e) =>
    `ред ${e.row}: ${labels[e.code] ?? e.code}${e.value ? ` („${e.value}“)` : ''}`);
  return [head, ...lines].join('\n') + '\n';
}
