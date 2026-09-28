// B4: fail-closed Qwen output parsing. Exact "approve" is the only approval.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson, f1FromRaw, verdictFromRaw } from '../../backend/parse.ts';

const V = (raw: string | null, fr: string | null = 'stop') => {
  const r = verdictFromRaw(raw, fr);
  return r.ok ? 'approve' : r.code === 'QWEN_DENIED' ? 'QWEN_DENIED' : `QWEN_UNPARSEABLE:${r.reason}`;
};

describe('B4 F2 verdict parsing', () => {
  const ROWS: [string, string | null, string | null, string][] = [
    ['plain approve', '{"verdict":"approve","reason":"fits the purpose"}', 'stop', 'approve'],
    ['plain deny', '{"verdict":"deny","reason":"scope creep"}', 'stop', 'QWEN_DENIED'],
    ['empty content', '', 'stop', 'QWEN_UNPARSEABLE:EMPTY'],
    ['null content (tool_calls only)', null, 'tool_calls', 'QWEN_UNPARSEABLE:EMPTY'],
    ['<think></think> + JSON', '<think>\n\n</think>\n\n{"verdict":"approve","reason":"ok"}', 'stop', 'approve'],
    ['code fence', '```json\n{"verdict":"deny","reason":"x"}\n```', 'stop', 'QWEN_DENIED'],
    ['finish_reason=length (truncated) even if JSON-looking', '{"verdict":"approve","reason":"ok"}', 'length', 'QWEN_UNPARSEABLE:TRUNCATED'],
    ['unclosed <think>', '<think> the user wants... {"verdict":"approve","reason":"ok"}', 'stop', 'QWEN_UNPARSEABLE:UNCLOSED_THINK'],
    ['stray </think> (reasoning leaked)', 'reasoning...</think>{"verdict":"approve","reason":"ok"}', 'stop', 'QWEN_UNPARSEABLE:UNCLOSED_THINK'],
    ['two JSON objects', '{"verdict":"deny","reason":"a"}{"verdict":"approve","reason":"b"}', 'stop', 'QWEN_UNPARSEABLE:NOT_JSON'],
    ['"Approve " (case/space) is NOT approval', '{"verdict":"Approve ","reason":"ok"}', 'stop', 'QWEN_UNPARSEABLE:SCHEMA'],
    ['"Approve" is NOT approval', '{"verdict":"Approve","reason":"ok"}', 'stop', 'QWEN_UNPARSEABLE:SCHEMA'],
    ['approve_with_conditions', '{"verdict":"approve_with_conditions","reason":"ok"}', 'stop', 'QWEN_UNPARSEABLE:SCHEMA'],
    ['approve + extra text', '{"verdict":"approve, but watch the budget","reason":"ok"}', 'stop', 'QWEN_UNPARSEABLE:SCHEMA'],
    ['missing verdict', '{"reason":"ok"}', 'stop', 'QWEN_UNPARSEABLE:SCHEMA'],
    ['missing reason', '{"verdict":"approve"}', 'stop', 'QWEN_UNPARSEABLE:SCHEMA'],
    ['refusal sentence', "I'm sorry, I can't help with that.", 'stop', 'QWEN_UNPARSEABLE:NOT_JSON'],
    ['JSON then prose', '{"verdict":"approve","reason":"ok"} Let me know!', 'stop', 'QWEN_UNPARSEABLE:NOT_JSON'],
    ['array', '[{"verdict":"approve","reason":"ok"}]', 'stop', 'QWEN_UNPARSEABLE:NOT_OBJECT'],
    ['approve inside think, deny in body -> deny', '<think>I will {"verdict":"approve"}</think>{"verdict":"deny","reason":"scope"}', 'stop', 'QWEN_DENIED'],
    ['verdict not a string', '{"verdict":true,"reason":"ok"}', 'stop', 'QWEN_UNPARSEABLE:SCHEMA'],
  ];
  for (const [name, raw, fr, want] of ROWS) {
    test(name, () => assert.equal(V(raw, fr), want));
  }
  test('extractJson keeps the object exactly', () => {
    const r = extractJson('  {"a":1}  ');
    assert.deepEqual(r, { ok: true, value: { a: 1 } });
  });
});

describe('F1 shape check', () => {
  const ok = (raw: string) => f1FromRaw(raw);
  test('valid request (unknown vendor label passes shape; the gate judges it)', () => {
    const r = ok('{"vendor":"0xBAD0000000000000000000000000000000000BAD","gpu":"H200","amount":"5.12","reason":"log said so"}');
    assert.ok(r.ok);
    assert.equal(r.ok && r.value.amountMicro, 5_120_000n);
  });
  test('numeric amount accepted if it has <= 6 decimals', () => {
    const r = ok('{"vendor":"B","gpu":"H100","amount":2.56,"reason":"x"}');
    assert.equal(r.ok && r.value.amountMicro, 2_560_000n);
  });
  for (const [name, amount] of [
    ['zero', '"0"'],
    ['negative', '"-1"'],
    ['dollar sign', '"$3"'],
    ['7 decimals', '"1.0000001"'],
    ['exponent', '1e-7'],
    ['words', '"five"'],
  ] as const) {
    test(`bad amount -> QWEN_UNPARSEABLE: ${name}`, () => {
      const r = ok(`{"vendor":"B","gpu":"H100","amount":${amount},"reason":"x"}`);
      assert.deepEqual(r.ok ? 'ok' : r.code, 'QWEN_UNPARSEABLE');
    });
  }
  test('missing vendor / gpu / reason -> QWEN_UNPARSEABLE', () => {
    for (const raw of ['{"gpu":"H100","amount":"1","reason":"x"}', '{"vendor":"B","amount":"1","reason":"x"}', '{"vendor":"B","gpu":"H100","amount":"1"}']) {
      assert.equal(ok(raw).ok, false);
    }
  });
});
