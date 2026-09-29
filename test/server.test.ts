// T10 dashboard: server routes/guards against a fake session, static checks on public/index.html, and a headless
// render of the page script against the demo fixture (minimal DOM shim, node:vm).
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'
import { parseAction, startServer, type ActionResult, type DashboardSession } from '../src/server.ts'
import type { ActionRequest, StateView } from '../src/types.ts'

const FIXTURE: StateView = JSON.parse(readFileSync(new URL('./fixtures/state.json', import.meta.url), 'utf8'))
const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(HTML)![1]

type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string }
function req(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const h = { ...headers }
    if (body !== undefined && !h['transfer-encoding']) h['content-length'] = String(Buffer.byteLength(body))
    const r = request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }))
    })
    r.on('error', reject)
    if (body !== undefined) r.write(body)
    r.end()
  })
}

function makeFake(dir?: string) {
  const calls: ActionRequest[] = []
  const f = {
    calls,
    next: { ok: true } as ActionResult,
    hold: null as Promise<void> | null, // when set, action() waits on it (in-flight test)
    throws: false,
    dir,
    state: () => FIXTURE,
    async action(a: ActionRequest): Promise<ActionResult> {
      calls.push(a)
      if (f.throws) throw new Error('boom at /secret/path.ts:12')
      if (f.hold) await f.hold
      return f.next
    },
  }
  return f
}

