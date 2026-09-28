// B3: record serialize/parse round trip, keccak(raw bytes) == recHash, prevHash chain,
// atomic write + read-back, tamper / delete / CRLF detection.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import {
  buildRecord,
  hashBytes,
  loadRecordDir,
  parseBytes,
  RecordIntegrityError,
  recordFileName,
  serialize,
  SerializeError,
  validateRecord,
  verifyChain,
  writeRecordFile,
  ZERO_HASH,
  type DecisionRecord,
  type Head,
  type RecordDraft,
} from '../../backend/record.ts';

const VAULT = '0x00000000000000000000000000000000000000aa' as const;

function pauseDraft(i: number): RecordDraft<'PAUSE'> {
  return {
    kind: 'PAUSE',
    run_id: 'run-test',
    chain_id: 31337,
    vault: VAULT,
    spec_id: 'spec-1',
    req_id: `req-${i}`,
    job_id: null,
    at: '2026-09-29T00:00:00.000Z',
    tx: { fn: 'setPaused', from: 'founder', args: [true] },
    body: { reason: `preset-${i}`, snapshot: null },
  };
}

describe('serialize', () => {
  test('compact JSON, no indentation, no trailing newline, insertion key order', () => {
    const bytes = serialize({ b: 1, a: [1, 2], c: { z: true, y: null } });
    const text = new TextDecoder().decode(bytes);
    assert.equal(text, '{"b":1,"a":[1,2],"c":{"z":true,"y":null}}');
    assert.notEqual(text.at(-1), '\n');
  });

  test('bigint -> string, NaN / Infinity -> strings', () => {
    const text = new TextDecoder().decode(
      serialize({ amt: 2n ** 255n, n: Number.NaN, p: Infinity, m: -Infinity, f: 1.5, z: -0 }),
    );
    assert.equal(
      text,
      `{"amt":"${(2n ** 255n).toString()}","n":"NaN","p":"Infinity","m":"-Infinity","f":1.5,"z":0}`,
    );
  });

  test('rejects undefined, Map, Date, functions (no silent drops)', () => {
    assert.throws(() => serialize({ a: undefined }), SerializeError);
    assert.throws(() => serialize({ a: new Map() }), SerializeError);
    assert.throws(() => serialize({ a: new Date(0) }), SerializeError);
    assert.throws(() => serialize({ a: () => 1 }), SerializeError);
    assert.throws(() => serialize([Symbol('x')]), SerializeError);
  });

  test('recHash is keccak256 of the exact bytes; round trip is stable', () => {
    const obj = { x: 5n, y: 'é漢字', z: [Number.NaN] };
    const bytes = serialize(obj);
    assert.equal(hashBytes(bytes), keccak256(bytes));
    const back = parseBytes(bytes);
    assert.deepEqual(back, { x: '5', y: 'é漢字', z: ['NaN'] });
    // re-serializing the parsed wire form gives identical bytes
    assert.deepEqual(serialize(back), bytes);
  });

  test('a 1-byte change changes the hash', () => {
    const bytes = serialize({ amount: '5120000' });
    const t = new Uint8Array(bytes);
    t[t.length - 3] = t[t.length - 3]! ^ 1;
    assert.notEqual(hashBytes(t), hashBytes(bytes));
  });
});

describe('buildRecord / validateRecord', () => {
  test('genesis prevHash is ZERO_HASH and seq 0; next links to it', () => {
    const r0 = buildRecord(null, pauseDraft(0));
    assert.equal(r0.seq, 0);
    assert.equal(r0.prevHash, ZERO_HASH);
    const h0 = hashBytes(serialize(r0));
    const r1 = buildRecord({ seq: 0, hash: h0 }, pauseDraft(1));
    assert.equal(r1.seq, 1);
    assert.equal(r1.prevHash, h0);
    assert.deepEqual(validateRecord(r1), []);
  });

  test('header key order is fixed (bytes do not depend on draft key order)', () => {
    const d = pauseDraft(0);
    const shuffled = { body: d.body, tx: d.tx, at: d.at, job_id: d.job_id, req_id: d.req_id, spec_id: d.spec_id, vault: d.vault, chain_id: d.chain_id, run_id: d.run_id, kind: d.kind } as RecordDraft<'PAUSE'>;
    assert.deepEqual(serialize(buildRecord(null, d)), serialize(buildRecord(null, shuffled)));
  });

  test('CHECKPOINT (no tx) anchors a NaN loss; it round-trips as "NaN" and re-hashes identically', () => {
    const d: RecordDraft<'CHECKPOINT'> = {
      kind: 'CHECKPOINT',
      run_id: 'run-test',
      chain_id: 31337,
      vault: VAULT,
      spec_id: 'spec-1',
      req_id: null,
      job_id: '1',
      at: '2026-09-29T00:00:00.000Z',
      tx: null,
      body: { checkpoint: { idx: 4, loss: Number.NaN as unknown as 'NaN', accrued_net: '1280000', sim_seconds: '1800' }, note: 'nan' },
    };
    const r = buildRecord(null, d);
    assert.deepEqual(validateRecord(r), []);
    const bytes = serialize(r);
    assert.ok(new TextDecoder().decode(bytes).includes('"loss":"NaN"'));
    const back = parseBytes<DecisionRecord<'CHECKPOINT'>>(bytes);
    assert.equal(back.body.checkpoint.loss, 'NaN');
    assert.deepEqual(serialize(back), bytes);
    // a CHECKPOINT may not carry a tx
    assert.deepEqual(validateRecord({ ...r, tx: { fn: 'settle', from: 'agent', args: [] } }), ['tx.fn settle not allowed for CHECKPOINT']);
  });

  test('tx fn must be allowed for the kind; tx-bearing kinds require a tx', () => {
    const r = buildRecord(null, pauseDraft(0)) as DecisionRecord;
    assert.deepEqual(validateRecord({ ...r, tx: { fn: 'refund', from: 'founder', args: [] } }), ['tx.fn refund not allowed for PAUSE']);
    assert.deepEqual(validateRecord({ ...r, tx: null }), ['PAUSE requires a tx']);
    assert.ok(validateRecord({ ...r, prevHash: '0x1234' }).includes('prevHash'));
    assert.ok(validateRecord({ ...r, kind: 'NOPE' }).includes('kind'));
  });
});

