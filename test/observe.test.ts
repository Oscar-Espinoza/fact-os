import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failingTests, resolveTests, classify, signature, recurringTests, readNew, improvementId, parseImprover, agentStats, observeOnce, observerPaths, lessonSection, parseCurated, bulletsOf } from '../lib/observe.ts';
import type { Diagnosis, Feature } from '../lib/types.ts';

const VITEST = `test command \`gate.sh\` exited 1:
| packages/a/src/ok.test.ts | pass | 0.4 |
| packages/b/src/refresh.db.test.ts | FAIL | 6.1 |
 FAIL  src/refresh.db.test.ts > crash windows > reclaimed after the lease
 ❯ src/refresh.db.test.ts:338:5
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @x/b test: \`node run-test.ts src/refresh.db.test.ts\``;

test('failingTests reads test files only from failure lines, not passing rows', () => {
  assert.deepEqual(failingTests(VITEST).sort(), ['packages/b/src/refresh.db.test.ts', 'src/refresh.db.test.ts']);
  assert.deepEqual(failingTests('not ok 3 - t/x.test.js\n✓ y.test.js'), ['t/x.test.js']);
});

test('resolveTests maps package-relative names to repo paths and drops ambiguous ones', () => {
  const files = ['packages/b/src/refresh.db.test.ts', 'apps/x/src/util.test.ts', 'apps/y/src/util.test.ts'];
  assert.deepEqual(resolveTests(['src/refresh.db.test.ts', 'packages/b/src/refresh.db.test.ts'], files), ['packages/b/src/refresh.db.test.ts']);
  assert.deepEqual(resolveTests(['src/util.test.ts', 'nope.test.ts'], files), []);
});

test('classify: a failing test the feature does not change is untouched; one in a directory it changes is its own', () => {
  const tests = ['packages/b/src/refresh.db.test.ts'];
  assert.equal(classify(VITEST, tests, ['apps/api/src/promo.ts']).cause, 'untouched');
  assert.equal(classify(VITEST, tests, ['packages/b/src/refresh.ts']).cause, 'own');
  assert.equal(classify(VITEST, tests, ['packages/b/src/refresh.db.test.ts']).cause, 'own');
  assert.equal(classify('test command `g` exited 1:\nsomething broke', [], []).cause, 'unknown');
});

test('classify: infrastructure errors win, then the foreman\'s own failure kinds', () => {
  assert.deepEqual(classify(`${VITEST}\nerror: out of shared memory`, ['x.test.ts'], ['x.test.ts']), { cause: 'infra', evidence: 'out of shared memory' });
  assert.equal(classify('test command `g` exited 1:\nDisk Quota hit', [], [], ['disk quota']).cause, 'infra');
  assert.equal(classify('merge conflict with main: too many base refreshes (10)', [], []).cause, 'conflict-loop');
  assert.equal(classify('prepare `p.sh` exited 1:\nno slot', [], []).cause, 'setup');
  assert.equal(classify('builder failed: timed out', [], []).cause, 'builder');
  assert.equal(classify('FAILED check 2: missing route', [], []).cause, 'own');
});

test('signature: infra by its pattern, test failures by their tests in any order', () => {
  assert.equal(signature({ cause: 'untouched', tests: ['b', 'a'], evidence: '' }), signature({ cause: 'untouched', tests: ['a', 'b'], evidence: 'x' }));
  assert.notEqual(signature({ cause: 'infra', tests: [], evidence: 'enospc' }), signature({ cause: 'infra', tests: [], evidence: 'econnrefused' }));
});

test('recurringTests: tests failing outside the feature in at least n features since a time', () => {
  const d = (feature: string, tests: string[], cause: Diagnosis['cause'] = 'untouched', ts = new Date().toISOString()): Diagnosis => ({ ts, feature, cause, tests, evidence: '', action: '' });
  const diags = [d('F1', ['t1']), d('F2', ['t1', 't2']), d('F2', ['t2']), d('F3', ['t3'], 'own'), d('F4', ['t3'], 'own'), d('F5', ['t1'], 'untouched', '2020-01-01T00:00:00Z')];
  assert.deepEqual(recurringTests(diags, Date.now() - 3600e3, 2), [['t1', ['F1', 'F2']]]);
});

test('improvementId follows the project\'s id style and takes the next free number', () => {
  assert.equal(improvementId(['F01-02-a', 'F99-01-x'], 'Make provisioning.ts merge-friendly!'), 'F99-02-make-provisioning-ts-merge-friendly');
  assert.equal(improvementId(['login', 'cart'], 'Stabilize the cart test'), 'imp-01-stabilize-the-cart-test');
  assert.equal(improvementId([], '???'), 'imp-01-improvement');
});

