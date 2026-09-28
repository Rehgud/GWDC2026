// classify(receipt) is the single decision point for every tx result (R3-8). Synthetic receipts.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type Hex } from 'viem';
import { vaultAbi } from '../../backend/abi.ts';
import { classify, decodeVaultLogs } from '../../backend/chain.ts';
import { codeToBytes32, NO_JOB } from '../../backend/codes.ts';

const VAULT = '0x00000000000000000000000000000000000000aa' as Hex;
const OTHER = '0x00000000000000000000000000000000000000bb' as Hex;
const REC = keccak256(toHex('rec'));
const B = '0x59E64c085b6cc41a98Cf6FBF8AA0e64b9c65403C' as Hex;

type Ev = Extract<(typeof vaultAbi)[number], { type: 'event' }>;
function mkLog(eventName: string, args: Record<string, unknown>, address: Hex = VAULT) {
  const ev = vaultAbi.find((x) => x.type === 'event' && x.name === eventName) as Ev;
  const topics = encodeEventTopics({ abi: vaultAbi, eventName: eventName as never, args: args as never });
  const nonIndexed = ev.inputs.filter((i) => !('indexed' in i && i.indexed));
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never);
  return { address, topics, data, blockNumber: 10n, transactionHash: keccak256(toHex('tx')), logIndex: 0, transactionIndex: 0 } as never;
}
const rcpt = (logs: unknown[], status: 'success' | 'reverted' = 'success') => ({ status, logs }) as never;

// an ERC20 Transfer from the token (not the vault)
const transferLog = {
  address: OTHER,
  topics: [keccak256(toHex('Transfer(address,address,uint256)')), `0x${'0'.repeat(64)}`, `0x${'0'.repeat(64)}`],
  data: `0x${'0'.repeat(63)}1`,
  blockNumber: 10n,
  transactionHash: keccak256(toHex('tx')),
  logIndex: 1,
  transactionIndex: 0,
};

describe('classify', () => {
  test('HoldOpened -> OK with jobId (jobId only from HoldOpened)', () => {
    const r = classify(rcpt([mkLog('HoldOpened', { jobId: 3n, vendor: B, net: 1n, gross: 1n, recordHash: REC })]), VAULT, 'open', REC);
    assert.equal(r.kind, 'OK');
    assert.equal(r.kind === 'OK' && r.jobId, 3n);
  });

  test('Settled + token Transfer logs: only vault logs are decoded -> OK', () => {
    const r = classify(rcpt([transferLog, mkLog('Settled', { jobId: 0n, vendor: B, net: 5n, fee: 0n, recordHash: REC }), transferLog]), VAULT, 'settle', REC);
    assert.equal(r.kind, 'OK');
  });

  test('Denied(enforced) from open -> DENIED(code), status alone would have said success', () => {
    const r = classify(rcpt([mkLog('Denied', { jobId: NO_JOB, code: codeToBytes32('PAUSED'), rec: REC, enforced: true })]), VAULT, 'open', REC);
    assert.equal(r.kind, 'DENIED');
    assert.equal(r.kind === 'DENIED' && r.code, 'PAUSED');
  });

  test('topUp that the chain Denied is DENIED, never OK', () => {
    const r = classify(rcpt([mkLog('Denied', { jobId: 1n, code: codeToBytes32('OVER_BUDGET_WITH_FEE'), rec: REC, enforced: true })]), VAULT, 'topUp', REC);
    assert.deepEqual([r.kind, r.kind === 'DENIED' && r.code], ['DENIED', 'OVER_BUDGET_WITH_FEE']);
  });

  test('status 0 -> REVERTED', () => {
    assert.equal(classify(rcpt([], 'reverted'), VAULT, 'close', REC).kind, 'REVERTED');
  });

  test('no vault log at all (Transfer only) -> UNEXPECTED (HALT)', () => {
    assert.equal(classify(rcpt([transferLog]), VAULT, 'settle', REC).kind, 'UNEXPECTED');
    assert.equal(classify(rcpt([]), VAULT, 'open', REC).kind, 'UNEXPECTED');
  });

  test('success event from ANOTHER address is ignored -> UNEXPECTED', () => {
    const r = classify(rcpt([mkLog('HoldOpened', { jobId: 0n, vendor: B, net: 1n, gross: 1n, recordHash: REC }, OTHER)]), VAULT, 'open', REC);
    assert.equal(r.kind, 'UNEXPECTED');
  });

  test('both success and Denied, or two successes -> UNEXPECTED', () => {
    const ok = mkLog('ToppedUp', { jobId: 0n, net: 1n, gross: 1n, recordHash: REC });
    const den = mkLog('Denied', { jobId: 0n, code: codeToBytes32('PAUSED'), rec: REC, enforced: true });
    assert.equal(classify(rcpt([ok, den]), VAULT, 'topUp', REC).kind, 'UNEXPECTED');
    assert.equal(classify(rcpt([ok, ok]), VAULT, 'topUp', REC).kind, 'UNEXPECTED');
  });

  test('wrong event for the function (Closed from settle) -> UNEXPECTED', () => {
    assert.equal(classify(rcpt([mkLog('Closed', { jobId: 0n, released: 1n, rec: REC })]), VAULT, 'settle', REC).kind, 'UNEXPECTED');
  });

  test('event carrying a different rec -> UNEXPECTED', () => {
    const other = keccak256(toHex('other'));
    assert.equal(classify(rcpt([mkLog('Closed', { jobId: 0n, released: 1n, rec: other })]), VAULT, 'close', REC).kind, 'UNEXPECTED');
  });

  test('recordDecision: Denied(enforced=false) with our rec -> OK; enforced=true -> UNEXPECTED', () => {
    const d = (enforced: boolean) => mkLog('Denied', { jobId: NO_JOB, code: codeToBytes32('QWEN_DENIED'), rec: REC, enforced });
    assert.equal(classify(rcpt([d(false)]), VAULT, 'recordDecision', REC).kind, 'OK');
    assert.equal(classify(rcpt([d(true)]), VAULT, 'recordDecision', REC).kind, 'UNEXPECTED');
  });

  test('Denied(enforced=false) from a rule-checked call -> UNEXPECTED', () => {
    const d = mkLog('Denied', { jobId: 0n, code: codeToBytes32('PAUSED'), rec: REC, enforced: false });
    assert.equal(classify(rcpt([d]), VAULT, 'settle', REC).kind, 'UNEXPECTED');
  });

  test('undecodable vault log -> UNEXPECTED', () => {
    const junk = { ...transferLog, address: VAULT };
    assert.equal(classify(rcpt([junk]), VAULT, 'open', REC).kind, 'UNEXPECTED');
    assert.equal(decodeVaultLogs(VAULT, [junk as never])[0]!.name, 'Unknown');
  });

  test('attacker-chosen unknown code is reported, not mapped to a known code', () => {
    const r = classify(rcpt([mkLog('Denied', { jobId: 0n, code: `0x${'ff'.repeat(32)}`, rec: REC, enforced: true })]), VAULT, 'open', REC);
    assert.equal(r.kind, 'DENIED');
    assert.match(r.kind === 'DENIED' ? r.code : '', /^UNKNOWN\(/);
  });
});