describe('server', () => {
  let server: Server, port: number, fake: ReturnType<typeof makeFake>
  const origin = () => `http://127.0.0.1:${port}`
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    req(port, 'POST', '/action', { 'content-type': 'application/json', origin: origin(), ...headers }, typeof body === 'string' ? body : JSON.stringify(body))

  before(async () => {
    fake = makeFake()
    ;({ server, port } = await startServer({ session: fake as DashboardSession, port: 0 }))
  })
  after(() => server.close())

  test('binds 127.0.0.1 only; any other host is refused', async () => {
    assert.equal((server.address() as { address: string }).address, '127.0.0.1')
    assert.throws(() => startServer({ session: fake as DashboardSession, port: 0, host: '0.0.0.0' }), /127\.0\.0\.1 only/)
    const r = await req(port, 'GET', '/state', { host: `evil.example:${port}` }) // DNS rebinding
    assert.equal(r.status, 403)
  })

  test('GET /state returns the StateView as JSON, no-store', async () => {
    const r = await req(port, 'GET', '/state')
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /^application\/json/)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.deepEqual(JSON.parse(r.body), FIXTURE)
    const lh = await req(port, 'GET', '/state', { host: `localhost:${port}` })
    assert.equal(lh.status, 200)
  })

  test('GET /health, GET / with a CSP that pins the inline script, unknown routes 404, /report 404 without a bundle', async () => {
    assert.deepEqual(JSON.parse((await req(port, 'GET', '/health')).body), FIXTURE.health)
    const page = await req(port, 'GET', '/')
    assert.equal(page.status, 200)
    assert.match(String(page.headers['content-type']), /^text\/html/)
    assert.equal(page.body, HTML)
    const sha = createHash('sha256').update(SCRIPT, 'utf8').digest('base64')
    const csp = String(page.headers['content-security-policy'])
    assert.ok(csp.includes(`script-src 'sha256-${sha}'`), csp)
    assert.ok(csp.includes("connect-src 'self'"))
    for (const [m, p] of [['GET', '/nope'], ['GET', '/index.html'], ['POST', '/state'], ['GET', '/action'], ['DELETE', '/action']]) {
      assert.equal((await req(port, m, p)).status, 404, `${m} ${p}`)
    }
    assert.equal((await req(port, 'GET', '/report')).status, 404)
    const video = await req(port, 'GET', '/?video=1') // video mode is the same page, same pinned script
    assert.equal(video.status, 200)
    assert.equal(video.body, HTML)
    assert.equal(video.headers['content-security-policy'], csp)
  })

  test('POST /action guards: Origin 403, Content-Type 415, malformed 400, oversized 413; nothing reaches the session', async () => {
    const stop = { type: 'STOP', reason: 'MANUAL', stateVersion: 57 }
    assert.equal((await post(stop, { origin: 'http://evil.example' })).status, 403)
    assert.equal((await post(stop, { origin: `http://127.0.0.1:${port + 1}` })).status, 403)
    assert.equal((await req(port, 'POST', '/action', { 'content-type': 'application/json' }, JSON.stringify(stop))).status, 403) // no Origin
    assert.equal((await post(stop, { 'content-type': 'text/plain' })).status, 415)
    assert.equal((await post('type=STOP', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415)
    const bad: unknown[] = [
      '{', 'null', '[]', '"STOP"', {},
      { type: 'STOP', reason: 'MANUAL' }, // no stateVersion
      { type: 'STOP', reason: 'PANIC', stateVersion: 1 },
      { type: 'STOP', reason: 'MANUAL', stateVersion: '57' },
      { type: 'STOP', reason: 'MANUAL', stateVersion: -1 },
      { type: 'STOP', reason: 'MANUAL', stateVersion: 1.5 },
      { type: 'STOP', reason: 'MANUAL', stateVersion: 1, jobId: '1' }, // extra key
      { type: 'WIND_DOWN', stateVersion: 1, amount: '999' },
      { type: 'RESUME', stateVersion: 1 },
      { type: 'setPaused', args: [false], stateVersion: 1 },
    ]
    for (const b of bad) assert.equal((await post(b)).status, 400, JSON.stringify(b))
    const big = JSON.stringify({ ...stop, pad: 'x'.repeat(5000) })
    assert.equal((await post(big)).status, 413)
    const chunked = await req(port, 'POST', '/action', { 'content-type': 'application/json', origin: origin(), 'transfer-encoding': 'chunked' }, big)
    assert.equal(chunked.status, 413)
    assert.equal(fake.calls.length, 0)
  })

  test('POST /action: a valid STOP reaches the session exactly once; 409 passes through; one action at a time; no stack on throw', async () => {
    fake.calls.length = 0
    const stop: ActionRequest = { type: 'STOP', reason: 'SCOPE_DRIFT', stateVersion: 57 }
    const ok = await post(stop, { 'content-type': 'application/json; charset=utf-8' })
    assert.equal(ok.status, 200)
    assert.deepEqual(JSON.parse(ok.body), { ok: true })
    assert.deepEqual(fake.calls, [stop])

    fake.next = { ok: false, status: 409, reason: 'stale stateVersion' }
    const r409 = await post({ type: 'WIND_DOWN', stateVersion: 3 }, { origin: `http://localhost:${port}` })
    assert.equal(r409.status, 409)
    assert.deepEqual(JSON.parse(r409.body), { ok: false, reason: 'stale stateVersion' })
    fake.next = { ok: false, status: 400, reason: 'not all jobs stopped' }
    assert.equal((await post({ type: 'WIND_DOWN', stateVersion: 3 })).status, 400)
    fake.next = { ok: true }

    // while one action is in flight (e.g. setPaused awaiting its receipt), a second click gets 409 from the server
    let release!: () => void
    fake.hold = new Promise((r) => (release = r))
    fake.calls.length = 0
    const first = post({ type: 'STOP', reason: 'MANUAL', stateVersion: 58 })
    await new Promise((r) => setTimeout(r, 50))
    // race so a missing busy guard fails fast instead of deadlocking on fake.hold
    const second = await Promise.race([post({ type: 'STOP', reason: 'MANUAL', stateVersion: 58 }), new Promise<null>((r) => setTimeout(r, 500, null))])
    assert.equal(second?.status, 409)
    release()
    assert.equal((await first).status, 200)
    assert.equal(fake.calls.length, 1)
    fake.hold = null

    fake.throws = true
    const boom = await post({ type: 'WIND_DOWN', stateVersion: 60 })
    fake.throws = false
    assert.equal(boom.status, 500)
    assert.ok(!boom.body.includes('secret') && !boom.body.includes('boom'), boom.body)
    assert.equal((await post({ type: 'WIND_DOWN', stateVersion: 60 })).status, 200) // busy flag released after a throw
  })
})

test('GET /report serves <session.dir>/report.md as text/plain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-'))
  writeFileSync(join(dir, 'report.md'), '# report\n| tokens | 42 |\n')
  const { server, port } = await startServer({ session: makeFake(dir) as DashboardSession, port: 0 })
  try {
    const r = await req(port, 'GET', '/report')
    assert.equal(r.status, 200)
    assert.match(String(r.headers['content-type']), /^text\/plain/)
    assert.equal(r.body, '# report\n| tokens | 42 |\n')
  } finally {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseAction is strict and returns a fresh object', () => {
  const raw = { type: 'STOP', reason: 'BUDGET_CONCERN', stateVersion: 0 }
  const a = parseAction(raw)
  assert.deepEqual(a, raw)
  assert.notEqual(a, raw)
  assert.deepEqual(parseAction({ type: 'WIND_DOWN', stateVersion: 9 }), { type: 'WIND_DOWN', stateVersion: 9 })
  assert.equal(parseAction({ type: 'WIND_DOWN', stateVersion: 9, reason: 'MANUAL' }), null)
  assert.equal(parseAction(JSON.parse('{"type":"STOP","reason":"MANUAL","stateVersion":1,"__proto__":{"x":1}}')), null)
})

