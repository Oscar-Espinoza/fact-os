import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failingTests, resolveTests, classify, signature, recurringTests, readNew, improvementId, parseImprover, agentStats, observeOnce, observe, observerPaths, lessonSection, parseCurated, bulletsOf, versionKey, runCosts, unpricedRun } from '../lib/observe.ts';
import type { Diagnosis, Feature } from '../lib/types.ts';
import { parseVerdict, feedbackFromVerdict } from '../lib/foreman.ts';

const VITEST = `test command \`gate.sh\` exited 1:
| packages/a/src/ok.test.ts | pass | 0.4 |
| packages/b/src/refresh.db.test.ts | FAIL | 6.1 |
 FAIL  src/refresh.db.test.ts > crash windows > reclaimed after the lease
 ❯ src/refresh.db.test.ts:338:5
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @x/b test: \`node run-test.ts src/refresh.db.test.ts\``;

test('R15: schema diagnostics cannot supply infrastructure, conflict or failing-test control evidence', () => {
  for (const raw of ['ECONNREFUSED\nFAIL src/quoted.test.ts', 'too many base refreshes\nFAIL src/quoted.test.ts', 'custom outage\nFAIL src/quoted.test.ts']) {
    const feedback = feedbackFromVerdict(parseVerdict(JSON.stringify({ pass: false, findings: [], blocking: raw })));
    assert.ok(feedback.includes(raw.split('\n')[0]!));
    assert.deepEqual(classify(feedback, [], [], ['custom outage']), { cause: 'own', evidence: 'the evaluator did not pass it' });
    assert.deepEqual(failingTests(feedback), []);
  }
  // A plain-text invalid verdict can include real-looking failure lines too.
  const feedback = feedbackFromVerdict(parseVerdict('ECONNREFUSED\nFAIL src/quoted.test.ts'));
  assert.match(feedback, /ECONNREFUSED/);
  assert.deepEqual(classify(feedback, [], []), { cause: 'own', evidence: 'the evaluator did not pass it' });
  assert.deepEqual(failingTests(feedback), []);
  assert.equal(classify('test command `g` exited 1:\nECONNREFUSED', [], []).cause, 'infra');
  assert.equal(classify('Evaluator: evaluator failed: exit 1: ECONNREFUSED', [], []).cause, 'infra', 'provider failure remains eligible for infrastructure retry');
});

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

test('agentStats: clean revalidation preserves the pass and merge without a conflict bounce or duplicate stage counts', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z'), at = (min: number) => new Date(T0 + min * 60e3).toISOString();
  const e = (min: number, event: string, detail = '') => ({ ts: at(min), feature: 'a', event, detail });
  const events = [
    e(0, 'launch'), e(5, 'testing', 'old-sha'), e(35, 'evaluating'),
    e(40, 'revalidate', 'main advanced after evaluation'), e(41, 'refreshed', 'before test, conflict-free'),
    e(42, 'testing', 'fresh-sha'), e(72, 'evaluating'),
    e(77, 'revalidate', 'main advanced again'), e(78, 'refreshed', 'before test, conflict-free'),
    e(79, 'testing', 'freshest-sha'), e(109, 'evaluating'), e(114, 'merged', 'ship/a'),
  ];
  const [era] = agentStats(events, [], T0 - 60e3);
  assert.deepEqual([era!.launches, era!.built, era!.gated, era!.evaluated, era!.passed, era!.merged], [1, 1, 1, 1, 1, 1]);
  assert.deepEqual([era!.bounced, era!.resolves, era!.resolvedMerged], [0, 0, 0]);
  assert.deepEqual([era!.buildMin, era!.gateMin, era!.evalMin], [5, 30, 5], 'initial stage timings exclude later revalidation');
  const [failed] = agentStats([...events.slice(0, 6), e(43, 'stuck', 'test command `gate` exited 1')], [], T0 - 60e3);
  assert.deepEqual([failed!.merged, failed!.bounced], [0, 0], 'a failed fresh gate is not a merge or a conflict');
  const [resolved] = agentStats([
    ...events.slice(0, 3), e(40, 'refreshed', 'conflicts in: reg.ts'), e(41, 'resolving', 'reg.ts'),
    e(42, 'resolved', 'resolved-sha'), e(43, 'testing', 'resolved-sha'), e(73, 'evaluating'),
    e(78, 'revalidate', 'main advanced during resolver evaluation'), e(79, 'refreshed', 'before test, conflict-free'),
    e(80, 'testing', 'fresh-resolved-sha'), e(110, 'evaluating'), e(115, 'merged', 'ship/a'),
  ], [], T0 - 60e3);
  assert.deepEqual([resolved!.merged, resolved!.resolvedMerged, resolved!.bounced, resolved!.resolves], [1, 1, 1, 1],
    'clean revalidation also preserves an earlier resolver continuation');
});

