import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Feature, FeaturesFile } from '../lib/types.ts';
import type { ProjectState } from '../lib/dash.ts';
import { reap } from './reap.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id}.txt exists`],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });

test('end to end: parallel builds, eval retry, human wait/resume, onMock, dash', { timeout: 60000 }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'fact-os-e2e-'));
  const repo = join(base, 'app');
  t.after(() => { reap(repo); rmSync(base, { recursive: true, force: true }); });
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.'); git('commit', '-qm', 'init');
  chmodSync(FAKE, 0o755);
  const env = { ...process.env, FACTOS_CLAUDE: FAKE, FACTOS_POLL_MS: '100',
    FAKE_LOG: join(base, 'fake.jsonl'), FAKE_VERDICTS: join(base, 'verdicts.json') };
  const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });

  let r = cli('init', '--test', 'true');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(repo, '.claude/skills/intake/SKILL.md')));
  assert.match(readFileSync(join(repo, '.git/info/exclude'), 'utf8'), /\.fact-os\/runs\//);
  assert.equal(cli('init').status, 0); // idempotent
  const cfgFile = join(repo, '.fact-os/config.json');
  assert.equal(JSON.parse(readFileSync(cfgFile, 'utf8')).test, 'true');

  writeFileSync(join(repo, '.fact-os/features.json'), JSON.stringify({ features: [
    F('a'), F('b'), F('c', { priority: 2 }), F('d', { priority: 2 }), F('e', { priority: 3 })] }));
  writeFileSync(join(repo, '.fact-os/human.json'), JSON.stringify({ tasks: [
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
  t.after(() => run.exitCode === null && run.kill('SIGKILL'));
  const features = () => (JSON.parse(readFileSync(join(repo, '.fact-os/features.json'), 'utf8')) as FeaturesFile).features;
  const status = () => Object.fromEntries(features().map((f) => [f.id, f.status]));

  for (let i = 0; i < 300 && !['a', 'b', 'c', 'e'].every((id) => status()[id] === 'merged'); i++) await sleep(100);
  assert.deepEqual(status(), { a: 'merged', b: 'merged', c: 'merged', d: 'todo', e: 'merged' }, out);
  await sleep(300);
  assert.equal(run.exitCode, null, 'run --watch keeps waiting on the human task');
  assert.match(readFileSync(join(repo, '.fact-os/log.jsonl'), 'utf8'), /"waiting"/);

  r = cli('done', 'keys');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(await exit, 0, out);
  assert.equal(status().d, 'merged');

  const calls = readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { mode: string; id: string; t0: number; t1: number; prompt: string; args: string[] });
  const build = (id: string) => calls.filter((c) => c.mode === 'build' && c.id === id);
  const [ba] = build('a'), [bb] = build('b');
  assert.ok(ba.t0 < bb.t1 && bb.t0 < ba.t1, 'a and b built in parallel');
  assert.equal(build('c').length, 2);
  assert.match(build('c')[1].prompt, /hard-coded result/, 'retry prompt carries evaluator feedback');
  const fc = features().find((f) => f.id === 'c')!;
  assert.equal(fc.attempts, 1);
  assert.ok(fc.costUsd! > 0.03);
  assert.equal(features().find((f) => f.id === 'e')!.onMock, true);
  assert.match(build('e')[0].prompt, /Sandbox account/);
  assert.ok(!features().find((f) => f.id === 'a')!.onMock);
  const ev = calls.find((c) => c.mode === 'eval' && c.id === 'a')!;
  assert.match(ev.prompt, /a\.txt/, 'evaluator sees the diff');
  assert.match(ev.prompt, /hard-coded results/);
  const args = ba.args.join(' ');
  for (const flag of ['-p', '--output-format json', '--permission-mode auto', '--model opus'])
    assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes('--max-budget-usd'), 'no per-run cap by default');
  const settings = JSON.parse(ba.args[ba.args.indexOf('--settings') + 1]);
  assert.match(JSON.stringify(settings.hooks), /PostToolUse.*hook/);
  assert.deepEqual(settings.permissions.deny, [`Edit(/${repo}/.fact-os/**)`, `Edit(/${repo}/.git/**)`,
    'Bash(git update-ref *)', 'Bash(git push *)', 'Bash(git branch -f *)', 'Bash(git config *)']);
  assert.ok(settings.permissions.deny[1].startsWith('Edit(//'), '"//" = absolute path, so .git/hooks and .git/config are covered');
  assert.ok(existsSync(join(repo, '.fact-os/runs/c/2-eval.json')));

  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  assert.equal(git('log', '--merges', '--oneline').split('\n').length, 5);
  for (const id of 'abcde') assert.ok(existsSync(join(repo, `${id}.txt`)), id);
  const claudeMd = readFileSync(join(repo, 'CLAUDE.md'), 'utf8');
  assert.equal(claudeMd.match(/Never hard-code results/g)!.length, 1);
  assert.equal(git('log', '-1', '--format=%s', '--', 'CLAUDE.md').startsWith('fact-os: lesson'), true);

  // hook: from inside a worktree, appends to the main checkout's activity log, silently
  const wt = join(base, 'app-worktrees', 'a');
  const h = spawnSync(process.execPath, [BIN, 'hook'], { cwd: wt, env: { ...env, SHIPYARD_FEATURE: 'a' }, encoding: 'utf8',
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git status' } }) });
  assert.deepEqual([h.status, h.stdout], [0, '']);
  assert.match(readFileSync(join(repo, '.fact-os/activity.jsonl'), 'utf8'), /"feature":"a".*"summary":"Bash git status"/);
  const bad = spawnSync(process.execPath, [BIN, 'hook'], { cwd: base, env, encoding: 'utf8', input: 'garbage' });
  assert.deepEqual([bad.status, bad.stdout], [0, '']);

  // dash against the same temp repo
  const d = spawn(process.execPath, [BIN, 'dash', '--root', base, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => d.kill());
  const url = await new Promise<string>((res) => d.stdout.on('data', (b) => { const m = String(b).match(/http:\/\/127\.0\.0\.1:\d+/); if (m) res(m[0]); }));
  assert.match(await (await fetch(url)).text(), /<html/);
  const s = await (await fetch(url + '/api/state')).json() as { projects: ProjectState[] };
  assert.deepEqual(s.projects.map((p) => p.path), [repo]);
  assert.equal(s.projects[0].features.filter((f) => f.status === 'merged').length, 5);
  assert.ok(s.projects[0].activity.length >= 1);
});

test('run --watch waits while a feature is paused and builds it once resumed from the CLI', { timeout: 30000 }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'fact-os-pause-'));
  const repo = join(base, 'app');
  t.after(() => { reap(repo); rmSync(base, { recursive: true, force: true }); });
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.'); git('commit', '-qm', 'init');
  chmodSync(FAKE, 0o755);
  const env = { ...process.env, FACTOS_CLAUDE: FAKE, FACTOS_POLL_MS: '100', FAKE_LOG: join(base, 'fake.jsonl'), FAKE_VERDICTS: join(base, 'verdicts.json') };
  const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  writeFileSync(env.FAKE_VERDICTS, '{}');
  assert.equal(cli('init', '--test', 'true').status, 0);
  writeFileSync(join(repo, '.fact-os/features.json'), JSON.stringify({ features: [F('a'), F('b', { status: 'paused' })] }));
  assert.equal(cli('doctor').status, 0, 'doctor accepts paused');
  assert.equal(cli('resume', 'a').status, 1, 'resuming a feature that is not paused fails');

  const run = spawn(process.execPath, [BIN, 'run', '--watch'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; run.stdout.on('data', (d) => { out += d; }); run.stderr.on('data', (d) => { out += d; });
  const exit = new Promise((res) => run.on('exit', res));
  t.after(() => run.exitCode === null && run.kill('SIGKILL'));
  const status = () => Object.fromEntries((JSON.parse(readFileSync(join(repo, '.fact-os/features.json'), 'utf8')) as FeaturesFile).features.map((f) => [f.id, f.status]));
  for (let i = 0; i < 200 && status().a !== 'merged'; i++) await sleep(100);
  await sleep(300);
  assert.deepEqual(status(), { a: 'merged', b: 'paused' }, out);
  assert.equal(run.exitCode, null, 'run --watch keeps waiting while b is paused');

  const r = cli('resume', 'b');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /resumed b/);
  assert.equal(await exit, 0, out);
  assert.equal(status().b, 'merged');
  const events = readFileSync(join(repo, '.fact-os/log.jsonl'), 'utf8');
  assert.match(events, /"feature":"b","event":"resumed"/);
  assert.match(events, /"feature":"b","event":"testing"/);
  assert.match(events, /"feature":"b","event":"evaluating"/);
});

test('prompt review end to end: a failed pass is reviewed once, and only that model\'s next build prompt carries the notes', { timeout: 90000 }, async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'fact-os-review-'));
  const repo = join(base, 'app');
  t.after(() => { reap(repo); rmSync(base, { recursive: true, force: true }); });
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  git('add', '.'); git('commit', '-qm', 'init');
  chmodSync(FAKE, 0o755);
  const env = { ...process.env, FACTOS_CLAUDE: FAKE, FACTOS_POLL_MS: '100', FAKE_DELAY_MS: '50', FAKE_LOG: join(base, 'fake.jsonl'), FAKE_VERDICTS: join(base, 'verdicts.json'), FAKE_REVIEWS: join(base, 'reviews.json') };
  const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 45000, killSignal: 'SIGKILL' });
  const state = (f: string) => join(repo, '.fact-os', f);
  const addFeature = (id: string) => { const d = JSON.parse(readFileSync(state('features.json'), 'utf8')) as FeaturesFile; d.features.push(F(id)); writeFileSync(state('features.json'), JSON.stringify(d)); };
  const calls = () => readFileSync(env.FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { mode: string; id: string; model: string; prompt: string; args: string[] });
  const events = () => readFileSync(state('log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { feature: string | null; event: string; detail: string });
  const NOTE = 'Create a.txt at the repository root, then run git add and git commit.';
  assert.equal(cli('init', '--test', 'true').status, 0);
  const cfgFile = join(repo, '.fact-os/config.json');
  writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(readFileSync(cfgFile, 'utf8')), observer: { promptReview: { everyMinutes: 0 } } })); // no throttle: "once" below is once per pass
  assert.match(readFileSync(join(repo, '.git/info/exclude'), 'utf8'), /\.fact-os\/prompt-notes\//);
  writeFileSync(state('features.json'), JSON.stringify({ features: [F('a')] }));
  writeFileSync(env.FAKE_VERDICTS, JSON.stringify({ a: [{ pass: false, findings: [{ check: 'a.txt exists', ok: false, evidence: 'nothing was committed at the root' }], cheating: [] }] }));
  writeFileSync(env.FAKE_REVIEWS, JSON.stringify({ a: [{ cause: 'prompt-missing-info', evidence: ['"a.txt exists"', 'nothing was committed at the root'], confidence: 'high', suggestion: NOTE, target: 'briefs' }] }));

  // A first run: the evaluator rejects the first pass of `a` (opus builds it), the second passes.
  let r = cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(calls().filter((c) => c.mode === 'build' && c.id === 'a').length, 2);
  assert.ok(calls().every((c) => !c.prompt.includes('## Notes for')), 'no notes yet');

  // The observer reviews the failed pass, once, read-only, and writes the notes for opus as builder.
  r = cli('observe', '--agent');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const reviews = () => calls().filter((c) => c.mode === 'review');
  assert.equal(reviews().length, 1);
  assert.equal(reviews()[0]!.id, 'a');
  assert.ok(reviews()[0]!.args.join(' ').includes('--permission-mode plan'), 'read-only');
  assert.match(reviews()[0]!.prompt, /nothing was committed|FAILED a\.txt exists/, 'the review gets the outcome');
  assert.match(reviews()[0]!.prompt, /You are the builder for feature "a"/, 'and the saved prompt');
  assert.equal(readFileSync(state('prompt-notes/opus-builder.md'), 'utf8'), `- ${NOTE}\n`);
  assert.equal(cli('observe', '--agent').status, 0);
  assert.equal(reviews().length, 1, 'a pass is reviewed once');
  const obs = JSON.parse(readFileSync(state('observer.json'), 'utf8')) as { promptReviews: Record<string, { cause: string; model: string; role: string; noted: boolean }> };
  assert.deepEqual(Object.entries(obs.promptReviews).map(([k, v]) => [k, v.cause, v.model, v.role, v.noted]), [['a/1', 'prompt-missing-info', 'opus', 'builder', true]]);
  assert.match(readFileSync(state('observer-report.md'), 'utf8'), /### opus as builder[\s\S]*Notes in force: 1/);

  // The next opus build gets the notes, with the notes in its fingerprint; the evaluator, another role, does not.
  addFeature('b');
  r = cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const bb = calls().find((c) => c.mode === 'build' && c.id === 'b')!;
  assert.equal(bb.model, 'opus');
  assert.match(bb.prompt, new RegExp(`\\n## Notes for opus as builder\\n\\n[^\\n]*\\n\\n- ${NOTE.replace(/\./g, '\\.')}\\n$`));
  assert.ok(!calls().find((c) => c.mode === 'eval' && c.id === 'b')!.prompt.includes('## Notes for'), 'notes are per role');
  const fp = (id: string, role: string) => events().filter((e) => e.feature === id && e.event === 'prompt' && e.detail.startsWith(role + ' ')).map((e) => e.detail);
  assert.match(fp('b', 'builder')[0]!, /^builder model=opus effort=medium lessons=- briefs=- notes=[0-9a-f]{8}$/);
  assert.ok(fp('a', 'builder').every((d) => !d.includes('notes=')), 'the earlier passes had none');

  // Another model (the fable-sonnet profile: sonnet builds) is not given opus's notes.
  assert.equal(cli('profile', 'fable-sonnet').status, 0);
  addFeature('c');
  r = cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const bc = calls().find((c) => c.mode === 'build' && c.id === 'c')!;
  assert.equal(bc.model, 'sonnet');
  assert.ok(!bc.prompt.includes('## Notes for') && !bc.prompt.includes(NOTE), 'sonnet does not get opus\'s notes');
  assert.ok(fp('c', 'builder')[0]!.includes('profile=fable-sonnet') && !fp('c', 'builder')[0]!.includes('notes='));
});
