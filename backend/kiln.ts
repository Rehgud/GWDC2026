// kiln.ts — the llm(flow) wrapper around Kiln (qwen3-32b), fail-closed (T7, D4).
//
//   - fetch + AbortSignal only (no SDK). OpenAI-compatible POST {KILN_URL}/chat/completions.
//     No response_format (Kiln returns empty content with it).
//   - timeout 10 s per attempt (F1/F2), no retry on timeout or network error -> QWEN_UNAVAILABLE
//   - ONE retry only for 429 with reset <= 5 s (or no reset header) and 5xx, after 1-2 s jitter.
//     429 with reset > 5 s, or 5xx with Retry-After in the future beyond 5 s -> refuse at once.
//   - finish_reason=length -> TRUNCATED (QWEN_UNPARSEABLE), never retried.
//   - process-wide semaphore of 4 concurrent requests (Kiln allows 8; the team shares the key).
//   - hard cap (D2): warn above 80% of LLM_CALL_CAP calls or of the INFERENCE hold in cost;
//     refuse with LLM_CALL_CAP (no fetch) before 100% is reached.
//   - every attempt, failed ones included, is appended to llm.jsonl with ALLOWED FIELDS ONLY:
//     {ts, flow, attempt, http, latency_ms, gen_id, finish_reason, usage, cost_known, error,
//      llm_mode, model, messages}. Never headers, error objects or absolute paths.
//   - LLM_MODE must be explicit (kiln | stub). No default, no automatic fallback. Stub gen ids
//     start with "stub-" so `audit --submission` can FAIL a bundle that contains one.
import { appendFileSync } from 'node:fs';
import type { DenyCode } from './codes.ts';
import type { LlmAttempt, LlmEvidence, Usage } from './record.ts';

export type LlmMode = 'kiln' | 'stub';
export type Flow = 'F1' | 'F2' | 'F3';
export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

export type StubReply = {
  content: string | null;
  finish_reason?: string;
  usage?: Partial<Usage>;
  /** simulate an HTTP status (429 / 500 / ...) instead of a 200 */
  http?: number;
  /** simulate latency; > timeout -> TIMEOUT */
  delayMs?: number;
  headers?: Record<string, string>;
};
export type StubResponder = (flow: Flow, messages: Msg[], attempt: number) => StubReply | Promise<StubReply>;

export type LlmConfig = {
  mode: LlmMode;
  model: string;
  url?: string;
  apiKey?: string;
  callCap: number;
  /** INFERENCE hold in micro-USD; cumulative known cost must stay below it */
  costCapMicro?: bigint;
  timeoutMs?: { F1: number; F2: number; F3: number };
  maxTokens?: { F1: number; F2: number; F3: number };
  noThink?: boolean;
  concurrency?: number;
  jsonlPath?: string;
  stub?: StubResponder;
  /** test seams */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  jitterMs?: () => number;
  now?: () => number;
  onWarn?: (msg: string) => void;
};

export class LlmConfigError extends Error {
  override name = 'LlmConfigError';
}

/** Resolve LLM_MODE strictly: throws when unset or unknown (no default, no fallback). */
export function llmModeFromEnv(v: string | undefined): LlmMode {
  if (v === 'kiln' || v === 'stub') return v;
  throw new LlmConfigError(`LLM_MODE must be set explicitly to "kiln" or "stub" (got ${JSON.stringify(v ?? null)})`);
}

// ------------------------------------------------------------------------------ cost
const COST_SCALE = 24; // exact decimal accumulation at 1e-24 USD

/** Parse a decimal (incl. exponent, e.g. "1.4e-4") into integer units of 1e-24. null if invalid. */
export function costUnits(c: string | number | null | undefined): bigint | null {
  if (c === null || c === undefined) return null;
  const s = typeof c === 'number' ? (Number.isFinite(c) ? c.toString() : '') : c.trim();
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return null;
  const digits = BigInt(m[1]! + (m[2] ?? ''));
  const exp = Number(m[3] ?? '0') - (m[2]?.length ?? 0) + COST_SCALE;
  if (exp < 0) {
    const d = 10n ** BigInt(-exp);
    return (digits + d - 1n) / d; // round up: never under-count cost
  }
  return digits * 10n ** BigInt(exp);
}