test('the dashboard CLI boots through run.ts bootSession (Akash warm-up + fresh vault + createSession), not a copy of it', () => {
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  assert.match(src, /await run\.bootSession\(\{ scenario: sc, chain, rpc,/)
  assert.doesNotMatch(src, /deployFor|createSession\(|AKASH_URL|fetch\(/)
})

test('index.html: single inline script/style, no innerHTML/eval/external URLs, every $(id) exists', () => {
  assert.equal(HTML.match(/<script/g)?.length, 1)
  assert.equal(HTML.match(/<style/g)?.length, 1)
  assert.ok(!/<script[^>]*\ssrc=/i.test(HTML))
  assert.ok(!/<link\b/i.test(HTML), 'no external stylesheets/fonts')
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', '@import']) assert.ok(!HTML.includes(bad), bad)
  assert.ok(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(HTML), 'no external URLs')
  assert.ok(!/localStorage|sessionStorage|WebSocket|XMLHttpRequest/.test(SCRIPT))
  const fetches = [...SCRIPT.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(fetches, ['/action', '/state'])
  const ids = new Set([...HTML.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  const used = [...SCRIPT.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1])
  for (const r of ['SCOPE_DRIFT', 'BUDGET_CONCERN', 'MANUAL']) used.push(`stop-${r}`)
  for (const id of used) assert.ok(ids.has(id), `missing #${id}`)
  assert.ok(!/resume/i.test(SCRIPT), 'no resume control')
})

// ---- headless render: run the page script against a minimal DOM shim ----
class El {
  tagName: string
  children: (El | { text: string })[] = []
  attrs: Record<string, string> = {}
  style: Record<string, string> = {}
  listeners: Record<string, (() => void)[]> = {}
  className = ''
  hidden = false
  disabled = false
  title = ''
  constructor(tag: string) { this.tagName = tag.toUpperCase() }
  append(...ns: (El | string)[]) {
    for (const n of ns) {
      if (n == null) throw new Error('null child (a real DOM would print "null")')
      this.children.push(typeof n === 'string' ? { text: n } : n)
    }
  }
  replaceChildren(...ns: (El | string)[]) { this.children = []; this.append(...ns) }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v) }
  addEventListener(t: string, f: () => void) { (this.listeners[t] ??= []).push(f) }
  click() { if (!this.disabled) for (const f of this.listeners.click ?? []) f() }
  get textContent(): string { return this.children.map((c) => (c instanceof El ? c.textContent : c.text)).join('') }
  set textContent(v: string) { this.children = [{ text: String(v) }] }
  set innerHTML(_v: string) { throw new Error('innerHTML used') }
  all(pred: (e: El) => boolean, out: El[] = []): El[] {
    if (pred(this)) out.push(this)
    for (const c of this.children) if (c instanceof El) c.all(pred, out)
    return out
  }
}

function boot(initial: StateView, search = '') {
  const ids = new Map<string, El>()
  const created: string[] = []
  const document = {
    title: '',
    documentElement: new El('html'),
    getElementById(id: string) { if (!ids.has(id)) ids.set(id, new El('div')); return ids.get(id)! },
    createElement(tag: string) { created.push(tag); return new El(tag) },
  }
  const env = {
    current: structuredClone(initial),
    posts: [] as unknown[],
    stateInits: [] as unknown[],
    reply: { status: 200, body: { ok: true } as unknown },
    timers: [] as (() => void)[],
    created,
    urls: [] as string[], // history.replaceState targets
    document,
    $: (id: string) => document.getElementById(id),
  }
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    if (url === '/state') env.stateInits.push(init)
    if (url === '/state') return { ok: true, status: 200, json: async () => structuredClone(env.current) }
    if (url === '/action' && init?.method === 'POST') {
      env.posts.push(JSON.parse(init.body!))
      const { status, body } = env.reply
      return { ok: status === 200, status, json: async () => body }
    }
    throw new Error(`unexpected fetch ${url}`)
  }
  const AbortSignal = { timeout: (ms: number) => ({ timeoutMs: ms }) }
  const location = { search, pathname: '/' }
  const history = { replaceState: (_s: unknown, _t: string, url: string) => env.urls.push(url) }
  vm.runInNewContext(SCRIPT, { document, fetch, AbortSignal, setTimeout: (f: () => void) => env.timers.push(f), console, location, history })
  return env
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)) }
const tick = async (env: ReturnType<typeof boot>) => { env.timers.shift()!(); await settle() }

test('index.html renders the demo fixture (three zones, terminal states, links, badges) and drives STOP once', async () => {
  const s = structuredClone(FIXTURE) as StateView
  s.topups.push({ req_id: 'demo-5fc8d326-r7', job_id: '2', action: 'topUp', stage: 'CHAIN', result: 'QWEN_NOT_A_JUDGEMENT', request: s.topups[1].request,
    gate: s.topups[1].gate, qwen: { verdict: null, reason: 'timeout 10s' }, code: 'QWEN_UNAVAILABLE', txHash: null, recHash: null })
  s.topups[2].request!.rationale = '<img src=x onerror=alert(1)>'
  const env = boot(s)
  await settle()
  const { $ } = env

  assert.equal($('run').textContent, 'demo-5fc8d326')
  assert.equal($('b-llm').textContent, 'LLM KILN')
  assert.equal($('b-price').textContent, 'PRICE LIVE')
  assert.match($('sync').textContent, /sync 1 s ago/)
  assert.equal($('banners').textContent, '')
  // GRANT
  assert.match($('spec').textContent, /LoRA fine-tune/)
  assert.match($('spec').textContent, /\d\dh \d\dm \d\ds/)
  assert.match($('budget').textContent, /\$20\.00/)
  assert.match($('budget').textContent, /환불 가능 CHAIN\$12\.0396/)
  assert.equal($('budget').all((e) => e.className === 'bar')[0].children.length, 4) // inference_paid = 0 is skipped
  assert.match($('vendors').textContent, /\$2\.56/)
  // LIVE: INFERENCE pinned first, tank with the 40% trigger line
  const rows = $('jobs').all((e) => e.tagName === 'TR')
  assert.match(rows[0].textContent, /INFERENCE/)
  assert.match(rows[1].textContent, /#1/)
  assert.equal(rows[2].all((e) => e.className === 'fill low')[0].style.width, '30%')
  assert.equal(rows[2].all((e) => e.className === 'trig').length, 1)
  const cards = $('topups').all((e) => e.tagName === 'ARTICLE')
  assert.equal(cards.length, 6)
  assert.match(cards[0].textContent, /QWEN_NOT_A_JUDGEMENT/)
  assert.match(cards[0].textContent, /판단 아님/)
  assert.match(cards[1].textContent, /✕ VENDOR_NOT_ALLOWED/)
  assert.match(cards[1].textContent, /✕ GPU_TYPE_NOT_ALLOWED/)
  assert.match(cards[1].textContent, /F2 호출 0회/)
  assert.match(cards[3].textContent, /QWEN_DENIED/)
  assert.match(cards[3].textContent, /scope creep/)
  assert.match(cards[3].textContent, /명세 purpose: LoRA fine-tune/) // Qwen reason next to the signed purpose
  assert.doesNotMatch(cards[4].textContent, /명세 purpose/)
  assert.match(cards[3].textContent, /<img src=x onerror=alert\(1\)>/) // shown as text
  assert.ok(!env.created.includes('img'))
  assert.match(cards[4].textContent, /APPROVED_ONCHAIN/)
  // EVIDENCE: stolen-key Denied on top, tx links to the explorer
  const led = $('ledger').all((e) => e.tagName === 'TR')
  assert.equal(led.length, FIXTURE.ledger.length)
  assert.match(led[0].textContent, /topUp.*DENIED.*OVER_MAX_HOLD/)
  const a = led[0].all((e) => e.tagName === 'A')[0]
  assert.equal(a.attrs.href, FIXTURE.explorer! + FIXTURE.ledger.at(-1)!.txHash)
  assert.equal(a.attrs.rel, 'noopener noreferrer')
  assert.match($('receipts').textContent, /\$5\.12.*\$0\.1536.*\$5\.2736.*2\.000 sim h.*LIVE.*scope creep.*H100/)
  for (const z of ['spec', 'budget', 'jobs', 'topups', 'receipts']) assert.ok($(z).all((e) => /^src /.test(e.className)).length > 0, `${z} has source badges`)

  // controls: STOP enabled (can.stop), wind-down disabled (can.windDown=false)
  assert.equal($('stop-MANUAL').disabled, false)
  assert.equal($('wind-btn').disabled, true)
  $('stop-MANUAL').click()
  assert.equal($('confirm').hidden, false)
  assert.equal(env.posts.length, 0) // confirm step first
  $('confirm-yes').click()
  await settle()
  assert.deepEqual(env.posts, [{ type: 'STOP', reason: 'MANUAL', stateVersion: 57 }])
  assert.equal($('stop-MANUAL').disabled, true) // locked until the next state version
  $('stop-MANUAL').click(); $('confirm-yes').click(); await settle()
  assert.equal(env.posts.length, 1)
  await tick(env) // same version: still locked
  assert.equal($('stop-SCOPE_DRIFT').disabled, true)
  env.current = { ...env.current, version: 58, stop: 'SENDING', can: { stop: false, windDown: false } }
  await tick(env)
  assert.match($('action-msg').textContent, /반영됐어요/)
  assert.equal($('stop-MANUAL').disabled, true) // can.stop is now false
  const cur = $('stop-stages').all((e) => e.className === 'cur')
  assert.equal(cur.length, 1)
  assert.match(cur[0].textContent, /SENDING/)

  // wind-down: enabled by can.windDown; a 409 shows the reason and unlocks
  env.current = { ...env.current, version: 59, stop: 'HALTED', can: { stop: false, windDown: true } }
  await tick(env)
  assert.equal($('wind-btn').disabled, false)
  env.reply = { status: 409, body: { ok: false, reason: 'stale stateVersion' } }
  $('wind-btn').click(); $('confirm-yes').click(); await settle()
  assert.deepEqual(env.posts.at(-1), { type: 'WIND_DOWN', stateVersion: 59 })
  assert.match($('action-msg').textContent, /409 · stale stateVersion/)
  assert.equal($('wind-btn').disabled, false)
})

test('index.html: a DONE card with result null is terminal (CANCELLED -> 취소됨); stolen-key ledger lines carry a 탈취 키 label', async () => {
  const s = structuredClone(FIXTURE) as StateView
  s.topups = [{ ...s.topups[1], req_id: 'demo-5fc8d326-r9', stage: 'DONE', result: null, qwen: null, code: 'CANCELLED', txHash: null, recHash: null }]
  const env = boot(s)
  await settle()
  const { $ } = env
  const card = $('topups').all((e) => e.tagName === 'ARTICLE')[0]
  assert.match(card.textContent, /CANCELLED · 취소됨 \(tx\/기록 없음\)/)
  assert.doesNotMatch(card.textContent, /진행 중|대기/)
  assert.equal(card.all((e) => e.className === 'step cur').length, 0) // no step shown as still running
  const led = $('ledger').all((e) => e.tagName === 'TR')
  assert.match(led[0].textContent, /^\S+topUp 탈취 키✕ DENIEDOVER_MAX_HOLD/)
  assert.equal(led.filter((r) => /탈취 키/.test(r.textContent)).length, 1) // only the attacker's line
})

test('index.html: a wind-down without a STOP strikes through the STOP stages it skipped; ETH shows 4 decimals', async () => {
  const s = structuredClone(FIXTURE) as StateView
  s.stop = 'HALTED' // plain windDown (no setPaused line): SENDING / PAUSED_ON_CHAIN / HALTING never happened
  s.health.ethAgent = '0.99977571999843004'
  const env = boot(s)
  await settle()
  const { $ } = env
  const li = () => $('stop-stages').all((e) => e.tagName === 'LI').map((e) => [e.className, e.textContent])
  assert.deepEqual(li(), [['done', '✓ RUNNING'], ['skip', 'SENDING'], ['skip', 'PAUSED_ON_CHAIN'], ['skip', 'HALTING'], ['cur', '● HALTED']])
  assert.match($('health').textContent, /ETH agent 0\.9998 \/ USER 0\.0871/)
  env.current = { ...s, version: s.version + 1, ledger: [...s.ledger, { ts: 1, fn: 'setPaused', status: 'OK', code: null, txHash: null, recHash: null, job_id: null, signer: 'founder' }] }
  await tick(env)
  assert.deepEqual(li().map(([c]) => c), ['done', 'done', 'done', 'done', 'cur'], 'after a real STOP every stage is ticked')
})

test('index.html shows STUB, STALE, HALTED and snapshot pricing', async () => {
  const s = structuredClone(FIXTURE) as StateView
  s.badges = { llm: 'stub', price: 'SNAPSHOT:timeout', scenario: 'demo' }
  s.syncAgeMs = 15_000
  s.health.halted = 'UNCONFIRMED 0xabc'
  s.can.windDown = true
  const env = boot(s)
  await settle()
  const { $ } = env
  assert.equal($('b-llm').textContent, 'LLM STUB')
  assert.equal($('b-llm').className, 'badge warn')
  assert.equal($('b-price').textContent, 'PRICE SNAPSHOT:timeout')
  assert.match($('sync').textContent, /STALE/)
  assert.match($('banners').textContent, /HALTED · UNCONFIRMED 0xabc/)
  assert.match($('banners').textContent, /STALE · 체인을 마지막으로 읽은 지 15초 지났어요/)
  assert.equal($('wind-btn').disabled, true) // no wind-down on a stale snapshot
  assert.equal($('stop-MANUAL').disabled, true) // StaleChain: 버튼 비활성 (design error table)
  assert.match($('banners').textContent, /STOP과 정산·환불 버튼을 누를 수 없어요/)
})

test('index.html: INFERENCE pinned whatever its id, only https explorers link, a broken zone does not freeze the controls, /state has a timeout', async () => {
  const s = structuredClone(FIXTURE) as StateView
  for (const j of s.jobs) if (j.inference) j.id = '7'
  s.explorer = 'javascript:alert(1)//'
  const env = boot(s)
  await settle()
  const { $ } = env
  assert.match($('jobs').all((e) => e.tagName === 'TR')[0].textContent, /#7 INFERENCE/)
  assert.equal($('ledger').all((e) => e.tagName === 'A').length, 0)
  assert.equal(JSON.stringify(env.stateInits[0]), '{"cache":"no-store","signal":{"timeoutMs":2500}}') // vm realm: compare as JSON
  assert.equal($('stop-MANUAL').disabled, false)

  // next state: receipts malformed (renderReceipts throws) and STOP no longer allowed -> button must still lock
  env.current = { ...env.current, version: 58, can: { stop: false, windDown: false }, receipts: [{ ...env.current.receipts[0], txHashes: 'oops' as never }] }
  await tick(env)
  assert.match($('banners').textContent, /그리지 못했어요 · renderReceipts/)
  assert.equal($('stop-MANUAL').disabled, true)
  assert.match($('run').textContent, /demo-5fc8d326/) // other zones still rendered
})

test('index.html video mode: ?video=1 hook and toggle, CSS-only layout, closed jobs marked, same security rules', async () => {
  // static: the hook is there and the page still has no HTML parsing, eval or outside URLs
  assert.match(SCRIPT, /\[\?&\]video=1/)
  assert.match(HTML, /id="video-btn"/)
  for (const sel of ['html.video { zoom: 1.5; }', '.video #ledger tr:nth-child(n+7)', '.video #topups > :nth-child(n+2)', '.video #jobs:has(tr:not(.closed)) tr.closed']) assert.ok(HTML.includes(sel), sel)
  for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', '@import', 'url(']) assert.ok(!HTML.includes(bad), bad)
  assert.ok(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(HTML), 'no external URLs')
  assert.equal(HTML.match(/<script/g)?.length, 1)

  // default: off
  const plain = boot(FIXTURE)
  await settle()
  assert.equal(plain.document.documentElement.className, '')
  assert.equal(plain.$('video-btn').attrs['aria-pressed'], 'false')

  // ?video=1: on; the button toggles and keeps the URL in step (no reload, no navigation)
  const env = boot(FIXTURE, '?scenario=demo&video=1')
  await settle()
  const { $ } = env
  assert.equal(env.document.documentElement.className, 'video')
  assert.equal($('video-btn').attrs['aria-pressed'], 'true')
  assert.equal($('video-btn').textContent, '기본 보기')
  $('video-btn').click()
  assert.equal(env.document.documentElement.className, '')
  assert.equal($('video-btn').textContent, '영상 모드')
  $('video-btn').click()
  assert.deepEqual(env.urls, ['/', '?video=1'])
  assert.equal(env.document.documentElement.className, 'video')
  assert.equal(boot(FIXTURE, '?video=10').document.documentElement.className, '')

  // the rows CSS hides in video mode: CLOSED jobs are marked, INFERENCE stays pinned; the newest ledger line is the stolen-key one
  assert.deepEqual($('jobs').all((e) => e.tagName === 'TR').map((r) => r.className), ['pin', 'closed', ''])
  assert.match($('ledger').all((e) => e.tagName === 'TR')[0].textContent, /탈취 키/)
  assert.equal($('topups').all((e) => e.tagName === 'ARTICLE').length, FIXTURE.topups.length) // DOM keeps every card; CSS shows the first
})

test('index.html CFO tree: decisions counted at the CFO, F1 shows its request, jobs are the leaves, a stolen key sits outside the CFO, STOP halts F1', async () => {
  const env = boot(FIXTURE)
  await settle()
  const { $ } = env
  const nodes = () => $('cfo').all((e) => /^node /.test(e.className))
  assert.deepEqual(nodes().map((n) => n.className), ['node root', 'node f1'])
  assert.match(nodes()[0].textContent, /^CFO.*승인 3 · 거절 2$/) // r2 r3 r5 APPROVED_ONCHAIN, r4 r6 DENIED_RECORDED
  assert.match(nodes()[1].textContent, /^F1.*GPU 작업 1개 실행 중$/) // job 2 RUNNING; job 1 CLOSED; INFERENCE not counted
  assert.match($('jobs').all((e) => e.tagName === 'TR')[2].textContent, /^#2 · B · h100/) // one allowed GPU type
  assert.equal($('bypass').hidden, false)
  assert.match($('bypass').textContent, /^탈취 키.*CFO 건너뜀.*금고 거절 1건/)
  assert.doesNotMatch($('cfo').textContent, /탈취/) // the stolen key is not under the CFO
  assert.equal($('banners').textContent, '')

  const inFlight = { ...FIXTURE.topups[1], req_id: 'demo-5fc8d326-r7', stage: 'F2' as const, result: null, qwen: null, code: null, txHash: null, recHash: null }
  env.current = { ...env.current, version: 58, topups: [...FIXTURE.topups, inFlight] }
  await tick(env)
  assert.deepEqual(nodes().map((n) => n.className), ['node root cur', 'node f1'])
  assert.match(nodes()[1].textContent, /#1 충전 요청 · CFO Qwen이 판정하는 중…$/)

  env.current = { ...env.current, version: 59, stop: 'HALTED', ledger: [...FIXTURE.ledger.filter((l) => l.signer !== 'attacker'),
    { ts: 2, fn: 'setPaused', status: 'OK', code: null, txHash: null, recHash: null, job_id: null, signer: 'founder' }] }
  await tick(env)
  assert.equal(nodes()[0].className, 'node root') // no live marker after STOP
  assert.match(nodes()[1].textContent, /금고 정지 · agent 키 차단/)
  assert.equal($('bypass').hidden, true)
  assert.equal(nodes()[1].className, 'node f1 halt') // red dot and text

  env.current = { ...structuredClone(FIXTURE), version: 60, topups: [...FIXTURE.topups, { ...inFlight, stage: 'F1' as const, request: null }] }
  await tick(env)
  assert.deepEqual(nodes().map((n) => n.className), ['node root', 'node f1 cur']) // F1 writes the request
  assert.match(nodes()[1].textContent, /#1 충전 요청을 쓰는 중…$/)

  env.current = { ...env.current, version: 61, stop: 'SENDING' }
  await tick(env)
  assert.deepEqual(nodes().map((n) => n.className), ['node root', 'node f1'])
  assert.match(nodes()[1].textContent, /USER가 STOP을 보내는 중…$/)

  // the tick saw the paused vault before the setPaused receipt came back: HALTING, no setPaused line yet
  env.current = { ...env.current, version: 62, stop: 'HALTING', jobs: env.current.jobs.map((j) => (j.inference || j.state === 'CLOSED' ? j : { ...j, state: 'STOPPED', stopReason: 'PAUSED' })) }
  await tick(env)
  assert.equal(nodes()[1].className, 'node f1 halt')

  // a stolen-key tx the vault did not deny is named by its status, never counted as 금고 거절
  const atk = FIXTURE.ledger.find((l) => l.signer === 'attacker')!
  env.current = { ...env.current, version: 63, ledger: [...FIXTURE.ledger, { ...atk, fn: 'open', status: 'ERROR', code: 'TimeoutError', txHash: null, job_id: null }] }
  await tick(env)
  assert.match($('bypass').textContent, /금고 거절 1건 · ERROR 1건/)

  // a wind-down without a STOP ended the session: the chain is no longer read, so an old snapshot is not STALE
  env.current = { ...structuredClone(FIXTURE), version: 64, stop: 'HALTED', ended: true, syncAgeMs: 30_000 }
  await tick(env)
  assert.equal(nodes()[1].className, 'node f1')
  assert.match(nodes()[1].textContent, /세션 종료$/)
  assert.equal($('banners').textContent, '')
  assert.equal($('sync').textContent, 'sync 30 s ago')
})

test('index.html glosses: every code keeps its bytes; plain Korean sits under the card code and in titles (failing gate chips only)', async () => {
  const s = structuredClone(FIXTURE) as StateView
  s.topups.push({ ...s.topups[1], req_id: 'demo-5fc8d326-r7', result: 'TX_ERROR', code: 'SEND_FAILED:timeout' }) // HALT reasons carry a ':' suffix
  const env = boot(s)
  await settle()
  const { $ } = env
  const cards = $('topups').all((e) => e.tagName === 'ARTICLE')
  assert.match(cards[0].textContent, /code SEND_FAILED:timeouttx를 보내지 못했어요/)
  assert.match(cards[1].textContent, /code VENDOR_NOT_ALLOWED허용되지 않은 벤더예요/)
  assert.match(cards[3].textContent, /✕ DENIED_RECORDED · 거절 · 체인에 고정/)
  const chips = cards[1].all((e) => e.tagName === 'LI')
  assert.deepEqual(chips.filter((c) => c.attrs.title).map((c) => c.textContent), ['✕ VENDOR_NOT_ALLOWED', '✕ GPU_TYPE_NOT_ALLOWED']) // a passing ✓ PAUSED gets no "paused" title
  const cells = $('ledger').all((e) => e.tagName === 'TR')[0].all((e) => e.tagName === 'TD')
  assert.deepEqual([cells[2].attrs.title, cells[3].attrs.title], ['컨트랙트가 거절해 돈은 그대로예요', '1회 상한 maxHold를 넘어요'])
  assert.equal($('stop-MANUAL').title, '다른 이유로 멈출 때 눌러요')
})