describe('record files and chain verification', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfo-rec-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeChain(n: number): Promise<string[]> {
    let head: Head = null;
    const files: string[] = [];
    for (let i = 0; i < n; i++) {
      const w = await writeRecordFile(dir, buildRecord(head, pauseDraft(i)));
      head = { seq: i, hash: w.hash };
      files.push(w.file);
    }
    return files;
  }

  test('write: <seq6>-<hash>.json, bytes on disk hash to the name, no tmp left behind', async () => {
    const rec = buildRecord(null, pauseDraft(0));
    const w = await writeRecordFile(dir, rec);
    assert.equal(w.file, recordFileName(0, w.hash));
    const disk = new Uint8Array(await readFile(join(dir, w.file)));
    assert.equal(keccak256(disk), w.hash);
    assert.deepEqual(disk, serialize(rec));
    assert.deepEqual(await readdir(dir), [w.file]);
  });

  test('write refuses to overwrite and refuses invalid records', async () => {
    const rec = buildRecord(null, pauseDraft(0));
    await writeRecordFile(dir, rec);
    await assert.rejects(writeRecordFile(dir, rec), RecordIntegrityError);
    await assert.rejects(writeRecordFile(dir, { ...rec, seq: -1 } as DecisionRecord), RecordIntegrityError);
  });

  test('clean chain of 5 verifies with no issues', async () => {
    await writeChain(5);
    const { records, stray } = await loadRecordDir(dir);
    assert.equal(records.length, 5);
    assert.deepEqual(stray, []);
    assert.deepEqual(verifyChain(records), []);
  });

  test('1-byte tamper in the middle -> HASH_MISMATCH at exactly that seq', async () => {
    const files = await writeChain(5);
    const p = join(dir, files[2]!);
    const b = new Uint8Array(await readFile(p));
    const i = b.indexOf('p'.charCodeAt(0), b.length - 40); // inside "preset-2"
    b[i] = 'P'.charCodeAt(0);
    await writeFile(p, b);
    const issues = verifyChain((await loadRecordDir(dir)).records);
    assert.deepEqual(issues.map((x) => [x.seq, x.kind]), [[2, 'HASH_MISMATCH']]);
  });

  test('tamper + rename to the new hash -> PREV_MISMATCH on the next record', async () => {
    const files = await writeChain(4);
    const p = join(dir, files[1]!);
    const b = new Uint8Array(await readFile(p));
    const i = b.indexOf('p'.charCodeAt(0), b.length - 40); // inside "preset-1": still valid JSON
    b[i] = 'P'.charCodeAt(0);
    await unlink(p);
    await writeFile(join(dir, recordFileName(1, keccak256(b))), b);
    const issues = verifyChain((await loadRecordDir(dir)).records);
    assert.deepEqual(issues.map((x) => [x.seq, x.kind]), [[2, 'PREV_MISMATCH']]);
  });

  test('deleted middle record -> SEQ_GAP + PREV_MISMATCH', async () => {
    const files = await writeChain(4);
    await unlink(join(dir, files[1]!));
    const issues = verifyChain((await loadRecordDir(dir)).records);
    assert.deepEqual(
      issues.map((x) => [x.seq, x.kind]).sort(),
      [[2, 'PREV_MISMATCH'], [2, 'SEQ_GAP']],
    );
  });

  test('CRLF conversion is flagged with a hint (and breaks the hash)', async () => {
    const files = await writeChain(2);
    const p = join(dir, files[0]!);
    const text = (await readFile(p, 'utf8')).replace('{', '{\r\n');
    await writeFile(p, text);
    const kinds = verifyChain((await loadRecordDir(dir)).records).map((x) => x.kind);
    assert.ok(kinds.includes('CRLF_SUSPECT'));
    assert.ok(kinds.includes('HASH_MISMATCH'));
  });

  test('stray files are reported, not silently used', async () => {
    await writeChain(1);
    await writeFile(join(dir, 'notes.txt'), 'x');
    const { stray } = await loadRecordDir(dir);
    assert.deepEqual(stray, ['notes.txt']);
  });

  test('a renamed file whose name hash does not match its bytes is caught', async () => {
    const files = await writeChain(2);
    const fake = recordFileName(1, `0x${'ab'.repeat(32)}`);
    await rename(join(dir, files[1]!), join(dir, fake));
    const issues = verifyChain((await loadRecordDir(dir)).records);
    assert.deepEqual(issues.map((x) => [x.seq, x.kind]), [[1, 'HASH_MISMATCH']]);
  });
});