test('agentStats: a resumed gate fix continues the pass; it is not a new launch or a new build', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z'), at = (min: number) => new Date(T0 + min * 60e3).toISOString();
  const e = (min: number, event: string, detail = '') => ({ ts: at(min), feature: 'a', event, detail });
  const fixed = [e(0, 'launch'), e(1, 'prompt', 'builder model=opus effort=medium lessons=- briefs=-'), e(5, 'testing', 's1'),
    e(35, 'gate-fix', 'resuming the builder after a test-gate failure'), e(36, 'prompt', 'builder model=opus effort=medium lessons=- briefs=-'),
    e(45, 'testing', 's2'), e(75, 'evaluating'), e(80, 'merged', 'ship/a')];
  const [era] = agentStats(fixed, [], T0 - 60e3);
  assert.deepEqual([era!.launches, era!.built, era!.gated, era!.evaluated, era!.merged], [1, 1, 1, 1, 1]);
  assert.deepEqual([era!.buildMin, era!.gateMin], [5, 30], 'the gate time is the run that passed, not the fix');
  const [failed] = agentStats([...fixed.slice(0, 6), e(75, 'stuck', 'test command `gate` exited 1')], [], T0 - 60e3);
  assert.deepEqual([failed!.launches, failed!.built, failed!.gated, failed!.merged], [1, 1, 0, 0]);
});

test('agentStats: a commit fix after the build stays in the build stage; it is not a new launch', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z'), at = (min: number) => new Date(T0 + min * 60e3).toISOString();
  const e = (min: number, event: string, detail = '') => ({ ts: at(min), feature: 'a', event, detail });
  const [era] = agentStats([e(0, 'launch'), e(1, 'prompt', 'builder model=opus effort=medium lessons=- briefs=-'),
    e(50, 'commit-fix', 'resuming the builder to commit work it left uncommitted'), e(51, 'prompt', 'builder model=opus effort=medium lessons=- briefs=-'),
    e(52, 'testing', 's1'), e(80, 'evaluating'), e(85, 'merged', 'ship/a')], [], T0 - 60e3);
  assert.deepEqual([era!.launches, era!.built, era!.gated, era!.merged], [1, 1, 1, 1]);
  assert.equal(era!.buildMin, 52, 'the build time includes its commit fix');
});

test('agentStats: a resolver run continues the pass that hit the conflict; its merge counts once, its gate and evaluation are not counted again', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z'), at = (min: number) => new Date(T0 + min * 60e3).toISOString();
  const e = (min: number, feature: string, event: string, detail = '') => ({ ts: at(min), feature, event, detail });
  const events = [
    e(0, 'f', 'launch'), e(5, 'f', 'testing', 'sha'), e(35, 'f', 'evaluating'), e(40, 'f', 'refreshed', 'conflicts in: reg.ts'),
    e(41, 'f', 'resolving', 'reg.ts'), e(45, 'f', 'resolved', 'sha2'), e(46, 'f', 'testing', 'sha2'), e(76, 'f', 'evaluating'), e(80, 'f', 'merged', 'ship/f'),
    e(0, 'g', 'launch'), e(6, 'g', 'refreshed', 'conflicts in: reg.ts'), e(7, 'g', 'resolving', 'reg.ts'), e(9, 'g', 'resolve-failed', 'keep-check: 1 lines lost'),
    e(10, 'g', 'testing', 'stray event after the pass ended'),
  ];
  const [era] = agentStats(events, [], T0 - 60e3);
  assert.deepEqual([era!.launches, era!.built, era!.gated, era!.evaluated, era!.passed, era!.bounced], [2, 1, 1, 1, 1, 1]);
  assert.deepEqual([era!.resolves, era!.merged, era!.resolvedMerged], [2, 1, 1]);
  assert.deepEqual(era!.builderFailures, [['merge conflict before the test', 1]]);
});

