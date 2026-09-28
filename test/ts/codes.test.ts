// codes.ts <-> fixtures/deny-codes.json <-> contracts/DenyCodes.sol, and the ABI pin ([IFACE]).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stringToHex } from 'viem';
import {
  bytes32ToCode,
  CHAIN_CODES,
  CHAIN_RULE_ORDER,
  codeToBytes32,
  DENY_CODES,
  describeBytes32,
  GATE_ORDER,
  isTransient,
  TRANSIENT_CODES,
} from '../../backend/codes.ts';
import { buildDenyCodesFixture } from '../../backend/fixtures.ts';
import { vaultAbi } from '../../backend/abi.ts';

describe('deny codes', () => {
  test('unique, ASCII, fit in bytes32', () => {
    assert.equal(new Set(DENY_CODES).size, DENY_CODES.length);
    assert.equal(DENY_CODES.length, 17);
    for (const c of DENY_CODES) {
      assert.match(c, /^[A-Z_]{1,32}$/);
    }
  });

  test('bytes32 round trip, Solidity literal layout (left-aligned, zero padded)', () => {
    for (const c of DENY_CODES) {
      const h = codeToBytes32(c);
      assert.equal(h, stringToHex(c, { size: 32 }));
      assert.equal(h.length, 66);
      assert.equal(bytes32ToCode(h), c);
      assert.equal(bytes32ToCode(h.toUpperCase().replace('0X', '0x') as `0x${string}`), c);
    }
    assert.equal(codeToBytes32('PAUSED'), '0x5041555345440000000000000000000000000000000000000000000000000000');
  });

  test('unknown or non-canonical bytes32 decode to null (attacker-chosen codes)', () => {
    assert.equal(bytes32ToCode(stringToHex('NOT_A_CODE', { size: 32 })), null);
    // PAUSED + garbage after the NUL padding
    assert.equal(bytes32ToCode('0x5041555345440000000000000000000000000000000000000000000000000001'), null);
    assert.equal(bytes32ToCode('0x1234'), null);
    assert.equal(describeBytes32(stringToHex('HELLO', { size: 32 })), 'UNKNOWN(HELLO)');
  });

  test('gate order: 10 rules, chain rules first in the contract order', () => {
    assert.equal(GATE_ORDER.length, 10);
    assert.deepEqual([...GATE_ORDER.slice(0, 5)], [...CHAIN_RULE_ORDER]);
    for (const c of CHAIN_RULE_ORDER) assert.ok((CHAIN_CODES as readonly string[]).includes(c));
  });

  test('D4: only QWEN_UNAVAILABLE, READ_FAILED, TOPUP_TIMEOUT may re-arm', () => {
    assert.deepEqual([...TRANSIENT_CODES].sort(), ['QWEN_UNAVAILABLE', 'READ_FAILED', 'TOPUP_TIMEOUT']);
    assert.equal(isTransient('QWEN_DENIED'), false);
    assert.equal(isTransient('QWEN_UNPARSEABLE'), false);
    assert.equal(isTransient('LLM_CALL_CAP'), false);
    assert.equal(isTransient('OVER_BUDGET_WITH_FEE'), false);
  });

  test('C12: committed fixtures/deny-codes.json equals codes.ts', () => {
    assert.deepEqual(JSON.parse(readFileSync('fixtures/deny-codes.json', 'utf8')), buildDenyCodesFixture());
  });

  test('contracts/DenyCodes.sol declares exactly the same literals (name == value)', () => {
    const sol = readFileSync('contracts/DenyCodes.sol', 'utf8');
    const found = [...sol.matchAll(/bytes32 internal constant (\w+) = "(\w+)";/g)].map((m) => {
      assert.equal(m[1], m[2], `Solidity constant ${m[1]} has literal ${m[2]}`);
      return m[1]!;
    });
    assert.deepEqual(found, [...DENY_CODES]);
  });
});

describe('ABI pin (backend/abi.ts generated from IAgentBudgetVault.sol)', () => {
  type Item = { type: string; name?: string; inputs?: { name: string; type: string; indexed?: boolean }[]; outputs?: { type: string }[] };
  const abi = vaultAbi as unknown as Item[];
  const ev = (n: string) => abi.find((x) => x.type === 'event' && x.name === n);
  const fn = (n: string) => abi.find((x) => x.type === 'function' && x.name === n);
  const sig = (x: Item | undefined) => x?.inputs?.map((i) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name}`);

  test('Denied(uint256 indexed jobId, bytes32 indexed code, bytes32 indexed rec, bool enforced)', () => {
    assert.deepEqual(sig(ev('Denied')), ['uint256 indexed jobId', 'bytes32 indexed code', 'bytes32 indexed rec', 'bool enforced']);
  });

  test('spend events index their recordHash; Closed/Refunded/PausedSet carry rec', () => {
    assert.deepEqual(sig(ev('HoldOpened')), ['uint256 indexed jobId', 'address indexed vendor', 'uint256 net', 'uint256 gross', 'bytes32 indexed recordHash']);
    assert.deepEqual(sig(ev('ToppedUp')), ['uint256 indexed jobId', 'uint256 net', 'uint256 gross', 'bytes32 indexed recordHash']);
    assert.deepEqual(sig(ev('Settled')), ['uint256 indexed jobId', 'address indexed vendor', 'uint256 net', 'uint256 fee', 'bytes32 indexed recordHash']);
    assert.deepEqual(sig(ev('Closed')), ['uint256 indexed jobId', 'uint256 released', 'bytes32 indexed rec']);
    assert.deepEqual(sig(ev('Refunded')), ['uint256 amount', 'bytes32 indexed rec']);
    assert.deepEqual(sig(ev('PausedSet')), ['bool paused', 'bytes32 indexed rec']);
    assert.deepEqual(sig(ev('Funded')), ['uint256 amount', 'uint256 deadline']);
    assert.deepEqual(sig(ev('VendorSet')), ['address indexed vendor', 'bool allowed']);
    assert.deepEqual(sig(ev('MaxHoldSet')), ['uint256 maxHold']);
  });

  test('write functions: net amounts + trailing rec; open returns jobId, topUp/settle/close return bool', () => {
    assert.deepEqual(sig(fn('open')), ['address vendor', 'uint256 net', 'bytes32 rec']);
    assert.deepEqual(fn('open')?.outputs?.map((o) => o.type), ['uint256']);
    assert.deepEqual(sig(fn('topUp')), ['uint256 jobId', 'uint256 net', 'bytes32 rec']);
    assert.deepEqual(sig(fn('settle')), ['uint256 jobId', 'uint256 net', 'bytes32 rec']);
    assert.deepEqual(sig(fn('close')), ['uint256 jobId', 'bytes32 rec']);
    for (const n of ['topUp', 'settle', 'close']) assert.deepEqual(fn(n)?.outputs?.map((o) => o.type), ['bool']);
    assert.deepEqual(sig(fn('recordDecision')), ['uint256 jobId', 'bytes32 code', 'bytes32 rec']);
    assert.deepEqual(sig(fn('refund')), ['uint256 amount', 'bytes32 rec']);
    assert.deepEqual(sig(fn('setPaused')), ['bool p', 'bytes32 rec']);
    assert.deepEqual(sig(fn('fund')), ['uint256 amount', 'uint256 newDeadline']);
  });

  test('revert set is exactly Unauthorized, JobClosed, OverBudget, TransferFailed', () => {
    const errors = abi.filter((x) => x.type === 'error').map((x) => x.name).sort();
    assert.deepEqual(errors, ['JobClosed', 'OverBudget', 'TransferFailed', 'Unauthorized']);
  });
});
