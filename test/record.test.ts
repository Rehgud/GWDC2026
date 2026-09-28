import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keccak256 } from 'viem'
import { RecordChain, ZERO_HASH, readChain, serialize, verifyChain } from '../src/record.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'rec-'))

test('serialize: compact, bigint and NaN as strings, no trailing newline', () => {
  const b = serialize({ a: 1n, b: NaN, c: Infinity, d: [1, 'x'] }).toString()
  assert.equal(b, '{"a":"1","b":"NaN","c":"Infinity","d":[1,"x"]}')
})

test('append -> readChain -> verifyChain round-trip; hash is keccak of file bytes', () => {
  const dir = tmp()
  const c = new RecordChain(dir, 'run-1')
  const a = c.append('SESSION_START', { spec_raw: '{"purpose":"x"}' }, 1)
  const b = c.append('DECISION', { amount: 2_560_000n, loss: NaN }, 2)
  assert.equal(b.rec.prev, a.hash)
  const recs = readChain(dir)
  assert.equal(recs.length, 2)
  assert.deepEqual(verifyChain(recs), [])
  for (const r of recs) assert.equal(keccak256(readFileSync(join(dir, r.file))), r.hash)
  assert.equal(recs[0].rec.prev, ZERO_HASH)
  rmSync(dir, { recursive: true })
})

test('reopening continues seq and head', () => {
  const dir = tmp()
  const h = new RecordChain(dir, 'r').append('SESSION_START', {}, 1).hash
  const c2 = new RecordChain(dir, 'r')
  assert.equal(c2.seq, 1)
  assert.equal(c2.append('STOP', {}, 2).rec.prev, h)
  assert.deepEqual(verifyChain(readChain(dir)), [])
  rmSync(dir, { recursive: true })
})

test('1-byte tamper and deleted middle record are detected', () => {
  const dir = tmp()
  const c = new RecordChain(dir, 'r')
  for (let i = 0; i < 3; i++) c.append('CHECKPOINT', { i }, i)
  const files = readdirSync(dir).sort()
  const p = join(dir, files[1])
  writeFileSync(p, readFileSync(p).toString().replace('"i":1', '"i":7'))
  assert.match(verifyChain(readChain(dir)).join('\n'), /content hash .* != file name/)
  rmSync(p)
  const errs = verifyChain(readChain(dir)).join('\n')
  assert.match(errs, /seq 2, expected 1/)
  assert.match(errs, /prev .* expected/)
  rmSync(dir, { recursive: true })
})
