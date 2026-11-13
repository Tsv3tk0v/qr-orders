import { BUSINESS_ROLES, type BusinessRole, type Role } from '@qr/shared';
import { withScope, type Db, type Scope, type Tx } from '../db/pool';
import {
  decrypt, DUMMY_PASSWORD_HASH, encrypt, hashPassword, MIN_PASSWORD_LENGTH, newToken, newTotpSecret,
  otpauthUrl, sha256, verifyPassword, verifyTotp,
} from './crypto';

/** Къде е входът: админ на платформата или на конкретен бизнес. */
export type Realm = { kind: 'platform' } | { kind: 'business'; businessId: string };

export const scopeOf = (realm: Realm): Scope =>
  realm.kind === 'platform' ? { platform: true } : { businessId: realm.businessId };
const realmBusinessId = (realm: Realm): string | null =>
  realm.kind === 'platform' ? null : realm.businessId;

export const LIMITS = {
  maxFailedLogins: 5,
  lockMinutes: 15,
  pendingSessionMinutes: 10,
  sessionHours: 12,
  idleMinutes: 120,
};

export class AuthError extends Error {
  constructor(public code: string, public status = 401) { super(code); }
}

export interface Meta { ip?: string; userAgent?: string }

export interface SessionUser {
  sessionId: string;
  stage: 'enroll_2fa' | 'verify_2fa' | 'active';
  user: { id: string; businessId: string | null; email: string; name: string; role: Role };
}

// --- Журнал ----------------------------------------------------------------
export interface AuditEntry {
  action: string;
  actorId?: string | null;
  targetType?: string;
  targetId?: string;
  data?: Record<string, unknown>;
  ip?: string;
}

export async function audit(tx: Tx, businessId: string | null, e: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (business_id, actor_id, action, target_type, target_id, data, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [businessId, e.actorId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.data ?? {}, e.ip ?? null],
  );
}

// --- Вход ------------------------------------------------------------------
interface UserRow {
  id: string; businessId: string | null; email: string; name: string; role: Role;
  passwordHash: string; totpSecretEnc: string | null; totpEnabled: boolean; totpLastStep: string | null;
  failedLogins: number; lockedUntil: Date | null; active: boolean;
}
const USER_COLS = `id, business_id AS "businessId", email, name, role, password_hash AS "passwordHash",
  totp_secret_enc AS "totpSecretEnc", totp_enabled AS "totpEnabled", totp_last_step AS "totpLastStep",
  failed_logins AS "failedLogins", locked_until AS "lockedUntil", active`;

async function findUserByEmail(tx: Tx, realm: Realm, email: string): Promise<UserRow | undefined> {
  const { rows } = await tx.query<UserRow>(
    `SELECT ${USER_COLS} FROM users WHERE business_id IS NOT DISTINCT FROM $1 AND email = $2 FOR UPDATE`,
    [realmBusinessId(realm), email.trim().toLowerCase()],
  );
  return rows[0];
}

async function registerFailure(tx: Tx, user: UserRow, realm: Realm, reason: string, meta: Meta) {
  const failed = user.failedLogins + 1;
  const lock = failed >= LIMITS.maxFailedLogins;
  await tx.query(
    `UPDATE users SET failed_logins = $2,
       locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END
     WHERE id = $1`,
    [user.id, lock ? 0 : failed, lock, LIMITS.lockMinutes],
  );
  await audit(tx, realmBusinessId(realm), {
    action: lock ? 'auth.locked' : 'auth.failed', actorId: user.id, data: { reason }, ip: meta.ip,
  });
}

const isLocked = (u: UserRow) => u.lockedUntil !== null && u.lockedUntil > new Date();

export interface LoginResult { token: string; stage: SessionUser['stage'] }
type Outcome = LoginResult | { error: string };

