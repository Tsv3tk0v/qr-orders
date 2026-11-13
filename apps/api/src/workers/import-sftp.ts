// Обхожда SFTP папките на интервал. Пуска се като отделен процес:
//   IMPORT_ROOT=/srv/sftp pnpm --filter @qr/api worker:import
import { env } from '../config';
import { createPool } from '../db/pool';
import { processSftpFolders } from '../menu/import/sftp';

const root = process.env.IMPORT_ROOT;
if (!root) throw new Error('Липсва IMPORT_ROOT');
const intervalMin = Number(process.env.IMPORT_INTERVAL_MIN ?? 15);
const [fromH, toH] = (process.env.IMPORT_HOURS ?? '06-22').split('-').map(Number) as [number, number];

/** Час в София, независимо от часовата зона на сървъра. */
function sofiaHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', hour: '2-digit', hour12: false })
    .format(d)) % 24;
}

const db = createPool(env.databaseUrl);
async function tick() {
  const h = sofiaHour();
  if (h < fromH || h >= toH) return;
  try {
    for (const r of await processSftpFolders(db, root!)) {
      console.log(`${r.slug}/${r.filename}: ${r.run.status} (+${r.run.created} ~${r.run.updated} !${r.run.errorCount})`);
    }
  } catch (err) {
    console.error('Грешка при SFTP импорт:', err);
  }
}
await tick();
setInterval(tick, intervalMin * 60_000);