/**
 * B6: sum usage.cost over the session, then ceil(sum * 1e6) ONCE -> micro-USDC for the INFERENCE
 * settle. Calls whose cost is unknown are counted separately (reported as "미상", never as $0).
 */
export function costToMicro(costs: readonly (string | number | null | undefined)[]): { micro: bigint; unknown: number } {
  let sum = 0n;
  let unknown = 0;
  for (const c of costs) {
    const u = costUnits(c);
    if (u === null) unknown++;
    else sum += u;
  }
  const d = 10n ** BigInt(COST_SCALE - 6);
  return { micro: (sum + d - 1n) / d, unknown };
}

// ------------------------------------------------------------------------------ semaphore
class Semaphore {
  private active = 0;
  private q: (() => void)[] = [];
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.q.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.q.shift()?.();
    }
  }
}
let globalSem: Semaphore | null = null;

// ------------------------------------------------------------------------------ client
function toUsage(u: unknown): Usage | null {
  if (!u || typeof u !== 'object') return null;
  const x = u as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const details = (x.completion_tokens_details ?? {}) as Record<string, unknown>;
  const cost = x.cost;
  return {
    prompt_tokens: num(x.prompt_tokens),
    completion_tokens: num(x.completion_tokens),
    total_tokens: num(x.total_tokens),
    reasoning_tokens: num(details.reasoning_tokens ?? x.reasoning_tokens),
    cost: typeof cost === 'number' || typeof cost === 'string' ? String(cost) : null,
  };
}

/** seconds to wait from a 429/5xx response; null when absent */
function resetSeconds(h: (k: string) => string | null, now: number): number | null {
  const reset = h('x-ratelimit-reset') ?? h('x-ratelimit-reset-requests');
  if (reset !== null) {
    const n = Number(reset.replace(/s$/, ''));
    if (Number.isFinite(n)) return n > 1e9 ? Math.max(0, n - now / 1000) : n; // epoch or delta
  }
  const ra = h('retry-after');
  if (ra !== null) {
    const n = Number(ra);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(ra);
    if (!Number.isNaN(t)) return Math.max(0, (t - now) / 1000);
  }
  return null;
}

type AttemptOut = { attempt: LlmAttempt; raw: string | null; status: 'ok' | 'retry' | 'fail'; code: DenyCode | null; waitMs: number };

export class LlmClient {
  private readonly cfg: LlmConfig;
  private calls = 0;
  private costSum = 0n; // 1e-24 units
  private stubSeq = 0;
  private warned = false;
  private readonly sem: Semaphore;

  constructor(cfg: LlmConfig) {
    if (cfg.mode !== 'kiln' && cfg.mode !== 'stub') throw new LlmConfigError('mode must be kiln | stub');
    if (cfg.mode === 'kiln' && (!cfg.url || !cfg.apiKey)) throw new LlmConfigError('LLM_MODE=kiln needs KILN_URL and KILN_API_KEY');
    if (cfg.mode === 'stub' && !cfg.stub) throw new LlmConfigError('LLM_MODE=stub needs a stub responder');
    this.cfg = cfg;
    if (cfg.concurrency) this.sem = new Semaphore(cfg.concurrency);
    else this.sem = globalSem ??= new Semaphore(4);
  }

  get mode(): LlmMode {
    return this.cfg.mode;
  }
  callCount(): number {
    return this.calls;
  }
  /** known cost so far in micro-USD (ceil) */
  costMicro(): bigint {
    const d = 10n ** BigInt(COST_SCALE - 6);
    return (this.costSum + d - 1n) / d;
  }

  private now(): number {
    return this.cfg.now ? this.cfg.now() : Date.now();
  }
  private sleep(ms: number): Promise<void> {
    return this.cfg.sleep ? this.cfg.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }
  private jitter(): number {
    return this.cfg.jitterMs ? this.cfg.jitterMs() : 1000 + Math.floor(Math.random() * 1000);
  }