test('observe: the active model profile picks the improver\'s and the curator\'s model and effort; an invalid control.json keeps the last good one', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh'), args = join(root, 'args.txt'), ctl = join(root, '.fact-os/control.json');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    const old = Array.from({ length: 40 }, (_, i) => `- lesson ${i} with enough words to pass the size limit`).join('\n');
    const cfg = (o: object = {}) => writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify({ base: 'main', branchPrefix: 'ship/', test: 'gate.sh', lessonsFile: '.fact-os/lessons.md',
      observer: { agent: { model: 'x', effort: 'low', permissionMode: 'auto' }, lessonsMaxBytes: 500, curateEveryHours: 0, improveEveryHours: 0 }, ...o }));
    cfg();
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: ['F01-01-a', 'F01-02-b'].map((id) => F(id, { status: 'todo' })) }));
    writeFileSync(join(root, '.fact-os/.foreman'), String(process.pid));
    const curated = '### Testing\\n' + Array.from({ length: 6 }, (_, i) => `- Rule ${i}.`).join('\\n');
    // the curator's prompt starts "You curate", the improver's "You improve"; each call's role and argv go to args.txt
    writeFileSync(fake, `#!/bin/sh\nin=$(cat)\ncase "$in" in "You curate"*) echo "curator $*" >> ${args}; printf '%s' '{"type":"result","is_error":false,"result":"<lessons>\\n${curated}\\n</lessons>","total_cost_usd":0}';;\n` +
      `*) echo "improver $*" >> ${args}; printf '%s' '{"type":"result","is_error":false,"result":"{\\"features\\":[],\\"humanTasks\\":[],\\"notes\\":\\"\\"}","total_cost_usd":0}';;\nesac\n`, { mode: 0o755 });
    process.env.FACTOS_CLAUDE = fake;
    const pass = async (profile: { last: string | null }) => {
      writeFileSync(args, '');
      writeFileSync(join(root, '.fact-os/lessons.md'), `## fact-os lessons\n\n${old}\n`);
      writeFileSync(join(root, '.fact-os/log.jsonl'), ['F01-01-a', 'F01-02-b'].map((id) => ev(id, 'evaluating', '') + ev(id, 'refreshed', 'conflicts in: pkg/registry.ts')).join(''));
      rmSync(observerPaths(root).state, { force: true });
      await observeOnce(root, { out: () => {}, profile });
      const lines = readFileSync(args, 'utf8').split('\n').filter(Boolean);
      const of = (role: string) => { const l = lines.find((x) => x.startsWith(role + ' ')); assert.ok(l, `${role} ran: ${lines.join(' | ')}`); return l!; };
      return { curator: of('curator'), improver: of('improver') };
    };
    const mem = { last: null as string | null };
    let r = await pass(mem);
    assert.match(r.curator, /--model x --effort low --permission-mode auto/, 'no profile: the agent config');
    assert.match(r.improver, /--model x --effort low --permission-mode plan/);
    writeFileSync(ctl, JSON.stringify({ profile: 'fable-sonnet' }));
    r = await pass(mem);
    assert.match(r.curator, /--model fable --effort medium --permission-mode auto/);
    assert.match(r.improver, /--model fable --effort high --permission-mode plan/, 'the improver stays read-only');
    writeFileSync(ctl, '{"profile":"nope"}');
    r = await pass(mem);
    assert.match(r.improver, /--model fable --effort high/, 'invalid control.json: the last good profile');
    assert.equal(mem.last, 'fable-sonnet');
    cfg({ profiles: { half: { curator: { model: 'c' } } } });
    writeFileSync(ctl, JSON.stringify({ profile: 'half' }));
    r = await pass(mem);
    assert.match(r.curator, /--model c --effort low --permission-mode auto/, 'entry fields override only when present');
    assert.match(r.improver, /--model x --effort low --permission-mode plan/, 'a role the profile does not name: the agent config');
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('agentStats: each launch counts in its own pass\'s version; a late opus prompt after a switch starts no stray version; risky prompts neither split nor skip', () => {
  const T0 = Date.parse('2026-10-01T10:00:00Z'), at = (min: number) => new Date(T0 + min * 60e3).toISOString();
  const e = (min: number, feature: string | null, event: string, detail = '') => ({ ts: at(min), feature, event, detail });
  const opus = 'builder model=opus effort=medium lessons=aaaaaaaa briefs=-', fs = 'builder model=sonnet effort=medium lessons=bbbbbbbb briefs=- profile=fable-sonnet';
  const risky = 'builder model=sonnet effort=high lessons=bbbbbbbb briefs=- profile=fable-sonnet risk=high effortBase=medium';
  const events = [
    e(0, 'a', 'launch'), e(1, 'b', 'launch'), e(2, 'b', 'prompt', opus), // a is still in prepare
    e(5, null, 'control', 'running, lanes 3, profile opus → running, lanes 3, profile fable-sonnet'),
    e(6, 'c', 'launch'), e(7, 'c', 'prompt', fs),
    e(8, 'a', 'prompt', opus),                                            // a's own (opus) pass, logged after the switch
    e(9, 'd', 'launch'), e(10, 'd', 'prompt', risky),
    e(11, 'f', 'launch'),                                                  // build skipped: no prompt, the version in force
    e(12, 'a', 'testing', 'sha'), e(13, 'c', 'testing', 'sha'), e(14, 'd', 'testing', 'sha')];
  const eras = agentStats(events, [], T0 - 60e3);
  assert.deepEqual(eras.map((x) => [x.change, x.launches, x.built]), [['start of the window', 2, 1], ['builder model=sonnet effort=medium briefs=- profile=fable-sonnet', 3, 2]]);
  assert.equal(eras[1]!.since, at(6), 'the version starts at its first launch, not at a prompt');
  assert.equal(versionKey(risky), versionKey(fs));
  assert.equal(versionKey(opus), 'builder model=opus effort=medium briefs=-');
});

