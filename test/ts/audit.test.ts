// Auditor goldens (G1-G16). Bundles + chain data frozen from real anvil runs
// (npm run e2e:local -- <names> --golden); judge() is pure over them, so no RPC is needed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, custom, encodeAbiParameters, keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { auditBundle, fetchChainData, CannotVerify, judgeWithSig, loadBundle, type Bundle, type ChainData } from '../../auditor/audit.ts';
import { buildRecord, hashBytes, recordFileName, serialize, type DecisionRecord, type LoadedRecord } from '../../backend/record.ts';
import { codeToBytes32 } from '../../backend/codes.ts';

const G = 'test/fixtures/golden';
const HAVE = existsSync(`${G}/normal/chain.json`);

async function golden(name: string): Promise<{ b: Bundle; c: ChainData; vault: Hex }> {
  const b = await loadBundle(`${G}/${name}/bundle`);
  const c = JSON.parse(readFileSync(`${G}/${name}/chain.json`, 'utf8')) as ChainData;
  return { b, c, vault: b.run.vault };
}
const clone = <T>(x: T): T => structuredClone(x);
const codes = (r: { findings: { level: string; code: string }[] }, level = 'FAIL') => [...new Set(r.findings.filter((f) => f.level === level).map((f) => f.code))].sort();

const SEL = {
  HoldOpened: keccak256(toHex('HoldOpened(uint256,address,uint256,uint256,bytes32)')),
  Settled: keccak256(toHex('Settled(uint256,address,uint256,uint256,bytes32)')),
  Denied: keccak256(toHex('Denied(uint256,bytes32,bytes32,bool)')),
  VendorSet: keccak256(toHex('VendorSet(address,bool)')),
  PausedSet: keccak256(toHex('PausedSet(bool,bytes32)')),
  ToppedUp: keccak256(toHex('ToppedUp(uint256,uint256,uint256,bytes32)')),
};

/**
 * A bundle forged AT WRITE TIME: mutate record `seq`, then re-chain every later record and
 * rewrite the on-chain rec topics + ledger to the new hashes. The hash chain is intact, so the
 * only thing left for the auditor to catch is the forged decision itself.
 */
function forge(b: Bundle, c: ChainData, seq: number, mutate: (rec: Record<string, any>) => void): { b: Bundle; c: ChainData } {
  const nb = clone(b);
  const nc = clone(c);
  const map = new Map<string, string>();
  let prev: string | null = null;
  for (let i = 0; i < nb.records.length; i++) {
    const r = nb.records[i]!;
    if (r.seq < seq) continue;
    let text = new TextDecoder().decode(r.bytes);
    for (const [o, n] of map) text = text.split(o).join(n);
    const obj = JSON.parse(text);
    if (r.seq === seq) mutate(obj);
    if (prev) obj.prevHash = prev;
    const bytes = serialize(obj);
    const h = hashBytes(bytes);
    map.set(r.nameHash.toLowerCase(), h);
    nb.records[i] = { ...r, bytes, hash: h, nameHash: h, file: recordFileName(r.seq, h), record: obj as DecisionRecord };
    prev = h;
  }
  for (const l of nc.logs) l.topics = l.topics.map((t) => (map.get(t.toLowerCase()) ?? t) as Hex);
  for (const l of nb.ledger) if (l.rec && map.has(l.rec.toLowerCase())) l.rec = map.get(l.rec.toLowerCase()) as Hex;
  return { b: nb, c: nc };
}

/** replace one record's bytes (keeps the file-name hash, like an in-place edit) */
function editRecord(b: Bundle, seq: number, mutate: (bytes: Uint8Array) => Uint8Array): Bundle {
  const out = clone(b);
  const i = out.records.findIndex((r) => r.seq === seq);
  const r = out.records[i]!;
  const bytes = mutate(new Uint8Array(r.bytes));
  let record: DecisionRecord | null = null;
  try {
    record = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    record = null;
  }
  out.records[i] = { ...r, bytes, hash: hashBytes(bytes), record };
  return out;
}