test('parseImprover keeps complete features and human tasks only', () => {
  const a = parseImprover('```json\n{"features":[{"title":"Split grants","description":"d","acceptance":["a"]},{"title":"No checks","description":"d","acceptance":[]}],' +
    '"humanTasks":[{"title":"Raise locks","why":"w","steps":["s"]},{"why":"untitled"}],"notes":"n"}\n```');
  assert.deepEqual(a.features, [{ title: 'Split grants', description: 'd', acceptance: ['a'] }]);
  assert.deepEqual(a.humanTasks, [{ title: 'Raise locks', why: 'w', steps: ['s'] }]);
  assert.deepEqual(parseImprover('nope'), { features: [], humanTasks: [], notes: '' });
});

test('readNew returns only complete new lines and starts over when the log is replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factos-obs-')), f = join(dir, 'log.jsonl');
  try {
    writeFileSync(f, '{"ts":"1","feature":null,"event":"a","detail":""}\n{"ts":"2"');
    const a = readNew(f, 0);
    assert.deepEqual(a.events.map((e) => e.event), ['a']);
    appendFileSync(f, ',"feature":null,"event":"b","detail":""}\n');
    assert.deepEqual(readNew(f, a.offset).events.map((e) => e.event), ['b']);
    writeFileSync(f, '{"ts":"3","feature":null,"event":"c","detail":""}\n');
    assert.deepEqual(readNew(f, 1000).events.map((e) => e.event), ['c']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- one pass over a real repo ----

const sh = (cwd: string, ...args: string[]) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: id, description: '', acceptance: ['x'], surface: 'any', deps: [], priority: 1,
  status: 'stuck', attempts: 2, updatedAt: new Date().toISOString(), ...o });

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'factos-obs-repo-'));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@t'); sh(root, 'config', 'user.name', 't');
  for (const f of ['pkg/a/src/x.test.ts', 'pkg/b/src/y.test.ts', 'pkg/b/src/y.ts']) { mkdirSync(join(root, f, '..'), { recursive: true }); writeFileSync(join(root, f), '//\n'); }
  sh(root, 'add', '.'); sh(root, 'commit', '-qm', 'base');
  for (const [id, file] of [['F1', 'pkg/b/src/y.ts'], ['F2', 'pkg/a/src/x.ts'], ['F3', 'pkg/b/src/z.ts']]) {
    sh(root, 'checkout', '-q', '-b', `ship/${id}`); writeFileSync(join(root, file), `// ${id}\n`);
    sh(root, 'add', '.'); sh(root, 'commit', '-qm', id); sh(root, 'checkout', '-q', 'main');
  }
  mkdirSync(join(root, '.fact-os'));
  writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify({ base: 'main', branchPrefix: 'ship/', test: 'gate.sh' }));
  writeFileSync(join(root, '.fact-os/human.json'), JSON.stringify({ tasks: [] }));
  return root;
}
const ev = (feature: string, event: string, detail: string) => JSON.stringify({ ts: new Date().toISOString(), feature, event, detail }) + '\n';
const failOn = (t: string) => `test command \`gate.sh\` exited 1:\n FAIL  ${t} > broke\n`;