  /** D2 hard cap: refuse BEFORE the next call would reach 100% of the call or cost budget. */
  private capCheck(): { blocked: boolean; warn: boolean } {
    const next = this.calls + 1;
    const cap = this.cfg.callCap;
    let blocked = next > cap;
    let warn = next > Math.floor(cap * 0.8);
    if (this.cfg.costCapMicro !== undefined) {
      const capUnits = this.cfg.costCapMicro * 10n ** BigInt(COST_SCALE - 6);
      // leave headroom of 2x the average call cost so a single call cannot cross 100%
      const avg = this.calls > 0 ? this.costSum / BigInt(this.calls) : 0n;
      if (this.costSum + 2n * avg >= capUnits) blocked = true;
      if (this.costSum * 10n > capUnits * 8n) warn = true;
    }
    return { blocked, warn };
  }

  private log(flow: Flow, a: LlmAttempt, messages: Msg[]): void {
    if (!this.cfg.jsonlPath) return;
    const line = {
      ts: new Date(this.now()).toISOString(),
      flow,
      attempt: a.attempt,
      http: a.http,
      latency_ms: a.latency_ms,
      gen_id: a.gen_id,
      finish_reason: a.finish_reason,
      usage: a.usage,
      cost_known: a.cost_known,
      error: a.error,
      llm_mode: this.cfg.mode,
      model: this.cfg.model,
      messages,
    };
    appendFileSync(this.cfg.jsonlPath, JSON.stringify(line) + '\n');
  }

