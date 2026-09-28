// Kiln (qwen3-32b) chat wrapper: fetch + AbortSignal, D4 retry policy, process-wide semaphore and call cap,
// one JSONL line per attempt. Callers turn result.error into QWEN_UNAVAILABLE / LLM_CALL_CAP (fail-closed).
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { KilnCall } from './record.ts'
import type { LlmOutput } from './parse.ts'

export type Flow = 'F1' | 'F2' | 'F3'
export type LlmMode = 'kiln' | 'stub'
export type LlmError = 'TIMEOUT' | 'RATE_LIMITED' | 'SERVER' | 'CAP' | 'NETWORK' | 'HTTP'
export type Msg = { role: 'system' | 'user' | 'assistant'; content: string }
export type Tool = { type: 'function'; function: { name: string; description: string; parameters: object } }

export type LlmReq = {
  flow: Flow
  messages: Msg[]
  tools?: Tool[]
  maxTokens?: number // default 512 for F1/F2, 256 for F3
  req_id: string
  job_id: string | null
  noThink?: boolean // default true; false only for the /no_think comparison script
}

/** KilnCall plus the two fields the auditor/report need (finish_reason is an [IFACE] request for KilnCall). */
export type Call = KilnCall & { finish_reason: string | null; cost_known: boolean }

export type LlmResult = LlmOutput & { calls: Call[]; toolName: string | null; error?: LlmError }

/** What a stub returns for one attempt. toolArgs objects are JSON-stringified. */
export type StubReply = { content?: string | null; toolName?: string; toolArgs?: string | object; finishReason?: string; error?: LlmError }
export type Stub = (req: LlmReq, n: number) => StubReply

export type KilnLine = {
  ts: number; flow: Flow; req_id: string; job_id: string | null; attempt: number; http: number | null
  latency_ms: number; gen_id: string | null; usage: Call['usage']; cost_known: boolean
  finish_reason: string | null; llm_mode: LlmMode; raw: string | null
}

export type LlmCtx = {
  mode: LlmMode // required: from llmMode(); no default, no fallback
  sink: string | ((line: KilnLine) => void) // runs/<vault>/kiln.jsonl or a callback
  stub?: Stub
  fetch?: typeof fetch
  timeoutMs?: number // per attempt, default 10s (D4)
  jitterMs?: number // retry delay override for tests; default 1000-2000 random
  cap?: number // default LLM_CALL_CAP env or 60
  apiKey?: string // default KILN_API_KEY
  baseUrl?: string // default KILN_BASE_URL
  warn?: (msg: string) => void
}

export const MODEL = 'qwen3-32b'
const SEM = 4
const FIELDS = ['ts', 'flow', 'req_id', 'job_id', 'attempt', 'http', 'latency_ms', 'gen_id', 'usage', 'cost_known', 'finish_reason', 'llm_mode', 'raw'] as const
export const JSONL_FIELDS: readonly string[] = FIELDS

/** Process-wide counters. calls = attempts made (kiln and stub), for the cap and /health. */
export const llmStats = { calls: 0, active: 0, stubN: 0 }

/** LLM_MODE must be set explicitly (S8-5). */
export function llmMode(env: Record<string, string | undefined> = process.env): LlmMode {
  const m = env.LLM_MODE
  if (m !== 'kiln' && m !== 'stub') throw new Error(`LLM_MODE must be "kiln" or "stub" (got ${m === undefined ? 'nothing' : JSON.stringify(m)})`)
  return m
}

const waiters: (() => void)[] = []
async function acquire() {
  if (llmStats.active < SEM) { llmStats.active++; return }
  await new Promise<void>((r) => waiters.push(r)) // slot handed over by release(), active unchanged
}
function release() {
  const next = waiters.shift()
  if (next) next()
  else llmStats.active--
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Seconds until the server says we may retry: Retry-After (seconds or HTTP date) or an x-ratelimit reset header. */
export function resetSeconds(h: Headers, now = Date.now()): number | null {
  let best: number | null = null
  for (const name of ['retry-after', 'x-ratelimit-reset', 'x-ratelimit-reset-requests', 'ratelimit-reset']) {
    const v = h.get(name)?.trim()
    if (!v) continue
    let s: number
    if (/^\d+(\.\d+)?$/.test(v)) s = Number(v) > 1e9 ? Number(v) - now / 1000 : Number(v) // epoch seconds or delta
    else if (/^(\d+(\.\d+)?(ms|s|m|h))+$/.test(v)) s = [...v.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)].reduce((a, [, n, u]) => a + Number(n) * { ms: 0.001, s: 1, m: 60, h: 3600 }[u]!, 0)
    else if (!Number.isNaN(Date.parse(v))) s = (Date.parse(v) - now) / 1000
    else continue
    best = Math.max(best ?? 0, s)
  }
  return best
}

