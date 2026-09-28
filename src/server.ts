// T10 founder dashboard: a localhost-only HTTP server around ONE static page (public/index.html).
//   GET /        the page (CSP: only its own inline script, connect-src 'self')
//   GET /state   session.state() (StateView)         GET /health  state().health
//   GET /report  <session.dir>/report.md (text/plain) or 404
//   POST /action ActionRequest -> session.action(): Origin-checked, JSON only, <= 4 KB, strict shape, one at a time.
// CLI: node --env-file-if-exists=.env src/server.ts --scenario <name> [--port N] [--speed N] [--chain anvil|base-sepolia] [--rpc URL]
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import type { ActionRequest, StateView } from './types.ts'

export type ActionResult = { ok: true } | { ok: false; status: 409 | 400; reason: string }

/** All the server needs from a session. The orchestrator's Session satisfies it; tests pass a fake. */
export type DashboardSession = {
  state(): StateView
  action(req: ActionRequest): Promise<ActionResult>
  start?(): Promise<unknown>
  run?(): Promise<unknown> // start + loop + windDown, preferred by the CLI when present
  dir?: string // bundle dir runs/<vault>; GET /report serves <dir>/report.md
}

const HTML = new URL('../public/index.html', import.meta.url)
const MAX_BODY = 4096
const REASONS = ['SCOPE_DRIFT', 'BUDGET_CONCERN', 'MANUAL'] as const

/** Strict ActionRequest check: exact key set, known values. Returns a fresh object or null. */
export function parseAction(x: unknown): ActionRequest | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null
  const o = x as Record<string, unknown>
  const keys = Object.keys(o).sort().join(',')
  const v = o.stateVersion
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return null
  if (o.type === 'STOP' && keys === 'reason,stateVersion,type' && (REASONS as readonly unknown[]).includes(o.reason))
    return { type: 'STOP', reason: o.reason as (typeof REASONS)[number], stateVersion: v }
  if (o.type === 'WIND_DOWN' && keys === 'stateVersion,type') return { type: 'WIND_DOWN', stateVersion: v }
  return null
}

const COMMON = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' }

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}) {
  res.writeHead(status, { ...COMMON, 'content-type': type, ...extra })
  res.end(body)
}
const json = (res: ServerResponse, status: number, v: unknown, extra?: Record<string, string>) =>
  send(res, status, JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)), 'application/json; charset=utf-8', extra)