  private async attempt(flow: Flow, messages: Msg[], n: number, isRetry: boolean): Promise<AttemptOut> {
    const timeout = this.cfg.timeoutMs?.[flow] ?? (flow === 'F3' ? 15_000 : 10_000);
    const maxTokens = this.cfg.maxTokens?.[flow] ?? (flow === 'F3' ? 256 : 512);
    const t0 = this.now();
    const base: LlmAttempt = { attempt: n, http: null, latency_ms: 0, gen_id: null, finish_reason: null, usage: null, cost_known: false, error: null };
    const done = (a: Partial<LlmAttempt>, raw: string | null, status: AttemptOut['status'], code: DenyCode | null, waitMs = 0): AttemptOut => {
      const attempt = { ...base, ...a, latency_ms: Math.max(0, this.now() - t0) };
      return { attempt, raw, status, code, waitMs };
    };
    this.calls++;

    let http: number;
    let body: unknown = null;
    let header: (k: string) => string | null = () => null;
    let genId: string | null = null;
    try {
      if (this.cfg.mode === 'stub') {
        const r = await this.cfg.stub!(flow, messages, n);
        if ((r.delayMs ?? 0) >= timeout) {
          await this.sleep(timeout);
          return done({ error: 'TIMEOUT' }, null, 'fail', 'QWEN_UNAVAILABLE');
        }
        if (r.delayMs) await this.sleep(r.delayMs);
        http = r.http ?? 200;
        genId = `stub-${++this.stubSeq}`;
        const hs = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
        header = (k) => hs[k] ?? null;
        body = http === 200 ? { choices: [{ message: { content: r.content }, finish_reason: r.finish_reason ?? 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0, ...r.usage } } : { error: 'stub' };
      } else {
        const f = this.cfg.fetchImpl ?? fetch;
        const res = await f(`${this.cfg.url!.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({ model: this.cfg.model, messages, max_tokens: maxTokens, temperature: 0, stream: false }),
          signal: AbortSignal.timeout(timeout),
        });
        http = res.status;
        header = (k) => res.headers.get(k);
        genId = res.headers.get('x-neocloud-generation-id');
        try {
          body = await res.json();
        } catch {
          body = null;
        }
      }
    } catch (e) {
      const name = (e as Error)?.name;
      const err = name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
      return done({ error: err }, null, 'fail', 'QWEN_UNAVAILABLE');
    }

    if (http === 429 || http >= 500) {
      const wait = resetSeconds(header, this.now());
      const errName = http === 429 ? 'HTTP_429' : 'HTTP_5XX';
      if (isRetry) return done({ http, gen_id: genId, error: errName }, null, 'fail', 'QWEN_UNAVAILABLE');
      if (wait !== null && wait > 5) return done({ http, gen_id: genId, error: `${errName}_RESET_${Math.ceil(wait)}S` }, null, 'fail', 'QWEN_UNAVAILABLE');
      const waitMs = Math.max(wait !== null ? Math.ceil(wait * 1000) : 0, this.jitter());
      return done({ http, gen_id: genId, error: errName }, null, 'retry', null, waitMs);
    }
    if (http !== 200) return done({ http, gen_id: genId, error: `HTTP_${http}` }, null, 'fail', 'QWEN_UNAVAILABLE');

    const b = (body ?? {}) as { id?: string; choices?: { message?: { content?: string | null }; finish_reason?: string }[]; usage?: unknown };
    const choice = b.choices?.[0];
    const usage = toUsage(b.usage);
    const costU = usage ? costUnits(usage.cost) : null;
    if (costU !== null) this.costSum += costU;
    const a: Partial<LlmAttempt> = {
      http,
      gen_id: genId ?? (typeof b.id === 'string' ? b.id : null),
      finish_reason: choice?.finish_reason ?? null,
      usage,
      cost_known: costU !== null,
    };
    const raw = typeof choice?.message?.content === 'string' ? choice.message.content : null;
    if (a.finish_reason === 'length') return done({ ...a, error: 'TRUNCATED' }, raw, 'fail', 'QWEN_UNPARSEABLE');
    if (!raw || !raw.trim()) return done({ ...a, error: 'EMPTY' }, raw, 'fail', 'QWEN_UNPARSEABLE');
    return done(a, raw, 'ok', null);
  }

  /**
   * One flow call. Never throws for model/HTTP problems: the returned evidence carries
   * `code` (QWEN_UNAVAILABLE / QWEN_UNPARSEABLE / LLM_CALL_CAP) when there is no usable answer.
   * Parsing of `raw` into a decision is the caller's job (parse.ts).
   */
  async call(flow: Flow, messages: Msg[]): Promise<LlmEvidence> {
    const msgs = this.cfg.noThink === false ? messages : withNoThink(messages);
    const ev: LlmEvidence = { flow, llm_mode: this.cfg.mode, model: this.cfg.model, messages: msgs, attempts: [], raw: null, gen_id: null, usage: null, code: null };
    const cap = this.capCheck();
    if (cap.blocked) {
      ev.code = 'LLM_CALL_CAP';
      return ev;
    }
    if (cap.warn && !this.warned) {
      this.warned = true;
      this.cfg.onWarn?.(`LLM usage above 80% of the cap (${this.calls}/${this.cfg.callCap} calls, ${this.costMicro()} micro-USD)`);
    }
    return this.sem.run(async () => {
      for (let n = 1; n <= 2; n++) {
        const out = await this.attempt(flow, msgs, n, n === 2);
        ev.attempts.push(out.attempt);
        this.log(flow, out.attempt, msgs);
        if (out.status === 'ok') {
          ev.raw = out.raw;
          ev.gen_id = out.attempt.gen_id;
          ev.usage = out.attempt.usage;
          return ev;
        }
        if (out.status === 'fail') {
          ev.raw = out.raw;
          ev.gen_id = out.attempt.gen_id;
          ev.usage = out.attempt.usage;
          ev.code = out.code;
          return ev;
        }
        // retry: check the cap again before spending a second call
        if (this.capCheck().blocked) {
          ev.code = 'LLM_CALL_CAP';
          return ev;
        }
        await this.sleep(out.waitMs);
      }
      ev.code = 'QWEN_UNAVAILABLE';
      return ev;
    });
  }
}

/** Qwen3 soft switch: append /no_think to the last user message. */
export function withNoThink(messages: Msg[]): Msg[] {
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]!.role === 'user') {
      if (!out[i]!.content.includes('/no_think')) out[i]!.content = `${out[i]!.content}\n/no_think`;
      break;
    }
  }
  return out;
}
