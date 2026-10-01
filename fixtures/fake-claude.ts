#!/usr/bin/env bun
// Fake `claude -p --output-format json` for the end-to-end tests. Builder mode commits a file;
// evaluator mode answers with the next scripted verdict from $FAKE_VERDICTS (default: pass); resolver mode finishes the
// merge the foreman started, keeping both sides.
// $FAKE_SCENARIO = {"<feature id>": "flag,flag"} makes it misbehave (see the flags below;
// plain flags apply to the builder, "eval:<flag>" to the evaluator, "resolve:<flag>" to the resolver).
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { FeaturesFile, Verdict } from '../lib/types.ts';

const prompt = readFileSync(0, 'utf8');
const id = process.env.FACTOS_FEATURE as string;
const log = process.env.FAKE_LOG as string;
const mode = prompt.startsWith('You are the builder') ? 'build' : prompt.startsWith('You are the merge resolver') ? 'resolve' : 'eval';
const flags = ((JSON.parse(process.env.FAKE_SCENARIO || '{}') as Record<string, string>)[id] || '').split(',');
const has = (f: string) => flags.includes(mode === 'build' ? f : `${mode}:${f}`);
const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const root = () => dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'));
const commit = (file: string, text: string) => { writeFileSync(file, text); git('add', file); git('commit', '-qm', `${mode} ${id}: ${file}`); };
const t0 = Date.now();

if (has('hang')) { // never answers; leaves a grandchild in its process group
  if (has('ignore-term')) process.on('SIGTERM', () => {});
  const kid = spawn('sleep', ['30'], { stdio: 'ignore' });
  appendFileSync(process.env.FAKE_PIDS as string, `${process.pid}\n${kid.pid}\n`);
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
// "slow" (any mode): five times the delay, so one feature can outlast another
await new Promise((r) => setTimeout(r, Number(process.env.FAKE_DELAY_MS ?? 400) * (flags.includes('slow') ? 5 : 1)));
let result = 'done', extra: Record<string, unknown> = {};
const conflicted = () => git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
if (mode === 'resolve') {
  // keep both sides of each conflicted file (ours, then theirs) and commit the merge; "drop": keep only ours (loses
  // theirs' lines); "declare": the same, but the commit message lists theirs' lines as dropped; "leave": do nothing
  if (!has('leave')) {
    const dropped: string[] = [];
    for (const f of conflicted()) {
      const ours = git('show', `:2:${f}`), theirs = git('show', `:3:${f}`);
      writeFileSync(f, has('drop') || has('declare') ? ours + '\n' : ours + '\n' + theirs + '\n');
      if (has('declare')) for (const l of theirs.split('\n').filter((x) => x.trim())) dropped.push(`dropped: ${f}: ${l.trim()}`);
      git('add', f);
    }
    git('commit', '-q', '-m', ['resolve the merge', ...dropped].join('\n'));
  }
} else if (mode === 'build') {
  if (has('acceptance')) { // rewrite its own acceptance checks in features.json
    const file = join(root(), '.fact-os/features.json'), d = JSON.parse(readFileSync(file, 'utf8')) as FeaturesFile;
    d.features.find((f) => f.id === id)!.acceptance = ['nothing to check'];
    writeFileSync(file, JSON.stringify(d));
  }
  if (has('config')) { // loosen the foreman's config
    const file = join(root(), '.fact-os/config.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), maxAttempts: 99 }));
  }
  if (has('budget')) extra = { subtype: 'error_max_budget_usd', is_error: true, result: '' };
  else if (has('noop')) {} // no changes, no commit
  else if (has('resolve') && existsSync(git('rev-parse', '--git-path', 'MERGE_HEAD'))) {
    // finish the merge the foreman started: keep both sides of each conflicted file, commit the merge and nothing else
    for (const f of git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean)) {
      writeFileSync(f, git('show', `:2:${f}`) + '\n' + git('show', `:3:${f}`) + '\n');
      git('add', f);
    }
    git('commit', '-q', '--no-edit');
  }
  else {
    if (has('hide')) { // hide the diff from a plain `git diff`
      writeFileSync('.gitattributes', '*.txt diff=hide\n');
      git('add', '.gitattributes');
      git('config', 'diff.hide.textconv', 'true');
      git('config', 'diff.external', 'true');
    }
    commit(`${id}.txt`, `built ${id} at ${Date.now()}\n`);
    if (has('dirty')) writeFileSync('leftover.txt', 'not committed\n');
    if (has('move-base')) { git('update-ref', 'refs/heads/main', 'HEAD'); commit(`${id}-2.txt`, 'more\n'); } // base gets its unevaluated commit
    if (has('synthetic-base')) { // a commit built from the branch's tree, put on base without a feature-branch parent
      const c = git('commit-tree', 'HEAD^{tree}', '-p', 'main', '-m', 'looks like the user');
      git('-c', 'a.b=1', 'update-ref', 'refs/heads/main', c);
    }
    if (has('root-commit')) { // the same file committed straight onto base in the main checkout
      writeFileSync(join(root(), `${id}.txt`), readFileSync(`${id}.txt`));
      git('-C', root(), 'add', `${id}.txt`); git('-C', root(), 'commit', '-qm', 'looks like the user too');
    }
    if (has('user-commit')) git('-C', root(), 'commit', '-q', '--allow-empty', '-m', 'the user\'s own work on main');
    for (const [flag, f, text] of [['base-file', `base-${id}.txt`, 'from base\n'], ['base-conflict', `${id}.txt`, 'base version\n']])
      if (has(flag)) { // the user commits on base while this feature builds (base-conflict: the same file, other content)
        writeFileSync(join(root(), f), text);
        git('-C', root(), 'add', f); git('-C', root(), 'commit', '-qm', `the user's ${f} on main`);
      }
  }
} else {
  if (has('move-branch')) commit('evil.txt', 'committed during evaluation\n');
  const past = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { mode: string; id: string }) : [];
  const n = past.filter((e) => e.mode === 'eval' && e.id === id).length;
  const scripted = (JSON.parse(readFileSync(process.env.FAKE_VERDICTS as string, 'utf8')) as Record<string, Partial<Verdict>[]>)[id]?.[n];
  result = 'Verdict:\n```json\n' + JSON.stringify(scripted ?? { pass: true,
    findings: [{ check: 'works', ok: true, evidence: 'fake' }], cheating: [], lesson: null }) + '\n```';
}
appendFileSync(log, JSON.stringify({ mode, id, t0, t1: Date.now(), prompt, args: process.argv.slice(2) }) + '\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, total_cost_usd: 0.01,
  session_id: 'fake', ...extra }));