describe('auditor goldens', { skip: !HAVE && 'golden fixtures missing (npm run e2e:local -- --golden)' }, () => {
  test('G1 honest normal run -> PASS, every check green, 1:1 matching, anchored to the last record', async () => {
    const { b, c, vault } = await golden('normal');
    const r = await judgeWithSig(b, c, { expectedVault: vault });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.failures, null, 1));
    assert.equal(r.exitCode, 0);
    assert.ok(r.checks.every((x) => x.ok));
    assert.equal(r.anchored.upTo, r.anchored.total);
    assert.ok(r.matching.length > 5 && r.matching.every((m) => m.result === 'OK'));
    assert.deepEqual(r.warnings, []);
  });

  test('G2 one byte of a record changed -> FAIL check1 (HASH_MISMATCH)', async () => {
    const { b, c, vault } = await golden('normal');
    const seq = b.records.find((x) => x.record?.kind === 'REQUEST')!.seq;
    const t = editRecord(b, seq, (by) => {
      const s = new TextDecoder().decode(by).replace('"amount":"2560000"', '"amount":"2560001"');
      return new TextEncoder().encode(s);
    });
    const r = await judgeWithSig(t, c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('HASH_MISMATCH'));
    assert.ok(r.failures.some((f) => f.check === 'check1' && f.seq === seq));
  });

  test('G3 one byte of the signed spec changed -> FAIL check3', async () => {
    const { b, c, vault } = await golden('normal');
    const t = clone(b);
    const s = new TextDecoder().decode(t.specBytes).replace('"job_cap_usd":"12.00"', '"job_cap_usd":"19.00"');
    t.specBytes = new TextEncoder().encode(s);
    const r = await judgeWithSig(t, c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('SPEC_BAD_SIGNATURE'));
    assert.ok(codes(r).includes('SPEC_HASH'));
  });

  test('G4 a middle record deleted -> FAIL (SEQ_GAP / PREV_MISMATCH, its tx no longer backed)', async () => {
    const { b, c, vault } = await golden('normal');
    const t = clone(b);
    const victim = t.records.find((x) => x.record?.kind === 'SETTLE')!;
    t.records = t.records.filter((x) => x !== victim && x.seq !== victim.seq);
    const r = await judgeWithSig(t, c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('SEQ_GAP'));
    assert.ok(codes(r).includes('UNGATED_SPEND'), 'the Settled event now has no record');
  });

  test('G5 stolen-key attempts: Denied without records -> UNRECORDED_ATTEMPT WARN, verdict PASS', async () => {
    const { b, c, vault } = await golden('stolen-key');
    const r = await judgeWithSig(b, c, { expectedVault: vault });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.failures, null, 1));
    assert.equal(r.unrecordedAttempts.length, 3);
    assert.deepEqual(r.unrecordedAttempts.map((u) => u.code).sort(), ['OVER_BUDGET_WITH_FEE', 'OVER_MAX_HOLD', 'VENDOR_NOT_ALLOWED']);
    assert.ok(r.unrecordedAttempts.every((u) => u.sender.toLowerCase() === c.immutables.agent.toLowerCase()));
    assert.deepEqual(codes(r, 'WARN'), ['UNRECORDED_ATTEMPT']);
  });

  test('G5b injection: gate denied before F2, the raw replay is an unrecorded contract Denied', async () => {
    const { b, c, vault } = await golden('injection');
    const r = await judgeWithSig(b, c, { expectedVault: vault });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.failures, null, 1));
    assert.deepEqual(r.unrecordedAttempts.map((u) => u.code), ['VENDOR_NOT_ALLOWED']);
    const deny = b.records.map((x) => x.record!).find((x) => x.kind === 'REQUEST' && (x as DecisionRecord<'REQUEST'>).body.decision === 'DENY') as DecisionRecord<'REQUEST'>;
    assert.equal(deny.body.code, 'VENDOR_NOT_ALLOWED');
    assert.equal(deny.body.f2, null, 'F2 was never called');
    assert.equal(deny.body.request!.gpu, 'H200');
  });

  test('G6 an attacker reuses a real record hash -> DUPLICATE_REC_REF reported', async () => {
    const { b, c, vault } = await golden('stolen-key');
    const t = clone(c);
    const realRec = b.records.find((x) => x.record?.kind === 'REQUEST')!.nameHash;
    const d = t.logs.find((l) => l.topics[0] === SEL.Denied)!; // an attacker's Denied
    d.topics = [d.topics[0]!, d.topics[1]!, d.topics[2]!, realRec];
    const r = await judgeWithSig(b, t, { expectedVault: vault });
    assert.ok(codes(r, 'WARN').includes('DUPLICATE_REC_REF'));
  });

  test('G7 split settles: fee is floored per settle (every Settled checks out)', async () => {
    const { b, c, vault } = await golden('normal');
    const r = await judgeWithSig(b, c, { expectedVault: vault });
    assert.ok(!r.failures.some((f) => f.code === 'FEE_MISMATCH'));
    // and a fee off by one is caught
    const t = clone(c);
    const sel = t.logs.find((l) => l.topics[0] === SEL.Settled)!;
    const net = BigInt(`0x${sel.data.slice(2, 66)}`);
    const fee = BigInt(`0x${sel.data.slice(66)}`);
    sel.data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [net, fee + 1n]);
    const r2 = await judgeWithSig(b, t, { expectedVault: vault });
    assert.ok(codes(r2).includes('FEE_MISMATCH'));
  });

  test('G8 pause then unpause, then an agent settle -> PASS (paused is judged at that block, not "ever")', async () => {
    const { b, c, vault } = await golden('normal');
    const t = clone(c);
    const firstSettle = t.logs.findIndex((l) => l.topics[0] === SEL.Settled);
    const at = t.logs[firstSettle]!;
    const paused = (p: boolean, idx: number) => ({
      address: at.address,
      topics: [SEL.PausedSet, keccak256(toHex(`founder-${p}`))] as Hex[],
      data: encodeAbiParameters([{ type: 'bool' }], [p]),
      blockNumber: (BigInt(at.blockNumber) - 1n).toString(),
      transactionHash: keccak256(toHex(`pause-${p}`)),
      logIndex: idx,
      transactionIndex: 0,
    });
    t.logs.splice(firstSettle, 0, paused(true, 9000), paused(false, 9001));
    for (const p of [true, false]) t.txs[keccak256(toHex(`pause-${p}`)).toLowerCase()] = { from: c.immutables.founder, blockNumber: (BigInt(at.blockNumber) - 1n).toString(), status: 'success' };
    t.blocks[(BigInt(at.blockNumber) - 1n).toString()] ??= t.blocks[at.blockNumber]!;
    const r = await judgeWithSig(b, t, { expectedVault: vault });
    assert.ok(!r.failures.some((f) => f.code === 'SPEND_WHILE_PAUSED'), JSON.stringify(r.failures));
    // the same settle while STILL paused fails
    const t2 = clone(c);
    t2.logs.splice(firstSettle, 0, paused(true, 9000));
    t2.txs[keccak256(toHex('pause-true')).toLowerCase()] = { from: c.immutables.founder, blockNumber: (BigInt(at.blockNumber) - 1n).toString(), status: 'success' };
    t2.blocks[(BigInt(at.blockNumber) - 1n).toString()] ??= t2.blocks[at.blockNumber]!;
    const r2 = await judgeWithSig(b, t2, { expectedVault: vault });
    assert.ok(codes(r2).includes('SPEND_WHILE_PAUSED'));
  });

  test('G10 an unanchored record appended after the last anchor -> UNANCHORED_TAIL', async () => {
    const { b, c, vault } = await golden('normal');
    const t = clone(b);
    const last = t.records[t.records.length - 1]!;
    const draft = { ...(last.record as DecisionRecord<'SESSION_END'>), kind: 'RECEIPT' as const, tx: null, body: { close_ref: last.nameHash, f3: null, text: 'appended after the anchor', receipt: {} } };
    const rec = buildRecord({ seq: last.seq, hash: last.nameHash }, draft as never);
    const bytes = serialize(rec);
    const h = hashBytes(bytes);
    t.records.push({ file: recordFileName(rec.seq, h), seq: rec.seq, nameHash: h, bytes, hash: h, record: rec } as LoadedRecord);
    const r = await judgeWithSig(t, c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('UNANCHORED_TAIL'));
    assert.equal(r.anchored.upTo, last.seq);
  });

  test('G10b the last record (SESSION_END) tampered -> FAIL', async () => {
    const { b, c, vault } = await golden('normal');
    const last = b.records[b.records.length - 1]!;
    const t = editRecord(b, last.seq, (by) => new TextEncoder().encode(new TextDecoder().decode(by).replace('"reason":"COMPLETED"', '"reason":"COMPLETEd"')));
    const r = await judgeWithSig(t, c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('HASH_MISMATCH'));
  });

  test('G11 a HoldOpened whose rec has no record -> UNGATED_SPEND FAIL', async () => {
    const { b, c, vault } = await golden('normal');
    const t = clone(c);
    const hos = t.logs.filter((l) => l.topics[0] === SEL.HoldOpened);
    const ho = hos[hos.length - 1]!; // the vendor job's open
    ho.topics = [ho.topics[0]!, ho.topics[1]!, ho.topics[2]!, keccak256(toHex('forged'))];
    const r = await judgeWithSig(b, t, { expectedVault: vault });
    assert.ok(codes(r).includes('UNGATED_SPEND'));
    assert.equal(r.verdict, 'FAIL');
  });

  test('G12 deadline run: approvals the chain overrode are CHAIN_OVERRIDE (INFO), not FAIL', async () => {
    const { b, c, vault } = await golden('deadline');
    const r = await judgeWithSig(b, c, { expectedVault: vault });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.failures, null, 1));
    const ov = r.findings.filter((f) => f.code === 'CHAIN_OVERRIDE');
    assert.ok(ov.length >= 2, 'agent settle + close Denied(PAST_DEADLINE)');
    assert.ok(r.matching.some((m) => m.result === 'CHAIN_OVERRIDE'));
  });

  test('G13 the right spec audited against another vault -> FAIL (wrong vault)', async () => {
    const { b, c } = await golden('normal');
    const other = (await golden('stolen-key')).vault;
    const r = await judgeWithSig(b, { ...c, vault: other }, { expectedVault: other });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('WRONG_VAULT'));
    assert.ok(codes(r).includes('SPEC_WRONG_VAULT'));
  });

  test('G13b a genuine founder-signed spec from ANOTHER vault swapped in -> FAIL (spec reuse)', async () => {
    const { b, c, vault } = await golden('normal');
    const o = await golden('stolen-key');
    const t = clone(b);
    t.specBytes = o.b.specBytes;
    t.specSig = o.b.specSig;
    const r = await judgeWithSig(t, c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('SPEC_WRONG_VAULT'));
    assert.ok(codes(r).includes('SPEC_HASH'));
    assert.ok(codes(r).includes('SPEC_REF'));
  });

  test('G13c two sessions with the same spec_id in one bundle -> SPEC_REUSE', async () => {
    const { b, c, vault } = await golden('normal');
    const t = clone(b);
    const g = t.records[0]!;
    t.records.splice(1, 0, { ...g, seq: 1 }); // a second genesis (the chain breaks too)
    const r = await judgeWithSig(t, c, { expectedVault: vault });
    assert.ok(codes(r).includes('SPEC_REUSE'));
  });

  test('I7 crash before send: a recorded deny whose tx was never sent -> TX_NEVER_SENT WARN, PASS', async () => {
    const { b, c, vault } = await golden('injection');
    const deny = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.decision === 'DENY')!;
    const t = clone(b);
    t.ledger = t.ledger.filter((l) => !(l.rec?.toLowerCase() === deny.nameHash.toLowerCase() && (l.status === 'sent' || l.status === 'mined')));
    const tc = clone(c);
    tc.logs = tc.logs.filter((l) => !(l.topics[0] === SEL.Denied && l.topics[3]?.toLowerCase() === deny.nameHash.toLowerCase()));
    const r = await judgeWithSig(t, tc, { expectedVault: vault });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.failures, null, 1));
    assert.ok(codes(r, 'WARN').includes('TX_NEVER_SENT'));
  });

  test('ledger says mined OK but no vault event carries the record -> TX_NOT_ON_CHAIN FAIL', async () => {
    const { b, c, vault } = await golden('injection');
    const deny = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.decision === 'DENY')!;
    const tc = clone(c);
    tc.logs = tc.logs.filter((l) => !(l.topics[0] === SEL.Denied && l.topics[3]?.toLowerCase() === deny.nameHash.toLowerCase()));
    const r = await judgeWithSig(b, tc, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('TX_NOT_ON_CHAIN'));
  });

  // ---------------------------------------------------------------- core-review soundness (F1..F10)
  const topUpReq = (b: Bundle, n = 0) => b.records.filter((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.trigger === 'topup')[n]!;

  test('F1 a stolen key replays an approved top-up rec in a new tx -> UNGATED_SPEND (not "gated")', async () => {
    const { b, c, vault } = await golden('normal');
    const t = clone(c);
    const i = t.logs.findIndex((l) => l.topics[0] === SEL.ToppedUp);
    const orig = t.logs[i]!;
    const replay = { ...orig, transactionHash: keccak256(toHex('replayed-topup')), logIndex: 999 };
    t.logs.splice(i + 1, 0, replay);
    t.txs[replay.transactionHash.toLowerCase()] = { from: c.immutables.agent, blockNumber: orig.blockNumber, status: 'success' };
    const r = await judgeWithSig(b, t, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(codes(r).includes('UNGATED_SPEND'));
    assert.ok(codes(r, 'WARN').includes('DUPLICATE_REC_REF'));
  });

  test('F6 an attacker Denied reusing a public rec stays an UNRECORDED_ATTEMPT; the honest bundle still PASSes', async () => {
    const { b, c, vault } = await golden('stolen-key');
    const t = clone(c);
    const inf = b.records.find((x) => x.record?.kind === 'INFERENCE_OPEN')!;
    const d = t.logs.filter((l) => l.topics[0] === SEL.Denied).at(-1)!;
    d.topics = [d.topics[0]!, d.topics[1]!, d.topics[2]!, inf.nameHash];
    const r = await judgeWithSig(b, t, { expectedVault: vault });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.failures, null, 1));
    assert.equal(r.unrecordedAttempts.length, 3, 'the reuse is still listed as an attack');
    assert.ok(codes(r, 'WARN').includes('DUPLICATE_REC_REF'));
  });

  test('F2 an INFERENCE hold above the fixed $0.05 -> INFERENCE_HOLD FAIL', async () => {
    const { b, c, vault } = await golden('normal');
    const inf = b.records.find((x) => x.record?.kind === 'INFERENCE_OPEN')!;
    const f = forge(b, c, inf.seq, (x) => {
      x.body.ruleInput.request.amount = '6000000';
      x.tx.args[1] = '6000000';
    });
    const ho = f.c.logs.find((l) => l.topics[0] === SEL.HoldOpened)!;
    ho.data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [6_000_000n, 6_000_000n]);
    assert.ok(codes(await judgeWithSig(f.b, f.c, { expectedVault: vault })).includes('INFERENCE_HOLD'));
  });

  test('F2 a top-up of the INFERENCE job -> INFERENCE_TOPUP FAIL (D2: no inference top-up path)', async () => {
    const { b, c, vault } = await golden('normal');
    const t = clone(c);
    const tu = t.logs.find((l) => l.topics[0] === SEL.ToppedUp)!;
    tu.topics = [tu.topics[0]!, `0x${'0'.repeat(64)}` as Hex, tu.topics[2]!]; // job 0 = INFERENCE
    assert.ok(codes(await judgeWithSig(b, t, { expectedVault: vault })).includes('INFERENCE_TOPUP'));
  });

  test('F3 asking the CFO again after a final QWEN_DENIED -> FINAL_DENY_REASKED', async () => {
    const { b, c, vault } = await golden('normal');
    const first = topUpReq(b, 0);
    const f = forge(b, c, first.seq, (x) => {
      x.body.decision = 'DENY';
      x.body.code = 'QWEN_DENIED';
      x.body.f2.raw = '{"verdict":"deny","reason":"scope"}';
    });
    assert.ok(codes(await judgeWithSig(f.b, f.c, { expectedVault: vault })).includes('FINAL_DENY_REASKED'));
  });

  test('F3 a Qwen deny relabeled as a transient code -> RELABELED_DENY', async () => {
    const { b, c, vault } = await golden('qwen-deny');
    const deny = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.code === 'QWEN_DENIED')!;
    const f = forge(b, c, deny.seq, (x) => {
      x.body.code = 'QWEN_UNAVAILABLE';
      x.tx.args[1] = 'QWEN_UNAVAILABLE';
    });
    const d = f.c.logs.find((l) => l.topics[0] === SEL.Denied && l.topics[3]!.toLowerCase() === f.b.records.find((r) => r.seq === deny.seq)!.nameHash.toLowerCase())!;
    d.topics = [d.topics[0]!, d.topics[1]!, codeToBytes32('QWEN_UNAVAILABLE'), d.topics[3]!];
    assert.ok(codes(await judgeWithSig(f.b, f.c, { expectedVault: vault })).includes('RELABELED_DENY'));
  });

  test('S2 a deny relabeled READ_FAILED (a local record) although the gate input was read -> RELABELED_DENY', async () => {
    const { b, c, vault } = await golden('qwen-deny');
    const deny = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.code === 'QWEN_DENIED')!;
    const f = forge(b, c, deny.seq, (x) => {
      x.body.code = 'READ_FAILED';
      x.body.f2 = null; // the F2 deny is dropped too, so only the gate-input evidence is left
      x.body.verdict = null;
      x.tx = null;
    });
    const newHash = f.b.records.find((r) => r.seq === deny.seq)!.nameHash.toLowerCase();
    f.c.logs = f.c.logs.filter((l) => !(l.topics[0] === SEL.Denied && l.topics[3]?.toLowerCase() === newHash));
    f.b.ledger = f.b.ledger.filter((l) => l.rec?.toLowerCase() !== newHash);
    const got = codes(await judgeWithSig(f.b, f.c, { expectedVault: vault }));
    assert.ok(got.includes('RELABELED_DENY'), got.join(','));
  });

  test('S2 a Qwen deny relabeled TOPUP_TIMEOUT (on-chain) -> RELABELED_DENY', async () => {
    const { b, c, vault } = await golden('qwen-deny');
    const deny = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.code === 'QWEN_DENIED')!;
    const f = forge(b, c, deny.seq, (x) => {
      x.body.code = 'TOPUP_TIMEOUT';
      x.tx.args[1] = 'TOPUP_TIMEOUT';
    });
    const d = f.c.logs.find((l) => l.topics[0] === SEL.Denied && l.topics[3]!.toLowerCase() === f.b.records.find((r) => r.seq === deny.seq)!.nameHash.toLowerCase())!;
    d.topics = [d.topics[0]!, d.topics[1]!, codeToBytes32('TOPUP_TIMEOUT'), d.topics[3]!];
    const got = codes(await judgeWithSig(f.b, f.c, { expectedVault: vault }));
    assert.ok(got.includes('RELABELED_DENY'), got.join(','));
  });

  test('S4 a vendor job closed with ledger usage unsettled -> WARN UNPAID_USAGE (not FAIL)', async () => {
    const { b, c, vault } = await golden('normal');
    const close = b.records.find((x) => x.record?.kind === 'CLOSE' && x.record.job_id !== '0')!;
    const f = forge(b, c, close.seq, (x) => (x.body.unsettled_net = '1234'));
    const r = await judgeWithSig(f.b, f.c, { expectedVault: vault });
    assert.equal(r.verdict, 'PASS', codes(r).join(','));
    assert.ok(codes(r, 'WARN').includes('UNPAID_USAGE'));
  });

  test('F4 a gate snapshot pinned at/after its own tx block -> SNAPSHOT_ORDER', async () => {
    const { b, c, vault } = await golden('normal');
    const req = topUpReq(b, 0);
    const txBlock = c.logs.find((l) => l.topics[0] === SEL.ToppedUp)!.blockNumber;
    const f = forge(b, c, req.seq, (x) => {
      x.body.gateInput.chain.blockNumber = txBlock;
      x.body.snapshot.blockNumber = txBlock;
    });
    assert.ok(codes(await judgeWithSig(f.b, f.c, { expectedVault: vault })).includes('SNAPSHOT_ORDER'));
  });

  test('F5 F2 reviewed a different amount than the one topped up -> F2_NOT_BOUND', async () => {
    const { b, c, vault } = await golden('normal');
    const req = topUpReq(b, 1);
    const f = forge(b, c, req.seq, (x) => {
      const u = x.body.f2.messages.find((m: { role: string }) => m.role === 'user');
      u.content = u.content.replace('$2.56 net', '$0.10 net');
    });
    assert.deepEqual(codes(await judgeWithSig(f.b, f.c, { expectedVault: vault })), ['F2_NOT_BOUND']);
  });

  test('F5 R not taken from F1\'s own answer -> F1_NOT_BOUND', async () => {
    const { b, c, vault } = await golden('normal');
    const req = topUpReq(b, 1);
    const f = forge(b, c, req.seq, (x) => (x.body.f1.raw = x.body.f1.raw.replace('"amount":"2.56"', '"amount":"0.10"')));
    assert.ok(codes(await judgeWithSig(f.b, f.c, { expectedVault: vault })).includes('F1_NOT_BOUND'));
  });

  test('F7 a NaN hidden from the gate (anchored checkpoint says NaN) -> LOSS_HISTORY_MISMATCH + SPEND_AFTER_NAN', async () => {
    const { b, c, vault } = await golden('normal');
    const req = topUpReq(b, 1);
    const settle = b.records.filter((x) => x.record?.kind === 'SETTLE' && x.seq < req.seq).at(-1)!;
    const f = forge(b, c, settle.seq, (x) => (x.body.checkpoint.loss = 'NaN'));
    const got = codes(await judgeWithSig(f.b, f.c, { expectedVault: vault }));
    assert.ok(got.includes('LOSS_HISTORY_MISMATCH'), got.join(','));
    assert.ok(got.includes('SPEND_AFTER_NAN'), got.join(','));
  });

  test('F8 F2 called on a gate-denied request that never reached the chain -> F2_AFTER_GATE_DENY + DENY_NOT_ON_CHAIN', async () => {
    const { b, c, vault } = await golden('injection');
    const start = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.trigger === 'start')!;
    const deny = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.decision === 'DENY')!;
    const f = forge(b, c, deny.seq, (x) => {
      x.tx = null;
      x.body.f2 = (start.record as DecisionRecord<'REQUEST'>).body.f2;
    });
    const newHash = f.b.records.find((r) => r.seq === deny.seq)!.nameHash.toLowerCase();
    f.c.logs = f.c.logs.filter((l) => !(l.topics[0] === SEL.Denied && l.topics[3]?.toLowerCase() === newHash));
    f.b.ledger = f.b.ledger.filter((l) => l.rec?.toLowerCase() !== newHash);
    const got = codes(await judgeWithSig(f.b, f.c, { expectedVault: vault }));
    assert.ok(got.includes('F2_AFTER_GATE_DENY') && got.includes('DENY_NOT_ON_CHAIN'), got.join(','));
  });

  test('F9 a "REVERTED" ledger claim pointing at a successful tx does not excuse a missing tx', async () => {
    const { b, c, vault } = await golden('injection');
    const deny = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.decision === 'DENY')!;
    const settle = b.ledger.find((l) => l.status === 'mined' && l.fn === 'settle')!;
    const t = clone(b);
    for (const l of t.ledger) if (l.rec?.toLowerCase() === deny.nameHash.toLowerCase() && l.status === 'mined') Object.assign(l, { result: 'REVERTED', tx: settle.tx, block: settle.block });
    const tc = clone(c);
    tc.logs = tc.logs.filter((l) => !(l.topics[0] === SEL.Denied && l.topics[3]?.toLowerCase() === deny.nameHash.toLowerCase()));
    assert.ok(codes(await judgeWithSig(t, tc, { expectedVault: vault })).includes('TX_NOT_ON_CHAIN'));
  });

  test('F10 a vault whose fee is not the designed 3% -> FEE_BPS FAIL', async () => {
    const { b, c, vault } = await golden('normal');
    assert.ok(codes(await judgeWithSig(b, { ...c, immutables: { ...c.immutables, feeBps: '0' } }, { expectedVault: vault })).includes('FEE_BPS'));
  });

  test('G14 stub LLM bundle with --submission -> FAIL; without the flag -> PASS', async () => {
    const { b, c, vault } = await golden('normal');
    const sub = await judgeWithSig(b, c, { expectedVault: vault, submission: true });
    assert.equal(sub.verdict, 'FAIL');
    assert.ok(codes(sub).includes('STUB_IN_SUBMISSION'));
    assert.equal((await judgeWithSig(b, c, { expectedVault: vault })).verdict, 'PASS');
  });

  test('G15 migration with setVendor(A,false) BEFORE the final settle -> PASS (agent Denied by D3, founder settles)', async () => {
    const { b, c, vault } = await golden('migration-d3');
    const r = await judgeWithSig(b, c, { expectedVault: vault });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.failures, null, 1));
    const ov = r.findings.filter((f) => f.code === 'CHAIN_OVERRIDE');
    assert.equal(ov.length, 1);
    assert.match(ov[0]!.detail, /VENDOR_NOT_ALLOWED/);
  });

  test('check 7: an AGENT settle to a vendor that is no longer allow-listed -> FAIL', async () => {
    const { b, c, vault } = await golden('migration-d3');
    const t = clone(c);
    // pretend the founder's settle after setVendor(A,false) was sent by the agent
    const vs = t.logs.findIndex((l) => l.topics[0] === SEL.VendorSet && l.data.endsWith('0'.repeat(64)));
    const settleAfter = t.logs.findIndex((l, i) => i > vs && l.topics[0] === SEL.Settled);
    t.txs[t.logs[settleAfter]!.transactionHash.toLowerCase()]!.from = c.immutables.agent;
    const r = await judgeWithSig(b, t, { expectedVault: vault });
    assert.ok(codes(r).includes('VENDOR_NOT_ALLOWED_AT_SETTLE'));
  });

  test('forge() sanity: re-chaining without a semantic change still PASSES', async () => {
    const { b, c, vault } = await golden('normal');
    const seq = b.records.find((x) => x.record?.kind === 'REQUEST')!.seq;
    const f = forge(b, c, seq, () => {});
    const r = await judgeWithSig(f.b, f.c, { expectedVault: vault });
    assert.equal(r.verdict, 'PASS', JSON.stringify(r.failures, null, 1));
  });

  test('forged at write time: a recorded chain input that disagrees with the replayed state -> CHAIN_INPUT_MISMATCH', async () => {
    const { b, c, vault } = await golden('normal');
    const seq = b.records.find((x) => x.record?.kind === 'REQUEST')!.seq;
    const f = forge(b, c, seq, (x) => (x.body.gateInput.chain.committed = '1'));
    const r = await judgeWithSig(f.b, f.c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(codes(r), ['CHAIN_INPUT_MISMATCH']);
  });

  test('forged at write time: a gate DENY the rules do not re-derive -> GATE_MISMATCH', async () => {
    const { b, c, vault } = await golden('injection');
    const seq = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.decision === 'DENY')!.seq;
    // claim the injected request was over maxHold instead of a disallowed vendor
    const f = forge(b, c, seq, (x) => (x.body.gateResult = ['OVER_MAX_HOLD']));
    const r = await judgeWithSig(f.b, f.c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(codes(r), ['GATE_MISMATCH']);
  });

  test('forged at write time: an approval whose raw F2 text says deny -> NO_CFO_APPROVAL', async () => {
    const { b, c, vault } = await golden('normal');
    const seq = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.trigger === 'topup')!.seq;
    const f = forge(b, c, seq, (x) => (x.body.f2.raw = '{"verdict":"deny","reason":"scope"}'));
    const r = await judgeWithSig(f.b, f.c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(codes(r), ['NO_CFO_APPROVAL']);
  });

  test('forged at write time: "Approve" (not exact) is not an approval -> NO_CFO_APPROVAL', async () => {
    const { b, c, vault } = await golden('normal');
    const seq = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.trigger === 'topup')!.seq;
    const f = forge(b, c, seq, (x) => (x.body.f2.raw = '{"verdict":"Approve","reason":"ok"}'));
    assert.deepEqual(codes(await judgeWithSig(f.b, f.c, { expectedVault: vault })), ['NO_CFO_APPROVAL']);
  });

  test('forged at write time: tx args not built from R -> R_MISMATCH', async () => {
    const { b, c, vault } = await golden('normal');
    const seq = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.trigger === 'start')!.seq;
    const f = forge(b, c, seq, (x) => (x.body.gateInput.request.amount = '1000000'));
    const r = await judgeWithSig(f.b, f.c, { expectedVault: vault });
    assert.ok(codes(r).includes('R_MISMATCH'));
  });

  test('forged at write time: F2 was called although the gate denied -> F2_AFTER_GATE_DENY', async () => {
    const { b, c, vault } = await golden('injection');
    const n = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.trigger === 'start')!;
    const seq = b.records.find((x) => x.record?.kind === 'REQUEST' && (x.record as DecisionRecord<'REQUEST'>).body.decision === 'DENY')!.seq;
    const f = forge(b, c, seq, (x) => (x.body.f2 = (n.record as DecisionRecord<'REQUEST'>).body.f2));
    assert.ok(codes(await judgeWithSig(f.b, f.c, { expectedVault: vault })).includes('F2_AFTER_GATE_DENY'));
  });
});

