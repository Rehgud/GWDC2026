// B12: dashboard server guards — 127.0.0.1 only, Origin check, JSON only, 409 on a duplicate
// pending action or a stale stateVersion; two concurrent STOP clicks -> exactly one founder tx.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { startServer, type ServerHandle } from '../../backend/server.ts';
import type { Session } from '../../backend/session.ts';

async function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => r(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

describe('B12 dashboard server', () => {
  let h: ServerHandle;
  let port = 0;
  let stops = 0;
  let winds = 0;
  let stopState = 'NONE';
  let version = 100;
  const fake = {
    state: () => ({ stateVersion: version, stopState, halted: null, stale: false, pendingTx: 0, syncAgoMs: 500, badges: { LLM: 'STUB' }, inference: { calls: 3 }, ended: null }),
    founderStop: async () => {
      stops++;
      await new Promise((r) => setTimeout(r, 200)); // tx in flight
      stopState = 'PAUSED_ON_CHAIN';
    },
    windDown: async () => {
      winds++;
      return 'WIND_DOWN';
    },
  } as unknown as Session;

  before(async () => {
    port = await freePort();
    h = await startServer(fake, { port, html: '<!doctype html><title>t</title>' });
  });
  after(async () => {
    await h.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/action`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}`, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  test('serves the page and /state, /health', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    const s = (await (await fetch(`http://127.0.0.1:${port}/state`)).json()) as { stateVersion: number };
    assert.equal(s.stateVersion, 100);
    const hh = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { ok: boolean };
    assert.equal(hh.ok, true);
  });

  test('binds 127.0.0.1 only', () => {
    assert.match(h.url, /^http:\/\/127\.0\.0\.1:/);
  });

  test('foreign Origin -> 403; missing Origin -> 403; non-JSON -> 415', async () => {
    assert.equal((await post({ type: 'STOP', stateVersion: 100 }, { origin: 'http://evil.example' })).status, 403);
    const noOrigin = await fetch(`http://127.0.0.1:${port}/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noOrigin.status, 403);
    assert.equal((await post('type=STOP', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  });

  test('stale stateVersion -> 409', async () => {
    assert.equal((await post({ type: 'STOP', stateVersion: 1 })).status, 409);
    assert.equal(stops, 0);
  });

  test('two concurrent STOP clicks -> one founder tx, the other 409', async () => {
    const [a, b] = await Promise.all([post({ type: 'STOP', stateVersion: 100 }), post({ type: 'STOP', stateVersion: 100 })]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(stops, 1);
    // STOP again after it landed -> 409 (already stopped)
    assert.equal((await post({ type: 'STOP', stateVersion: 100 })).status, 409);
    assert.equal(stops, 1);
  });

  test('WIND_DOWN goes through the session (amounts computed server-side), unknown action -> 400', async () => {
    const r = await post({ type: 'WIND_DOWN', stateVersion: 100, amount: '999999999' });
    assert.equal(r.status, 200);
    assert.equal(winds, 1);
    assert.equal((await post({ type: 'REFUND_ALL', stateVersion: 100 })).status, 400);
  });
});
