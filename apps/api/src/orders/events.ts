import { EventEmitter } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Живи обновления (реш. 9). Един процес → събития в паметта.
 * При всяка промяна абонатът получава пълен снимък — така преконектиране не губи нищо.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export const locationChannel = (locationId: string) => `loc:${locationId}`;
export const orderChannel = (orderId: string) => `order:${orderId}`;

export function publish(channel: string): void {
  bus.emit(channel);
}

export const HEARTBEAT_MS = 15_000;

/** Отваря SSE поток: снимък веднага, после при всяка промяна; heartbeat на 15 с. */
export function openStream(
  req: FastifyRequest, reply: FastifyReply, channels: string[], snapshot: () => Promise<unknown>,
): void {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // без буфериране зад прокси (реш. 19)
  });
  let closed = false;
  let pending = false;
  let running = false;
  const send = async () => {
    if (closed) return;
    if (running) { pending = true; return; }
    running = true;
    try {
      do {
        pending = false;
        const data = await snapshot();
        if (!closed) res.write(`event: snapshot\ndata: ${JSON.stringify(data)}\n\n`);
      } while (pending && !closed);
    } catch (err) {
      req.log.error(err);
    } finally {
      running = false;
    }
  };
  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, HEARTBEAT_MS);
  for (const c of channels) bus.on(c, send);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    for (const c of channels) bus.off(c, send);
  };
  req.raw.on('close', close);
  res.on('error', close);
  res.write('retry: 3000\n\n');
  void send();
}
