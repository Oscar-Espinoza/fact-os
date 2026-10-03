// Curation races use a blocked fake curator and disposable Git repositories only.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { observeOnce, observerPaths, lessonSection, bulletsOf } from '../lib/observe.ts';
import { run } from '../lib/foreman.ts';
import { DEFAULT_CONFIG, sleep, withCheckoutLock } from '../lib/state.ts';
import type { Feature, LogEvent } from '../lib/types.ts';

const until = async (fn: () => boolean) => {
  for (const end = Date.now() + 5000; !fn(); ) {
    assert.ok(Date.now() < end, 'fixture did not reach its barrier'); await sleep(10);
  }
};
function setup(t: TestContext, tracked = true) {
  const base = mkdtempSync(join(tmpdir(), 'fact-os-curation-')), root = join(base, 'app'); mkdirSync(root);
  const git = (...args: string[]) => { const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  const file = join(root, 'CLAUDE.md'), archive = join(root, 'CLAUDE.archive.md');
  const original = '# Project\n\nKeep these instructions.\n\n## fact-os lessons\n\n' +
    Array.from({ length: 40 }, (_, i) => `- 2026-09-30: lesson ${i} about testing carefully`).join('\n') + '\n\n## Other\n\nKeep this too.\n';
  writeFileSync(file, original); writeFileSync(join(root, '.gitignore'), '.fact-os/\n');
  writeFileSync(join(root, 'other.txt'), 'original\n'); git('add', '.gitignore', 'other.txt');
  if (tracked) git('add', 'CLAUDE.md'); git('commit', '-qm', 'init');
  mkdirSync(join(root, '.fact-os'));
  const config = { ...DEFAULT_CONFIG, worktreesDir: join(base, 'worktrees'), test: 'true', maxParallel: 1, timeoutMin: 0.2,
    observer: { agent: { model: 'fake' }, lessonsMaxBytes: 500, improve: false, promptReview: { enabled: false } } };
  const writeConfig = () => writeFileSync(join(root, '.fact-os/config.json'), JSON.stringify(config)); writeConfig();
  writeFileSync(join(root, '.fact-os/features.json'), '{"features":[]}'); writeFileSync(join(root, '.fact-os/human.json'), '{"tasks":[]}');
  writeFileSync(join(root, '.fact-os/log.jsonl'), '');
  const started = join(base, 'started'), release = join(base, 'release'), fake = join(base, 'curator.sh'), answer = join(base, 'answer');
  writeFileSync(answer, JSON.stringify({ type: 'result', is_error: false, total_cost_usd: 0,
    result: '<lessons>\n### Testing\n' + Array.from({ length: 6 }, (_, i) => `- Curated rule ${i}.`).join('\n') + '\n</lessons>' }));
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\ntouch '${started}'\nwhile [ ! -f '${release}' ]; do sleep 0.01; done\ncat '${answer}'\n`, { mode: 0o755 });
  const keys = ['FACTOS_CLAUDE', 'FAKE_LOG', 'FAKE_VERDICTS', 'FAKE_DELAY_MS', 'FAKE_SCENARIO', 'FACTOS_POLL_MS'];
  const previous = keys.map((k) => process.env[k]); process.env.FACTOS_CLAUDE = fake;
  t.after(() => { keys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; }); rmSync(base, { recursive: true, force: true }); });
  const start = () => observeOnce(root, { out: () => {} });
  const finish = () => writeFileSync(release, '');
  const foreman = async (ids: string[]) => {
    const features: Feature[] = ids.map((id) => ({ id, title: id, description: 'Build it', acceptance: ['works'], deps: [],
      surface: 'any', priority: 1, status: 'todo', attempts: 0, updatedAt: '' }));
    writeFileSync(join(root, '.fact-os/features.json'), JSON.stringify({ features }));
    const verdicts = join(base, 'verdicts.json');
    writeFileSync(verdicts, JSON.stringify(Object.fromEntries(ids.map((id) => [id, [{ pass: true,
      findings: [{ check: 'works', ok: true, evidence: 'tested' }], lesson: `Rule from ${id}.` }]]))));
    process.env.FACTOS_CLAUDE = new URL('../fixtures/fake-claude.ts', import.meta.url).pathname;
    process.env.FAKE_LOG = join(base, 'fake.jsonl'); process.env.FAKE_VERDICTS = verdicts; process.env.FAKE_DELAY_MS = '0';
    process.env.FAKE_SCENARIO = '{}'; process.env.FACTOS_POLL_MS = '10';
    assert.equal(await run(root, { out: () => {} }), 0);
  };
  return { root, base, git, file, archive, original, config, writeConfig, start, finish, foreman,
    started: () => until(() => existsSync(started)), log: () => readFileSync(join(root, '.fact-os/log.jsonl'), 'utf8') };
}

for (const change of ['branch', 'edit', 'delete rule', 'delete section', 'delete file', 'unrecorded append', 'outside section', 'staged edit', 'committed edit', 'tracking change', 'merge in progress']) {
  test(`curation refuses intervening ${change} without writing or committing`, async (t) => {
    const s = setup(t), pending = s.start();
    try {
      await s.started();
      if (change === 'branch') s.git('checkout', '-qb', 'user-work');
      else if (change === 'delete file') unlinkSync(s.file);
      else if (change === 'tracking change') s.git('rm', '--cached', '-q', 'CLAUDE.md');
      else if (change === 'merge in progress') writeFileSync(join(s.root, '.git/MERGE_HEAD'), s.git('rev-parse', 'HEAD') + '\n');
      else {
        const text = change === 'delete rule' ? s.original.replace('- 2026-09-30: lesson 0 about testing carefully\n', '')
          : change === 'delete section' ? '# Project\n\nDeleted lessons.\n'
          : change === 'unrecorded append' ? s.original.replace('\n\n## Other', '\n- 2026-10-02: User-added rule.\n\n## Other')
          : change === 'outside section' ? s.original.replace('Keep these instructions.', 'User instructions.')
          : s.original.replace('lesson 0 about testing carefully', 'user replacement');
        writeFileSync(s.file, text);
        if (change === 'staged edit' || change === 'committed edit') s.git('add', 'CLAUDE.md');
        if (change === 'committed edit') s.git('commit', '-qm', 'user lesson edit');
      }
      const head = s.git('rev-parse', 'HEAD'), index = s.git('ls-files', '--stage'), text = existsSync(s.file) ? readFileSync(s.file, 'utf8') : null;
      s.finish(); await pending;
      assert.equal(s.git('rev-parse', 'HEAD'), head, 'curation must not create a commit');
      assert.equal(s.git('ls-files', '--stage'), index, 'curation must not change the index');
      assert.equal(existsSync(s.file) ? readFileSync(s.file, 'utf8') : null, text, 'curation must preserve the intervening change');
      assert.equal(existsSync(s.archive), false, 'refusal must not archive stale rules');
      assert.match(s.log(), /not curated: .*changed|not curated: .*operation|not curated: .*clean/);
    } finally { s.finish(); await pending; }
  });
}

test('untracked lessons also refuse an intervening branch switch', async (t) => {
  const s = setup(t, false), pending = s.start();
  try {
    await s.started(); s.git('checkout', '-qb', 'user-work'); const head = s.git('rev-parse', 'HEAD');
    s.finish(); await pending;
    assert.equal(readFileSync(s.file, 'utf8'), s.original); assert.equal(existsSync(s.archive), false); assert.equal(s.git('rev-parse', 'HEAD'), head);
  } finally { s.finish(); await pending; }
});

for (const tracked of [true, false]) test(`curation preserves actual foreman appends (${tracked ? 'tracked' : 'untracked'}) and unrelated staging`, async (t) => {
  const s = setup(t, tracked), pending = s.start();
  try {
    await s.started(); await s.foreman(['a', 'b']);
    const appends = s.log().trim().split('\n').map((l) => JSON.parse(l) as LogEvent).filter((e) => e.event === 'lesson');
    assert.equal(appends.length, 2); assert.equal(appends[0]!.lessonAppend!.file, s.file);
    assert.match(appends[0]!.lessonAppend!.before, /^[a-f0-9]{64}$/);
    assert.equal(appends[0]!.lessonAppend!.after, appends[1]!.lessonAppend!.before);
    writeFileSync(join(s.root, 'other.txt'), 'user staged work\n'); s.git('add', 'other.txt');
    const index = s.git('ls-files', '--stage', '--', 'other.txt'), head = s.git('rev-parse', 'HEAD');
    s.finish(); await pending;
    const text = readFileSync(s.file, 'utf8');
    assert.match(text, /Curated rule 0/); assert.match(text, /Rule from a\./); assert.match(text, /Rule from b\./);
    assert.equal(bulletsOf(lessonSection(text)!.body).length, 8);
    assert.match(text, /Keep these instructions\./); assert.match(text, /Keep this too\./);
    assert.equal(s.git('ls-files', '--stage', '--', 'other.txt'), index); assert.equal(s.git('show', 'HEAD:other.txt'), 'original');
    if (tracked) { assert.equal(s.git('log', '-1', '--format=%s'), 'fact-os: curate lessons'); assert.equal(s.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'CLAUDE.md'); }
    else assert.equal(s.git('rev-parse', 'HEAD'), head, 'untracked lessons must stay uncommitted');
    assert.match(readFileSync(s.archive, 'utf8'), /lesson 39/); assert.doesNotMatch(readFileSync(s.archive, 'utf8'), /Rule from [ab]/);
  } finally { s.finish(); await pending; }
});

for (const change of ['user before foreman', 'user after foreman', 'proof removed', 'proof invalid', 'log replaced', 'log truncated']) {
  test(`curation rejects an invalid append chain: ${change}`, async (t) => {
    const s = setup(t, false), logFile = join(s.root, '.fact-os/log.jsonl');
    writeFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), feature: null, event: 'notice', detail: 'seed' }) + '\n');
    const pending = s.start();
    try {
      await s.started();
      if (change === 'user before foreman') writeFileSync(s.file, s.original.replace('lesson 0', 'user rule'));
      await s.foreman(['a']);
      if (change === 'user after foreman') writeFileSync(s.file, readFileSync(s.file, 'utf8').replace('lesson 0', 'user rule'));
      if (change.startsWith('proof ')) {
        const lines = s.log().trim().split('\n').map((l) => JSON.parse(l) as LogEvent);
        for (const e of lines) if (e.event === 'lesson') {
          if (change === 'proof removed') delete e.lessonAppend; else e.lessonAppend!.before = '0'.repeat(64);
        }
        writeFileSync(logFile, lines.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
      if (change === 'log replaced') { writeFileSync(logFile + '.new', s.log()); renameSync(logFile + '.new', logFile); }
      if (change === 'log truncated') writeFileSync(logFile, '');
      const text = readFileSync(s.file, 'utf8'), head = s.git('rev-parse', 'HEAD'); s.finish(); await pending;
      assert.equal(readFileSync(s.file, 'utf8'), text); assert.equal(existsSync(s.archive), false); assert.equal(s.git('rev-parse', 'HEAD'), head);
      assert.match(s.log(), /not curated: .*changed|not curated: .*truncated/);
    } finally { s.finish(); await pending; }
  });
}

test('curation reports a failed commit and keeps unrelated staged work', async (t) => {
  const s = setup(t), pending = s.start();
  try {
    await s.started();
    writeFileSync(join(s.root, '.git/hooks/pre-commit'), '#!/bin/sh\necho "curation commit rejected" >&2\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(s.root, 'other.txt'), 'user staged work\n'); s.git('add', 'other.txt');
    const head = s.git('rev-parse', 'HEAD'), index = s.git('ls-files', '--stage', '--', 'other.txt');
    s.finish(); await pending;
    assert.equal(s.git('rev-parse', 'HEAD'), head); assert.equal(s.git('ls-files', '--stage', '--', 'other.txt'), index);
    assert.match(s.log(), /commit failed: curation commit rejected/);
    assert.match(readFileSync(s.file, 'utf8'), /Curated rule 0/); assert.ok(existsSync(s.archive));
  } finally { s.finish(); await pending; }
});

test('a checkout lock timeout safely defers curation instead of failing the observer', { timeout: 35000 }, async (t) => {
  const s = setup(t), pending = s.start();
  try {
    await s.started(); const head = s.git('rev-parse', 'HEAD');
    await withCheckoutLock(s.root, async () => {
      s.finish(); const state = await pending;
      assert.ok(state.lessonsAt, 'the paid call was already launched before the apply lock timeout');
      assert.equal(readFileSync(s.file, 'utf8'), s.original); assert.equal(existsSync(s.archive), false);
      assert.equal(s.git('rev-parse', 'HEAD'), head); assert.match(s.log(), /not curated: checkout is busy/);
    });
  } finally { s.finish(); await pending; }
});

test('curation waits for a foreman merge hook instead of committing its pending merge', async (t) => {
  const s = setup(t), pending = s.start(), hookStarted = join(s.base, 'hook-started'), hookRelease = join(s.base, 'hook-release');
  let running: Promise<void> | undefined;
  try {
    await s.started();
    s.config.mergeHook = `touch '${hookStarted}'; while [ ! -f '${hookRelease}' ]; do sleep 0.01; done`; s.writeConfig();
    running = s.foreman(['a']); await until(() => existsSync(hookStarted));
    assert.ok(existsSync(join(s.root, '.git/MERGE_HEAD'))); s.finish();
    await sleep(150);
    assert.equal(s.git('log', '-1', '--format=%s'), 'init', 'curator must not commit the in-progress merge');
    assert.equal(existsSync(s.archive), false);
    writeFileSync(hookRelease, ''); await running; await pending;
    assert.match(s.git('log', '--format=%s'), /fact-os: merge a: a/);
    assert.match(readFileSync(s.file, 'utf8'), /Curated rule 0/); assert.match(readFileSync(s.file, 'utf8'), /Rule from a\./);
  } finally { s.finish(); writeFileSync(hookRelease, ''); await running; await pending; }
});
