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
const F = (id, o = {}) => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id}.txt exists`],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });

test('end to end: parallel builds, eval retry, human wait/resume, onMock, dash', { timeout: 60000 }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'shipyard-e2e-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'app');
  mkdirSync(repo);
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.'); git('commit', '-qm', 'init');
  chmodSync(FAKE, 0o755);
  const env = { ...process.env, SHIPYARD_CLAUDE: FAKE, SHIPYARD_POLL_MS: '100',
    FAKE_LOG: join(base, 'fake.jsonl'), FAKE_VERDICTS: join(base, 'verdicts.json') };
  const cli = (...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8' });

  let r = cli('init', '--test', 'true');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, '.claude/skills/intake/SKILL.md')));
  assert.match(readFileSync(join(repo, '.git/info/exclude'), 'utf8'), /\.shipyard\/runs\//);
  assert.equal(cli('init').status, 0); // idempotent
  const cfgFile = join(repo, '.shipyard/config.json');
  assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).test, 'true');

  writeFileSync(join(repo, '.shipyard/features.json'), JSON.stringify({ features: [
    F('a'), F('b'), F('c', { priority: 2 }), F('d', { priority: 2 }), F('e', { priority: 3 })] }));
  writeFileSync(join(repo, '.shipyard/human.json'), JSON.stringify({ tasks: [
    { id: 'keys', title: 'Get API keys', steps: ['ask vendor'], unblocks: ['d'], mockable: false, status: 'open' },
    { id: 'sandbox', title: 'Sandbox account', steps: ['sign up'], unblocks: ['e'], mockable: true, status: 'open' }] }));
  writeFileSync(env.FAKE_VERDICTS, JSON.stringify({ c: [{ pass: false,
    findings: [{ check: 'c.txt exists', ok: false, evidence: 'returns a constant' }], cheating: ['hard-coded result'],
    lesson: 'Never hard-code results' }] }));
  r = cli('doctor');
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const run = spawn(process.execPath, [BIN, 'run', '--watch'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; run.stdout.on('data', (d) => { out += d; }); run.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((res) => run.on('exit', res));
  t.after(() => run.exitCode === null && run.kill());
  const features = () => JSON.parse(readFileSync(join(repo, '.shipyard/features.json'), 'utf8')).features;
  const status = () => Object.fromEntries(features().map((f) => [f.id, f.status]));

  for (let i = 0; i < 300 && !['a', 'b', 'c', 'e'].every((id) => status()[id] === 'merged'); i++) await sleep(100);
  assert.deepEqual(status(), { a: 'merged', b: 'merged', c: 'merged', d: 'todo', e: 'merged' }, out);
  await sleep(300);
  assert.equal(run.exitCode, null, 'run --watch keeps waiting on the human task');
  assert.match(readFileSync(join(repo, '.shipyard/log.jsonl'), 'utf8'), /"waiting"/);

  r = cli('done', 'keys');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await exit, 0, out);
  assert.equal(status().d, 'merged');

  const calls = readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map(JSON.parse);
  const build = (id) => calls.filter((c) => c.mode === 'build' && c.id === id);
  const [ba] = build('a'), [bb] = build('b');
  assert.ok(ba.t0 < bb.t1 && bb.t0 < ba.t1, 'a and b built in parallel');
  assert.equal(build('c').length, 2);
  assert.match(build('c')[1].prompt, /hard-coded result/, 'retry prompt carries evaluator feedback');
  const fc = features().find((f) => f.id === 'c');
  assert.equal(fc.attempts, 1);
  assert.ok(fc.costUsd > 0.03);
  assert.equal(features().find((f) => f.id === 'e').onMock, true);
  assert.match(build('e')[0].prompt, /Sandbox account/);
  assert.ok(!features().find((f) => f.id === 'a').onMock);
  const ev = calls.find((c) => c.mode === 'eval' && c.id === 'a');
  assert.match(ev.prompt, /a\.txt/, 'evaluator sees the diff');
  assert.match(ev.prompt, /hard-coded results/);
  const args = ba.args.join(' ');
  for (const flag of ['-p', '--output-format json', '--permission-mode auto', '--model opus'])
    assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes('--max-budget-usd'), 'no per-run cap by default');
  const settings = JSON.parse(ba.args[ba.args.indexOf('--settings') + 1]);
  assert.match(JSON.stringify(settings.hooks), /PostToolUse.*hook/);
  assert.deepEqual(settings.permissions.deny, [`Edit(/${repo}/.shipyard/**)`, `Edit(/${repo}/.git/**)`,
    'Bash(git update-ref *)', 'Bash(git push *)', 'Bash(git branch -f *)', 'Bash(git config *)']);
  assert.ok(settings.permissions.deny[1].startsWith('Edit(//'), '"//" = absolute path, so .git/hooks and .git/config are covered');
  assert.ok(existsSync(join(repo, '.shipyard/runs/c/2-eval.json')));

  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(git('log', '--merges', '--oneline').split('\n').length, 5);
  for (const id of 'abcde') assert.ok(existsSync(join(repo, `${id}.txt`)), id);
  const claudeMd = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
  assert.equal(claudeMd.match(/Never hard-code results/g).length, 1);
  assert.equal(git('log', '-1', '--format=%s', '--', 'CLAUDE.md').startsWith('shipyard: lesson'), true);

  // hook: from inside a worktree, appends to the main checkout's activity log, silently
  const wt = join(base, 'app-worktrees', 'a');
  const h = spawnSync(process.execPath, [BIN, 'hook'], { cwd: wt, env: { ...env, SHIPYARD_FEATURE: 'a' }, encoding: 'utf8',
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } }) });
  assert.deepEqual([h.status, h.stdout], [0, '']);
  assert.match(readFileSync(join(repo, '.shipyard/activity.jsonl'), 'utf8'), /"feature":"a".*"summary":"Bash git status"/);
  const bad = spawnSync(process.execPath, [BIN, 'hook'], { cwd: base, env, encoding: 'utf8', input: 'garbage' });
  assert.deepEqual([bad.status, bad.stdout], [0, '']);

  // dash against the same temp repo
  const d = spawn(process.execPath, [BIN, 'dash', '--root', base, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => d.kill());
  const url = await new Promise((res) => d.stdout.on('data', (b) => { const m = String(b).match(/http:\/\/127\.0\.0\.1:\d+/); if (m) res(m[0]); }));
  assert.match(await (await fetch(url)).text(), /<html/);
  const s = await (await fetch(url + '/api/state')).json();
  assert.deepEqual(s.projects.map((p) => p.path), [repo]);
  assert.equal(s.projects[0].features.filter((f) => f.status === 'merged').length, 5);
  assert.ok(s.projects[0].activity.length >= 1);
});
