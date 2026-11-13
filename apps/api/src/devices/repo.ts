import { randomInt } from 'node:crypto';
import type { DeviceKind } from '@qr/shared';
import type { Tx } from '../db/pool';
import { newToken, sha256 } from '../auth/crypto';

export const PAIRING_MINUTES = 15;

export interface Device {
  id: string; locationId: string; kind: DeviceKind; name: string;
  pairedAt: Date | null; lastSeenAt: Date | null; revokedAt: Date | null; pairingExpiresAt: Date | null;
}
const COLS = `id, location_id AS "locationId", kind, name, paired_at AS "pairedAt", last_seen_at AS "lastSeenAt",
  revoked_at AS "revokedAt", pairing_expires_at AS "pairingExpiresAt"`;

const codeHash = (businessId: string, code: string) => sha256(`pair:${businessId}:${code}`);

export async function listDevices(tx: Tx): Promise<Device[]> {
  return (await tx.query<Device>(`SELECT ${COLS} FROM devices ORDER BY created_at`)).rows;
}

/** Ново устройство + 6-цифрен код за сдвояване (важи 15 мин). */
export async function createDevice(
  tx: Tx, businessId: string, input: { locationId: string; kind: DeviceKind; name: string },
): Promise<{ device: Device; pairingCode: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO devices (business_id, location_id, kind, name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [businessId, input.locationId, input.kind, input.name.trim()]);
  return newPairingCode(tx, businessId, rows[0]!.id);
}

/** Нов код (напр. смяна на таблета). Старият токен спира да важи. */
export async function newPairingCode(tx: Tx, businessId: string, deviceId: string) {
  for (;;) {
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    const clash = await tx.query(`SELECT 1 FROM devices WHERE pairing_code_hash = $1 AND pairing_expires_at > now()`,
      [codeHash(businessId, code)]);
    if (clash.rows.length) continue;
    const { rows } = await tx.query<Device>(
      `UPDATE devices SET pairing_code_hash = $2, pairing_expires_at = now() + make_interval(mins => $3),
         token_hash = NULL, revoked_at = NULL, paired_at = NULL
       WHERE id = $1 RETURNING ${COLS}`, [deviceId, codeHash(businessId, code), PAIRING_MINUTES]);
    if (!rows[0]) throw new Error('not_found');
    return { device: rows[0], pairingCode: code };
  }
}

/** Устройството въвежда кода → получава дълъг токен (в бисквитка). */
export async function pairDevice(tx: Tx, businessId: string, code: string, locationId: string | null) {
  const token = newToken();
  const { rows } = await tx.query<Device>(
    `UPDATE devices SET token_hash = $2, pairing_code_hash = NULL, pairing_expires_at = NULL,
       paired_at = now(), last_seen_at = now()
     WHERE pairing_code_hash = $1 AND pairing_expires_at > now() AND revoked_at IS NULL
       AND ($3::uuid IS NULL OR location_id = $3)
     RETURNING ${COLS}`, [codeHash(businessId, code), sha256(token), locationId]);
  return rows[0] ? { device: rows[0], token } : null;
}

export async function deviceByToken(tx: Tx, token: string): Promise<Device | null> {
  const { rows } = await tx.query<Device & { stale: boolean }>(
    `SELECT ${COLS}, last_seen_at < now() - interval '1 minute' AS stale FROM devices
     WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
  const d = rows[0];
  if (!d) return null;
  if (d.stale) await tx.query('UPDATE devices SET last_seen_at = now() WHERE id = $1', [d.id]);
  return d;
}

export async function revokeDevice(tx: Tx, id: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE devices SET revoked_at = now(), token_hash = NULL, pairing_code_hash = NULL WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}