describe('auditor RPC handling', () => {
  test('G9 RPC unreachable -> CANNOT_VERIFY, exit 2', { skip: !HAVE && 'no golden' }, async () => {
    const r = await auditBundle({ dir: `${G}/normal/bundle`, rpcUrl: 'http://127.0.0.1:1', expectedVault: JSON.parse(readFileSync(`${G}/normal/bundle/run.json`, 'utf8')).vault });
    assert.equal(r.verdict, 'CANNOT_VERIFY');
    assert.equal(r.exitCode, 2);
  });

  const fakePc = (head: bigint, opts: { maxRange?: bigint; failLogs?: boolean } = {}) => {
    const calls: [bigint, bigint][] = [];
    const pc = createPublicClient({
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === 'eth_chainId') return '0x7a69';
          if (method === 'eth_blockNumber') return toHex(head);
          if (method === 'eth_getCode') return '0x60';
          if (method === 'eth_call') return encodeAbiParameters([{ type: 'address' }], ['0x0000000000000000000000000000000000000001']);
          if (method === 'eth_getLogs') {
            const p = (params as { fromBlock: Hex; toBlock: Hex }[])[0]!;
            const f = BigInt(p.fromBlock);
            const t = BigInt(p.toBlock);
            calls.push([f, t]);
            if (opts.failLogs || t - f + 1n > (opts.maxRange ?? 1000n)) throw new Error('block range too large (-32614)');
            return [];
          }
          throw new Error(`unexpected ${method}`);
        },
      }),
    }) as PublicClient;
    return { pc, calls };
  };

  test('G9 head behind the bundle last block -> CannotVerify', async () => {
    const { pc } = fakePc(100n);
    await assert.rejects(fetchChainData(pc, { vault: '0x0000000000000000000000000000000000000002', fromBlock: 0n, toBlock: 500n, txHashes: [], blocks: [] }), CannotVerify);
  });

  test('getLogs is chunked at 1,000 blocks (public RPC limit); persistent RPC errors -> CannotVerify', async () => {
    const ok = fakePc(5_000n);
    await fetchChainData(ok.pc, { vault: '0x0000000000000000000000000000000000000002', fromBlock: 10n, toBlock: 3_500n, txHashes: [], blocks: [] });
    assert.ok(ok.calls.length >= 4 && ok.calls.every(([f, t]) => t - f + 1n <= 1000n));
    const bad = fakePc(5_000n, { failLogs: true });
    await assert.rejects(fetchChainData(bad.pc, { vault: '0x0000000000000000000000000000000000000002', fromBlock: 10n, toBlock: 20n, txHashes: [], blocks: [] }), CannotVerify);
  });
});

