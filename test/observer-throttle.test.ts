// R13: fake providers, real observer stages and disposable Git/filesystem failures.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeOnce, observerPaths } from '../lib/observe.ts';
import { sleep } from '../lib/state.ts';

type Stage = 'lessons' | 'improver';
const keyOf = (stage: Stage) => stage === 'lessons' ? 'lessonsAt' : 'improveAt';
const until = async (fn: () => boolean) => {
  const end = Date.now() + 5000;
  while (!fn()) { assert.ok(Date.now() < end, 'fake provider did not start'); await sleep(10); }
};
function setup(t: TestContext, stage: Stage) {
  const root = mkdtempSync(join(tmpdir(), 'fact-os-throttle-')), dir = join(root, '.fact-os');
  execFileSync('git', ['init', '-qb', 'main'], { cwd: root });
  mkdirSync(dir);
  writeFileSync(join(root, 'seed'), 'seed');
  execFileSync('git', ['add', 'seed'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'seed'], { cwd: root });
  const lessons = '## fact-os lessons\n\n' + Array.from({ length: 20 }, (_, i) => `- Rule ${i}: preserve the contract and verify its callers.`).join('\n') + '\n';
  const file = join(root, 'CLAUDE.md'), archive = join(root, 'CLAUDE.archive.md');
  if (stage === 'lessons') writeFileSync(file, lessons);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ base: 'main', observer: { goals: false,
    agent: { model: 'fake' }, retry: false, improve: stage === 'improver', lessonsMaxBytes: 500,
    promptReview: { enabled: false }, curateEveryHours: 4, improveEveryHours: 6 } }));
  writeFileSync(join(dir, 'features.json'), '{"features":[]}');
  const human = join(dir, 'human.json'), emptyHuman = '{"tasks":[]}'; writeFileSync(human, emptyHuman);
  writeFileSync(join(dir, 'log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), feature: null, event: 'alert', detail: 'Systemic fixture failure' }) + '\n');
  const fake = join(root, 'provider.sh'), calls = join(root, 'calls'), release = join(root, 'release');
  const answer = stage === 'lessons' ? '<lessons>\n### Testing\n' + Array.from({ length: 6 }, (_, i) => `- Curated rule ${i}.`).join('\n') + '\n</lessons>'
    : JSON.stringify({ features: [{ title: 'Repair recurring issue', description: 'Fixture evidence', acceptance: ['verified'] }],
      humanTasks: [{ title: 'Inspect fixture environment', why: 'Fixture evidence', steps: ['inspect'] }], notes: 'Must not apply after failure' });
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\necho call >> '${calls}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\nprintf '%s' '${JSON.stringify({ type: 'result', is_error: false, result: answer, total_cost_usd: 0.2 })}'\n`, { mode: 0o755 });
  const previous = process.env.FACTOS_CLAUDE; process.env.FACTOS_CLAUDE = fake;
  t.after(() => { if (previous === undefined) delete process.env.FACTOS_CLAUDE; else process.env.FACTOS_CLAUDE = previous; rmSync(root, { recursive: true, force: true }); });
  const O = observerPaths(root);
  const stored = (): Record<string, unknown> => existsSync(O.state) ? JSON.parse(readFileSync(O.state, 'utf8')) : {};
  return { root, dir, file, archive, lessons, human, emptyHuman, O, stored,
    finish: () => writeFileSync(release, ''), started: () => until(() => existsSync(calls)),
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0,
    log: () => readFileSync(join(dir, 'log.jsonl'), 'utf8') };
}

for (const stage of ['lessons', 'improver'] as const) {
  test(`${stage}: checkpoint is persisted before the provider completes`, async (t) => {
    const s = setup(t, stage), pass = observeOnce(s.root, { out: () => {} });
    try { await s.started(); assert.equal(typeof s.stored()[keyOf(stage)], 'string'); }
    finally { s.finish(); await pass; }
  });

  test(`${stage}: application failure is reported and the next pass retains its throttle`, async (t) => {
    const s = setup(t, stage), messages: string[] = [];
    const out = (message: string) => {
      messages.push(message);
      if (stage === 'improver' && message.startsWith('observer: improver failed:')) {
        rmSync(s.human, { recursive: true }); writeFileSync(s.human, s.emptyHuman);
      }
    };
    const pass = observeOnce(s.root, { out });
    let state: Awaited<ReturnType<typeof observeOnce>>;
    try {
      await s.started();
      if (stage === 'lessons') mkdirSync(s.archive);
      else { rmSync(s.human); mkdirSync(s.human); }
      s.finish(); state = await pass;
    } finally { s.finish(); await pass.catch(() => {}); }
    assert.equal(s.calls(), 1);
    assert.equal(typeof s.stored()[keyOf(stage)], 'string');
    assert.ok(messages.some((m) => m.startsWith(`observer: ${stage === 'lessons' ? 'lesson curation' : 'improver'} failed:`)));
    assert.match(s.log(), /"event":"observer-error"/);
    if (stage === 'lessons') {
      assert.equal(readFileSync(s.file, 'utf8'), s.lessons); assert.doesNotMatch(s.log(), /"detail":"curated /);
    } else {
      assert.equal(state!.improvements.length, 1, 'partial successful feature application remains accounted for');
      assert.equal(state!.agentNotes, undefined); assert.doesNotMatch(s.log(), /improver done/);
    }
    assert.ok(existsSync(s.O.report), 'the observer still writes its report');
    const timestamp = s.stored()[keyOf(stage)];
    await observeOnce(s.root, { out: () => {} });
    assert.equal(s.calls(), 1, 'an in-interval poll must not repeat the paid call');
    assert.equal(s.stored()[keyOf(stage)], timestamp);
  });

  for (const prior of ['missing', 'expired'] as const) test(`${stage}: failed checkpoint preserves ${prior} throttle and prevents launch`, async (t) => {
    const s = setup(t, stage); s.finish();
    const old = prior === 'expired' ? new Date(Date.now() - 8 * 3600e3).toISOString() : undefined;
    if (old) writeFileSync(s.O.state, JSON.stringify({ [keyOf(stage)]: old }));
    const out = (message: string) => {
      if (message.startsWith(stage === 'lessons' ? 'observer: curating ' : 'observer: improver looking ')) {
        rmSync(s.O.state, { force: true }); mkdirSync(s.O.state);
      }
      if (message.startsWith(`observer: ${stage === 'lessons' ? 'lesson curation' : 'improver'} failed:`)) rmSync(s.O.state, { recursive: true });
    };
    await observeOnce(s.root, { out });
    assert.equal(s.calls(), 0); assert.equal(s.stored()[keyOf(stage)], old);
    await observeOnce(s.root, { out: () => {} });
    assert.equal(s.calls(), 1, 'a later healthy pass is eligible');
  });

  test(`${stage}: a report failure after launch cannot erase the throttle`, async (t) => {
    const s = setup(t, stage); s.finish(); mkdirSync(s.O.report);
    await assert.rejects(observeOnce(s.root, { out: () => {} }), /EISDIR/);
    const timestamp = s.stored()[keyOf(stage)]; assert.equal(typeof timestamp, 'string');
    rmSync(s.O.report, { recursive: true });
    await observeOnce(s.root, { out: () => {} });
    assert.equal(s.calls(), 1); assert.equal(s.stored()[keyOf(stage)], timestamp);
  });

  test(`${stage}: stopping before launch leaves calls and throttle untouched`, async (t) => {
    const s = setup(t, stage); let stopping = false;
    await observeOnce(s.root, { stopping: () => stopping, out: (message) => {
      if (message.startsWith(stage === 'lessons' ? 'observer: curating ' : 'observer: improver looking ')) stopping = true;
    } });
    assert.equal(stopping, true); assert.equal(s.calls(), 0); assert.equal(s.stored()[keyOf(stage)], undefined);
  });
}

test('a failed curation still allows the independently eligible improver to launch', async (t) => {
  const s = setup(t, 'lessons'); s.finish(); mkdirSync(s.archive);
  const configFile = join(s.dir, 'config.json'), config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.observer.improve = true; writeFileSync(configFile, JSON.stringify(config));
  await observeOnce(s.root, { out: () => {} });
  assert.equal(s.calls(), 2); assert.equal(typeof s.stored().lessonsAt, 'string'); assert.equal(typeof s.stored().improveAt, 'string');
  assert.match(s.log(), /"event":"observer-error","detail":"lesson curation: EISDIR/);
});
