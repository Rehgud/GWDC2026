// Session races and failure paths from the core review (S2, S3, S5, S9), on anvil.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { PublicClient } from 'viem';
import { auditBundle } from '../../auditor/audit.ts';
import { HaltError } from '../../backend/commit.ts';
import { contextStub } from '../../backend/scenarios.ts';
import { anvilAvailable } from './helpers/anvil.ts';
import { makeSession } from './helpers/session.ts';

const SKIP = !anvilAvailable() && 'anvil or forge out/ not available';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('session races on anvil', { skip: SKIP }, () => {
  test('S2 a stuck top-up flow is ended by the 60 s watchdog (TOPUP_TIMEOUT, recorded), then re-armed once', async () => {
    const base = contextStub();
    let hang = true;
    // F1 on the first top-up hangs far past the (shortened) watchdog; the re-armed one answers
    const stub = async (flow: 'F1' | 'F2' | 'F3', msgs: { role: string; content: string }[]) => {
      const u = msgs.filter((m) => m.role === 'user').at(-1)?.content ?? '';
      if (flow === 'F1' && u.includes('REQUEST TYPE: topup') && hang) {
        hang = false;
        await sleep(6_000);
      }
      return base(flow, msgs as never);
    };
    const t = await makeSession({ stub, cfg: { topupTimeoutMs: 1_500 }, llm: { timeoutMs: { F1: 20_000, F2: 20_000, F3: 20_000 } } });
    try {
      const reason = await t.session.run();
      assert.equal(reason, 'COMPLETED');
      const recs = await t.records();
      const timeout = recs.find((r) => r.kind === 'REQUEST' && r.body.code === 'TOPUP_TIMEOUT');
      assert.ok(timeout, 'TOPUP_TIMEOUT recorded');
      assert.equal(timeout.tx.fn, 'recordDecision');
      assert.ok(recs.some((r) => r.kind === 'REQUEST' && r.body.trigger === 'rearm' && r.body.decision === 'APPROVE'), 'one re-armed request, approved');
      assert.equal(recs.at(-1)?.kind, 'SESSION_END', 'nothing after SESSION_END (the abandoned flow wrote nothing)');
      const audit = await auditBundle({ dir: t.dir, rpcUrl: t.anvil.url, expectedVault: t.fx.vault });
      assert.equal(audit.verdict, 'PASS', JSON.stringify(audit.failures, null, 1));
    } finally {
      await t.cleanup();
    }
  });

  test('S3 windDown while a top-up flow is in flight: SESSION_END stays the last record', async () => {
    const base = contextStub();
    const stub = async (flow: 'F1' | 'F2' | 'F3', msgs: { role: string; content: string }[]) => {
      if (flow === 'F2') await sleep(2_500); // a slow CFO review keeps the flow in flight
      return base(flow, msgs as never);
    };
    const t = await makeSession({ stub, scenario: { maxCheckpoints: 20 } });
    try {
      const running = t.session.run();
      for (let i = 0; i < 200; i++) {
        const j = t.session.state().jobs[0];
        if (j && j.latch === 'inflight') break;
        await sleep(50);
      }
      assert.equal(t.session.state().jobs[0]?.latch, 'inflight', 'a top-up is in flight');
      const [a, b] = await Promise.all([t.session.windDown('WIND_DOWN'), running]);
      assert.equal(a, 'WIND_DOWN');
      assert.equal(b, 'WIND_DOWN');
      const recs = await t.records();
      assert.equal(recs.at(-1)?.kind, 'SESSION_END');
      assert.equal(recs.filter((r) => r.kind === 'SESSION_END').length, 1);
      const audit = await auditBundle({ dir: t.dir, rpcUrl: t.anvil.url, expectedVault: t.fx.vault });
      assert.equal(audit.verdict, 'PASS', JSON.stringify(audit.failures, null, 1));
    } finally {
      await t.cleanup();
    }
  });

  test('S9 a submit error whose tx DID reach the node is found by one re-query: no HALT', async () => {
    let failNext = 3; // the 3rd raw send: the tx is broadcast, then the RPC answer is an error
    const wrap = (pc: PublicClient): PublicClient =>
      new Proxy(pc, {
        get(target, prop, recv) {
          if (prop === 'sendRawTransaction') {
            return async (args: unknown) => {
              const h = await (target.sendRawTransaction as (a: unknown) => Promise<unknown>)(args);
              if (--failNext === 0) throw new Error('HTTP request failed. Status: 503');
              return h;
            };
          }
          return Reflect.get(target, prop, recv);
        },
      }) as PublicClient;
    const t = await makeSession({ stub: contextStub(), wrapPc: wrap, scenario: { maxCheckpoints: 2 } });
    try {
      assert.equal(await t.session.run(), 'COMPLETED');
      const audit = await auditBundle({ dir: t.dir, rpcUrl: t.anvil.url, expectedVault: t.fx.vault });
      assert.equal(audit.verdict, 'PASS', JSON.stringify(audit.failures, null, 1));
    } finally {
      await t.cleanup();
    }
  });

  test('S5 a HALT inside a top-up flow makes run() reject (never reported as a normal end)', async () => {
    let sends = 0;
    const wrap = (pc: PublicClient): PublicClient =>
      new Proxy(pc, {
        get(target, prop, recv) {
          if (prop === 'sendRawTransaction') {
            return async (args: unknown) => {
              sends++;
              if (sends === 4) throw new Error('nonce too low'); // never reached the node
              return (target.sendRawTransaction as (a: unknown) => Promise<unknown>)(args);
            };
          }
          return Reflect.get(target, prop, recv);
        },
      }) as PublicClient;
    const t = await makeSession({ stub: contextStub(), wrapPc: wrap, scenario: { maxCheckpoints: 6 } });
    try {
      await assert.rejects(t.session.run(), (e: unknown) => e instanceof HaltError && e.reason === 'SEND_FAILED');
      assert.match(String(t.session.state().halted), /SEND_FAILED/);
      assert.equal(t.session.state().ended, null, 'not reported as WIND_DOWN / COMPLETED');
    } finally {
      await t.cleanup();
    }
  });
});
