// End to end: the merge process (file claims, the both-sides brief, the resolver, the keep-lines check) with a real git
// conflict and the fake claude (fixtures/fake-claude.ts). Never the real claude.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Config, Feature, FeaturesFile } from '../lib/types.ts';
import { reap } from './reap.ts';

const BIN = fileURLToPath(new URL('../bin/fact-os', import.meta.url));
const FAKE = fileURLToPath(new URL('../fixtures/fake-claude.ts', import.meta.url));
const F = (id: string, o: Partial<Feature> = {}): Feature => ({ id, title: `Feature ${id}`, description: `Build ${id}`, acceptance: [`${id}.txt exists`],
  surface: 'any', deps: [], priority: 1, status: 'todo', attempts: 0, updatedAt: '', ...o });
interface Call { mode: string; id: string; t0: number; t1: number; prompt: string; args: string[] }

function setup(t: TestContext, { features, config = {}, scenario = {}, delay = '50' }:
  { features: Feature[]; config?: Partial<Config>; scenario?: Record<string, string>; delay?: string }) {
  const base = mkdtempSync(join(tmpdir(), 'fact-os-mp-'));
  const repo = join(base, 'app');
  t.after(() => { reap(repo, join(base, 'pids')); rmSync(base, { recursive: true, force: true }); });
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# app\n');
  writeFileSync(join(repo, 'registry.txt'), 'start\nend\n');
  git('add', '.'); git('commit', '-qm', 'init');
  chmodSync(FAKE, 0o755);
  const env = { ...process.env, FACTOS_CLAUDE: FAKE, FACTOS_POLL_MS: '100', FAKE_DELAY_MS: delay, FAKE_LOG: join(base, 'fake.jsonl'),
    FAKE_VERDICTS: join(base, 'verdicts.json'), FAKE_PIDS: join(base, 'pids'), FAKE_SCENARIO: JSON.stringify(scenario) };
  const cli = (...a: string[]) => spawnSync(process.execPath, [BIN, ...a], { cwd: repo, env, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(cli('init', '--test', 'true').status, 0);
  const sy = (f: string) => join(repo, '.fact-os', f);
  writeFileSync(sy('config.json'), JSON.stringify({ ...JSON.parse(readFileSync(sy('config.json'), 'utf8')), ...config }));
  writeFileSync(sy('features.json'), JSON.stringify({ features }));
  writeFileSync(env.FAKE_VERDICTS, '{}');
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  return { repo, git, cli, sy, env,
    feature: (id: string) => (JSON.parse(read(sy('features.json'))) as FeaturesFile).features.find((f) => f.id === id)!,
    log: () => read(sy('log.jsonl')),
    events: (id: string) => read(sy('log.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { feature: string; event: string; detail: string })
      .filter((e) => e.feature === id && e.event !== 'prompt' && e.event !== 'lesson').map((e) => e.event),
    calls: (mode: string, id: string) => read(env.FAKE_LOG).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Call).filter((c) => c.mode === mode && c.id === id) };
}
type Setup = ReturnType<typeof setup>;

// Two features that each append their own entry to registry.txt before its shared last line, on their own branches:
// whichever merges second conflicts. Only they touch it, with these descriptions and checks.
function registryBranches(s: Setup, ids: string[]) {
  for (const id of ids) {
    s.git('checkout', '-qb', `ship/${id}`);
    writeFileSync(join(s.repo, 'registry.txt'), `start\nentry ${id}\nend\n`);
    s.git('commit', '-qam', `${id} registers itself`);
    s.git('checkout', '-q', 'main');
  }
}
const both = (s: Setup) => readFileSync(join(s.repo, 'registry.txt'), 'utf8');

test('resolver: a merge bounce is resolved in the same pass with both sides\' context, then tested, evaluated again and merged', { timeout: 30000 }, (t) => {
  const s = setup(t, {
    features: [F('b', { branch: 'ship/b', priority: 0, description: 'Registers b in registry.txt', acceptance: ['registry.txt lists entry b'] }),
      F('a', { branch: 'ship/a', description: 'Registers a in registry.txt', acceptance: ['registry.txt lists entry a'] })],
    config: { maxParallel: 1, maxAttempts: 1, test: 'grep -q "entry $FACTOS_FEATURE" registry.txt', resolver: { model: 'sonnet', effort: 'high' } } });
  registryBranches(s, ['b', 'a']);
  s.git('checkout', '-q', 'main');
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const a = s.feature('a');
  assert.deepEqual([s.feature('b').status, a.status, a.attempts, a.refreshes, a.conflict], ['merged', 'merged', 0, 1, undefined]);
  assert.equal(s.calls('build', 'a').length, 1, 'no second build: the resolver finished the merge');
  const [res] = s.calls('resolve', 'a');
  assert.ok(res, 'a resolver ran');
  assert.match(res.args.join(' '), /--model sonnet --effort high/, 'with its own role config');
  // both sides' context: this feature, the feature merged into main that touched the file (its checks), the diff3 hunk
  assert.match(res.prompt, /^You are the merge resolver for feature "a"/);
  assert.match(res.prompt, /This branch: a: Feature a\nRegisters a in registry\.txt\nAcceptance:\n- registry\.txt lists entry a/);
  assert.match(res.prompt, /- b: Feature b \([0-9a-f]{12}; files: registry\.txt\)\n {2}Registers b in registry\.txt\n {2}Acceptance:\n {2}- registry\.txt lists entry b/);
  assert.match(res.prompt, /<<<<<<< HEAD\nentry a\n\|\|\|\|\|\|\| [0-9a-f]+\n=======\nentry b\n>>>>>>> /);
  assert.match(res.prompt, /dropped: <file>: <the line exactly as it was>` \(the line as written in the file: no backticks around it and nothing after it\), with the reason on the next line/);
  // the resolution still went through the test and a fresh evaluator, which was told what else to check
  assert.deepEqual(s.events('a').slice(-8), ['testing', 'evaluating', 'refreshed', 'resolving', 'resolved', 'testing', 'evaluating', 'merged']);
  const evals = s.calls('eval', 'a');
  assert.equal(evals.length, 2);
  assert.doesNotMatch(evals[0].prompt, /resolved a merge conflict/);
  assert.match(evals[1].prompt, /resolved a merge conflict with main in this pass[\s\S]*- b: Feature b \(registry\.txt\)\n {2}- registry\.txt lists entry b/);
  assert.match(both(s), /entry a[\s\S]*entry b|entry b[\s\S]*entry a/, 'main has both entries');
  assert.ok(existsSync(join(s.sy('runs'), 'a', '1.2-resolve.json')) && existsSync(join(s.sy('runs'), 'a', '1.2-eval.json')), 'the resolution pass has its own run files');
  assert.ok(existsSync(join(s.sy('runs'), 'a', '1-eval.json')), 'the first evaluation was kept');
  assert.doesNotMatch(s.log(), /"alert"/);
});

test('resolver with refreshBeforeTest: a conflict before the test is resolved inline; the conflicted state is never tested or evaluated', { timeout: 30000 }, (t) => {
  const s = setup(t, { features: [F('a')], config: { maxAttempts: 1, refreshBeforeTest: true, resolver: {} }, scenario: { a: 'base-conflict' } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual([s.feature('a').status, s.feature('a').refreshes], ['merged', 1]);
  assert.deepEqual(s.events('a'), ['launch', 'planned', 'refreshed', 'resolving', 'resolved', 'testing', 'evaluating', 'merged']);
  const [res] = s.calls('resolve', 'a');
  assert.match(res.prompt, /- commit [0-9a-f]{12} "the user's a\.txt on main" \(files: a\.txt\)/, 'a non-feature commit on base is named too');
  assert.equal(s.calls('eval', 'a').length, 1);
  assert.equal(readFileSync(join(s.repo, 'a.txt'), 'utf8').includes('base version'), true, 'main kept the user\'s line');
});

test('keep-lines check: a resolver that drops the other side\'s line is sent back, and the lost line never reaches main', { timeout: 30000 }, (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0 }), F('a', { branch: 'ship/a' })],
    config: { maxParallel: 1, maxAttempts: 1, resolver: {}, keepFixes: 0 }, scenario: { a: 'resolve:drop' } });
  registryBranches(s, ['b', 'a']);
  const r = s.cli('run');
  assert.equal(r.status, 2, r.stdout + r.stderr);
  const a = s.feature('a');
  assert.equal(a.status, 'stuck');
  assert.match(s.log(), /"event":"resolve-failed","detail":"keep-check: 1 lines lost"/);
  assert.match(s.calls('build', 'a')[1].prompt, /A resolver run tried first: The merge resolution lost lines[\s\S]*- registry\.txt: `entry b` \(added by main\)/);
  // the next build (which does not put the line back) fails the same check: an attempt, never a merge
  assert.match(a.lastFeedback!, /lost lines that one side added[\s\S]*`entry b`/);
  assert.match(s.log(), /"event":"keep-check","detail":"1 lines lost"/);
  assert.equal(s.calls('eval', 'a').length, 1, 'only the pre-bounce evaluation');
  assert.doesNotMatch(both(s), /entry a/);
});

test('keep-lines check: a drop declared in the merge commit (`dropped: <file>: <line>`) passes and merges', { timeout: 30000 }, (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0 }), F('a', { branch: 'ship/a' })],
    config: { maxParallel: 1, maxAttempts: 1, resolver: {} }, scenario: { a: 'resolve:declare' } });
  registryBranches(s, ['b', 'a']);
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
  assert.match(s.log(), /"feature":"a","event":"resolved"/);
});

test('a resolver that leaves the merge unfinished hands it to the builder with the same brief; the builder\'s resolution is checked', { timeout: 30000 }, (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0, acceptance: ['registry.txt lists entry b'] }), F('a', { branch: 'ship/a' })],
    config: { maxParallel: 1, maxAttempts: 1, resolver: {} }, scenario: { a: 'resolve:leave,resolve' } });
  registryBranches(s, ['b', 'a']);
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.feature('a').status, 'merged');
  assert.match(s.log(), /"event":"resolve-failed","detail":"the resolver left the merge uncommitted"/);
  const p = s.calls('build', 'a')[1].prompt;
  assert.match(p, /conflicts in: registry\.txt[\s\S]*- b: Feature b[\s\S]*registry\.txt lists entry b[\s\S]*A resolver run tried first: the resolver left the merge uncommitted/);
  assert.match(s.log(), /"feature":"a","event":"keep-check","detail":"ok: registry\.txt"/);
  assert.match(s.calls('eval', 'a').at(-1)!.prompt, /resolved a merge conflict with main in this pass/);
});

test('conflictBrief without a resolver: the builder gets both sides\' context and its resolution is checked before the test', { timeout: 30000 }, (t) => {
  const s = setup(t, { features: [F('b', { branch: 'ship/b', priority: 0, description: 'Registers b' }), F('a', { branch: 'ship/a' })],
    config: { maxParallel: 1, maxAttempts: 1, conflictBrief: true }, scenario: { a: 'resolve' } });
  registryBranches(s, ['b', 'a']);
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(s.calls('resolve', 'a').length, 0, 'no resolver configured');
  const p = s.calls('build', 'a')[1].prompt;
  assert.match(p, /conflicts in: registry\.txt\. Resolve[\s\S]*dropped: <file>: <the line exactly as it was>[\s\S]*## Merge conflict: keep both sides[\s\S]*- b: Feature b[\s\S]*Registers b[\s\S]*<<<<<<< HEAD/);
  assert.match(s.log(), /"feature":"a","event":"keep-check","detail":"ok: registry\.txt"/);
  assert.equal(s.feature('a').conflict, undefined);
  assert.equal(s.feature('a').status, 'merged');
});

test('claims: two features that change a hot file never run together; a feature on other files still runs beside them', { timeout: 30000 }, (t) => {
  const s = setup(t, { delay: '1000', // long enough that c still overlaps a under load
    features: [F('a', { touches: ['registry.txt'] }), F('b', { touches: ['registry.txt'] }), F('c')],
    config: { maxParallel: 3, claims: { hot: ['registry.txt'] } } });
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [a] = s.calls('build', 'a'), [b] = s.calls('build', 'b'), [c] = s.calls('build', 'c');
  const overlap = (x: Call, y: Call) => x.t0 < y.t1 && y.t0 < x.t1;
  assert.ok(!overlap(a, b), 'a and b (same hot file) ran one after the other');
  assert.ok(overlap(a, c), 'c ran beside a');
  assert.match(s.log(), /"feature":"b","event":"claim-wait","detail":"registry\.txt is claimed by a"/);
  assert.doesNotMatch(a.prompt, /Hot files:/, 'a launched first: nothing hot was held');
  assert.match(c.prompt, /Hot files: [^\n]*\n- registry\.txt \(a\)\nKeep your edits there small and additive/, 'c is told what a holds');
});

test('claims from history: a file whose conflicts scored minScore is hot, and a re-run\'s claim comes from its branch diff', { timeout: 30000 }, (t) => {
  const s = setup(t, { delay: '700', features: [F('a', { branch: 'ship/a', touches: ['registry.txt'] }), F('b', { branch: 'ship/b' })],
    config: { maxParallel: 2, claims: { minScore: 3 } } });
  registryBranches(s, ['b']); // b already changed registry.txt on an earlier pass
  const now = new Date().toISOString();
  for (const id of ['x', 'y', 'z']) appendFileSync(s.sy('log.jsonl'), JSON.stringify({ ts: now, feature: id, event: 'refreshed', detail: 'conflicts in: registry.txt' }) + '\n');
  const r = s.cli('run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const [a] = s.calls('build', 'a'), [b] = s.calls('build', 'b');
  assert.ok(a.t1 <= b.t0 || b.t1 <= a.t0, 'never in flight together');
  assert.match(s.log(), /"event":"claim-wait","detail":"registry\.txt is claimed by (a|b)"/);
});


const directoryClaimCases = [
  { name: 'listed file held, broad directory wanted', a: 'src/a/hot.ts', b: 'src/', source: 'listed', blocker: 'src/a/hot.ts' },
  { name: 'broad directory held, listed file wanted', a: 'src/', b: 'src/a/hot.ts', source: 'listed', blocker: 'src/a/hot.ts' },
  { name: 'scored descendant inside nested directory overlap', a: 'src/', b: 'src/a/', source: 'scored', blocker: 'src/a/' },
  { name: 'listed prefix beneath held/wanted directories', a: 'src/a/', b: 'src/', source: 'prefix', blocker: 'src/a/' },
  { name: 'cold concrete overlap under a broadly hot directory', a: 'src/', b: 'src/b/cold.ts', source: 'listed', blocker: null },
  { name: 'default-disabled claims keep concurrent launch behavior', a: 'src/', b: 'src/a/hot.ts', source: 'off', blocker: null },
  { name: 'zero threshold protects unrecorded directory overlap and hints held paths', a: 'src/', b: 'src/a/', source: 'zero', blocker: 'src/a/' },
] as const;
for (const check of directoryClaimCases) test(`R11: foreman ${check.name}`, { timeout: 15000 }, (t) => {
  const hotPath = check.source === 'prefix' ? 'src/a/protected/' : 'src/a/hot.ts';
  const s = setup(t, { delay: '0', features: [F('a', { touches: [check.a] }), F('b', { touches: [check.b] }), F('c', { touches: [check.source === 'zero' ? 'other/' : 'src/b/cold.ts'] })],
    config: { maxParallel: 3, claims: check.source === 'off' ? null : check.source === 'zero' ? { minScore: 0, hot: ['unrelated/hot.ts'] } : { hot: check.source === 'scored' ? [] : [hotPath] } } });
  if (check.source === 'scored') for (const id of ['x', 'y', 'z'])
    appendFileSync(s.sy('log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), feature: id, event: 'refreshed', detail: 'conflicts in: src/a/hot.ts' }) + '\n');
  // a cannot complete until c starts. Factory event order proves both exclusivity
  // and cold-file concurrency without relying on process-duration overlap estimates.
  const aStarted = s.sy('a-started'), cStarted = s.sy('c-started'), wrapper = s.sy('claim-provider.sh');
  writeFileSync(wrapper, `#!/bin/sh\nin=$(cat)\ncase "$in" in "You are the builder"*)\ncase "$FACTOS_FEATURE" in a) touch '${aStarted}'; while [ ! -f '${cStarted}' ]; do sleep 0.01; done;; c) touch '${cStarted}';; esac;; esac\nprintf '%s' "$in" | '${FAKE}' "$@"\n`, { mode: 0o755 });
  s.env.FACTOS_CLAUDE = wrapper;
  const r = s.cli('run'); assert.equal(r.status, 0, r.stdout + r.stderr);
  const events = s.log().trim().split('\n').map((line) => JSON.parse(line) as { feature: string; event: string; detail: string });
  const at = (id: string, event: string) => events.findIndex((e) => e.feature === id && e.event === event);
  assert.ok(at('c', 'launch') >= 0 && at('c', 'launch') < at('a', 'merged'), 'cold c must launch while a holds its claim');
  assert.ok(at('b', 'launch') >= 0);
  if (check.blocker) {
    assert.ok(at('a', 'merged') < at('b', 'launch'), 'protected overlap must wait until a merges');
    assert.ok(events.some((e) => e.feature === 'b' && e.event === 'claim-wait' && e.detail === `${check.blocker} is claimed by a`));
  } else {
    assert.ok(at('b', 'launch') < at('a', 'merged'), 'cold or disabled claims must not serialize b');
    assert.equal(events.some((e) => e.feature === 'b' && e.event === 'claim-wait'), false);
  }
  const prompt = s.calls('build', 'c')[0]!.prompt;
  if (check.source === 'off') assert.doesNotMatch(prompt, /Hot files:/);
  else if (check.source === 'zero') {
    assert.ok(prompt.includes(`${check.a} (a)`), 'zero threshold hints all held paths, including unrecorded directories');
    assert.equal(prompt.includes('unrelated/hot.ts (a)'), false, 'unheld known hot files do not enter hints');
  }
  else {
    assert.ok(prompt.includes(`${hotPath} (a)`), 'builder hints identify the protected descendant, not its broad held directory');
    if (check.a !== hotPath) assert.equal(prompt.includes(`- ${check.a} (a)`), false);
  }
  for (const id of ['a', 'b', 'c']) { assert.equal(s.feature(id).status, 'merged'); assert.equal(s.calls('build', id).length, 1); }
});
