import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseF1, parseVerdict, parseVerdictRaw, type LlmOutput } from '../src/parse.ts'

const out = (content: string | null, toolArgs: string | null = null, finishReason: string | null = 'stop', error?: string): LlmOutput =>
  ({ content, toolArgs, finishReason, ...(error && { error }) })
const J = (o: unknown) => JSON.stringify(o)
const A = J({ verdict: 'approve', reason: 'fits' })
const D = J({ verdict: 'deny', reason: 'scope creep' })

// [name, input, expected: 'approve' | code]
const verdictRows: [string, LlmOutput, string][] = [
  ['empty content', out(''), 'QWEN_UNPARSEABLE'],
  ['null content, no tool call', out(null), 'QWEN_UNPARSEABLE'],
  ['<think></think> + JSON', out(`<think></think>\n${A}`), 'approve'],
  ['<think>reasoning</think> + JSON', out(`<think>budget ok, purpose ok</think>\n\n${D}`), 'QWEN_DENIED'],
  ['json code fence', out('```json\n' + A + '\n```'), 'approve'],
  ['bare code fence', out('```\n' + A + '\n```'), 'approve'],
  ['finish_reason length with valid JSON', out(A, null, 'length'), 'QWEN_UNPARSEABLE'],
  ['finish_reason length on tool call', out('\n\n', A, 'length'), 'QWEN_UNPARSEABLE'],
  ['unclosed <think>', out(`<think>${A}`), 'QWEN_UNPARSEABLE'],
  ['deny, then unclosed <think> with approve', out(`${D}\n<think>${A}`), 'QWEN_DENIED'], // everything after an unclosed <think> is thinking
  ['<think> only', out('<think>let me consider the purpose</think>'), 'QWEN_UNPARSEABLE'],
  ['two JSON objects', out(`${A}\n${D}`), 'QWEN_UNPARSEABLE'],
  ['"Approve " passes', out(J({ verdict: 'Approve ', reason: 'ok' })), 'approve'],
  ['"DENY" is deny', out(J({ verdict: 'DENY', reason: 'no' })), 'QWEN_DENIED'],
  ['approve_with_conditions', out(J({ verdict: 'approve_with_conditions', reason: 'ok if' })), 'QWEN_UNPARSEABLE'],
  ['"allow" is not approve', out(J({ verdict: 'allow' })), 'QWEN_UNPARSEABLE'],
  ['missing verdict', out(J({ reason: 'looks fine' })), 'QWEN_UNPARSEABLE'],
  ['verdict not a string', out(J({ verdict: true })), 'QWEN_UNPARSEABLE'],
  ['refusal sentence', out("I'm sorry, but I can't help with that request."), 'QWEN_UNPARSEABLE'],
  ['prose around JSON', out(`Here is my verdict: ${A}`), 'QWEN_UNPARSEABLE'],
  ['JSON array', out(`[${A}]`), 'QWEN_UNPARSEABLE'],
  ['tool_calls only (content null)', out(null, A, 'tool_calls'), 'approve'],
  ['tool_calls with "\\n\\n" content', out('\n\n', D, 'tool_calls'), 'QWEN_DENIED'],
  ['two tool calls joined', out('\n\n', `${A}\n${D}`, 'tool_calls'), 'QWEN_UNPARSEABLE'],
  ['approve in <think>, deny in body', out(`<think>${A} ... actually no</think>${D}`), 'QWEN_DENIED'],
  // ambiguous shapes that once read as approve: all must be UNPARSEABLE
  ['stray </think> then approve', out(`${D}</think>\n${A}`), 'QWEN_UNPARSEABLE'],
  ['stray </think> then deny', out(`I would approve: ${A}</think>\n${D}`), 'QWEN_UNPARSEABLE'],
  ['nested <think> then approve', out(`<think> x <think> y </think> ${D} </think> ${A}`), 'QWEN_UNPARSEABLE'],
  ['duplicate verdict key, approve last', out('{"verdict":"deny","verdict":"approve"}'), 'QWEN_UNPARSEABLE'],
  ['duplicate verdict key in tool args', out('\n\n', '{"verdict": "deny", "reason": "r", "verdict" : "approve"}', 'tool_calls'), 'QWEN_UNPARSEABLE'],
  ['text after closing fence', out(`${A}\`\`\`deny`), 'QWEN_UNPARSEABLE'],
  ['backticks inside JSON string are kept', out(J({ verdict: 'approve', reason: 'see ```notes```' })), 'approve'],
  ['"verdict": quoted inside reason is not a duplicate', out(J({ verdict: 'deny', reason: 'the "verdict": field says approve' })), 'QWEN_DENIED'],
  ['llm TIMEOUT', out(null, null, null, 'TIMEOUT'), 'QWEN_UNAVAILABLE'],
  ['llm RATE_LIMITED', out(null, null, null, 'RATE_LIMITED'), 'QWEN_UNAVAILABLE'],
  ['llm CAP', out(null, null, null, 'CAP'), 'LLM_CALL_CAP'],
]