test('observeOnce sends back features stuck on tests they do not change, once per failure, and leaves the rest', async () => {
  const root = repo();
  try {
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [
      F('F1', { lastFeedback: failOn('a/src/x.test.ts') }), F('F2', { lastFeedback: failOn('a/src/x.test.ts') }),
      F('F3', { lastFeedback: 'test command `gate.sh` exited 1:\nerror: out of shared memory' }), F('F4', { status: 'merged' })] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), ev('F1', 'stuck', failOn('a/src/x.test.ts')) + ev('F2', 'stuck', failOn('a/src/x.test.ts'))
      + ev('F3', 'stuck', 'test command `gate.sh` exited 1:\nerror: out of shared memory'));
    const lines: string[] = [];
    const s = await observeOnce(root, { out: (l) => lines.push(l) });
    const fs = (JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')) as { features: Feature[] }).features;
    const st = (id: string) => fs.find((f) => f.id === id)!;
    assert.equal(st('F1').status, 'todo', 'F1 changes pkg/b only: pkg/a/src/x.test.ts is not its own');
    assert.equal(st('F1').attempts, 0);
    assert.match(st('F1').lastFeedback!, /observer: your last attempt failed on pkg\/a\/src\/x\.test\.ts, which this feature does not change/);
    assert.match(st('F1').lastFeedback!, /That failure was:\ntest command/);
    assert.equal(st('F2').status, 'stuck', 'F2 changes pkg/a/src: the test is its own');
    assert.equal(st('F3').status, 'todo', 'infrastructure failure');
    assert.deepEqual(s.diagnoses.map((d) => [d.feature, d.cause, d.action]),
      [['F1', 'untouched', 'sent back'], ['F2', 'own', 'left for a person'], ['F3', 'infra', 'sent back']]);
    const log = readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8');
    assert.match(log, /"feature":"F1","event":"observer-retry"/);
    assert.ok(existsSync(observerPaths(root).report));
    const report = readFileSync(observerPaths(root).report, 'utf8');
    assert.match(report, /F2 is stuck: its own code or tests \(pkg\/a\/src\/x\.test\.ts\)/);
    assert.match(report, /Sent back by the observer: 2/);

    // The same failure again after the retry: left for a person this time.
    fs.find((f) => f.id === 'F1')!.status = 'stuck';
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: fs }));
    appendFileSync(join(root, '.fact-os/log.jsonl'), ev('F1', 'stuck', failOn('a/src/x.test.ts')));
    const s2 = await observeOnce(root, { out: () => {} });
    assert.equal(s2.diagnoses.at(-1)!.action, 'left for a person: it already failed this way after a retry');
    assert.equal((JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')) as { features: Feature[] }).features.find((f) => f.id === 'F1')!.status, 'stuck');
    assert.ok(lines.some((l) => /sent back F1/.test(l)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('observeOnce parks a ready feature whose merge never started, so the foreman merges it again', async () => {
  const root = repo();
  try {
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [F('F1', { status: 'ready', sha: 'abc' }), F('F2', { status: 'merged' })] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), ev('F1', 'merge-failed', 'Unable to create index.lock; left as ready'));
    await observeOnce(root, { out: () => {} });
    const f = (JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')) as { features: Feature[] }).features[0]!;
    assert.equal(f.parked, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('observeOnce alerts when the foreman is not running and features are left', async () => {
  const root = repo();
  try {
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [F('F1', { status: 'todo' })] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), '');
    const s = await observeOnce(root, { out: () => {} });
    assert.match(s.alerts[0]!.text, /the foreman is not running/);
    const again = await observeOnce(root, { out: () => {} });
    assert.equal(again.alerts.length, 1, 'the same alert is not repeated within the hour');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('lessonSection splits a lessons file around its section, old heading included', () => {
  const s = lessonSection('# Notes\n\nkeep\n\n## Shipyard lessons\n\n- 2026-01-01: a\n- b\n\n## Other\n\nx\n')!;
  assert.equal(s.heading, '## Shipyard lessons');
  assert.deepEqual(bulletsOf(s.body), ['- 2026-01-01: a', '- b']);
  assert.match(s.before, /keep/);
  assert.match(s.after, /^## Other/);
  assert.equal(lessonSection('no lessons here'), null);
});

test('parseCurated takes bullets and ### topics within the size limit, and refuses anything else', () => {
  const five = Array.from({ length: 5 }, (_, i) => `- rule ${i}`).join('\n');
  assert.deepEqual(parseCurated(`Sure.\n<lessons>\n### Tests\n${five}\n</lessons>`, 1000), { body: `### Tests\n${five}` });
  assert.match((parseCurated('no tags', 1000) as { error: string }).error, /no <lessons>/);
  assert.match((parseCurated('<lessons>- a\n- b</lessons>', 1000) as { error: string }).error, /only 2 bullets/);
  assert.match((parseCurated(`<lessons>${five}</lessons>`, 20) as { error: string }).error, /over the limit/);
  assert.match((parseCurated(`<lessons>Here you go:\n${five}</lessons>`, 1000) as { error: string }).error, /other than bullets/);
});

test('observeOnce curates an oversized lessons section with the agent, archives the original and keeps new lessons', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    const old = Array.from({ length: 40 }, (_, i) => `- 2026-09-2${i % 9}: lesson number ${i} about testing things carefully`).join('\n');
    writeFileSync(join(root, '.fact-os/lessons.md'), `## fact-os lessons\n\n${old}\n`);
    writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify({ base: 'main', branchPrefix: 'ship/', test: 'gate.sh', lessonsFile: '.fact-os/lessons.md',
      observer: { agent: { model: 'x' }, lessonsMaxBytes: 500 } }));
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [F('F1', { status: 'merged' })] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), '');
    const curated = '### Testing\\n' + Array.from({ length: 6 }, (_, i) => `- Rule ${i}.`).join('\\n');
    writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '{"type":"result","is_error":false,"result":"<lessons>\\n${curated}\\n</lessons>","total_cost_usd":0.25}'\n`, { mode: 0o755 });
    process.env.FACTOS_CLAUDE = fake;
    const s = await observeOnce(root, { out: () => {} });
    const text = readFileSync(join(root, '.fact-os/lessons.md'), 'utf8');
    assert.match(text, /^## fact-os lessons\n\n<!-- Curated .* by the fact-os observer; the full history is in lessons\.archive\.md\. -->\n\n### Testing\n- Rule 0\./);
    assert.equal(bulletsOf(lessonSection(text)!.body).length, 6);
    assert.match(readFileSync(join(root, '.fact-os/lessons.archive.md'), 'utf8'), /## Archived .* \(40 lessons\)[\s\S]*lesson number 39/);
    assert.ok(s.lessonsAt);
    assert.match(readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8'), /"event":"observer-lessons","detail":"curated 40 lessons into 6/);

    // Within curateEveryHours nothing runs again, even when the section grows.
    writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    appendFileSync(join(root, '.fact-os/lessons.md'), old + '\n');
    await observeOnce(root, { out: () => {} });
    assert.doesNotMatch(readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8'), /not curated/);
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('observeOnce leaves the lessons alone when the agent answers with something unusable', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    const old = Array.from({ length: 40 }, (_, i) => `- lesson ${i} with enough words to pass the size limit`).join('\n');
    writeFileSync(join(root, '.fact-os/lessons.md'), `## fact-os lessons\n\n${old}\n`);
    writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify({ base: 'main', branchPrefix: 'ship/', test: 'gate.sh', lessonsFile: '.fact-os/lessons.md',
      observer: { agent: { model: 'x' }, lessonsMaxBytes: 500 } }));
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [F('F1', { status: 'merged' })] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), '');
    writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '{"type":"result","is_error":false,"result":"I could not do it.","total_cost_usd":0.1}'\n`, { mode: 0o755 });
    process.env.FACTOS_CLAUDE = fake;
    await observeOnce(root, { out: () => {} });
    assert.equal(readFileSync(join(root, '.fact-os/lessons.md'), 'utf8'), `## fact-os lessons\n\n${old}\n`);
    assert.ok(!existsSync(join(root, '.fact-os/lessons.archive.md')));
    assert.match(readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8'), /not curated: no <lessons> block/);
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('observeOnce counts features sent back by a merge conflict after passing evaluation, and alerts on a hot file', async () => {
  const root = repo();
  try {
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map((id) => F(id, { status: 'todo' })) }));
    let log = '';
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5'])
      log += ev(id, 'evaluating', '') + ev(id, 'lesson', 'x') + ev(id, 'refreshed', 'conflicts in: pkg/registry.ts, pkg/b.ts');
    log += ev('F6', 'launch', '') + ev('F6', 'refreshed', 'conflicts in: pkg/registry.ts'); // not after an evaluation
    writeFileSync(join(root, '.fact-os/log.jsonl'), log);
    writeFileSync(join(root, '.fact-os/.foreman'), String(process.pid));
    const s = await observeOnce(root, { out: () => {} });
    assert.deepEqual(s.bounces.map((b) => b.feature), ['F1', 'F2', 'F3', 'F4', 'F5']);
    assert.ok(s.alerts.some((a) => /merge conflicts in pkg\/registry\.ts keep sending features that passed evaluation back/.test(a.text)));
    assert.match(readFileSync(observerPaths(root).report, 'utf8'), /Passed evaluation but sent back by a merge conflict: 5\.\n\n- pkg\/registry\.ts: 5/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the improver queues improvement features ahead of the rest and files outside work as human tasks, read-only', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh'), args = join(root, 'args.txt');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify({ base: 'main', branchPrefix: 'ship/', test: 'gate.sh', observer: { agent: { model: 'x' } } }));
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: ['F01-01-a', 'F01-02-b', 'F01-03-c', 'F01-04-d', 'F01-05-e'].map((id) => F(id, { status: 'todo', priority: 3 })) }));
    let log = '';
    for (const id of ['F01-01-a', 'F01-02-b', 'F01-03-c', 'F01-04-d', 'F01-05-e']) log += ev(id, 'evaluating', '') + ev(id, 'refreshed', 'conflicts in: pkg/registry.ts');
    writeFileSync(join(root, '.fact-os/log.jsonl'), log);
    writeFileSync(join(root, '.fact-os/.foreman'), String(process.pid));
    const answer = JSON.stringify({ features: [{ title: 'Split the registry', description: 'Five bounces.', acceptance: ['one file per entry', 'existing tests pass'] }],
      humanTasks: [{ title: 'Raise Postgres locks', why: 'out of shared memory', steps: ['edit compose'] }], notes: 'registry is the hot spot' });
    writeFileSync(fake, `#!/bin/sh\necho "$@" > ${args}\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ type: 'result', is_error: false, result: answer, total_cost_usd: 0.3 }).replace(/'/g, "'\\''")}'\n`, { mode: 0o755 });
    process.env.FACTOS_CLAUDE = fake;
    const s = await observeOnce(root, { out: () => {} });
    assert.match(readFileSync(args, 'utf8'), /--permission-mode plan/);
    const fs = (JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')) as { features: Feature[] }).features;
    const imp = fs.find((f) => f.id === 'F99-01-split-the-registry')!;
    assert.ok(imp, 'queued in the project\'s id style');
    assert.equal(imp.status, 'todo');
    assert.ok(imp.priority < 3, 'ahead of the other features');
    assert.deepEqual(imp.acceptance, ['one file per entry', 'existing tests pass']);
    assert.deepEqual(s.improvements, ['F99-01-split-the-registry']);
    const tasks = (JSON.parse(readFileSync(join(root, '.fact-os/human.json'), 'utf8')) as { tasks: { title: string; steps: string[] }[] }).tasks;
    assert.deepEqual(tasks.map((t) => [t.title, t.steps]), [['Raise Postgres locks', ['out of shared memory', 'edit compose']]]);
    assert.match(readFileSync(observerPaths(root).report, 'utf8'), /## Improvements queued by the observer\n\n- F99-01-split-the-registry: Split the registry \(todo\)/);
    // Within improveEveryHours it does not run again.
    writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await observeOnce(root, { out: () => {} });
    assert.equal((JSON.parse(readFileSync(join(root, '.fact-os/features.json'), 'utf8')) as { features: Feature[] }).features.length, 6);
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('agentStats follows each pass through build, gate and evaluator, keeps setup failures off the builder, and splits by prompt version', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z'), at = (min: number) => new Date(T0 + min * 60e3).toISOString();
  const e = (min: number, feature: string | null, event: string, detail = '') => ({ ts: at(min), feature, event, detail });
  const events = [
    e(0, 'a', 'launch'), e(5, 'a', 'refreshed', 'before test, conflict-free'), e(6, 'a', 'testing', 'sha'), e(36, 'a', 'evaluating'), e(37, 'a', 'lesson', 'x'), e(37, 'a', 'merged', 'b'),
    e(0, 'b', 'launch'), e(4, 'b', 'failed', 'prepare `p.sh` exited 1:\nno slot'),
    e(0, 'c', 'launch'), e(8, 'c', 'refreshed', 'conflicts in: x.ts'),
    e(0, 'd', 'launch'), e(3, 'd', 'testing', 'sha'), e(30, 'd', 'failed', 'test command `g` exited 1:'),
    e(50, null, 'observer-lessons', 'curated 40 lessons into 6 (500 bytes); $0.70'),
    e(60, 'a', 'launch'), e(62, 'a', 'testing', 'sha'), e(90, 'a', 'evaluating'), e(91, 'a', 'refreshed', 'conflicts in: reg.ts'),
    e(60, 'e', 'launch'), e(62, 'e', 'testing', 'sha'), e(90, 'e', 'evaluating'), e(91, 'e', 'failed', 'FAILED check 1: missing route\nFAILED check 2: x'),
  ];
  const [one, two] = agentStats(events, [{ ts: at(40), role: 'build', cost: 2, ms: 1 }, { ts: at(95), role: 'eval', cost: 1, ms: 1 }], T0 - 60e3);
  assert.equal(two!.change, 'lessons curated 40 lessons into 6 (500 bytes)');
  assert.deepEqual([one!.launches, one!.setup, one!.built, one!.gated, one!.evaluated, one!.passed, one!.merged], [4, 1, 2, 1, 1, 1, 1]);
  assert.deepEqual(one!.builderFailures, [['merge conflict before the test', 1]], 'the prepare failure is setup, not the builder');
  assert.equal(one!.buildMin, 4.5);
  assert.equal(one!.costBuild, 2);
  assert.deepEqual([two!.launches, two!.passed, two!.bounced, two!.evaluated], [2, 1, 1, 2]);
  assert.deepEqual(two!.rejections, [['check 1: missing route', 1]]);
  assert.equal(two!.costEval, 1);
});
