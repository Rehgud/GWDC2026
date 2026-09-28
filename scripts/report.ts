// report.ts — per-flow token / cost / energy table from llm.jsonl + gate pre-rejection savings (T12).
//   npm run report -- <bundleDir> [<bundleDir> ...] [--out file.md] [--json]
// Energy (design "Kiln 흐름과 효율"): E = sum(output tokens) x 1.63 J (RNGD, Furiosa blog
// 2026-04-02: 8-card server 3 kW / (46 users x 40 tok/s)). Same conditions RTX Pro 6000: 4.02 J.
// Assumptions: rated power, full load, no PUE, prefill (input) tokens excluded. Upper reference:
// 4 x 180 W RNGD serving one unbatched request at 60.6 tok/s -> 11.9 J/token. Kiln's real serving
// setup is unknown. Calls whose cost is missing are shown as "미상" (unknown), never as $0.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { costToMicro } from '../backend/kiln.ts';
import { formatUsd } from '../backend/rules.ts';

export const J_PER_TOKEN = { RNGD: 1.63, RTX_PRO_6000: 4.02, RNGD_UNBATCHED_UPPER: 11.9 } as const;

type Line = {
  flow: 'F1' | 'F2' | 'F3';
  attempt: number;
  http: number | null;
  latency_ms: number;
  gen_id: string | null;
  finish_reason: string | null;
  usage: { prompt_tokens: number; completion_tokens: number; reasoning_tokens?: number; cost: string | null } | null;
  cost_known: boolean;
  error: string | null;
  llm_mode: string;
};

export type FlowRow = {
  flow: string;
  calls: number;
  attempts: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costKnownMicro: string;
  costUnknownCalls: number;
  energyJ: number;
  energyJRtx: number;
  p50ms: number;
  p95ms: number;
};

export type Metrics = {
  bundles: string[];
  llmModes: string[];
  flows: FlowRow[];
  total: FlowRow;
  gate: { requests: number; gateDenied: number; f2Calls: number; f2SavedCalls: number; f2AvgTokens: number; f2SavedTokensEst: number; f2SavedEnergyJEst: number; codes: Record<string, number> };
};

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
};

function row(flow: string, lines: Line[]): FlowRow {
  const byCall = lines.filter((l) => l.attempt === 1).length;
  const costs = lines.map((l) => (l.usage && l.cost_known ? l.usage.cost : null));
  const { micro, unknown } = costToMicro(costs);
  const out = lines.reduce((s, l) => s + (l.usage?.completion_tokens ?? 0), 0);
  return {
    flow,
    calls: byCall,
    attempts: lines.length,
    failed: lines.filter((l) => l.error).length,
    inputTokens: lines.reduce((s, l) => s + (l.usage?.prompt_tokens ?? 0), 0),
    outputTokens: out,
    reasoningTokens: lines.reduce((s, l) => s + (l.usage?.reasoning_tokens ?? 0), 0),
    costKnownMicro: micro.toString(),
    costUnknownCalls: unknown,
    energyJ: +(out * J_PER_TOKEN.RNGD).toFixed(2),
    energyJRtx: +(out * J_PER_TOKEN.RTX_PRO_6000).toFixed(2),
    p50ms: pct(lines.map((l) => l.latency_ms), 50),
    p95ms: pct(lines.map((l) => l.latency_ms), 95),
  };
}

