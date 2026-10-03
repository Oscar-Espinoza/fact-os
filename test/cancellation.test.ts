import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeOnce, observerPaths } from '../lib/observe.ts';
import { loadConfig, withCheckoutLock, withLock } from '../lib/state.ts';
import { reviewFailures, passesOf, reviewBudget, fileTemplateTasks, type PromptReview } from '../lib/promptreview.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean) => {
  for (let i = 0; i < 250 && !fn(); i++) await sleep(10);
  assert.ok(fn(), 'timed out waiting for fixture');
};
const repo = (t: { after: (fn: () => void) => void }, stopAfter = '') => {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-cancellation-')), dir = join(root, '.fact-os');
  mkdirSync(dir);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeFileSync(join(root, 'seed'), 'seed');
  execFileSync('git', ['add', 'seed'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'seed'], { cwd: root });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ base: 'main', lessonsFile: 'AGENTS.md', observer: {
    agent: { model: 'fake', effort: 'low' }, retry: false, lessonsMaxBytes: 250,
    curateEveryHours: 0, improveEveryHours: 0, promptReview: { everyMinutes: 0, notesMaxBytes: 100 } } }));
  writeFileSync(join(dir, 'features.json'), '{"features":[]}');
  writeFileSync(join(dir, 'human.json'), '{"tasks":[]}');
  writeFileSync(join(dir, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), feature: null, event: 'alert', detail: 'Systemic fixture failure' }) + '\n');
  const lessons = '## fact-os lessons\n\n' + Array.from({ length: 15 }, (_, i) => `- Rule ${i}: keep a concrete invariant while building features.`).join('\n') + '\n';
  writeFileSync(join(root, 'AGENTS.md'), lessons);
  const reviews = Object.fromEntries(['one', 'two'].map((model) => [model + '/1', {
    ts: new Date().toISOString(), feature: model, tag: '1', role: 'builder', model, effort: 'low', notes: '-', kind: 'builder-failed',
    next: '', cause: 'prompt-missing-info', evidence: ['q'], confidence: 'high', target: 'briefs', cost: 0,
    suggestion: 'Keep the generated files consistent with their source and validate all exported contracts. '.repeat(3),
  } satisfies PromptReview]));
  writeFileSync(observerPaths(root).state, JSON.stringify({ promptReviews: reviews }));
  const fake = join(root, 'provider.sh'), callsFile = join(root, 'calls'), stopped = join(root, 'stop');
  const response = (text: string | object) => JSON.stringify({ type: 'result', is_error: false, result: typeof text === 'string' ? text : JSON.stringify(text), total_cost_usd: 0.2 });
  writeFileSync(fake, `#!/bin/sh
in=$(cat)
case "$in" in
  *"You review one failed pass"*) stage=review; result='${response({ cause: 'model-limitation', evidence: ['q'], confidence: 'high', suggestion: '', target: 'briefs' })}';;
  *"You tidy the prompt notes"*) stage=notes; result='${response('<notes>\n- Keep generated contracts consistent.\n</notes>')}';;
  *"You curate the lessons"*) stage=lessons; result='${response('<lessons>\n### Rules\n- Check contracts.\n- Keep gates.\n- Check callers.\n- Preserve data.\n- Commit carefully.\n</lessons>')}';;
  *) stage=improver; result='${response({ features: [{ title: 'Canceled proposal', description: 'Must not be queued', acceptance: ['works'] }], humanTasks: [{ title: 'Canceled task', why: 'fixture', steps: ['do it'] }], notes: 'Canceled notes' })}';;
esac
echo "$stage" >> '${callsFile}'
if [ "$stage" = '${stopAfter}' ]; then touch '${stopped}'; fi
printf '%s' "$result"
`, { mode: 0o755 });
  const previous = process.env.FACTOS_CLAUDE;
  process.env.FACTOS_CLAUDE = fake;
  t.after(() => { if (previous === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = previous; rmSync(root, { recursive: true, force: true }); });
  return { root, dir, lessons, stopped, fake, calls: () => existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [] };
};
const failure = (root: string, id: string) => {
  const ts = new Date().toISOString();
  const events = [{ ts, feature: id, event: 'launch', detail: '' }, { ts, feature: id, event: 'prompt', detail: 'builder model=fake effort=low lessons=- briefs=-' },
    { ts, feature: id, event: 'failed', detail: 'builder failed: fixture' }];
  const dir = join(root, '.fact-os/runs', id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1-build.prompt.md'), 'Build the fixture.');
  return events;
};

for (const stage of ['already', 'review', 'notes', 'lessons', 'improver']) test(`observer cancellation during ${stage} prevents later launches and canceled mutations`, async (t) => {
  const s = repo(t, stage);
  if (stage === 'already') writeFileSync(s.stopped, '');
  if (stage === 'review') writeFileSync(join(s.dir, 'log.jsonl'), failure(s.root, 'a').map((e) => JSON.stringify(e)).join('\n') + '\n' + readFileSync(join(s.dir, 'log.jsonl'), 'utf8'));
  const state = await observeOnce(s.root, { out: () => {}, stopping: () => existsSync(s.stopped) });
  assert.deepEqual(s.calls(), stage === 'already' ? [] : stage === 'review' ? ['review'] : stage === 'notes' ? ['notes'] : stage === 'lessons' ? ['notes', 'notes', 'lessons'] : ['notes', 'notes', 'lessons', 'improver']);
  if (['already', 'review', 'notes'].includes(stage)) {
    assert.equal(existsSync(join(s.dir, 'prompt-notes/one-builder.md')), false);
    assert.equal(state.promptReviews!['one/1']!.noted, undefined);
  }
  if (stage !== 'improver') { assert.equal(readFileSync(join(s.root, 'AGENTS.md'), 'utf8'), s.lessons); assert.equal(existsSync(join(s.root, 'AGENTS.archive.md')), false); }
  assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'features.json'), 'utf8')).features, []);
  assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'human.json'), 'utf8')).tasks, []);
  assert.equal(state.agentNotes, undefined);
  if (stage === 'review') { assert.ok(state.promptReviews!['a/1'], 'completed paid review evidence is kept'); assert.equal(state.promptReviewCost, 0.2); }
});