/** Body as a string, or null once it passes MAX_BODY (the rest is not buffered). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > MAX_BODY) { req.pause(); resolve(null) } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function page(res: ServerResponse) {
  const html = await readFile(HTML, 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  const sha = createHash('sha256').update(script, 'utf8').digest('base64')
  const csp = `default-src 'none'; script-src 'sha256-${sha}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  send(res, 200, html, 'text/html; charset=utf-8', { 'content-security-policy': csp })
}

export function startServer(o: { session: DashboardSession; port?: number; host?: string }): Promise<{ server: Server; port: number; url: string }> {
  const { session, port = 8787, host = '127.0.0.1' } = o
  if (host !== '127.0.0.1') throw new Error('the dashboard binds 127.0.0.1 only')
  let busy = false // one founder action at a time (double-click / second tab -> 409)

  const server = createServer((req, res) => {
    handle(req, res).catch(() => { // never echo a stack
      if (!res.headersSent) json(res, 500, { ok: false, reason: 'internal error' })
      else res.destroy()
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const p = (server.address() as AddressInfo).port
    // DNS-rebinding guard: only our own host names reach any route.
    if (req.headers.host !== `127.0.0.1:${p}` && req.headers.host !== `localhost:${p}`) return json(res, 403, { ok: false, reason: 'bad host' })
    const path = (req.url ?? '/').split('?')[0]
    const get = req.method === 'GET'
    if (get && path === '/') return page(res)
    if (get && path === '/state') return json(res, 200, session.state())
    if (get && path === '/health') return json(res, 200, session.state().health)
    if (get && path === '/report') {
      const txt = session.dir ? await readFile(join(session.dir, 'report.md'), 'utf8').catch(() => null) : null
      return txt === null ? json(res, 404, { error: 'no report yet' }) : send(res, 200, txt, 'text/plain; charset=utf-8')
    }
    if (req.method === 'POST' && path === '/action') return action(req, res, p)
    return json(res, 404, { error: 'not found' })
  }

  async function action(req: IncomingMessage, res: ServerResponse, p: number) {
    const origin = req.headers.origin
    if (origin !== `http://127.0.0.1:${p}` && origin !== `http://localhost:${p}`) return json(res, 403, { ok: false, reason: 'bad origin' })
    const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (ct !== 'application/json') return json(res, 415, { ok: false, reason: 'application/json only' })
    const tooBig = () => json(res, 413, { ok: false, reason: `body > ${MAX_BODY} bytes` }, { connection: 'close' })
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return tooBig()
    const body = await readBody(req)
    if (body === null) return tooBig()
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { return json(res, 400, { ok: false, reason: 'invalid JSON' }) }
    const a = parseAction(parsed)
    if (!a) return json(res, 400, { ok: false, reason: 'expected {type:"STOP",reason,stateVersion} or {type:"WIND_DOWN",stateVersion}' })
    if (busy) return json(res, 409, { ok: false, reason: 'another action is pending' })
    busy = true
    try {
      const r = await session.action(a)
      if (r.ok) return json(res, 200, { ok: true })
      return json(res, r.status === 409 ? 409 : 400, { ok: false, reason: String(r.reason) })
    } finally {
      busy = false
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const p = (server.address() as AddressInfo).port
      resolve({ server, port: p, url: `http://127.0.0.1:${p}/` })
    })
  })
}

// ---- CLI ----
const USAGE = 'usage: node --env-file-if-exists=.env src/server.ts --scenario <name> [--port N] [--speed N] [--chain anvil|base-sepolia] [--rpc URL]'

async function main() {
  const { values: a } = parseArgs({
    options: { scenario: { type: 'string' }, port: { type: 'string' }, speed: { type: 'string' }, chain: { type: 'string' }, rpc: { type: 'string' } },
  })
  if (!a.scenario) throw new Error(USAGE)
  const chain = a.chain ?? process.env.CHAIN ?? 'anvil'
  if (chain !== 'anvil' && chain !== 'base-sepolia') throw new Error(`--chain must be anvil or base-sepolia (got ${chain})`)
  if (a.speed !== undefined && !(Number(a.speed) > 0)) throw new Error(`--speed must be a positive number (got ${a.speed})`)
  // Loaded at runtime so this file (and its tests) work while the orchestrator is missing or changing.
  let run: any, scn: any, ses: any, kiln: any
  try {
    ;[run, scn, ses, kiln] = await Promise.all([import('./run.ts'), import('./scenarios.ts'), import('./session.ts'), import('./kiln.ts')])
  } catch (e) {
    throw new Error(`cannot load the orchestrator (src/run.ts, src/scenarios.ts, src/session.ts): ${(e as Error).message}`)
  }
  if (typeof run.createSession !== 'function' || typeof scn.scenario !== 'function' || typeof ses.Session?.deployFor !== 'function')
    throw new Error('orchestrator API mismatch: need createSession() in src/run.ts, scenario() in src/scenarios.ts, Session.deployFor() in src/session.ts')
  kiln.llmMode?.() // LLM_MODE unset -> fail here, not after a (testnet) deploy
  const sc = scn.scenario(a.scenario)
  const rpc = a.rpc || process.env.RPC_URL || (chain === 'anvil' ? 'http://127.0.0.1:8545' : 'https://sepolia.base.org')

  // Listen before deploying: a busy port fails before any tx, and the page shows "connecting" while the vault deploys.
  let session: DashboardSession | null = null
  const { url } = await startServer({
    port: a.port ? Number(a.port) : 8787,
    session: {
      state: () => { if (!session) throw new Error('session not started'); return session.state() },
      action: async (r) => (session ? session.action(r) : { ok: false, status: 409, reason: 'session not started' }),
      get dir() { return session?.dir },
    },
  })
  console.log(`dashboard    ${url}`)
  console.log(`deploying a fresh vault for scenario "${sc.name}" on ${chain} ...`)
  const deployment = await ses.Session.deployFor(sc, { chain, rpcUrls: [rpc], log: (s: string) => console.log(`  ${s}`) })
  const s: DashboardSession = run.createSession({ deployment, chain, rpcUrls: [rpc], scenario: sc, speed: a.speed ? Number(a.speed) : undefined })
  session = s
  const go = s.run ?? s.start
  try {
    if (go) await go.call(s)
    console.log('session finished; the dashboard stays up (Ctrl+C to exit)')
  } catch (e) {
    // Keep serving: the HALTED / STALE banners matter most right after a failure.
    console.error(`session failed: ${(e as Error)?.message ?? e}; the dashboard stays up (Ctrl+C to exit)`)
  }
}

if (import.meta.main) {
  main().catch((e) => { console.error(`server: ${e?.message ?? e}`); process.exit(1) })
}
