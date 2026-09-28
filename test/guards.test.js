// End-to-end scenarios where the builder, the evaluator or the checkout misbehave. Uses fixtures/fake-claude.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/shipyard', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const F = (id, o = {}) => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id}.txt exists`],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });

function setup(t, { features, config = {}, scenario = {}, verdicts = {} }) {
  const base = mkdtempSync(join(tmpdir(), 'shipyard-guard-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'app');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.'); git('commit', '-qm', 'init');
  chmodSync(FAKE, 0o755);
  const env = { ...process.env, SHIPYARD_CLAUDE: FAKE, SHIPYARD_POLL_MS: '100', FAKE_DELAY_MS: '50',
    FAKE_LOG: join(base, 'fake.jsonl'), FAKE_VERDICTS: join(base, 'verdicts.json'), FAKE_PIDS: join(base, 'pids'),
    FAKE_SCENARIO: JSON.stringify(scenario) };
  const cli = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(cli('init', '--test', 'true').status, 0);
  const sy = (f) => join(repo, '.shipyard', f);
  writeFileSync(sy('config.json'), JSON.stringify({ ...JSON.parse(readFileSync(sy('config.json'), 'utf8')), ...config }));
  writeFileSync(sy('features.json'), JSON.stringify({ features }));
  writeFileSync(env.FAKE_VERDICTS, JSON.stringify(verdicts));
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return {
    repo, env, git, cli,
    feature: (id) => JSON.parse(read(sy('features.json'))).features.find((f) => f.id === id),
    log: () => read(sy('log.jsonl')),
    calls: (mode, id) => read(env.FAKE_LOG).split('\n').filter(Boolean).map(JSON.parse).filter((c) => c.mode === mode && c.id === id),
    pids: () => read(env.FAKE_PIDS).split('\n').filter(Boolean).map(Number),
    start: () => {
      const cp = spawn(process.execPath, [BIN, 'run'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; cp.stdout.on('data', (d) => { out += d; }); cp.stderr.on('data', (d) => { out += d; });
      t.after(() => cp.exitCode === null && cp.kill('SIGKILL'));
      return { cp, exit: new Promise((r) => cp.on('exit', (code) => r(code))), out: () => out };
    },
  };
}
const until = async (cond, ms = 10000) => { for (const end = Date.now() + ms; !cond() && Date.now() < end;) await sleep(50); return cond(); };

test('a builder that leaves no commit, or uncommitted changes, is failed with "commit your work" (exit 2)', (t) => {
  const s = setup(t, { features: [F('noop'), F('dirty')], config: { maxAttempts: 1 }, scenario: { noop: 'noop', dirty: 'dirty' } });
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  for (const id of ['noop', 'dirty']) {
    assert.equal(s.feature(id).status, 'stuck', id);
    assert.match(s.feature(id).lastFeedback, /commit your work/, id);
    assert.equal(s.calls('eval', id).length, 0, `${id} was not evaluated`);
  }
  assert.equal(s.git('log', '--merges', '--oneline'), '');
});

test('the evaluated commit is merged; a branch that moves during evaluation is refused', (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1 }, scenario: { a: 'eval:move-branch' } });
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.feature('a').attempts, 1);
  assert.match(s.feature('a').lastFeedback, /moved/);
  assert.equal(existsSync(join(s.repo, 'evil.txt')), false);
  assert.equal(s.git('log', '--merges', '--oneline'), '');
});

test('the evaluator sees the diff even when .gitattributes, textconv and diff.external try to hide it', (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'hide' } });
  assert.equal(s.cli('run').status, 0);
  assert.match(s.calls('eval', 'a')[0].prompt, /\+built a at/);
});

test('a merge git refuses to start (no MERGE_HEAD) leaves the feature ready without costing an attempt', (t) => {
  const s = setup(t, { features: [F('a')] });
  writeFileSync(join(s.repo, 'a.txt'), 'untracked, would be overwritten\n');
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual([s.feature('a').status, s.feature('a').attempts], ['ready', 0]);
  assert.match(s.log(), /would be overwritten/);
  assert.doesNotMatch(s.log(), /conflict/);
});

test('merge is skipped (feature ready) when the main checkout is dirty or on another branch', (t) => {
  const s = setup(t, { features: [F('a'), F('b', { priority: 2 })], config: { maxParallel: 1 } });
  writeFileSync(join(s.repo, 'README.md'), 'local edit\n');
  assert.equal(s.cli('run', '--max-features', '1').status, 2);
  assert.equal(s.feature('a').status, 'ready');
  assert.match(s.log(), /merge-skipped.*uncommitted changes/);
  s.git('checkout', '-q', 'README.md');
  s.git('checkout', '-qb', 'other');
  assert.equal(s.cli('run').status, 0);
  assert.equal(s.feature('b').status, 'ready');
  assert.match(s.log(), /merge-skipped.*on other, not main/);
  assert.equal(s.git('log', '--merges', '--oneline', 'main'), '');
});

test('a conflicting merge is aborted and the feature goes back with "rebase on main"', (t) => {
  const s = setup(t, { features: [F('a', { branch: 'ship/a' })], config: { maxAttempts: 1 } });
  s.git('branch', 'ship/a');
  writeFileSync(join(s.repo, 'a.txt'), 'main version\n');
  s.git('add', 'a.txt'); s.git('commit', '-qm', 'main changes a.txt');
  assert.equal(s.cli('run').status, 2);
  assert.equal(s.feature('a').attempts, 1);
  assert.match(s.feature('a').lastFeedback, /conflict: rebase on main/);
  assert.equal(existsSync(join(s.repo, '.git/MERGE_HEAD')), false, 'merge --abort ran');
  assert.equal(s.git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(readFileSync(join(s.repo, 'a.txt'), 'utf8'), 'main version\n');
});

test('base moved by someone other than Shipyard: alert, nothing more is launched or merged, exit 2', (t) => {
  const lesson = { pass: true, findings: [{ check: 'ok', ok: true, evidence: 'e' }], cheating: [], lesson: 'Keep it small' };
  const s = setup(t, { features: [F('z', { priority: 0 }), F('a'), F('b', { priority: 2 })], config: { maxParallel: 1 },
    scenario: { a: 'move-base' }, verdicts: { z: [lesson] } });
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout);
  assert.equal(s.feature('z').status, 'merged', 'its own merge and lesson commit do not trip the alert');
  assert.equal(s.feature('a').status, 'todo');
  assert.equal(s.feature('a').attempts, 0);
  assert.match(s.log(), /"alert".*main moved/);
  assert.equal(s.calls('build', 'b').length, 0, 'nothing launched after the alert');
});

test('config.json changed during the run: alert and exit 2 before merging', (t) => {
  const s = setup(t, { features: [F('a')], scenario: { a: 'config' } });
  assert.equal(s.cli('run').status, 2);
  assert.notEqual(s.feature('a').status, 'merged');
  assert.match(s.log(), /"alert".*config\.json/);
});

test('acceptance checks are the ones from launch, even if features.json is edited mid-run', (t) => {
  const fail1 = { pass: false, findings: [{ check: 'a.txt exists', ok: false, evidence: 'no' }], cheating: [], lesson: null };
  const s = setup(t, { features: [F('a')], scenario: { a: 'acceptance' }, verdicts: { a: [fail1] } });
  s.cli('run');
  const prompts = [...s.calls('build', 'a'), ...s.calls('eval', 'a')].map((c) => c.prompt);
  assert.equal(prompts.length, 4);
  for (const p of prompts) { assert.match(p, /- a\.txt exists/); assert.doesNotMatch(p, /nothing to check/); }
});
