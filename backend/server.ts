// server.ts — baseline dashboard server (D6 A, T10): one HTML file + GET /state polled every 1 s.
//
// Security (D1 / S3-11): binds 127.0.0.1 only; state-changing POST /action accepts JSON only and
// checks the Origin; stale stateVersion or a duplicate pending action -> 409. Founder actions
// (STOP, settle/close/refund = windDown) go through the same commit() queue as agent txs; amounts
// are computed by the server, never taken from the client.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Session } from './session.ts';

export type ServerHandle = { url: string; close: () => Promise<void> };

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
};

async function readJson(req: IncomingMessage, limit = 4096): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startServer(session: Session, opts: { port: number; html?: string }): Promise<ServerHandle> {
  const pending = new Set<string>();
  const html = opts.html ?? readFileSync('backend/dashboard.html', 'utf8');
  const allowedOrigins = new Set([`http://127.0.0.1:${opts.port}`, `http://localhost:${opts.port}`]);

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${opts.port}`);
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
        return void res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, session.state());
      if (req.method === 'GET' && url.pathname === '/health') {
        const s = session.state();
        return json(res, 200, { ok: !s.halted && !s.stale, stale: s.stale, halted: s.halted, pendingTx: s.pendingTx, syncAgoMs: s.syncAgoMs, badges: s.badges, llmCalls: s.inference.calls });
      }
      if (req.method === 'POST' && url.pathname === '/action') {
        const origin = req.headers.origin;
        if (!origin || !allowedOrigins.has(origin)) return json(res, 403, { error: 'bad origin' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'json only' });
        const body = (await readJson(req)) as { type?: string; stateVersion?: number; reason?: string };
        const s = session.state();
        if (typeof body.stateVersion !== 'number' || body.stateVersion < s.stateVersion - 50) return json(res, 409, { error: 'stale stateVersion' });
        const type = String(body.type ?? '');
        if (pending.has(type)) return json(res, 409, { error: 'action pending' });
        const REASONS = ['STOP: budget review', 'STOP: off-purpose spending', 'STOP: incident'];
        pending.add(type);
        try {
          if (type === 'STOP') {
            if (s.stopState !== 'NONE') return json(res, 409, { error: 'already stopped' });
            await session.founderStop(REASONS.includes(body.reason ?? '') ? body.reason! : REASONS[0]!);
            return json(res, 200, { ok: true });
          }
          if (type === 'WIND_DOWN') {
            // founder settle -> close -> INFERENCE -> refund; idempotent, amounts computed server-side.
            // Only when every open job has halted (STOPPED / HOLD_EXHAUSTED) and no tx is pending:
            // press STOP first to end a running job.
            const open = (s.jobs ?? []).filter((j: { phase: string }) => j.phase !== 'CLOSED');
            if (!s.ended && (s.pendingTx > 0 || open.some((j: { phase: string }) => j.phase !== 'STOPPED' && j.phase !== 'HOLD_EXHAUSTED'))) {
              return json(res, 409, { error: 'jobs still running or txs pending: STOP first' });
            }
            const reason = await session.windDown('WIND_DOWN');
            return json(res, 200, { ok: true, reason });
          }
          return json(res, 400, { error: 'unknown action' });
        } finally {
          pending.delete(type);
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: (e as Error).message.split('\n')[0] });
    }
  });
  await new Promise<void>((r) => server.listen(opts.port, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${opts.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