describe('auditor boundaries and portability', () => {
  test('the auditor imports pure modules only (never executor/kiln/akash/session/server/commit)', () => {
    for (const f of readdirSync('auditor').filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join('auditor', f), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]!).filter((m) => m.startsWith('.'));
      for (const m of imports) {
        assert.doesNotMatch(m, /(executor|kiln|akash|session|server|scenarios|commit|config)\.ts$/, `${f} imports ${m}`);
      }
    }
  });

  test('golden bundles are stored byte-exact (.gitattributes -text)', { skip: !HAVE && 'no golden' }, () => {
    const out = execFileSync('git', ['check-attr', 'text', `${G}/normal/bundle/records/000000-x.json`], { encoding: 'utf8' });
    assert.match(out, /text: unset/);
  });

  test('G16 a `git -c core.autocrlf=true clone` of the committed repo still audits PASS', async (t) => {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', `${G}/normal/chain.json`]).status === 0;
    if (!tracked) return t.skip('golden fixtures not committed yet');
    const dir = mkdtempSync(join(tmpdir(), 'cfo-crlf-'));
    try {
      execFileSync('git', ['-c', 'core.autocrlf=true', 'clone', '--quiet', '--no-hardlinks', '.', dir], { stdio: 'pipe' });
      const b = await loadBundle(join(dir, G, 'normal', 'bundle'));
      const c = JSON.parse(readFileSync(join(dir, G, 'normal', 'chain.json'), 'utf8')) as ChainData;
      assert.ok(b.records.every((r) => !r.bytes.includes(0x0d)), 'no CR bytes after an autocrlf clone');
      const r = await judgeWithSig(b, c, { expectedVault: b.run.vault });
      assert.equal(r.verdict, 'PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CRLF-converted records are FAIL with a CRLF hint (what -text prevents)', { skip: !HAVE && 'no golden' }, async () => {
    const { b, c, vault } = await golden('normal');
    const t = editRecord(b, 1, (by) => new TextEncoder().encode(new TextDecoder().decode(by).replace('{', '{\r\n')));
    const r = await judgeWithSig(t, c, { expectedVault: vault });
    assert.equal(r.verdict, 'FAIL');
    assert.ok(r.findings.some((f) => f.code === 'CRLF_SUSPECT'));
  });
});

void codeToBytes32;
