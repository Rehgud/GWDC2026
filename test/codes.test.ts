import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CHAIN_CODES, CODES, fromBytes32, toBytes32 } from '../src/codes.ts'
import { vaultAbi } from '../src/abi.ts'

test('contract Denied literals == CHAIN_CODES, same order (C12)', () => {
  const sol = readFileSync('contracts/AgentBudgetVault.sol', 'utf8')
  const found = [...sol.matchAll(/bytes32 constant (\w+) = "(\w+)";/g)]
  for (const [, name, lit] of found) assert.equal(name, lit, `${name} constant holds "${lit}"`)
  assert.deepEqual(found.map((m) => m[2]), [...CHAIN_CODES])
})

test('bytes32 encoding round-trips and matches Solidity bytes32("PAUSED")', () => {
  assert.equal(toBytes32('PAUSED'), `0x${Buffer.from('PAUSED').toString('hex').padEnd(64, '0')}`)
  for (const c of CODES) {
    assert.ok(c.length <= 32, c)
    assert.equal(fromBytes32(toBytes32(c)), c)
  }
  assert.equal(new Set(CODES).size, CODES.length)
})

test('abi.ts is in sync with the contract events the auditor consumes', () => {
  const events = vaultAbi.filter((x) => x.type === 'event').map((x) => x.name).sort()
  assert.deepEqual(events, ['Closed', 'Denied', 'Funded', 'HoldOpened', 'MaxHoldSet', 'PausedSet', 'Refunded', 'Settled', 'ToppedUp', 'VendorSet'])
  const denied = vaultAbi.find((x) => x.type === 'event' && x.name === 'Denied') as any
  assert.deepEqual(denied.inputs.map((i: any) => [i.name, i.type, i.indexed]), [
    ['jobId', 'uint256', true], ['code', 'bytes32', true], ['rec', 'bytes32', true], ['enforced', 'bool', false],
  ])
})
