// Signed work spec: exact-bytes EIP-191, vault/chain/spec_id binding (R3-16), strict parsing.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';
import { bytesToHex } from 'viem';
import { parseSpec, specBytes, specJobCap, SpecError, verifySpec, type WorkSpec } from '../../backend/spec.ts';

// anvil account 0 (public dev key) as founder, account 1 as someone else
const FOUNDER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const OTHER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const VAULT = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;

const spec: WorkSpec = {
  schema_version: 1,
  spec_id: 'spec-20260929-001',
  vault: VAULT,
  chain_id: 84532,
  issued_at: '2026-09-29T02:00:00Z',
  purpose: 'Fine-tune a 7B model on the support-ticket dataset to beat the baseline eval.',
  success_metric: 'eval loss < 1.20 on the held-out split',
  allowed_gpu_types: ['H100'],
  job_cap_usd: '12.00',
  deadline: 1_790_000_000,
};

async function signed(s: WorkSpec = spec) {
  const bytes = specBytes(s);
  const sig = await FOUNDER.signMessage({ message: { raw: bytes } });
  return { bytes, sig };
}

describe('spec bytes', () => {
  test('canonical compact bytes, no trailing newline, stable', () => {
    const a = specBytes(spec);
    const b = specBytes({ ...spec });
    assert.deepEqual(a, b);
    const text = new TextDecoder().decode(a);
    assert.ok(text.startsWith('{"schema_version":1,"spec_id":"spec-20260929-001","vault":'));
    assert.ok(!text.endsWith('\n'));
    assert.deepEqual(parseSpec(a), spec);
    assert.equal(specJobCap(spec), 12_000_000n);
  });

  test('strict parse: wrong key order, extra key, bad fields', () => {
    const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
    const { purpose, ...rest } = spec;
    assert.throws(() => parseSpec(enc({ purpose, ...rest })), SpecError); // order
    assert.throws(() => parseSpec(enc({ ...spec, extra: 1 })), SpecError);
    assert.throws(() => parseSpec(enc({ ...spec, job_cap_usd: '$12' })), SpecError);
    assert.throws(() => parseSpec(enc({ ...spec, allowed_gpu_types: [] })), SpecError);
    assert.throws(() => parseSpec(enc({ ...spec, vault: '0x12' })), SpecError);
    assert.throws(() => parseSpec(enc({ ...spec, deadline: '1790000000' })), SpecError);
    assert.throws(() => parseSpec(new Uint8Array([0xff, 0xfe])), SpecError);
  });
});

describe('verifySpec', () => {
  test('founder-signed spec for this vault/chain verifies', async () => {
    const { bytes, sig } = await signed();
    const r = await verifySpec({ bytes, sig, founder: FOUNDER.address, vault: VAULT, chainId: 84532 });
    assert.deepEqual(r.issues, []);
    assert.equal(r.signer, FOUNDER.address);
  });

  test('1-byte tamper -> signature no longer from founder', async () => {
    const { bytes, sig } = await signed();
    const t = new Uint8Array(bytes);
    const i = new TextDecoder().decode(t).indexOf('12.00') + 1;
    t[i] = '9'.charCodeAt(0); // job_cap 12.00 -> 19.00
    const r = await verifySpec({ bytes: t, sig, founder: FOUNDER.address, vault: VAULT, chainId: 84532 });
    assert.deepEqual(r.issues.map((x) => x.issue), ['SPEC_BAD_SIGNATURE']);
  });

  test('signed by someone else -> SPEC_BAD_SIGNATURE', async () => {
    const bytes = specBytes(spec);
    const sig = await OTHER.signMessage({ message: { raw: bytes } });
    const r = await verifySpec({ bytes, sig, founder: FOUNDER.address, vault: VAULT, chainId: 84532 });
    assert.deepEqual(r.issues.map((x) => x.issue), ['SPEC_BAD_SIGNATURE']);
  });

  test('genuine spec for another vault / chain -> FAIL (no replay)', async () => {
    const { bytes, sig } = await signed();
    const other = '0x000000000000000000000000000000000000dEaD' as const;
    const r1 = await verifySpec({ bytes, sig, founder: FOUNDER.address, vault: other, chainId: 84532 });
    assert.deepEqual(r1.issues.map((x) => x.issue), ['SPEC_WRONG_VAULT']);
    const r2 = await verifySpec({ bytes, sig, founder: FOUNDER.address, vault: VAULT, chainId: 31337 });
    assert.deepEqual(r2.issues.map((x) => x.issue), ['SPEC_WRONG_CHAIN']);
  });

  test('garbage signature is reported, not thrown', async () => {
    const r = await verifySpec({ bytes: specBytes(spec), sig: '0x1234', founder: FOUNDER.address, vault: VAULT, chainId: 84532 });
    assert.deepEqual(r.issues.map((x) => x.issue), ['SPEC_BAD_SIGNATURE']);
  });

  test('forge keystore path: `cast wallet sign 0x<file bytes>` == viem raw signature', async (t) => {
    let castSig: string;
    try {
      castSig = execFileSync('cast', ['wallet', 'sign', '--private-key', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', bytesToHex(specBytes(spec))], { encoding: 'utf8' }).trim();
    } catch {
      t.skip('cast not on PATH');
      return;
    }
    const { sig } = await signed();
    assert.equal(castSig, sig);
  });
});