// ---- prompt review ----

// Failed passes F<k>: a builder prompt saved under runs/, the log events of the pass, ending in a rejection `k` seconds from now.
function failedPass(root: string, id: string, k: number, model = 'sonnet', detail = `FAILED check 1: ${id} is missing`) {
  const dir = join(root, '.fact-os/runs', id), t = Date.now();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1-build.prompt.md'), `You are the builder for feature "${id}": ${id}\n\nBuild it.\n`);
  const at = (ms: number) => new Date(ms).toISOString(), e = (ms: number, event: string, detail = '') => JSON.stringify({ ts: at(ms), feature: id, event, detail }) + '\n';
  appendFileSync(join(root, '.fact-os/log.jsonl'), e(t, 'launch') + e(t, 'prompt', `builder model=${model} effort=medium lessons=- briefs=-`) + e(t + 1, 'testing', 'sha') + e(t + 2, 'evaluating')
    + e(t + k * 1000, 'failed', detail));
}
const reviewConfig = (root: string, observer: object = {}) => writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify({ base: 'main', branchPrefix: 'ship/', test: 'gate.sh',
  observer: { agent: { model: 'x', effort: 'low', permissionMode: 'auto' }, improve: false, ...observer } }));
const answer = (o: object | string) => JSON.stringify({ type: 'result', is_error: false, result: typeof o === 'string' ? o : JSON.stringify(o), total_cost_usd: 0.2 }).replace(/'/g, "'\\''");

test('observeOnce reviews each failed pass once (newest first, at most maxPerPass, read-only), keeps an invalid answer, and turns answers into notes and a human task', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh'), args = join(root, 'args.txt');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    reviewConfig(root, { promptReview: { maxPerPass: 2, everyMinutes: 0 } });
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: ['F1', 'F2', 'F3', 'F4'].map((id) => F(id, { status: 'todo' })) }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), '');
    for (const [i, id] of ['F1', 'F2', 'F3', 'F4'].entries()) failedPass(root, id, i + 1, id === 'F4' ? 'opus' : 'sonnet');
    const tpl = (feature: string) => ({ cause: 'prompt-ambiguous', evidence: [`"${feature} is missing"`], confidence: 'medium', suggestion: `State the exact file ${feature} must create.`, target: 'template' });
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${args}\nin=$(cat)\ncase "$in" in\n` +
      `*"Feature: F1:"*) printf '%s' '${answer({ cause: 'prompt-missing-info', evidence: ['"no typecheck"'], confidence: 'high', suggestion: 'Run bun run typecheck before you commit.', target: 'briefs' })}';;\n` +
      `*"Feature: F2:"*) printf '%s' '${answer(tpl('F2'))}';;\n*"Feature: F4:"*) printf '%s' '${answer(tpl('F4'))}';;\n*"Feature: F5:"*) printf '%s' '${answer(tpl('F5'))}';;\n` +
      `*) printf '%s' '${answer('I think the model was just unlucky.')}';;\nesac\n`, { mode: 0o755 });
    process.env.FACTOS_CLAUDE = fake;
    const reviews = () => (JSON.parse(readFileSync(observerPaths(root).state, 'utf8')) as { promptReviews: Record<string, { cause: string | null; error?: string; noted?: boolean; filed?: boolean }> }).promptReviews;
    const calls = () => readFileSync(args, 'utf8').split('\n').filter(Boolean);

    await observeOnce(root, { out: () => {} });
    assert.equal(calls().length, 2, 'maxPerPass');
    assert.deepEqual(Object.keys(reviews()).sort(), ['F3/1', 'F4/1'], 'the newest failures first');
    assert.match(reviews()['F3/1']!.error!, /^invalid answer: not a JSON object/);
    assert.equal(reviews()['F3/1']!.cause, null);
    for (const c of calls()) assert.match(c, /--model x --effort low --permission-mode plan/, 'read-only, with the observer agent\'s model');

    await observeOnce(root, { out: () => {} });
    assert.equal(calls().length, 4);
    assert.deepEqual(Object.keys(reviews()).sort(), ['F1/1', 'F2/1', 'F3/1', 'F4/1']);
    const notes = join(root, '.fact-os/prompt-notes');
    assert.equal(readFileSync(join(notes, 'sonnet-builder.md'), 'utf8'), '- Run bun run typecheck before you commit.\n', 'a high-confidence suggestion for the briefs becomes a note for the model that failed');
    assert.ok(!existsSync(join(notes, 'opus-builder.md')), 'and only for that model: a template suggestion is not a note');
    assert.equal(reviews()['F1/1']!.noted, true);
    const tasks = (JSON.parse(readFileSync(join(root, '.fact-os/human.json'), 'utf8')) as { tasks: { title: string; steps: string[]; id: string }[] }).tasks;
    assert.equal(tasks.length, 1, 'F2 and F4 are the same kind of template problem: one task for the role');
    assert.equal(tasks[0]!.title, 'Prompt template change suggested for builder');
    assert.match(tasks[0]!.id, /^observer-/);
    assert.match(tasks[0]!.steps.join('\n'), /State the exact file F2 must create\./);
    assert.match(tasks[0]!.steps.join('\n'), /State the exact file F4 must create\./);
    assert.match(tasks[0]!.steps.join('\n'), /Evidence from F2\/1: "F2 is missing"/);
    assert.equal(reviews()['F2/1']!.filed, true);
    assert.ok(!existsSync(join(notes, 'sonnet-builder.archive.md')));

    await observeOnce(root, { out: () => {} });
    assert.equal(calls().length, 4, 'a pass is reviewed at most once');
    // a later template suggestion joins the open task, and the count in its first step follows
    failedPass(root, 'F5', 5);
    await observeOnce(root, { out: () => {} });
    const joined = (JSON.parse(readFileSync(join(root, '.fact-os/human.json'), 'utf8')) as { tasks: { steps: string[] }[] }).tasks;
    assert.equal(joined.length, 1);
    assert.match(joined[0]!.steps[0]!, /found 3 failed builder passes/);
    assert.match(joined[0]!.steps.join('\n'), /State the exact file F5 must create\./);
    assert.match(readFileSync(observerPaths(root).report, 'utf8'), /Review cost so far: \$1\.00 \(5 review runs in the last 24 hours\)/, 'five runs at $0.20 each');
    const log = readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8');
    assert.match(log, /"event":"observer-review","detail":"F1\/1 builder sonnet: prompt-missing-info \(high\)/);
    assert.match(log, /"event":"observer-review","detail":"F3\/1 builder sonnet: invalid answer/);
    assert.match(log, /"event":"observer-notes","detail":"sonnet as builder: 1 added/);
    assert.match(log, /"event":"observer-proposal","detail":"Prompt template change suggested for builder/);
    const report = readFileSync(observerPaths(root).report, 'utf8');
    assert.match(report, /## Why runs failed, by model/);
    assert.match(report, /### sonnet as builder\n\nCauses: .*the prompt left something out 1/);
    assert.match(report, /### opus as builder\n\nCauses: the prompt could be read two ways 1\./);
    assert.match(report, /Run bun run typecheck before you commit\. \(briefs\)/);
    assert.match(report, /Notes in force: 1, \d+ bytes\./);
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('observeOnce does not review failed passes without an agent or with promptReview off, and the curator role of the profile picks the reviewer', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh'), args = join(root, 'args.txt');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [F('F1', { status: 'todo' })] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), '');
    failedPass(root, 'F1', 1);
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${args}\ncat >/dev/null\nprintf '%s' '${answer({ cause: 'model-limitation', evidence: [], confidence: 'low', suggestion: '', target: 'lessons' })}'\n`, { mode: 0o755 });
    writeFileSync(args, '');
    process.env.FACTOS_CLAUDE = fake;
    const calls = () => readFileSync(args, 'utf8').split('\n').filter(Boolean);
    writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify({ base: 'main', branchPrefix: 'ship/', test: 'gate.sh' }));
    await observeOnce(root, { out: () => {} });
    reviewConfig(root, { promptReview: { enabled: false } });
    await observeOnce(root, { out: () => {} });
    assert.equal(calls().length, 0);
    assert.equal(readFileSync(observerPaths(root).report, 'utf8').includes('Why runs failed'), false);
    reviewConfig(root);
    writeFileSync(join(root, '.fact-os/control.json'), JSON.stringify({ profile: 'fable-sonnet' }));
    await observeOnce(root, { out: () => {} });
    assert.equal(calls().length, 1);
    assert.match(calls()[0]!, /--model fable --effort medium --permission-mode plan/, 'the profile\'s curator role: reviews are the cheaper role');
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('notes over their cap: the curator tidies them, and when it cannot the oldest go to the archive', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh'), args = join(root, 'args.txt');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    reviewConfig(root, { promptReview: { notesMaxBytes: 300 } });
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), '');
    const old = ['alpha', 'beta', 'gamma'].map((w) => `- ${w}: ${'keep this rule in mind while building. '.repeat(2).trim()}`), file = join(root, '.fact-os/prompt-notes/sonnet-builder.md');
    const seed = () => {
      mkdirSync(join(root, '.fact-os/prompt-notes'), { recursive: true });
      writeFileSync(file, old.join('\n') + '\n');
      rmSync(file.replace('.md', '.archive.md'), { force: true });
      const r = { ts: new Date().toISOString(), feature: 'x', tag: '1', role: 'builder', model: 'sonnet', effort: 'medium', notes: '-', kind: 'gate-failed', next: '', cause: 'prompt-conflict',
        evidence: ['q'], confidence: 'high', suggestion: 'Never touch the generated client; regenerate it with bun run gen instead of editing it by hand.', target: 'lessons', cost: 0 };
      writeFileSync(observerPaths(root).state, JSON.stringify({ promptReviews: { 'x/1': r } }));
    };
    process.env.FACTOS_CLAUDE = fake;
    // the curator cannot tidy them (no usable answer): the oldest notes are archived
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${args}\ncat >/dev/null\nprintf '%s' '${answer('no thanks')}'\n`, { mode: 0o755 });
    seed();
    await observeOnce(root, { out: () => {} });
    const kept = readFileSync(file, 'utf8');
    assert.ok(Buffer.byteLength(kept) <= 300, kept);
    assert.match(kept, /bun run gen/);
    assert.ok(!kept.includes('alpha'));
    assert.match(readFileSync(file.replace('.md', '.archive.md'), 'utf8'), /^## Archived \d{4}-\d\d-\d\d \(\d oldest notes dropped\)\n\n- alpha:/);
    // the curator rewrites them
    writeFileSync(args, '');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${args}\ncat >/dev/null\nprintf '%s' '${answer('<notes>\n- Merged rule one.\n- Never edit the generated client by hand; run bun run gen.\n</notes>')}'\n`, { mode: 0o755 });
    seed();
    await observeOnce(root, { out: () => {} });
    assert.equal(readFileSync(file, 'utf8'), '- Merged rule one.\n- Never edit the generated client by hand; run bun run gen.\n');
    assert.match(readFileSync(args, 'utf8'), /--model x --effort low --permission-mode auto/, 'the curator role, not read-only plan mode');
    const archive = readFileSync(file.replace('.md', '.archive.md'), 'utf8');
    assert.match(archive, /\(3 notes before tidying\)/);
    assert.ok(archive.includes('alpha') && archive.includes('gamma'));
    assert.match(readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8'), /"event":"observer-notes","detail":"sonnet as builder: 1 added, tidied by the curator/);
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed review run is retried once and then left alone; reviews are throttled, counted and stopped with the observer', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh'), args = join(root, 'args.txt');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), '');
    failedPass(root, 'F1', 1);
    process.env.FACTOS_CLAUDE = fake;
    const calls = () => (existsSync(args) ? readFileSync(args, 'utf8').split('\n').filter(Boolean).length : 0);
    const st = () => JSON.parse(readFileSync(observerPaths(root).state, 'utf8')) as { promptReviews?: object; promptReviewTries?: Record<string, { n: number }>; promptReviewCost?: number; promptReviewRuns?: string[]; promptReviewAt?: string };
    // the agent run fails (crash): asked again once, then never
    reviewConfig(root, { promptReview: { everyMinutes: 0 } });
    writeFileSync(fake, `#!/bin/sh\necho x >> ${args}\ncat >/dev/null\nexit 1\n`, { mode: 0o755 });
    for (let i = 0; i < 4; i++) await observeOnce(root, { out: () => {} });
    assert.equal(calls(), 2, 'one try and one retry');
    assert.equal(st().promptReviews && Object.keys(st().promptReviews!).length, 0);
    assert.equal(st().promptReviewTries!['F1/1']!.n, 2);
    // stopping: no batch starts
    rmSync(observerPaths(root).state); writeFileSync(args, '');
    writeFileSync(fake, `#!/bin/sh\necho x >> ${args}\ncat >/dev/null\nprintf '%s' '${answer({ cause: 'model-limitation', evidence: [], confidence: 'low', suggestion: '', target: 'lessons' })}'\n`, { mode: 0o755 });
    await observeOnce(root, { out: () => {}, stopping: () => true });
    assert.equal(calls(), 0);
    // the throttle: a batch now, then nothing for everyMinutes; the cost of the runs is kept
    reviewConfig(root, { promptReview: { everyMinutes: 30 } });
    failedPass(root, 'F2', 2);
    await observeOnce(root, { out: () => {} });
    assert.equal(calls(), 2, 'both failed passes, in one batch');
    assert.equal(st().promptReviewCost, 0.4, 'two runs at $0.20');
    assert.equal(st().promptReviewRuns!.length, 2);
    failedPass(root, 'F3', 3);
    await observeOnce(root, { out: () => {} });
    assert.equal(calls(), 2, 'within everyMinutes of the last batch');
    reviewConfig(root, { promptReview: { everyMinutes: 30, maxPerDay: 2 } });
    const s = st(); s.promptReviewAt = new Date(Date.now() - 31 * 60e3).toISOString(); writeFileSync(observerPaths(root).state, JSON.stringify(s));
    await observeOnce(root, { out: () => {} });
    assert.equal(calls(), 2, 'maxPerDay: two runs today already');
    reviewConfig(root, { promptReview: { everyMinutes: 30, maxPerDay: 3 } });
    await observeOnce(root, { out: () => {} });
    assert.equal(calls(), 3, 'one more run fits in the day');
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failing notes step does not lose the paid reviews or stop the pass, and an evaluator rejection quoting an infrastructure error is still reviewed', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh'), args = join(root, 'args.txt');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    reviewConfig(root, { promptReview: { everyMinutes: 0 } });
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), '');
    failedPass(root, 'F1', 1, 'sonnet', 'FAILED check 1: curl got ECONNREFUSED from the fake server');
    writeFileSync(fake, `#!/bin/sh\necho x >> ${args}\ncat >/dev/null\nprintf '%s' '${answer({ cause: 'prompt-missing-info', evidence: ['q'], confidence: 'high', suggestion: 'Start the fake server first.', target: 'briefs' })}'\n`, { mode: 0o755 });
    process.env.FACTOS_CLAUDE = fake;
    writeFileSync(join(root, '.fact-os/prompt-notes'), 'a file where the notes directory should be');
    const lines: string[] = [];
    const s = await observeOnce(root, { out: (l) => lines.push(l) });
    assert.deepEqual(Object.keys(s.promptReviews!), ['F1/1'], 'reviewed although its failure text says ECONNREFUSED (not an infrastructure failure)');
    assert.ok(lines.some((l) => /prompt notes failed/.test(l)), lines.join('\n'));
    const saved = JSON.parse(readFileSync(observerPaths(root).state, 'utf8')) as { promptReviews: Record<string, { noted?: boolean }> };
    assert.equal(saved.promptReviews['F1/1']!.noted, undefined, 'saved; its notes are tried again next pass');
    assert.match(readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8'), /"event":"observer-error","detail":"prompt notes: /);
    assert.ok(existsSync(observerPaths(root).report), 'the pass finished');
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('notes over the cap with no notes file yet and a curator that cannot tidy them: the oldest are archived, nothing throws', async () => {
  const root = repo(), fake = join(root, 'fake-claude.sh');
  const prev = process.env.FACTOS_CLAUDE;
  try {
    reviewConfig(root, { promptReview: { notesMaxBytes: 100 } });
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [] }));
    writeFileSync(join(root, '.fact-os/log.jsonl'), '');
    const r = (feature: string, suggestion: string) => ({ ts: new Date().toISOString(), feature, tag: '1', role: 'builder', model: 'sonnet', effort: 'medium', notes: '-', kind: 'gate-failed', next: '', cause: 'prompt-conflict', evidence: ['q'], confidence: 'high', suggestion, target: 'lessons', cost: 0 });
    writeFileSync(observerPaths(root).state, JSON.stringify({ promptReviews: { 'a/1': r('a', 'First rule: ' + 'a'.repeat(60)), 'b/1': r('b', 'Second rule: ' + 'b'.repeat(60)) } }));
    writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${answer('no thanks')}'\n`, { mode: 0o755 });
    process.env.FACTOS_CLAUDE = fake;
    await observeOnce(root, { out: () => {} });
    const notes = join(root, '.fact-os/prompt-notes');
    assert.match(readFileSync(join(notes, 'sonnet-builder.md'), 'utf8'), /^- Second rule/);
    assert.match(readFileSync(join(notes, 'sonnet-builder.archive.md'), 'utf8'), /- First rule/);
  } finally {
    if (prev === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('observe --watch reports a failing pass and goes on with the next one', async () => {
  const root = repo(), out: string[] = [];
  try {
    writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify({ base: 'main', branchPrefix: 'ship/', test: 'gate.sh', observer: { pollSec: 1 } }));
    writeFileSync(join(root, '.fact-os/features.json'), '{not json');
    const done = observe(root, { watch: true, out: (l) => out.push(l) });
    for (let i = 0; i < 50 && !out.some((l) => /pass failed/.test(l)); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(out.some((l) => /pass failed/.test(l)), out.join('\n'));
    // a broken config.json is reported at every poll too, and the loop keeps its poll interval
    const cfgFile = join(root, '.fact-os/config.json'), cfgText = readFileSync(cfgFile, 'utf8');
    writeFileSync(cfgFile, '{not json');
    const failures = () => out.filter((l) => /pass failed/.test(l)).length, n0 = failures();
    for (let i = 0; i < 60 && failures() < n0 + 2; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(failures() >= n0 + 2, out.join('\n'));
    writeFileSync(cfgFile, cfgText);
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features: [] }));
    for (let i = 0; i < 60 && !existsSync(observerPaths(root).state); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(existsSync(observerPaths(root).state), 'the next pass ran');
    process.emit('SIGTERM');
    assert.equal(await done, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('classify: prepare output is setup even when it names infrastructure; a worktree failure keeps the infrastructure retry', () => {
  assert.equal(classify('prepare `sh setup` exited 3:\nECONNREFUSED 127.0.0.1:5432', [], []).cause, 'setup');
  assert.equal(classify('prepare `sh setup` exited 3:\nmy custom outage', [], [], ['my custom outage']).cause, 'setup');
  assert.deepEqual(classify('worktree: fatal: could not create leading directories: No space left on device', [], []), { cause: 'infra', evidence: 'no space left on device' });
  assert.equal(classify('worktree: dependency a is not a merged commit on main', [], []).cause, 'setup');
});

test('unpricedRun / runCosts: a Codex run has no USD (new or legacy artifact); a Claude fallback or a genuine $0 Claude run is priced', (t) => {
  assert.equal(unpricedRun({ provider: 'codex', total_cost_usd: null, cost_status: 'unpriced' }), true);
  assert.equal(unpricedRun({ provider: 'codex', total_cost_usd: 0 }), true, 'legacy synthetic $0');
  assert.equal(unpricedRun({ total_cost_usd: 1.25 }), false, 'a paid Claude run (fallback included)');
  assert.equal(unpricedRun({ total_cost_usd: 0 }), false, 'a genuine $0 Claude run');
  const dir = mkdtempSync(join(tmpdir(), 'fact-os-cost-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'a'));
  writeFileSync(join(dir, 'a', '1-build.json'), JSON.stringify({ total_cost_usd: 2.5, duration_ms: 10 }));
  writeFileSync(join(dir, 'a', '1-eval.json'), JSON.stringify({ provider: 'codex', model: 'gpt-6.1-sol', total_cost_usd: null, cost_status: 'unpriced', duration_ms: 5 }));
  const runs = runCosts(dir).sort((x, y) => x.role.localeCompare(y.role));
  assert.deepEqual(runs.map((r) => [r.role, r.cost, !!r.unpriced]), [['build', 2.5, false], ['eval', 0, true]]);
  const eras = agentStats([], runs, 0);
  assert.equal(eras.reduce((n, e) => n + e.unpricedRuns, 0), 1);
});

test('review F13: a review repair counts the rejected evaluation, then continues the same pass to the fresh evaluation', () => {
  const ev = (m: number, event: string, detail = '') => ({ ts: new Date(Date.parse('2026-10-04T10:00:00Z') + m * 60e3).toISOString(), feature: 'a', event, detail });
  const [e] = agentStats([ev(0, 'launch'), ev(10, 'testing', 's1'), ev(20, 'evaluating'), ev(25, 'review-fix', 'resuming'), ev(40, 'testing', 's2'), ev(50, 'evaluating'), ev(52, 'merged')], [], 0);
  assert.equal(e!.evaluated, 2); assert.equal(e!.passed, 1); assert.equal(e!.merged, 1); assert.equal(e!.built, 1, 'one build');
  assert.equal(e!.evalMin, 3.5, 'only evaluator work is timed (5 and 2 minutes)');
});

test('recheck R13: a resumed builder that fails during a review repair counts as a builder failure', () => {
  const ev = (m: number, event: string, detail = '') => ({ ts: new Date(Date.parse('2026-10-04T10:00:00Z') + m * 60e3).toISOString(), feature: 'a', event, detail });
  const [e] = agentStats([ev(0, 'launch'), ev(10, 'testing', 's1'), ev(20, 'evaluating'), ev(25, 'review-fix', 'resuming'), ev(30, 'failed', 'builder failed: exit 1')], [], 0);
  assert.equal(e!.evaluated, 1); assert.deepEqual(e!.builderFailures.map(([r]) => r), ['builder failed']);
});

test('recheck2: a diagnosis note in a failure detail is builder context, never infrastructure evidence of the current failure', () => {
  const detail = 'test command `gate` exited 1:\nFAIL src/orders/tenant.test.ts > isolation\nAssertionError: expected 403 to be 200' +
    '\n\nDiagnosis (gpt-6.1-sol): code: the earlier ECONNREFUSED came from a wrong database port\nSuggested fix: use 5433';
  const c = classify(detail, ['src/orders/tenant.test.ts'], ['src/orders/tenant.ts']);
  assert.equal(c.cause, 'own', JSON.stringify(c));
  assert.equal(classify('test command `gate` exited 1:\nError: connect ECONNREFUSED 127.0.0.1:5433', [], []).cause, 'infra', 'current evidence still counts');
});

test('recheck3: a delimited diagnosis note with a multi-line fix is stripped whole', () => {
  const detail = 'test command `gate` exited 1:\nFAIL src/orders/tenant.test.ts > isolation\nAssertionError: expected 403 to be 200' +
    '\n\n[diagnosis]\nDiagnosis (gpt-6.1-sol): code: wrong port\nSuggested fix: Use port 5433.\nIf ECONNREFUSED persists, restart the relay.\n[/diagnosis]';
  assert.equal(classify(detail, ['src/orders/tenant.test.ts'], ['src/orders/tenant.ts']).cause, 'own');
});