/**
 * D4: 429 and 5xx get one retry after the 1-2 s jitter, or after the server's reset if that is later but <= 5 s.
 * A reset/Retry-After more than 5 s away, or any other status, is not retried. Returns the delay, or null.
 */
export function retryDelayMs(status: number, h: Headers, jitterMs: number, now = Date.now()): number | null {
  if (status !== 429 && status < 500) return null
  const reset = resetSeconds(h, now)
  return reset === null || reset <= 5 ? Math.max(jitterMs, reset === null ? 0 : reset * 1000) : null
}

function writeLine(ctx: LlmCtx, line: KilnLine) {
  const clean = Object.fromEntries(FIELDS.map((k) => [k, line[k]])) as KilnLine
  if (typeof ctx.sink === 'function') return ctx.sink(clean)
  mkdirSync(dirname(ctx.sink), { recursive: true })
  appendFileSync(ctx.sink, JSON.stringify(clean) + '\n')
}

type Attempt = { call: Call; out: Omit<LlmResult, 'calls'>; retryMs?: number }

function fromMessage(msg: any, finishReason: string | null): Omit<LlmResult, 'calls'> {
  const tcs: any[] = Array.isArray(msg?.tool_calls) ? msg.tool_calls : []
  const args = tcs.map((t) => (typeof t?.function?.arguments === 'string' ? t.function.arguments : JSON.stringify(t?.function?.arguments ?? null)))
  // Several tool calls are kept as a JSON array of their argument strings: the parser never reads an array,
  // so this is always UNPARSEABLE (no picking a favourite, even if one call has empty arguments).
  const toolArgs = args.length === 0 ? null : args.length === 1 ? args[0] : JSON.stringify(args)
  return { content: typeof msg?.content === 'string' ? msg.content : null, toolArgs, toolName: tcs[0]?.function?.name ?? null, finishReason }
}

function stubAttempt(req: LlmReq, ctx: LlmCtx, attempt: number): Attempt {
  const n = ++llmStats.stubN
  const r = (ctx.stub ?? defaultStub)(req, n)
  const toolArgs = r.toolArgs === undefined ? null : typeof r.toolArgs === 'string' ? r.toolArgs : JSON.stringify(r.toolArgs)
  const finishReason = r.error ? null : r.finishReason ?? (toolArgs !== null ? 'tool_calls' : 'stop')
  const out = { content: r.content ?? null, toolArgs, toolName: toolArgs !== null ? r.toolName ?? null : null, finishReason, ...(r.error && { error: r.error }) }
  const ok = !r.error
  return {
    out,
    call: {
      flow: req.flow, attempt, http: ok ? 200 : null, latency_ms: 0, gen_id: `stub-${n}`,
      usage: ok ? { prompt_tokens: 0, completion_tokens: 0, reasoning_tokens: 0, cost: 0 } : null,
      raw: ok ? toolArgs ?? out.content : null, llm_mode: 'stub', finish_reason: finishReason, cost_known: ok,
    },
  }
}

/** Canned deterministic answers per flow. Scenarios pass their own ctx.stub. */
export const defaultStub: Stub = (req) =>
  req.flow === 'F1' ? { toolName: 'request_gpu_hold', toolArgs: { vendor_label: 'B', gpu: 'h100', amount_usd: '2.56', rationale: 'stub: continue the approved job for one more GPU-hour' } }
  : req.flow === 'F2' ? { toolName: 'record_verdict', toolArgs: { verdict: 'approve', reason: 'stub: within the approved purpose' } }
  : { content: 'Stub receipt: the job ran on the approved vendor and was settled from the vault within its hold.' }