/** Стъпка 1: имейл и парола. Създава сесия, която още чака 2FA. */
export async function login(db: Db, realm: Realm, email: string, password: string, meta: Meta): Promise<LoginResult> {
  // Грешките при вход трябва да се запишат, затова не хвърляме в транзакцията.
  const outcome = await withScope(db, scopeOf(realm), async (tx): Promise<Outcome> => {
    const user = await findUserByEmail(tx, realm, email);
    const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !user.active) return { error: 'invalid_credentials' }
    if (isLocked(user)) return { error: 'locked' }
    if (!ok) {
      await registerFailure(tx, user, realm, 'password', meta);
      return { error: 'invalid_credentials' }
    }
    const stage = user.totpEnabled ? 'verify_2fa' : 'enroll_2fa';
    const token = await createSession(tx, realm, user.id, stage, meta);
    return { token, stage }
  });
  if ('error' in outcome) throw new AuthError(outcome.error, outcome.error === 'locked' ? 423 : 401);
  return outcome;
}

async function createSession(tx: Tx, realm: Realm, userId: string, stage: SessionUser['stage'], meta: Meta) {
  const token = newToken();
  const minutes = stage === 'active' ? LIMITS.sessionHours * 60 : LIMITS.pendingSessionMinutes;
  await tx.query(
    `INSERT INTO sessions (business_id, user_id, token_hash, stage, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6, $7)`,
    [realmBusinessId(realm), userId, sha256(token), stage, minutes, meta.ip ?? null, meta.userAgent ?? null],
  );
  return token;
}

/** Сесията по бисквитката, само в този realm (бисквитка от друг бизнес не важи). */
export async function getSession(db: Db, realm: Realm, token: string): Promise<SessionUser | null> {
  return withScope(db, scopeOf(realm), async (tx) => {
    const { rows } = await tx.query<SessionUser['user'] & { sessionId: string; stage: SessionUser['stage']; stale: boolean }>(
      `SELECT s.id AS "sessionId", s.stage, u.id, u.business_id AS "businessId", u.email, u.name, u.role,
              s.last_seen_at < now() - interval '5 minutes' AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.business_id IS NOT DISTINCT FROM $2 AND u.active
         AND s.expires_at > now() AND s.last_seen_at > now() - make_interval(mins => $3)`,
      [sha256(token), realmBusinessId(realm), LIMITS.idleMinutes],
    );
    const r = rows[0];
    if (!r) return null;
    if (r.stale) await tx.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.sessionId]);
    return {
      sessionId: r.sessionId, stage: r.stage,
      user: { id: r.id, businessId: r.businessId, email: r.email, name: r.name, role: r.role },
    };
  });
}

export async function logout(db: Db, realm: Realm, s: SessionUser, meta: Meta): Promise<void> {
  await withScope(db, scopeOf(realm), async (tx) => {
    await tx.query('DELETE FROM sessions WHERE id = $1', [s.sessionId]);
    await audit(tx, realmBusinessId(realm), { action: 'auth.logout', actorId: s.user.id, ip: meta.ip });
  });
}

// --- 2FA -------------------------------------------------------------------
export const TOTP_ISSUER = 'QR поръчки';

/** Генерира нова тайна (още не е включена) и връща данните за QR кода. */
export async function startEnrollment(db: Db, realm: Realm, s: SessionUser, key: Buffer) {
  if (s.stage !== 'enroll_2fa') throw new AuthError('wrong_stage', 409);
  const secret = newTotpSecret();
  await withScope(db, scopeOf(realm), (tx) =>
    tx.query('UPDATE users SET totp_secret_enc = $2 WHERE id = $1 AND NOT totp_enabled',
      [s.user.id, encrypt(secret, key)]));
  return { secret, otpauthUrl: otpauthUrl(secret, s.user.email, TOTP_ISSUER) };
}

/**
 * Проверява код от приложението. При enroll_2fa включва 2FA, при verify_2fa
 * завършва входа. И в двата случая издава нова бисквитка (старата спира да важи).
 */
