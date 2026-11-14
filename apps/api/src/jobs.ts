import { formatPrice, pickText, type I18nText } from '@qr/shared';
import { withScope, type Db } from './db/pool';
import type { Mailer } from './mail';
import { locationChannel, publish } from './orders/events';
import { reportSummary } from './http/routes/ops';
import { processSftpFolders, errorReport } from './menu/import/sftp';

export const JOB_LIMITS = {
  autoCollectMinutes: 60,   // „Готова“, но невзета → затваря се като взета
  pendingTimeoutMinutes: 30, // неприета QR поръчка → отказана, за да не държи номер
  retentionDays: 30,        // реш. 7
};

/** Всяка минута: затваря забравени поръчки, чисти изтекли сесии. */
export async function sweep(db: Db): Promise<number> {
  const locs = await withScope(db, { platform: true }, async (tx) => {
    const { rows } = await tx.query<{ locationId: string }>(
      `UPDATE orders SET
         status = CASE WHEN status = 'ready' THEN 'collected' ELSE 'rejected' END, closed_at = now()
       WHERE (status = 'ready' AND ready_at < now() - make_interval(mins => $1))
          OR (status = 'pending' AND created_at < now() - make_interval(mins => $2))
       RETURNING location_id AS "locationId"`, [JOB_LIMITS.autoCollectMinutes, JOB_LIMITS.pendingTimeoutMinutes]);
    await tx.query(`DELETE FROM customer_sessions WHERE expires_at < now() - interval '1 day'
                    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.session_id = customer_sessions.id)`);
    return [...new Set(rows.map((r) => r.locationId))];
  });
  for (const l of locs) publish(locationChannel(l));
  return locs.length;
}

/** Веднъж на ден: личните следи се пазят 30 дни (реш. 7). */
export async function purge(db: Db): Promise<void> {
  await withScope(db, { platform: true }, async (tx) => {
    const d = JOB_LIMITS.retentionDays;
    await tx.query(`UPDATE orders SET customer_hash = NULL
                    WHERE customer_hash IS NOT NULL AND created_at < now() - make_interval(days => $1)`, [d]);
    await tx.query(`DELETE FROM customer_marks WHERE (blocked_until IS NULL OR blocked_until < now())
                    AND greatest(last_order_at, last_no_show_at) < now() - make_interval(days => $1)`, [d]);
    await tx.query(`DELETE FROM customer_sessions WHERE expires_at < now() - make_interval(days => $1)`, [d]);
  });
}

const sofia = (d = new Date()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
};

/** Работният ден започва в 04:00 (реш. 6), затова отчетът „живее“ в часовник, изместен с 4 часа. */
export const DAY_START_HOUR = 4;

/**
 * Дневен имейл до собствениците в избрания час (по София) за текущия работен ден.
 * Пример: час 22 → праща се между 22:00 и 03:59 за деня, започнал в 04:00.
 */
export async function dailyEmails(db: Db, mailer: Mailer, now = new Date()): Promise<number> {
  const { date, hour } = sofia(new Date(now.getTime() - DAY_START_HOUR * 3_600_000));
  const due = await withScope(db, { platform: true }, async (tx) => (await tx.query<{ id: string; name: string }>(
    `SELECT b.id, b.name FROM businesses b
     WHERE b.status = 'active' AND b.daily_email AND (b.daily_email_hour + 24 - $3) % 24 <= $1
       AND NOT EXISTS (SELECT 1 FROM daily_reports r WHERE r.business_id = b.id AND r.day = $2)`,
    [hour, date, DAY_START_HOUR])).rows);
  let sent = 0;
  for (const b of due) {
    await withScope(db, { businessId: b.id }, async (tx) => {
      const claimed = await tx.query(
        `INSERT INTO daily_reports (business_id, day) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [b.id, date]);
      if (!claimed.rowCount) return;
      const to = (await tx.query<{ email: string }>(
        `SELECT email FROM users WHERE business_id = $1 AND role = 'owner' AND active`, [b.id])).rows.map((r) => r.email);
      const r = await reportSummary(tx, date, date, null);
      const day = r.days[0] as Record<string, number> | undefined;
      const lines = [
        `${b.name} — отчет за ${date}`, '',
        `Поръчки: ${day?.orders ?? 0} (от киоск: ${day?.kiosk ?? 0})`,
        `Взети: ${day?.collected ?? 0}`,
        `Неявили се: ${day?.noShows ?? 0}`,
        `Отказани: ${day?.cancelled ?? 0}`,
        `Оборот (взети поръчки): ${formatPrice(day?.revenueCents ?? 0)}`,
        `Средно време за приготвяне: ${day?.avgPrepMinutes ?? '—'} мин`, '',
        'Най-продавани:',
        ...(r.topItems as { name: I18nText; qty: number }[]).map((t) => `  ${t.qty} × ${pickText(t.name, 'bg')}`),
        '', 'Това е автоматично съобщение от системата за поръчки.',
      ];
      await mailer.send(to, `Дневен отчет — ${b.name} — ${date}`, lines.join('\n'));
      sent++;
    });
  }
  return sent;
}

/** SFTP импорт + имейл при грешка. */
export async function sftpImport(db: Db, root: string, mailer: Mailer): Promise<void> {
  for (const r of await processSftpFolders(db, root)) {
    if (!r.run.errors.length) continue;
    await withScope(db, { platform: true }, async (tx) => {
      const notify = (await tx.query(`SELECT notify_on_error FROM import_settings WHERE business_id =
        (SELECT id FROM businesses WHERE slug = $1)`, [r.slug])).rows[0]?.notify_on_error;
      if (!notify) return;
      const to = (await tx.query<{ email: string }>(
        `SELECT u.email FROM users u JOIN businesses b ON b.id = u.business_id
         WHERE b.slug = $1 AND u.role IN ('owner', 'manager') AND u.active`, [r.slug])).rows.map((x) => x.email);
      await mailer.send(to, `Импорт на артикули: ${r.run.status} — ${r.filename}`, errorReport(r.run));
    });
  }
}

export interface JobOptions { importRoot?: string; importIntervalMin: number; importHours: [number, number] }

/** Пуска всички фонови задачи в същия процес (по-проста инсталация). */
export function startJobs(db: Db, mailer: Mailer, opt: JobOptions, log: (m: string, e?: unknown) => void) {
  const safe = (name: string, fn: () => Promise<unknown>) => () => fn().catch((e) => log(`Грешка в ${name}`, e));
  const timers = [
    setInterval(safe('sweep', () => sweep(db)), 60_000),
    setInterval(safe('daily-email', () => dailyEmails(db, mailer)), 5 * 60_000),
    setInterval(safe('purge', () => purge(db)), 6 * 60 * 60_000),
  ];
  if (opt.importRoot) {
    const root = opt.importRoot;
    timers.push(setInterval(safe('sftp', async () => {
      const h = sofia().hour;
      if (h >= opt.importHours[0] && h < opt.importHours[1]) await sftpImport(db, root, mailer);
    }), opt.importIntervalMin * 60_000));
  }
  void safe('purge', () => purge(db))();
  return () => timers.forEach(clearInterval);
}