for (const [name, input, want] of verdictRows) {
  test(`parseVerdict: ${name} -> ${want}`, () => {
    const v = parseVerdict(input)
    assert.equal(v.approve ? 'approve' : v.code, want)
  })
}

test('parseVerdict keeps the reason; parseVerdictRaw on the recorded raw agrees', () => {
  const v = parseVerdict(out('\n\n', D, 'tool_calls'))
  assert.deepEqual(v, { approve: false, code: 'QWEN_DENIED', reason: 'scope creep' })
  assert.deepEqual(parseVerdictRaw(D, 'tool_calls'), v)
  assert.equal(parseVerdictRaw(null).approve, false)
})

const f1 = (o: Record<string, unknown>) => parseF1(out('\n\n', J({ vendor_label: 'B', gpu: 'h100', rationale: 'loss improving', ...o }), 'tool_calls'))
const amountRows: [unknown, bigint | null][] = [
  ['2.56', 2_560_000n], ['3', 3_000_000n], [3, 3_000_000n], [2.5, 2_500_000n], ['0.000001', 1n], ['6.000000', 6_000_000n],
  ['$3', null], ['3 USD', null], ['-1', null], [-1, null], ['1.0000001', null], [1e-7, null], ['0', null], [0, null],
  ['0.000000', null], ['', null], ['.5', null], ['3.', null], ['1e3', null], [null, null], [undefined, null],
]
for (const [amt, want] of amountRows) {
  test(`parseF1 amount ${JSON.stringify(amt) ?? 'undefined'} -> ${want ?? 'QWEN_UNPARSEABLE'}`, () => {
    const r = f1({ amount_usd: amt })
    if (want === null) assert.deepEqual(r.ok ? null : r.code, 'QWEN_UNPARSEABLE')
    else assert.equal(r.ok && r.fields.amount, want)
  })
}

test('parseF1: unknown vendor label passes through (the gate denies it), shape errors fail, rationale capped', () => {
  const inj = f1({ vendor_label: '0xBAD0000000000000000000000000000000000BAD', gpu: 'h200', amount_usd: '5' })
  assert.ok(inj.ok && inj.fields.vendorLabel.startsWith('0xBAD') && inj.fields.gpu === 'h200')
  assert.equal(f1({ vendor_label: 1, amount_usd: '1' }).ok, false)
  assert.equal(f1({ gpu: undefined, amount_usd: '1' }).ok, false)
  assert.equal(f1({ rationale: undefined, amount_usd: '1' }).ok, false)
  const long = f1({ amount_usd: '1', rationale: 'x'.repeat(400) })
  assert.equal(long.ok && long.fields.rationale.length, 300)
  // content-JSON fallback when Qwen does not call the tool
  const c = parseF1(out(`<think></think>${J({ vendor_label: 'A', gpu: 'h100', amount_usd: '2.04', rationale: 'r' })}`))
  assert.ok(c.ok && c.fields.amount === 2_040_000n)
  assert.deepEqual(parseF1(out(null, null, null, 'TIMEOUT')), { ok: false, code: 'QWEN_UNAVAILABLE', reason: 'TIMEOUT' })
  assert.equal(parseF1(out('\n\n', J({ vendor_label: 'B', gpu: 'h100', amount_usd: '1', rationale: 'r' }), 'length')).ok, false)
  // a repeated key is ambiguous: which vendor/amount did Qwen mean?
  assert.equal(parseF1(out('\n\n', '{"vendor_label":"B","gpu":"h100","amount_usd":"1","amount_usd":"6","rationale":"r"}', 'tool_calls')).ok, false)
})