export async function completeSecondFactor(
  db: Db, realm: Realm, s: SessionUser, code: string, key: Buffer, meta: Meta,
): Promise<LoginResult> {
  if (s.stage === 'active') throw new AuthError('wrong_stage', 409);
  const outcome = await withScope(db, scopeOf(realm), async (tx): Promise<Outcome> => {
    const { rows } = await tx.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1 FOR UPDATE`, [s.user.id]);
    const user = rows[0];
    if (!user || !user.active) return { error: 'invalid_credentials' }
    if (isLocked(user)) return { error: 'locked' }
    if (!user.totpSecretEnc) return { error: 'enrollment_not_started' }
    const enrolling = s.stage === 'enroll_2fa';
    if (enrolling === user.totpEnabled) return { error: 'wrong_stage' }

    const step = verifyTotp(decrypt(user.totpSecretEnc, key), code.trim(),
      user.totpLastStep === null ? null : Number(user.totpLastStep));
    if (step === null) {
      await registerFailure(tx, user, realm, 'totp', meta);
      return { error: 'invalid_code' }
    }
    await tx.query(
      `UPDATE users SET totp_enabled = true, totp_last_step = $2, failed_logins = 0, locked_until = NULL
       WHERE id = $1`, [user.id, step]);
    await tx.query('DELETE FROM sessions WHERE id = $1', [s.sessionId]);
    const token = await createSession(tx, realm, user.id, 'active', meta);
    const bid = realmBusinessId(realm);
    if (enrolling) await audit(tx, bid, { action: 'auth.2fa_enabled', actorId: user.id, ip: meta.ip });
    await audit(tx, bid, { action: 'auth.login', actorId: user.id, ip: meta.ip });
    return { token, stage: 'active' }
  });
  if ('error' in outcome) {
    const status = outcome.error === 'locked' ? 423 : outcome.error === 'invalid_code' ? 401 : 409;
    throw new AuthError(outcome.error, status);
  }
  return outcome;
}

export async function changePassword(
  db: Db, realm: Realm, s: SessionUser, current: string, next: string, meta: Meta,
): Promise<void> {
  if (next.length < MIN_PASSWORD_LENGTH) throw new AuthError('weak_password', 400);
  const hash = await hashPassword(next);
  const ok = await withScope(db, scopeOf(realm), async (tx) => {
    const { rows } = await tx.query<UserRow>(`SELECT ${USER_COLS} FROM users WHERE id = $1 FOR UPDATE`, [s.user.id]);
    if (!rows[0] || !(await verifyPassword(current, rows[0].passwordHash))) return false;
    await tx.query('UPDATE users SET password_hash = $2 WHERE id = $1', [s.user.id, hash]);
    // Другите сесии на потребителя спират да важат.
    await tx.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [s.user.id, s.sessionId]);
    await audit(tx, realmBusinessId(realm), { action: 'auth.password_changed', actorId: s.user.id, ip: meta.ip });
    return true;
  });
  if (!ok) throw new AuthError('invalid_credentials', 401);
}

// --- Потребители на бизнеса ------------------------------------------------
export interface PublicUser {
  id: string; email: string; name: string; role: Role; active: boolean; totpEnabled: boolean;
}
const PUBLIC_USER_COLS = `id, email, name, role, active, totp_enabled AS "totpEnabled"`;

export interface NewUser { email: string; name?: string; role: Role; password: string }

export async function insertUser(tx: Tx, businessId: string | null, input: NewUser): Promise<PublicUser> {
  if (businessId === null ? input.role !== 'platform_admin' : !BUSINESS_ROLES.includes(input.role as BusinessRole)) {
    throw new AuthError('invalid_role', 400);
  }
  if (input.password.length < MIN_PASSWORD_LENGTH) throw new AuthError('weak_password', 400);
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new AuthError('invalid_email', 400);
  try {
    const { rows } = await tx.query<PublicUser>(
      `INSERT INTO users (business_id, email, name, role, password_hash)
       VALUES ($1, $2, $3, $4, $5) RETURNING ${PUBLIC_USER_COLS}`,
      [businessId, email, input.name ?? '', input.role, await hashPassword(input.password)],
    );
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new AuthError('email_taken', 409);
    throw err;
  }
}

export async function listUsers(tx: Tx, businessId: string | null): Promise<PublicUser[]> {
  const { rows } = await tx.query<PublicUser>(
    `SELECT ${PUBLIC_USER_COLS} FROM users WHERE business_id IS NOT DISTINCT FROM $1 ORDER BY email`, [businessId]);
  return rows;
}

export interface UserChange { role?: Role; active?: boolean; reset2fa?: boolean; password?: string }

/**
 * Промяна от собственик: роля, активност, нулиране на 2FA.
 * Собственикът не може да промени себе си — така бизнесът винаги има собственик.
 */
export async function updateUser(
  tx: Tx, businessId: string, actorId: string, userId: string, change: UserChange, meta: Meta,
): Promise<PublicUser> {
  if (userId === actorId) throw new AuthError('cannot_change_self', 409);
  if (change.role && !BUSINESS_ROLES.includes(change.role as BusinessRole)) throw new AuthError('invalid_role', 400);
  if (change.password !== undefined && change.password.length < MIN_PASSWORD_LENGTH) throw new AuthError('weak_password', 400);
  const newHash = change.password ? await hashPassword(change.password) : null;
  const { rows } = await tx.query<PublicUser>(
    `UPDATE users SET role = coalesce($3, role), active = coalesce($4, active),
       totp_enabled = CASE WHEN $5 THEN false ELSE totp_enabled END,
       totp_secret_enc = CASE WHEN $5 THEN NULL ELSE totp_secret_enc END,
       totp_last_step = CASE WHEN $5 THEN NULL ELSE totp_last_step END,
       password_hash = coalesce($6, password_hash),
       failed_logins = CASE WHEN $6 IS NULL THEN failed_logins ELSE 0 END,
       locked_until = CASE WHEN $6 IS NULL THEN locked_until ELSE NULL END
     WHERE id = $2 AND business_id = $1 RETURNING ${PUBLIC_USER_COLS}`,
    [businessId, userId, change.role ?? null, change.active ?? null, change.reset2fa ?? false, newHash],
  );
  const user = rows[0];
  if (!user) throw new AuthError('not_found', 404);
  // Всяка промяна на права или 2FA изхвърля потребителя от всички сесии.
  await tx.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  await audit(tx, businessId, {
    action: 'user.updated', actorId, targetType: 'user', targetId: userId,
    data: { ...change, password: change.password ? '***' : undefined }, ip: meta.ip,
  });
  return user;
}

export interface AuditRow {
  id: string; actorId: string | null; actorEmail: string | null; action: string;
  targetType: string | null; targetId: string | null; data: Record<string, unknown>; ip: string | null; createdAt: Date;
}

export async function listAudit(tx: Tx, businessId: string | null, limit = 100, beforeId?: string): Promise<AuditRow[]> {
  const { rows } = await tx.query<AuditRow>(
    `SELECT a.id, a.actor_id AS "actorId", u.email AS "actorEmail", a.action, a.target_type AS "targetType",
            a.target_id AS "targetId", a.data, host(a.ip) AS ip, a.created_at AS "createdAt"
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.business_id IS NOT DISTINCT FROM $1 AND ($3::bigint IS NULL OR a.id < $3)
     ORDER BY a.id DESC LIMIT $2`,
    [businessId, Math.min(Math.max(limit, 1), 500), beforeId ?? null],
  );
  return rows;
}

/**
 * Нов достъп: създава потребителя или му задава нова парола, нулира 2FA, отключва и активира.
 * Ползва се от админа на платформата (собственик на бизнес) и от командата qr reset-admin.
 */
export async function resetAccess(tx: Tx, businessId: string | null, email: string, password: string,
  role: Role): Promise<PublicUser> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new AuthError('weak_password', 400);
  const e = email.trim().toLowerCase();
  const { rows } = await tx.query<PublicUser>(
    `UPDATE users SET password_hash = $3, totp_enabled = false, totp_secret_enc = NULL, totp_last_step = NULL,
       failed_logins = 0, locked_until = NULL, active = true, role = $4
     WHERE business_id IS NOT DISTINCT FROM $1 AND email = $2 RETURNING ${PUBLIC_USER_COLS}`,
    [businessId, e, await hashPassword(password), role]);
  if (rows[0]) {
    await tx.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]);
    return rows[0];
  }
  return insertUser(tx, businessId, { email: e, role, password });
}