test('curation rechecks cancellation after waiting for the checkout snapshot lock', async (t) => {
  const s = repo(t); let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { release = r; });
  const holder = withCheckoutLock(s.root, async () => { entered(); await gate; });
  await started;
  const cfg = JSON.parse(readFileSync(join(s.dir, 'config.json'), 'utf8')); cfg.observer.promptReview.enabled = false;
  writeFileSync(join(s.dir, 'config.json'), JSON.stringify(cfg));
  let observed = false;
  const pass = observeOnce(s.root, { out: () => {}, stopping: () => { observed = true; return existsSync(s.stopped); } });
  try {
    await until(() => observed);
    writeFileSync(s.stopped, ''); release(); await holder; await pass;
    assert.deepEqual(s.calls(), []);
    assert.equal(readFileSync(join(s.root, 'AGENTS.md'), 'utf8'), s.lessons);
  } finally { release(); await holder; await pass; }
});

test('parallel review rechecks cancellation inside each launch and charges only started runs', async (t) => {
  const s = repo(t), config = loadConfig(s.root), passes = passesOf(['a', 'b', 'c'].flatMap((id) => failure(s.root, id)), () => 'builder');
  let stopping = false;
  const state: import('../lib/promptreview.ts').PromptState = {};
  await reviewFailures(s.root, config, { model: 'fake' }, { enabled: true, maxPerPass: 6, maxPerDay: 24, everyMinutes: 0, notesMaxBytes: 100 }, state, passes,
    (id) => { stopping = true; return { title: id, branch: 'gone' }; }, { out: () => {}, children: new Set(), stopping: () => stopping });
  assert.deepEqual(s.calls(), []);
  assert.equal(state.promptReviewRuns?.length ?? 0, 0);
  assert.equal(state.promptReviewAt, undefined, 'an unstarted batch must not start the throttle');
});

test('a started review batch advances an expired throttle timestamp', async (t) => {
  const s = repo(t), config = loadConfig(s.root), cfg = { enabled: true, maxPerPass: 6, maxPerDay: 24, everyMinutes: 30, notesMaxBytes: 100 };
  const old = new Date(Date.now() - 31 * 60000).toISOString(), state = { promptReviewAt: old };
  await reviewFailures(s.root, config, { model: 'fake' }, cfg, state, passesOf(failure(s.root, 'a'), () => 'builder'),
    (id) => ({ title: id, branch: 'gone' }), { out: () => {}, children: new Set(), stopping: () => false });
  assert.notEqual(state.promptReviewAt, old);
  assert.equal(reviewBudget(cfg, state).wait, true);
});