async function httpAttempt(req: LlmReq, ctx: LlmCtx, attempt: number): Promise<Attempt> {
  const apiKey = ctx.apiKey ?? process.env.KILN_API_KEY
  const baseUrl = (ctx.baseUrl ?? process.env.KILN_BASE_URL)!
  const messages = req.messages.map((m) => ({ ...m }))
  if (req.noThink !== false) {
    const last = messages.findLastIndex((m) => m.role === 'user')
    if (last >= 0) messages[last].content += ' /no_think'
  }
  const body = {
    model: MODEL, messages, temperature: 0, max_tokens: req.maxTokens ?? (req.flow === 'F3' ? 256 : 512),
    ...(req.tools?.length && { tools: req.tools, tool_choice: 'auto' }),
  }
  const base = { flow: req.flow, attempt, llm_mode: 'kiln' as const, usage: null, raw: null, gen_id: null, finish_reason: null, cost_known: false }
  const none = { content: null, toolArgs: null, toolName: null, finishReason: null }
  await acquire()
  const t0 = performance.now()
  const ms = () => Math.round(performance.now() - t0)
  try {
    const res = await (ctx.fetch ?? fetch)(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 10_000),
    })
    const gen_id = res.headers.get('x-neocloud-generation-id')
    const text = await res.text()
    if (!res.ok) {
      const call: Call = { ...base, http: res.status, latency_ms: ms(), gen_id }
      const error: LlmError = res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'SERVER' : 'HTTP'
      const retryMs = retryDelayMs(res.status, res.headers, ctx.jitterMs ?? 1000 + Math.random() * 1000) ?? undefined
      return { call, out: { ...none, error }, retryMs }
    }
    let j: any
    try { j = JSON.parse(text) } catch { j = null }
    const choice = j?.choices?.[0]
    const u = j?.usage
    const cost = typeof u?.cost === 'number' && Number.isFinite(u.cost) ? u.cost : null
    const usage = u ? { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0, cost } : null
    if (!choice) return { call: { ...base, http: res.status, latency_ms: ms(), gen_id, usage, cost_known: cost !== null }, out: { ...none, error: 'HTTP' } }
    const out = fromMessage(choice.message, choice.finish_reason ?? null)
    return { out, call: { ...base, http: res.status, latency_ms: ms(), gen_id, usage, cost_known: cost !== null, raw: out.toolArgs ?? out.content, finish_reason: out.finishReason } }
  } catch (e: any) {
    const error: LlmError = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'
    return { call: { ...base, http: null, latency_ms: ms() }, out: { ...none, error } }
  } finally {
    release()
  }
}

export async function llm(req: LlmReq, ctx: LlmCtx): Promise<LlmResult> {
  if (ctx.mode !== 'kiln' && ctx.mode !== 'stub') throw new Error(`llm(): mode must be "kiln" or "stub" (got ${JSON.stringify(ctx.mode)})`)
  const cap = ctx.cap ?? Number(process.env.LLM_CALL_CAP ?? 60)
  if (!Number.isInteger(cap) || cap <= 0) throw new Error(`LLM_CALL_CAP must be a positive integer (got ${cap})`)
  if (ctx.mode === 'kiln' && !((ctx.apiKey ?? process.env.KILN_API_KEY) && (ctx.baseUrl ?? process.env.KILN_BASE_URL)))
    throw new Error('LLM_MODE=kiln needs KILN_API_KEY and KILN_BASE_URL (run node --env-file=.env)')
  const calls: Call[] = []
  let last: Attempt | null = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (llmStats.calls >= cap) return { calls, content: null, toolArgs: null, toolName: null, finishReason: null, error: 'CAP' }
    if (++llmStats.calls === Math.ceil(cap * 0.8)) (ctx.warn ?? console.warn)(`kiln: ${llmStats.calls}/${cap} LLM calls used (80% of LLM_CALL_CAP)`)
    last = ctx.mode === 'stub' ? stubAttempt(req, ctx, attempt) : await httpAttempt(req, ctx, attempt)
    calls.push(last.call)
    writeLine(ctx, { ts: Date.now(), req_id: req.req_id, job_id: req.job_id, ...last.call })
    if (last.retryMs === undefined || attempt === 2) break
    await sleep(last.retryMs)
  }
  return { calls, ...last!.out }
}

/**
 * Sum of usage.cost (USD floats) -> micro-USDC, ceil once over the exact decimal sum (doc: ceil(sum*1e6) once).
 * Each float is read through its shortest decimal form, so 1.4e-4 is exactly 0.00014, not 0.000139999...
 */
export function costToMicro(costs: readonly (number | null | undefined)[]): { micro: bigint; unknown: number } {
  let unknown = 0
  const parts: { n: bigint; e: number }[] = []
  for (const c of costs) {
    if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) { unknown++; continue }
    const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(c))!
    parts.push({ n: BigInt(m[1] + (m[2] ?? '')), e: Number(m[3] ?? 0) - (m[2]?.length ?? 0) })
  }
  const e = Math.min(0, ...parts.map((p) => p.e))
  const sum = parts.reduce((a, p) => a + p.n * 10n ** BigInt(p.e - e), 0n) // value = sum * 10^e
  const shift = e + 6
  const micro = shift >= 0 ? sum * 10n ** BigInt(shift) : (sum + 10n ** BigInt(-shift) - 1n) / 10n ** BigInt(-shift)
  return { micro, unknown }
}
