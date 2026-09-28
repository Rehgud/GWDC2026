// B5 llm() against a local mock Kiln: timeout (no retry), 429 (no header / reset<=5 / reset=30),
// 5xx once, truncation, cap. B6 cost -> micro-USDC. LLM_MODE strictness. JSONL allowed fields.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costToMicro, llmModeFromEnv, LlmClient, LlmConfigError, withNoThink } from '../../backend/kiln.ts';

type Step = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number };
let script: Step[] = [];
let hits = 0;
let lastAuth = '';
let lastBody: Record<string, unknown> = {};

const okBody = (content: string, finish = 'stop', cost: unknown = 0.00014) => ({
  id: 'body-id',
  choices: [{ message: { content }, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost },
});

describe('B5 llm() fail-closed wrapper (mock Kiln over HTTP)', () => {
  let server: Server;
  let url = '';
  let dir = '';
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfo-kiln-'));
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        hits++;
        lastAuth = String(req.headers.authorization ?? '');
        lastBody = JSON.parse(data || '{}');
        const s = script.shift() ?? { status: 500 };
        const send = () => {
          res.writeHead(s.status, { 'content-type': 'application/json', 'x-neocloud-generation-id': `gen-${hits}`, ...(s.headers ?? {}) });
          res.end(JSON.stringify(s.body ?? { error: 'x' }));
        };
        if (s.delayMs) setTimeout(send, s.delayMs);
        else send();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const a = server.address();
    url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`;
  });
  after(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });

  const slept: number[] = [];
  const client = (over: Partial<ConstructorParameters<typeof LlmClient>[0]> = {}) =>
    new LlmClient({
      mode: 'kiln',
      model: 'qwen3-32b',
      url,
      apiKey: 'test-key-not-secret',
      callCap: 60,
      concurrency: 4,
      timeoutMs: { F1: 300, F2: 300, F3: 300 },
      sleep: async (ms) => {
        slept.push(ms);
      },
      jitterMs: () => 1500,
      jsonlPath: join(dir, 'llm.jsonl'),
      ...over,
    });
  const msgs = [{ role: 'user' as const, content: 'hi' }];
  const reset = () => {
    hits = 0;
    slept.length = 0;
  };

  test('200: content, usage, gen id from X-Neocloud-Generation-Id; request shape', async () => {
    reset();
    script = [{ status: 200, body: okBody('{"verdict":"approve","reason":"ok"}') }];
    const ev = await client().call('F2', msgs);
    assert.equal(ev.code, null);
    assert.equal(ev.raw, '{"verdict":"approve","reason":"ok"}');
    assert.equal(ev.gen_id, 'gen-1');
    assert.equal(ev.usage?.completion_tokens, 20);
    assert.equal(lastAuth, 'Bearer test-key-not-secret');
    assert.equal(lastBody.model, 'qwen3-32b');
    assert.equal(lastBody.max_tokens, 512);
    assert.equal(lastBody.temperature, 0);
    assert.equal('response_format' in lastBody, false, 'no response_format (Kiln returns empty content)');
    assert.match(String((lastBody.messages as { content: string }[])[0]!.content), /\/no_think$/);
  });

  test('timeout -> QWEN_UNAVAILABLE after ONE attempt (no retry)', async () => {
    reset();
    script = [{ status: 200, body: okBody('{}'), delayMs: 2_000 }];
    const ev = await client().call('F1', msgs);
    assert.equal(ev.code, 'QWEN_UNAVAILABLE');
    assert.equal(ev.attempts.length, 1);
    assert.equal(ev.attempts[0]!.error, 'TIMEOUT');
    assert.equal(hits, 1);
  });

  test('429 without reset header -> one retry after 1-2 s jitter -> success', async () => {
    reset();
    script = [{ status: 429 }, { status: 200, body: okBody('{"verdict":"deny","reason":"x"}') }];
    const ev = await client().call('F2', msgs);
    assert.equal(ev.code, null);
    assert.deepEqual(ev.attempts.map((a) => a.http), [429, 200]);
    assert.deepEqual(slept, [1500]);
  });

  test('429 with reset=3 s -> waits max(3 s, jitter) then retries', async () => {
    reset();
    script = [{ status: 429, headers: { 'x-ratelimit-reset': '3' } }, { status: 200, body: okBody('{"verdict":"deny","reason":"x"}') }];
    const ev = await client().call('F2', msgs);
    assert.equal(ev.code, null);
    assert.deepEqual(slept, [3000]);
  });

  test('429 with reset=30 s -> refused at once, no retry', async () => {
    reset();
    script = [{ status: 429, headers: { 'x-ratelimit-reset': '30' } }];
    const ev = await client().call('F2', msgs);
    assert.equal(ev.code, 'QWEN_UNAVAILABLE');
    assert.equal(hits, 1);
    assert.match(ev.attempts[0]!.error ?? '', /RESET_30S/);
  });

  test('429 twice -> QWEN_UNAVAILABLE after exactly 2 attempts', async () => {
    reset();
    script = [{ status: 429 }, { status: 429 }];
    const ev = await client().call('F1', msgs);
    assert.equal(ev.code, 'QWEN_UNAVAILABLE');
    assert.equal(hits, 2);
  });

  test('500 then 200 -> one retry', async () => {
    reset();
    script = [{ status: 500 }, { status: 200, body: okBody('{"verdict":"approve","reason":"ok"}') }];
    const ev = await client().call('F2', msgs);
    assert.equal(ev.code, null);
    assert.equal(hits, 2);
  });

  test('400 -> no retry', async () => {
    reset();
    script = [{ status: 400 }];
    const ev = await client().call('F2', msgs);
    assert.equal(ev.code, 'QWEN_UNAVAILABLE');
    assert.equal(hits, 1);
  });

  test('finish_reason=length -> QWEN_UNPARSEABLE (TRUNCATED), no retry', async () => {
    reset();
    script = [{ status: 200, body: okBody('{"verdict":"appr', 'length') }];
    const ev = await client().call('F2', msgs);
    assert.equal(ev.code, 'QWEN_UNPARSEABLE');
    assert.equal(ev.attempts[0]!.error, 'TRUNCATED');
    assert.equal(hits, 1);
  });

  test('empty content -> QWEN_UNPARSEABLE (EMPTY)', async () => {
    reset();
    script = [{ status: 200, body: okBody('') }];
    assert.equal((await client().call('F2', msgs)).code, 'QWEN_UNPARSEABLE');
  });

  test('network error -> QWEN_UNAVAILABLE without retry', async () => {
    const c = client({ url: 'http://127.0.0.1:1/v1' });
    const ev = await c.call('F1', msgs);
    assert.equal(ev.code, 'QWEN_UNAVAILABLE');
    assert.equal(ev.attempts.length, 1);
    assert.equal(ev.attempts[0]!.error, 'NETWORK');
  });

  test('D2 hard cap: blocks BEFORE the cap is reached, with no fetch; warns above 80%', async () => {
    reset();
    const warns: string[] = [];
    const c = client({ callCap: 5, onWarn: (m) => warns.push(m) });
    script = Array.from({ length: 5 }, () => ({ status: 200, body: okBody('{"verdict":"deny","reason":"x"}') }));
    for (let i = 0; i < 5; i++) assert.equal((await c.call('F2', msgs)).code, null);
    const blocked = await c.call('F2', msgs);
    assert.equal(blocked.code, 'LLM_CALL_CAP');
    assert.equal(blocked.attempts.length, 0);
    assert.equal(hits, 5);
    assert.equal(warns.length, 1);
  });

  test('cost cap: refuses once known cost approaches the INFERENCE hold', async () => {
    reset();
    const c = client({ callCap: 1000, costCapMicro: 1_000n }); // $0.001 hold
    script = Array.from({ length: 20 }, () => ({ status: 200, body: okBody('{"verdict":"deny","reason":"x"}', 'stop', 0.0002) }));
    let n = 0;
    while ((await c.call('F2', msgs)).code === null) n++;
    assert.ok(n >= 3 && n <= 5, `stopped after ${n} calls`);
    assert.ok(c.costMicro() < 1_000n, 'never reached 100%');
  });

  test('JSONL holds allowed fields only (no headers, no key)', async () => {
    const text = await readFile(join(dir, 'llm.jsonl'), 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l));
    assert.ok(lines.length > 5);
    const allowed = ['ts', 'flow', 'attempt', 'http', 'latency_ms', 'gen_id', 'finish_reason', 'usage', 'cost_known', 'error', 'llm_mode', 'model', 'messages'];
    for (const l of lines) assert.deepEqual(Object.keys(l).sort(), [...allowed].sort());
    assert.ok(!text.includes('test-key-not-secret'));
    assert.ok(!text.toLowerCase().includes('authorization'));
  });
});

describe('stub mode and LLM_MODE', () => {
  test('LLM_MODE must be explicit: no default, no fallback', () => {
    assert.throws(() => llmModeFromEnv(undefined), LlmConfigError);
    assert.throws(() => llmModeFromEnv(''), LlmConfigError);
    assert.throws(() => llmModeFromEnv('KILN'), LlmConfigError);
    assert.equal(llmModeFromEnv('kiln'), 'kiln');
    assert.equal(llmModeFromEnv('stub'), 'stub');
  });
  test('kiln mode without URL/key refuses to construct', () => {
    assert.throws(() => new LlmClient({ mode: 'kiln', model: 'qwen3-32b', callCap: 60 }), LlmConfigError);
  });
  test('stub gen ids start with "stub-"; stub can simulate a timeout', async () => {
    const c = new LlmClient({ mode: 'stub', model: 'qwen3-32b', callCap: 60, sleep: async () => {}, stub: (flow) => (flow === 'F1' ? { content: '{}', delayMs: 60_000 } : { content: '{"verdict":"approve","reason":"ok"}' }) });
    const ok = await c.call('F2', [{ role: 'user', content: 'x' }]);
    assert.match(ok.gen_id ?? '', /^stub-/);
    assert.equal(ok.llm_mode, 'stub');
    const to = await c.call('F1', [{ role: 'user', content: 'x' }]);
    assert.equal(to.code, 'QWEN_UNAVAILABLE');
  });
  test('withNoThink appends once to the last user message', () => {
    const m = withNoThink([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
    assert.equal(m[1]!.content, 'u\n/no_think');
    assert.equal(withNoThink(m)[1]!.content, 'u\n/no_think');
  });
});

describe('B6 cost -> micro-USDC (sum first, ceil once)', () => {
  test('1.4e-4, 5e-7, 0, missing', () => {
    assert.deepEqual(costToMicro([0.00014]), { micro: 140n, unknown: 0 });
    assert.deepEqual(costToMicro(['5e-7']), { micro: 1n, unknown: 0 });
    assert.deepEqual(costToMicro([0]), { micro: 0n, unknown: 0 });
    assert.deepEqual(costToMicro([null, undefined, 'n/a']), { micro: 0n, unknown: 3 });
  });
  test('ceil once over the sum, not per call: 3 x 3e-7 = 9e-7 -> 1 micro (not 3)', () => {
    assert.deepEqual(costToMicro([3e-7, 3e-7, 3e-7]), { micro: 1n, unknown: 0 });
  });
  test('60 calls x $0.00014 = $0.0084 = 8400 micro (D2 sizing)', () => {
    assert.equal(costToMicro(Array(60).fill(0.00014)).micro, 8400n);
  });
});
