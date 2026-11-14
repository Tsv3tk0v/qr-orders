import type { FastifyInstance, FastifyRequest } from 'fastify';
import { can } from '@qr/shared';
import { withScope } from '../../db/pool';
import { AuthError, audit } from '../../auth/service';
import { requireAuth } from '../app';

export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Проверка по съдържанието, не само по заглавката (SVG не се приема — може да съдържа скриптове). */
export function sniffImage(b: Buffer): (typeof TYPES)[number] | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Качване (админ) и показване (публично) на снимки и лога. */
export async function mediaRoutes(app: FastifyInstance) {
  const { db } = app.deps;
  const bid = (req: FastifyRequest) => {
    if (req.tenant.kind !== 'business') throw new AuthError('not_found', 404);
    return req.tenant.business.id;
  };
  app.addContentTypeParser([...TYPES], { parseAs: 'buffer', bodyLimit: MAX_MEDIA_BYTES },
    (_req, body, done) => done(null, body));

  app.post<{ Body: Buffer }>('/api/admin/media', { preHandler: requireAuth() }, async (req, reply) => {
    const role = req.session!.user.role;
    if (!can(role, 'menu.manage') && !can(role, 'settings.manage')) throw new AuthError('forbidden', 403);
    if (!Buffer.isBuffer(req.body)) throw new AuthError('unsupported_media_type', 415);
    const type = sniffImage(req.body);
    if (!type) throw new AuthError('unsupported_image', 400);
    const id = await withScope(db, { businessId: bid(req) }, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO media (business_id, content_type, bytes, size, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [bid(req), type, req.body, req.body.length, req.session!.user.id]);
      await audit(tx, bid(req), { action: 'media.uploaded', actorId: req.session!.user.id, targetType: 'media',
        targetId: rows[0]!.id, data: { size: req.body.length }, ip: req.ip });
      return rows[0]!.id;
    });
    return reply.code(201).send({ url: `/media/${id}` });
  });

  app.get<{ Params: { id: string } }>('/media/:id', { schema: { params: { type: 'object',
    properties: { id: { type: 'string', format: 'uuid' } } } } }, async (req, reply) => {
    const m = await withScope(db, { businessId: bid(req) }, async (tx) =>
      (await tx.query<{ contentType: string; bytes: Buffer }>(
        `SELECT content_type AS "contentType", bytes FROM media WHERE id = $1`, [req.params.id])).rows[0]);
    if (!m) throw new AuthError('not_found', 404);
    return reply.type(m.contentType)
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'")
      .send(m.bytes);
  });
}
