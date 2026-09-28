// /no_think on/off comparison (doc: 절감 근거): the same F2 prompt 3x with /no_think and 3x without.
// Writes runs/eval/nothink.jsonl, one line per run: {mode: 'think'|'no_think', usage, latency_ms, finish_reason, gen_id}.
// max_tokens 2048 and a 60 s timeout for BOTH modes so thinking is not cut off (production F2 uses 512 / 10 s).
// Run: LLM_MODE=kiln node --env-file=.env scripts/nothink-compare.ts
import { appendFileSync, mkdirSync } from 'node:fs'
import { llm, llmMode } from '../src/kiln.ts'
import { parseVerdict } from '../src/parse.ts'
import { F2_TOOL } from '../src/prompts.ts'
import { CASES, f2For } from './eval-f2.ts'

const OUT = process.argv[2] ?? 'runs/eval/nothink.jsonl'
const mode = llmMode()
mkdirSync('runs/eval', { recursive: true })
for (const noThink of [true, false]) {
  for (let i = 0; i < 3; i++) {
    const r = await llm(
      { flow: 'F2', messages: f2For(CASES[1]), tools: [F2_TOOL], maxTokens: 2048, noThink, req_id: `nothink-${noThink ? 'on' : 'off'}-${i}`, job_id: null },
      { mode, sink: 'runs/eval/kiln.jsonl', timeoutMs: 60_000 },
    )
    const c = r.calls.at(-1)!
    const line = { mode: noThink ? 'no_think' : 'think', usage: c.usage, latency_ms: c.latency_ms, finish_reason: r.finishReason, gen_id: c.gen_id }
    appendFileSync(OUT, JSON.stringify(line) + '\n')
    const v = parseVerdict(r)
    console.log(`${line.mode.padEnd(9)} ${String(c.latency_ms).padStart(6)} ms  completion ${c.usage?.completion_tokens ?? '-'} (reasoning ${c.usage?.reasoning_tokens ?? '-'})  cost ${c.usage?.cost ?? '-'}  finish ${r.finishReason}  verdict ${v.approve ? 'approve' : v.code}${r.error ? ` error ${r.error}` : ''}`)
    await new Promise((res) => setTimeout(res, 1100))
  }
}