export function computeMetrics(dirs: string[]): Metrics {
  const lines: Line[] = [];
  let requests = 0;
  let gateDenied = 0;
  const codes: Record<string, number> = {};
  for (const d of dirs) {
    const f = join(d, 'llm.jsonl');
    if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean)) lines.push(JSON.parse(l));
    const rd = join(d, 'records');
    if (!existsSync(rd)) continue;
    for (const name of readdirSync(rd)) {
      const r = JSON.parse(readFileSync(join(rd, name), 'utf8'));
      if (r.kind !== 'REQUEST') continue;
      requests++;
      if (Array.isArray(r.body.gateResult) && r.body.gateResult.length > 0 && !r.body.f2) {
        gateDenied++;
        codes[r.body.gateResult[0]] = (codes[r.body.gateResult[0]] ?? 0) + 1;
      }
    }
  }
  const flows = (['F1', 'F2', 'F3'] as const).map((f) => row(f, lines.filter((l) => l.flow === f)));
  const f2 = lines.filter((l) => l.flow === 'F2' && l.usage);
  const f2Avg = f2.length ? f2.reduce((s, l) => s + (l.usage!.prompt_tokens + l.usage!.completion_tokens), 0) / f2.length : 0;
  const f2AvgOut = f2.length ? f2.reduce((s, l) => s + l.usage!.completion_tokens, 0) / f2.length : 0;
  return {
    bundles: dirs,
    llmModes: [...new Set(lines.map((l) => l.llm_mode))],
    flows,
    total: row('total', lines),
    gate: {
      requests,
      gateDenied,
      f2Calls: flows[1]!.calls,
      f2SavedCalls: gateDenied,
      f2AvgTokens: Math.round(f2Avg),
      f2SavedTokensEst: Math.round(gateDenied * f2Avg),
      f2SavedEnergyJEst: +(gateDenied * f2AvgOut * J_PER_TOKEN.RNGD).toFixed(2),
      codes,
    },
  };
}

export function renderMarkdown(m: Metrics): string {
  const usd = (micro: string, unknown: number) => `$${formatUsd(BigInt(micro))}${unknown ? ` + 미상 ${unknown}` : ''}`;
  const lines = [
    `### Kiln usage by flow (${m.llmModes.join(', ') || 'no calls'}${m.llmModes.includes('stub') ? ' — STUB: not submission evidence' : ''})`,
    '',
    '| flow | calls | attempts (failed) | input tok | output tok | cost | energy RNGD (1.63 J/tok) | RTX Pro 6000 (4.02 J/tok) | p50 / p95 ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...[...m.flows, m.total].map(
      (r) => `| ${r.flow} | ${r.calls} | ${r.attempts} (${r.failed}) | ${r.inputTokens} | ${r.outputTokens} | ${usd(r.costKnownMicro, r.costUnknownCalls)} | ${r.energyJ} J | ${r.energyJRtx} J | ${r.p50ms} / ${r.p95ms} |`,
    ),
    '',
    `**Gate pre-rejection:** ${m.gate.gateDenied} of ${m.gate.requests} requests were denied by the code gate before F2, so F2 was not called ${m.gate.f2SavedCalls} time(s)` +
      ` (~${m.gate.f2SavedTokensEst} tokens, ~${m.gate.f2SavedEnergyJEst} J at the observed F2 average of ${m.gate.f2AvgTokens} tokens/call). Codes: ${Object.entries(m.gate.codes).map(([k, v]) => `${k}×${v}`).join(', ') || 'none'}.`,
    '',
    `Energy assumptions: E = Σ output tokens × 1.63 J (RNGD, Furiosa blog 2026-04-02: 3 kW / (46 users × 40 tok/s)); rated power, full load, PUE excluded, prefill excluded. Upper reference (unbatched, 4×180 W at 60.6 tok/s): ${J_PER_TOKEN.RNGD_UNBATCHED_UPPER} J/token. Kiln's actual serving setup is unknown.`,
  ];
  return lines.join('\n') + '\n';
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : null;
  const dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  if (!dirs.length) {
    console.error('usage: npm run report -- <bundleDir> [...] [--out metrics.md] [--json]');
    process.exit(2);
  }
  const m = computeMetrics(dirs);
  const text = args.includes('--json') ? JSON.stringify(m, null, 2) : renderMarkdown(m);
  if (out) writeFileSync(out, text);
  console.log(text);
}
