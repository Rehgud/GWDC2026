// Parsing of Kiln (Qwen) answers. Pure: the auditor imports this to recompute verdicts from recorded raw strings.
import type { Code } from './codes.ts'

/** The part of an llm() result the parsers read. raw = toolArgs ?? content, same as KilnCall.raw. */
export type LlmOutput = {
  content: string | null
  toolArgs: string | null
  finishReason: string | null
  error?: string // llm() failure: TIMEOUT | RATE_LIMITED | SERVER | NETWORK | HTTP | CAP
}

export type Verdict = { approve: true; reason: string } | { approve: false; code: Code; reason: string }

export type F1Fields = { vendorLabel: string; gpu: string; amount: bigint; rationale: string }
export type F1Parse = { ok: true; fields: F1Fields } | { ok: false; code: Code; reason: string }

const bad = (reason: string) => ({ approve: false as const, code: 'QWEN_UNPARSEABLE' as Code, reason })

/**
 * Strips <think> blocks and one outer code fence, then JSON.parses the WHOLE remaining string.
 * Returns the object, or null for anything else (prose around the JSON, two objects, arrays, empty,
 * a stray or nested think tag, a repeated key). Ambiguous input must never read as a verdict.
 */
export function extractJson(text: string): Record<string, unknown> | null {
  let s = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  const open = s.indexOf('<think>') // unclosed: everything after is thinking
  if (open >= 0) s = s.slice(0, open)
  s = s.trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '')
  if (!s) return null
  let v: unknown
  try { v = JSON.parse(s) } catch { return null }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  // JSON.parse silently keeps the last of duplicate keys ({"verdict":"deny","verdict":"approve"}): reject instead.
  if (Object.keys(v).some((k) => s.split(new RegExp(`"${k.replace(/\W/g, '\\$&')}"\\s*:`)).length > 2)) return null
  return v as Record<string, unknown>
}

const failed = (o: LlmOutput): Code | null =>
  o.error === 'CAP' ? 'LLM_CALL_CAP' : o.error ? 'QWEN_UNAVAILABLE' : null

/** F2 verdict from one recorded raw string. Only an exact (trimmed, case-folded) "approve" passes. */
export function parseVerdictRaw(raw: string | null, finishReason?: string | null): Verdict {
  if (finishReason === 'length') return bad('truncated (finish_reason length)')
  const o = extractJson(raw ?? '')
  if (!o) return bad('no single JSON object')
  if (typeof o.verdict !== 'string') return bad('verdict missing')
  const reason = typeof o.reason === 'string' ? o.reason : ''
  const v = o.verdict.trim().toLowerCase()
  if (v === 'approve') return { approve: true, reason }
  if (v === 'deny') return { approve: false, code: 'QWEN_DENIED', reason }
  return bad(`verdict ${JSON.stringify(o.verdict.slice(0, 40))}`)
}

/** F2: record_verdict tool arguments if Qwen called the tool, else the content JSON. */
export function parseVerdict(o: LlmOutput): Verdict {
  const code = failed(o)
  if (code) return { approve: false, code, reason: o.error! }
  return parseVerdictRaw(o.toolArgs ?? o.content, o.finishReason)
}

/** "2.56" or 2.56 -> 2_560_000n. Positive, <= 6 fraction digits, digits only ("$3", "3 USD", "1e-7" fail). */
export function usdToMicro(x: unknown): bigint | null {
  const s = typeof x === 'number' ? String(x) : x
  if (typeof s !== 'string' || !/^\d+(\.\d{1,6})?$/.test(s)) return null
  const [int, frac = ''] = s.split('.')
  const m = BigInt(int) * 1_000_000n + BigInt(frac.padEnd(6, '0'))
  return m > 0n ? m : null
}

/** F1 request_gpu_hold: shape only. Unknown vendor labels pass through; the gate turns them into VENDOR_NOT_ALLOWED. */
export function parseF1Raw(raw: string | null, finishReason?: string | null): F1Parse {
  const no = (reason: string): F1Parse => ({ ok: false, code: 'QWEN_UNPARSEABLE', reason })
  if (finishReason === 'length') return no('truncated (finish_reason length)')
  const o = extractJson(raw ?? '')
  if (!o) return no('no single JSON object')
  if (typeof o.vendor_label !== 'string') return no('vendor_label not a string')
  if (typeof o.gpu !== 'string') return no('gpu not a string')
  if (typeof o.rationale !== 'string') return no('rationale not a string')
  const amount = usdToMicro(o.amount_usd)
  if (amount === null) return no(`amount_usd ${JSON.stringify(o.amount_usd)}`.slice(0, 60))
  return { ok: true, fields: { vendorLabel: o.vendor_label, gpu: o.gpu, amount, rationale: Array.from(o.rationale).slice(0, 300).join('') } }
}

export function parseF1(o: LlmOutput): F1Parse {
  const code = failed(o)
  if (code) return { ok: false, code, reason: o.error! }
  return parseF1Raw(o.toolArgs ?? o.content, o.finishReason)
}
