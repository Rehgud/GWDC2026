// T1: scripts/check-secrets.sh must catch leaks in large staged diffs and recent history
// (regression for the pipefail + `grep -q` SIGPIPE miss), in .env.example, and Kiln keys.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir, copyFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/check-secrets.sh');
const SECRET = '0x' + '1234abcd'.repeat(8);
const PAD = 'x'.repeat(100) + '\n';
const BIG = PAD.repeat(3000); // ~300 KB after the secret: well past any pipe buffer

function hasTools(): boolean {
  for (const [cmd, args] of [['bash', ['--version']], ['git', ['--version']]] as const) {
    if (spawnSync(cmd, [...args]).status !== 0) return false;
  }
  return true;
}

describe('check-secrets.sh', { skip: !hasTools() && 'bash/git not available' }, () => {
  let dir: string;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString();
  const run = () => spawnSync('bash', ['scripts/check-secrets.sh'], { cwd: dir, encoding: 'utf8' });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cfo-secrets-'));
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
    git('config', 'core.autocrlf', 'false');
    await mkdir(join(dir, 'scripts'));
    await copyFile(SCRIPT, join(dir, 'scripts/check-secrets.sh'));
    await writeFile(join(dir, '.gitignore'), '.env*\n!.env.example\n');
    await writeFile(join(dir, '.env'), `AGENT_PK=${SECRET}\nCHAIN=anvil\n`);
    await writeFile(join(dir, '.env.example'), 'AGENT_PK=\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('clean repo passes', () => {
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /PASS \(1 secret value/);
  });

  test('secret at the TOP of a >200 KB staged diff is caught (no SIGPIPE miss)', async () => {
    await writeFile(join(dir, 'a-big.txt'), `${SECRET}\n${BIG}`);
    git('add', 'a-big.txt');
    await unlink(join(dir, 'a-big.txt')); // only the staged diff still has it
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /value of AGENT_PK found in staged changes/);
    git('reset', '-q', '--', 'a-big.txt');
  });

  test('secret in the NEWEST commit of a large history is caught after removal from the tree', async () => {
    await writeFile(join(dir, 'old.txt'), BIG);
    git('add', 'old.txt');
    git('commit', '-q', '-m', 'bulk');
    await writeFile(join(dir, 'leak.txt'), `${SECRET}\n${BIG}`);
    git('add', 'leak.txt');
    git('commit', '-q', '-m', 'leak');
    git('rm', '-q', 'leak.txt');
    git('commit', '-q', '-m', 'remove leak');
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /value of AGENT_PK found in git history/);
  });

  test('.env.example is scanned (a real value pasted into the template)', async () => {
    const d2 = await mkdtemp(join(tmpdir(), 'cfo-secrets2-'));
    try {
      const g = (...a: string[]) => execFileSync('git', a, { cwd: d2, stdio: 'pipe' });
      g('init', '-q');
      await mkdir(join(d2, 'scripts'));
      await copyFile(SCRIPT, join(d2, 'scripts/check-secrets.sh'));
      await writeFile(join(d2, '.gitignore'), '.env*\n!.env.example\n');
      await writeFile(join(d2, '.env'), `FOUNDER_PK=${SECRET}\n`);
      await writeFile(join(d2, '.env.example'), `FOUNDER_PK=${SECRET}\n`);
      const r = spawnSync('bash', ['scripts/check-secrets.sh'], { cwd: d2, encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /value of FOUNDER_PK found in \.env\.example/);
    } finally {
      await rm(d2, { recursive: true, force: true });
    }
  });

  test('Kiln key pattern is caught even with no .env', async () => {
    const d3 = await mkdtemp(join(tmpdir(), 'cfo-secrets3-'));
    try {
      const g = (...a: string[]) => execFileSync('git', a, { cwd: d3, stdio: 'pipe' });
      g('init', '-q');
      await mkdir(join(d3, 'scripts'));
      await copyFile(SCRIPT, join(d3, 'scripts/check-secrets.sh'));
      await writeFile(join(d3, '.gitignore'), '.env*\n');
      await writeFile(join(d3, 'notes.md'), `key: ${'sk-' + 'bk-'}AbCdEf123456\n${BIG}`);
      const r = spawnSync('bash', ['scripts/check-secrets.sh'], { cwd: d3, encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Kiln key pattern sk-bk-\* found in notes\.md/);
    } finally {
      await rm(d3, { recursive: true, force: true });
    }
  });

  test('public anvil dev keys are allowed', async () => {
    const d4 = await mkdtemp(join(tmpdir(), 'cfo-secrets4-'));
    try {
      const g = (...a: string[]) => execFileSync('git', a, { cwd: d4, stdio: 'pipe' });
      g('init', '-q');
      await mkdir(join(d4, 'scripts'));
      await copyFile(SCRIPT, join(d4, 'scripts/check-secrets.sh'));
      const anvil0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
      await writeFile(join(d4, '.gitignore'), '.env*\n');
      await writeFile(join(d4, '.env'), `FOUNDER_PK=${anvil0}\n`);
      await writeFile(join(d4, 'e2e.sh'), `PK=${anvil0}\n`);
      const r = spawnSync('bash', ['scripts/check-secrets.sh'], { cwd: d4, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /PASS \(0 secret value/);
    } finally {
      await rm(d4, { recursive: true, force: true });
    }
  });
});
