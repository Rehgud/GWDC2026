// parse.ts — fail-closed parsing of Qwen outputs (T7). Imported unchanged by the auditor, which
// re-derives every recorded F2 verdict from the raw text (check 3).
//
//   finish_reason == "length"          -> TRUNCATED, never retried          -> QWEN_UNPARSEABLE
//   strip every <think>...</think> and one surrounding code fence, then JSON.parse the WHOLE rest;
//   an unclosed <think>, an empty rest, two JSON objects, prose, arrays -> QWEN_UNPARSEABLE
//   F2: verdict === "approve" exactly -> approve; === "deny" exactly -> QWEN_DENIED;
//       anything else ("Approve", " approve", "approve_with_conditions", "approve, but ...",
//       missing) -> QWEN_UNPARSEABLE. (Stricter than the design's trim().toLowerCase(): prompt.md
//       §18 forbids treating "Approve" as approval; both are fail-closed.)
//   F1: shape only. vendor/gpu are free strings (an unknown vendor label goes to the gate and
//       gets VENDOR_NOT_ALLOWED, which keeps the D5 injection visible); amount must be a positive
//       USD decimal with <= 6 decimals (string or JSON number), else QWEN_UNPARSEABLE.
import { parseUsd } from './rules.ts';

export type ParseFail = { ok: false; code: 'QWEN_UNPARSEABLE'; reason: 'TRUNCATED' | 'EMPTY' | 'UNCLOSED_THINK' | 'NOT_JSON' | 'NOT_OBJECT' | 'DUPLICATE_KEY' | 'SCHEMA' };
export type ParseOk<T> = { ok: true; value: T };

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;

/**
 * True when any object in (already valid) JSON text repeats a key. JSON.parse silently keeps the
 * last duplicate, so {"verdict":"deny","verdict":"approve"} would otherwise read as approve.
 */
export function hasDuplicateKeys(text: string): boolean {
  const stack: ({ obj: true; keys: Set<string>; expectKey: boolean } | { obj: false })[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.obj && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return true;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (ch === '{') stack.push({ obj: true, keys: new Set(), expectKey: true });
    else if (ch === '[') stack.push({ obj: false });
    else if (ch === '}' || ch === ']') stack.pop();
    else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top && top.obj) top.expectKey = true;
    }
  }
  return false;
}
const FENCE = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?\s*```$/;

/** Extract the single JSON object an answer must consist of. */
export function extractJson(raw: string | null | undefined, finishReason: string | null = null): ParseOk<Record<string, unknown>> | ParseFail {
  if (finishReason === 'length') return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'TRUNCATED' };
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'EMPTY' };
  let s = raw.replace(THINK_BLOCK, '');
  if (/<\/?think>/.test(s)) return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'UNCLOSED_THINK' };
  s = s.trim();
  const fence = FENCE.exec(s);
  if (fence) s = fence[1]!.trim();
  if (s === '') return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'EMPTY' };
  let v: unknown;
  try {
    v = JSON.parse(s);
  } catch {
    return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'NOT_JSON' };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'NOT_OBJECT' };
  if (hasDuplicateKeys(s)) return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'DUPLICATE_KEY' };
  return { ok: true, value: v as Record<string, unknown> };
}

export type Verdict = { verdict: 'approve' | 'deny'; reason: string };
export type VerdictResult =
  | { ok: true; verdict: 'approve'; reason: string }
  | { ok: false; code: 'QWEN_DENIED'; reason: string }
  | ParseFail;

/** F2 verdict from an extracted object. Exact "approve" is the ONLY approval. */
export function parseVerdict(x: ParseOk<Record<string, unknown>> | ParseFail): VerdictResult {
  if (!x.ok) return x;
  const { verdict, reason } = x.value;
  if (typeof verdict !== 'string' || typeof reason !== 'string') return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'SCHEMA' };
  if (verdict === 'approve') return { ok: true, verdict: 'approve', reason };
  if (verdict === 'deny') return { ok: false, code: 'QWEN_DENIED', reason };
  return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'SCHEMA' };
}

/** Convenience: raw F2 content -> verdict (what the auditor recomputes). */
export function verdictFromRaw(raw: string | null, finishReason: string | null = null): VerdictResult {
  return parseVerdict(extractJson(raw, finishReason));
}

export type F1Parsed = { vendor: string; gpu: string; amount: string; amountMicro: bigint; reason: string };

/** F1 work_request: shape check only. */
export function parseF1(x: ParseOk<Record<string, unknown>> | ParseFail): ParseOk<F1Parsed> | ParseFail {
  if (!x.ok) return x;
  const { vendor, gpu, amount, reason } = x.value;
  if (typeof vendor !== 'string' || !vendor.trim()) return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'SCHEMA' };
  if (typeof gpu !== 'string' || !gpu.trim()) return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'SCHEMA' };
  if (typeof reason !== 'string') return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'SCHEMA' };
  let amountStr: string;
  if (typeof amount === 'string') amountStr = amount.trim();
  else if (typeof amount === 'number' && Number.isFinite(amount)) amountStr = String(amount);
  else return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'SCHEMA' };
  let micro: bigint;
  try {
    micro = parseUsd(amountStr); // rejects "$3", "-1", "1e-7", 7+ decimals
  } catch {
    return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'SCHEMA' };
  }
  if (micro <= 0n) return { ok: false, code: 'QWEN_UNPARSEABLE', reason: 'SCHEMA' };
  return { ok: true, value: { vendor: vendor.trim(), gpu: gpu.trim(), amount: amountStr, amountMicro: micro, reason } };
}

export function f1FromRaw(raw: string | null, finishReason: string | null = null): ParseOk<F1Parsed> | ParseFail {
  return parseF1(extractJson(raw, finishReason));
}
