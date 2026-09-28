import { test } from 'node:test'
import assert from 'node:assert/strict'
import { privateKeyToAccount } from 'viem/accounts'
import { makeSpec, parseSpecForGate, signSpec, verifySpec, type Spec } from '../src/spec.ts'

// anvil #0 / #1 (public test keys)
const founder = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

const spec: Spec = {
  spec_id: 'spec-001', vault: '0x5FbDB2315678afecb367f032d93F642f64180aa3', chain_id: 84532, issued_at: '2026-09-29T00:00:00Z',
  purpose: 'fine-tune a 7B model on support tickets', success_metric: 'eval loss < 1.2', allowed_gpu_types: ['h100'],
  job_cap_usd: '12.5', deadline: 1_790_000_000,
}

test('makeSpec: compact JSON, fixed key order whatever the input order', () => {
  const shuffled = Object.fromEntries(Object.entries(spec).reverse()) as Spec
  const b = makeSpec(shuffled)
  assert.deepEqual(b, makeSpec(spec))
  const s = b.toString('utf8')
  assert.ok(s.startsWith('{"spec_id":"spec-001","vault":'))
  assert.ok(s.endsWith('"deadline":1790000000}'))
  assert.ok(!s.includes('\n') && !s.includes(': '))
})

test('makeSpec rejects missing fields and non-decimal caps', () => {
  assert.throws(() => makeSpec({ ...spec, purpose: undefined } as any), /purpose/)
  assert.throws(() => makeSpec({ ...spec, job_cap_usd: 12.5 } as any), /job_cap_usd/)
  assert.throws(() => makeSpec({ ...spec, job_cap_usd: '1e3' }), /job_cap_usd/)
  assert.throws(() => makeSpec({ ...spec, job_cap_usd: '1.1234567' }), /job_cap_usd/)
})

test('sign -> verify recovers the founder; 1-byte change -> different signer', async () => {
  const bytes = makeSpec(spec)
  const sig = await signSpec(bytes, founder)
  assert.equal(await verifySpec(bytes, sig), founder.address)
  const tampered = Buffer.from(bytes)
  tampered[tampered.indexOf('12.5') + 1] = '3'.charCodeAt(0) // "13.5"
  assert.notEqual(await verifySpec(tampered, sig), founder.address)
  assert.notEqual(await verifySpec(bytes, await signSpec(bytes, other)), founder.address)
})

test('signature == personal_sign of the UTF-8 string (cast wallet sign "$(cat spec.json)")', async () => {
  const bytes = makeSpec({ ...spec, purpose: '한국어 목적 ✓' })
  assert.equal(await signSpec(bytes, founder), await founder.signMessage({ message: bytes.toString('utf8') }))
})

test('parseSpecForGate: job_cap in micro-USDC, deadline bigint', () => {
  assert.deepEqual(parseSpecForGate(makeSpec(spec)), { allowed_gpu_types: ['h100'], job_cap: 12_500_000n, deadline: 1_790_000_000n })
  assert.equal(parseSpecForGate(makeSpec({ ...spec, job_cap_usd: '7' })).job_cap, 7_000_000n)
  assert.equal(parseSpecForGate(makeSpec({ ...spec, job_cap_usd: '0.000001' })).job_cap, 1n)
  // exact decimal, not float: 8.2 * 1e6 = 8199999.999999999 in binary floating point
  assert.equal(parseSpecForGate(makeSpec({ ...spec, job_cap_usd: '8.2' })).job_cap, 8_200_000n)
  assert.equal(parseSpecForGate(makeSpec({ ...spec, job_cap_usd: '123456789012.123456' })).job_cap, 123_456_789_012_123_456n)
  assert.throws(() => parseSpecForGate(Buffer.from('{"allowed_gpu_types":"h100","job_cap_usd":"1","deadline":1}')), /allowed_gpu_types/)
})