test('cancellation during a parallel review batch keeps paid results and prevents the next batch', async (t) => {
  const s = repo(t, 'review');
  writeFileSync(join(s.dir, 'log.jsonl'), ['a', 'b', 'c', 'd'].flatMap((id) => failure(s.root, id)).map((e) => JSON.stringify(e)).join('\n') + '\n');
  const state = await observeOnce(s.root, { out: () => {}, stopping: () => existsSync(s.stopped) });
  assert.deepEqual(s.calls(), ['review', 'review', 'review']);
  assert.equal(state.promptReviewRuns!.length, 3);
  assert.equal(state.promptReviewCost, 0.6);
  assert.equal(Object.keys(state.promptReviews!).filter((k) => /^[abcd]\//.test(k)).length, 3);
  assert.deepEqual(state.promptReviewTries, {});
});

test('stopped template proposals waiting for the state lock remain unfiled', async (t) => {
  const s = repo(t), state = JSON.parse(readFileSync(observerPaths(s.root).state, 'utf8'));
  for (const r of Object.values(state.promptReviews) as PromptReview[]) r.target = 'template';
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), started = new Promise<void>((r) => { entered = r; });
  const holder = withLock(s.root, async () => { entered(); await gate; }); await started;
  let stopping = false;
  const pass = fileTemplateTasks(s.root, state, () => {}, () => stopping);
  try {
    stopping = true; release(); await holder; await pass;
    assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'human.json'), 'utf8')).tasks, []);
    assert.ok((Object.values(state.promptReviews) as PromptReview[]).every((r) => !r.filed));
  } finally { release(); await holder; await pass; }
});

for (const stage of ['lessons', 'improver']) test(`cancellation while ${stage} waits to apply its result preserves stored work`, async (t) => {
  const s = repo(t), entered = join(s.root, 'provider-entered'), releaseProvider = join(s.root, 'provider-release');
  const cfg = JSON.parse(readFileSync(join(s.dir, 'config.json'), 'utf8')); cfg.observer.promptReview.enabled = false;
  if (stage === 'improver') rmSync(join(s.root, 'AGENTS.md'));
  writeFileSync(join(s.dir, 'config.json'), JSON.stringify(cfg));
  const original = readFileSync(s.fake, 'utf8');
  writeFileSync(s.fake, original.replace('printf', `touch '${entered}'\nwhile [ ! -f '${releaseProvider}' ]; do sleep 0.01; done\nprintf`));
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), started = new Promise<void>((r) => { locked = r; });
  const children = new Set<import('node:child_process').ChildProcess>();
  const pass = observeOnce(s.root, { children, out: () => {}, stopping: () => existsSync(s.stopped) });
  await until(() => existsSync(entered));
  const holder = (stage === 'lessons' ? withCheckoutLock : withLock)(s.root, async () => { locked(); await gate; }); await started;
  try {
    writeFileSync(releaseProvider, ''); await until(() => children.size === 0);
    writeFileSync(s.stopped, ''); release(); await holder; await pass;
    assert.deepEqual(s.calls(), [stage]);
    if (stage === 'lessons') { assert.equal(readFileSync(join(s.root, 'AGENTS.md'), 'utf8'), s.lessons); assert.equal(existsSync(join(s.root, 'AGENTS.archive.md')), false); }
    assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'features.json'), 'utf8')).features, []);
    assert.deepEqual(JSON.parse(readFileSync(join(s.dir, 'human.json'), 'utf8')).tasks, []);
  } finally { writeFileSync(releaseProvider, ''); release(); await holder; await pass; }
});

test('observer second stop signal kills its resistant provider and descendant process group', async (t) => {
  const s = repo(t), pids = join(s.root, 'pids'), ready = join(s.root, 'term');
  writeFileSync(s.fake, `#!/bin/sh\ncat >/dev/null\ntrap 'touch "${ready}"' TERM\nsh -c 'trap "" TERM; echo $$ >> "${pids}"; exec sleep 120' &\necho $$ >> '${pids}'\nwait\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
  const cp = spawn(process.execPath, [new URL('../bin/fact-os', import.meta.url).pathname, 'observe', '--watch'], { cwd: s.root, env: { ...process.env, FACTOS_CLAUDE: s.fake }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; cp.stdout.on('data', (d) => { output += d; }); cp.stderr.on('data', (d) => { output += d; });
  const done = new Promise<number | null>((r) => cp.once('exit', r));
  const alive = (pid: number) => { try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };
  let owned: number[] = [];
  t.after(() => { if (cp.exitCode === null && cp.signalCode === null) cp.kill('SIGKILL'); for (const pid of owned) if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {} } });
  await until(() => { if (existsSync(pids)) owned = readFileSync(pids, 'utf8').trim().split('\n').map(Number); return owned.length === 2; });
  cp.kill('SIGTERM'); await until(() => existsSync(ready));
  assert.ok(owned.every(alive), 'fixture survives first signal');
  cp.kill('SIGTERM'); assert.equal(await done, 130, output);
  await until(() => owned.every((pid) => !alive(pid)));
  assert.equal(s.calls().length, 0, 'no later provider starts');
});

test('observer final cleanup drains owned review children before releasing supervisor ownership', async (t) => {
  const s = repo(t), pids = join(s.root, 'remaining-pids'), fixture = join(s.root, 'observer.ts');
  const cfg = JSON.parse(readFileSync(join(s.dir, 'config.json'), 'utf8')); cfg.observer.improve = false;
  writeFileSync(join(s.dir, 'config.json'), JSON.stringify(cfg));
  writeFileSync(observerPaths(s.root).state, '{}'); rmSync(join(s.root, 'AGENTS.md'));
  writeFileSync(join(s.dir, 'log.jsonl'), ['a', 'b'].flatMap((id) => failure(s.root, id)).map((e) => JSON.stringify(e)).join('\n') + '\n');
  writeFileSync(s.fake, `#!/bin/sh\nin=$(cat)\ncase "$in" in\n*"Feature: a:"*) while [ ! -f '${pids}' ] || [ "$(wc -l < '${pids}')" -lt 2 ]; do sleep 0.01; done; exit 1;;\n*) sh -c 'echo $$ >> "${pids}"; exec sleep 120' &\necho $$ >> '${pids}'\nwait;;\nesac\n`, { mode: 0o755 });
  writeFileSync(fixture, `import { observe } from ${JSON.stringify(new URL('../lib/observe.ts', import.meta.url).pathname)};
import { existsSync, readFileSync } from 'node:fs';
const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
await observe(${JSON.stringify(s.root)}, { out: (line) => { if (/review of a/.test(line)) throw new Error('fixture output failure'); } });
if (existsSync(${JSON.stringify(observerPaths(s.root).pid)})) throw new Error('ownership not released');
if (before.some((n, i) => n !== process.listenerCount(i ? 'SIGTERM' : 'SIGINT'))) throw new Error('signal listener leaked');
for (const pid of readFileSync(${JSON.stringify(pids)}, 'utf8').trim().split('\\n')) {
  let stat = ''; try { stat = readFileSync('/proc/' + pid + '/stat', 'utf8'); } catch {}
  if (stat && !/^\\d+ \\(.*\\) Z /.test(stat)) throw new Error('ownership released with live child ' + pid);
}
`);
  const cp = spawn(process.execPath, [fixture], { cwd: s.root, env: { ...process.env, FACTOS_CLAUDE: s.fake }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; cp.stdout.on('data', (d) => { output += d; }); cp.stderr.on('data', (d) => { output += d; });
  const done = new Promise<number | null>((r) => cp.once('exit', r));
  let owned: number[] = [];
  t.after(() => {
    if (cp.exitCode === null && cp.signalCode === null) cp.kill('SIGKILL');
    for (const pid of owned) {
      try { process.kill(-pid, 'SIGKILL'); } catch {} try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });
  await until(() => { if (existsSync(pids)) owned = readFileSync(pids, 'utf8').trim().split('\n').map(Number); return cp.exitCode !== null; });
  assert.equal(await done, 0, output);
  assert.equal(existsSync(observerPaths(s.root).pid), false);
});
